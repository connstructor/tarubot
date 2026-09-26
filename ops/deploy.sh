#!/usr/bin/env bash
# Owner-approved production deploys over SSH (2.30.0; issue #41). REQUIREMENTS.md "Approved
# SSH-deploy amendments (2026-09-26)" records the owner's decisions; docs/HOSTING.md "Automated
# deploys" has the flow, what each outcome means and what to do by hand.
#
# This is the forced command of the deploy key in the tarubot user's ~/.ssh/authorized_keys:
# restrict,command="<home>/tarubot/ops/deploy.sh", where <home> is what `getent passwd tarubot`
# names (/opt/tarubot on the current host, /home/tarubot on one rebuilt from the runbook in
# docs/HOSTING.md). The "Deploy production" workflow
# (.github/workflows/deploy.yml) connects only after the owner approves its run in GitHub, and
# sshd hands the client's command over in SSH_ORIGINAL_COMMAND. Exactly two forms are accepted,
# the v1 command contract:
#
#   deploy   <version> <commit> <digest> <run>
#   rollback <version> <commit> <digest> <run> <from>
#
# Anything else prints the usage line and exits 64 without touching git, Docker or a lock.
#
#   1. The entry starts one detached worker per run id, holding runs/<run>/lock, and follows its
#      public log. A reconnect with the same request attaches to the same run instead. A run
#      refused before its approval was confirmed starts over on the next request.
#   2. The worker asks GitHub's public API whether this exact run is in progress on main with its
#      Deploy job running, names this target and was approved by the owner for `production`, and
#      asks again just before the first change. The key alone authorizes nothing.
#   3. It refuses while manual work looks in progress (the bot stopped, the pinned release not the
#      one running, a backup running, a changed clone), then compares the live release with the
#      target in git: no migration files added means a restart; added files mean stop, a fresh
#      ops/backup.sh dump, migrate.js in the new image, then start.
#   4. The image must be the digest the plan showed. The previous release comes back on its own
#      only when the new one provably never took the writer lease, or the migration did not
#      commit. Commands are registered globally and read back whenever a release is started or
#      verified.
#
# Only fixed `step`, `warning` and `result` lines leave the host. Tool output stays in
# ~/.local/state/tarubot-deploy/runs/<run>/worker.log. The command format and the run directory
# layout (request, lock, step, public.log, worker.log, result) are a versioned contract: a change
# to either raises FLOOR to the release that makes it, because after a rollback an older copy of
# this script answers the current workflow.
#
# The recovery rule also reads two of the bot's own log messages, both logged at info: "Modules
# loaded" (src/main.ts, before the bot asks for the writer lease) and "Database writer lease
# acquired" (src/application/lifecycle.ts). They are frozen. Bash has read this script before the
# clone moves to the target, so the live release's copy judges the new release's logs: a renamed
# message, or one logged below info, would let an older copy put the previous release back over
# the new one's writes. tests/unit/deploy-script.test.ts checks both sources.
set -Eeuo pipefail

# The oldest release whose ops/deploy.sh speaks this contract; older targets are refused.
readonly FLOOR=2.30.0
readonly REPO=deconfined/tarubot
readonly IMAGE=ghcr.io/deconfined/tarubot
# The one GitHub account whose approval of `production` authorizes a deploy, by login and by its
# numeric id, which a renamed or re-registered login can't take over.
readonly REVIEWER=deconfined
readonly REVIEWER_ID=71469756
readonly WORKFLOW=.github/workflows/deploy.yml
# The most workers that may run at once; a new run, or one starting over, beyond that is refused.
readonly MAX_WORKERS=4
readonly API=https://api.github.com
# The only PATH the entry and the worker use, whatever sshd passed.
readonly SAFE_PATH=/usr/local/bin:/usr/bin:/bin
readonly MAX_REQUEST=200
readonly VERSION='^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'
# The v1 contract. deploy.yml carries the same three patterns (tests/unit/deploy-workflow.test.ts).
# Fields come from BASH_REMATCH: 1 is the version, 5 the commit, 6 the digest, 7 the run id and,
# for a rollback, 8 the live version it leaves.
readonly DEPLOY_FORM='^deploy ((0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})) ([0-9a-f]{40}) (sha256:[0-9a-f]{64}) ([1-9][0-9]{0,19})$'
readonly ROLLBACK_FORM='^rollback ((0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})) ([0-9a-f]{40}) (sha256:[0-9a-f]{64}) ([1-9][0-9]{0,19}) ((0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3}))$'
readonly RESULT_FORM='^result outcome=(deployed|already-live|superseded|refused|recovered|needs-you) version=(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3}) previous=((0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})|-) path=(plain|migration|rollback|none) downtime=([0-9]{1,5}|-) commands=(registered|failed|skipped) backup=(daily/tarubot-[0-9]{8}T[0-9]{6}Z\.dump\.age|-) restore_point=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z|-) reason=([a-z0-9-]{1,40}|-)$'
readonly STEP_LINE='^step [a-z-]{1,20}$'
readonly WARNING_LINE='^warning [a-z0-9-]{1,40}$'
# Refusals that come before the approval is confirmed, and a worker that never started. Nothing
# happened in such a run, so the same request, or a new one for that run id, starts it over: a
# request sent before the approval, or a GitHub API failure, never blocks the approved run.
readonly RETRYABLE=' reason=(missing-tool|approval-unverified|not-approved|worker-not-started)$'
# The frozen log messages (see the header).
readonly LEASE_LINE='"msg":"Database writer lease acquired"'
readonly MODULES_LINE='"msg":"Modules loaded"'
# ops/backup.sh's last line names the object it uploaded to daily/.
readonly BACKUP_DONE='backup ok: tarubot-([0-9]{8}T[0-9]{6}Z) '

# ---------------------------------------------------------------------------------------------
# Output. The SSH client's stdout carries only what say prints; tool output goes to the logs.
# ---------------------------------------------------------------------------------------------

# The one writer of the client's stdout: the usage line (`say usage`), or a public line
# (`say line TEXT`) that matches one of the fixed forms. Anything else is dropped.
say() {
  if [[ $1 == usage ]]; then
    printf '%s\n' 'usage: deploy <version> <commit> <digest> <run> | rollback <version> <commit> <digest> <run> <from>'
    return 0
  fi
  if [[ $2 =~ $STEP_LINE || $2 =~ $WARNING_LINE || $2 =~ $RESULT_FORM ]]; then
    printf '%s\n' "$2"
  fi
}

# Print $2 when it is a valid token of kind $1, "-" when it is "-" and $3 is "dash", else "?".
token() {
  local pattern
  case $1 in
    version) pattern=$VERSION ;;
    int) pattern='^(0|[1-9][0-9]{0,4})$' ;;
    reason) pattern='^[a-z0-9-]{1,40}$' ;;
    step) pattern='^[a-z-]{1,20}$' ;;
    backup) pattern='^daily/tarubot-[0-9]{8}T[0-9]{6}Z\.dump\.age$' ;;
    stamp) pattern='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' ;;
    *) pattern='^$' ;;
  esac
  if [[ -n $2 && $2 =~ $pattern ]] || [[ ${3-} == dash && $2 == - ]]; then
    printf '%s' "$2"
  else
    printf '?'
  fi
}

# A timestamped line in the current log: entry.log for the entry, worker.log for the worker.
log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2
}

# Append one public line to the run's public.log (the worker's only public output).
public() {
  printf '%s\n' "$1" >>"$RUN/public.log"
}

# Record the step the worker has reached, in the step file and the public log.
step() {
  printf '%s\n' "$1" >"$RUN/step"
  public "step $1"
  log "step $1"
}

# Write the result line (public) and then the result file, which ends the run. $1 is the outcome
# and $2 the reason token or "-"; the other fields come from the run's globals.
write_result() {
  local line
  line="result outcome=$1 version=$(token version "$V") previous=$(token version "$LIVE_V" dash)"
  line+=" path=$PATH_KIND downtime=$(token int "$DOWNTIME" dash) commands=$COMMANDS"
  line+=" backup=$(token backup "$BACKUP" dash) restore_point=$(token stamp "$RESTORE_POINT" dash)"
  line+=" reason=$(token reason "${2:--}" dash)"
  public "$line"
  printf '%s\n' "$1" >"$RUN/result.tmp"
  mv -f "$RUN/result.tmp" "$RUN/result"
  log "result: $1 (${2:--})"
}

# End the worker with a result. Its exit releases the run lock.
finish() {
  trap - ERR
  write_result "$1" "${2:--}"
  exit 0
}

# Nothing changed on the host. A clone already moved to the target goes back to the live commit.
refuse() {
  if ((STAGED)); then
    git reset --quiet --keep "$LIVE_C" || log "could not put the clone back at $LIVE_C"
    STAGED=0
  fi
  finish refused "$1"
}

# The host is in a state the owner has to look at; docs/HOSTING.md says what to do per reason.
needs_you() {
  finish needs-you "$1"
}

# A command failed where the script didn't expect it. In a subshell (a command substitution),
# only leave it; the caller sees the failure.
unexpected() {
  [[ $BASHPID == "${WORKER_PID-}" ]] || exit "$1"
  trap - ERR
  log "unexpected failure (status $1, line $2)"
  if ((CHANGED)); then needs_you unexpected-error; fi
  refuse unexpected-error
}

# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------

# Parse one request (the whole SSH_ORIGINAL_COMMAND) into ACTION V C D R F; false if it isn't
# exactly one of the two forms. Runs under LC_ALL=C, so lengths are bytes and [0-9] is ASCII.
parse_request() {
  local req=$1
  ((${#req} <= MAX_REQUEST)) || return 1
  if [[ $req =~ $DEPLOY_FORM ]]; then
    ACTION=deploy V=${BASH_REMATCH[1]} C=${BASH_REMATCH[5]} D=${BASH_REMATCH[6]}
    R=${BASH_REMATCH[7]} F=-
  elif [[ $req =~ $ROLLBACK_FORM ]]; then
    ACTION=rollback V=${BASH_REMATCH[1]} C=${BASH_REMATCH[5]} D=${BASH_REMATCH[6]}
    R=${BASH_REMATCH[7]} F=${BASH_REMATCH[8]}
  else
    return 1
  fi
}

# True when version $1 is older than version $2 (both already match VERSION).
version_lt() {
  local -a a b
  local i
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    ((a[i] == b[i])) && continue
    ((a[i] < b[i]))
    return
  done
  return 1
}

# What `git diff --name-status --no-renames LIVE C -- migrations/` (in $1) means: none, added
# (only new files, the migration path) or changed (an applied migration was edited or removed).
migration_kind() {
  local line
  if [[ -z $1 ]]; then
    printf none
    return 0
  fi
  while IFS= read -r line; do
    if [[ $line != A$'\t'migrations/* ]]; then
      printf changed
      return 0
    fi
  done <<<"$1"
  printf added
}

# The container logs are the writer-lease evidence, so they must be written at info or below.
# $1 is the .env value of LOG_LEVEL (empty when unset; Compose then uses info).
log_level_ok() {
  local value=$1
  value=${value#\"} value=${value%\"} value=${value#\'} value=${value%\'}
  case $value in "" | trace | debug | info) return 0 ;; *) return 1 ;; esac
}

# The restore point from migrate.js's output ($1): the lease time, normalized to UTC with
# microseconds; "-" when nothing was applied or the time can't be read.
restore_point() {
  local line raw stamp
  line=$(grep -m 1 '^Migration writer lease acquired at ' <<<"$1") || line=
  raw=${line#Migration writer lease acquired at }
  raw=${raw%%;*}
  if [[ -n $line ]] && stamp=$(date -u -d "$raw" +%Y-%m-%dT%H:%M:%S.%6NZ 2>/dev/null); then
    printf '%s' "$stamp"
  else
    printf -- -
  fi
}

# Day of week (1 is Monday) and hour, in UTC. Tests replace it.
now_utc() {
  date -u '+%u %H'
}

# The managed cluster's weekly maintenance: Tuesdays 19:00-23:00 UTC (docs/HOSTING.md).
in_maintenance_window() {
  local day hour
  read -r day hour < <(now_utc)
  [[ $day == 2 ]] && ((10#$hour >= 19 && 10#$hour < 23))
}

# One value from `docker inspect` JSON ($1) by jq filter $2; empty when null or unreadable.
field() {
  jq -r "($2) // empty" <<<"$1" 2>/dev/null || true
}

# The GitHub REST API, anonymously (the repository is public).
api() {
  curl -fsS --max-time 20 --retry 2 -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' "$API/repos/$REPO/$1"
}

# docker compose on the production file in the clone, bounded by timeout(1): $1 is the limit in
# seconds. A TARUBOT_IMAGE_TAG set for the call overrides the .env pin (Compose prefers the
# environment), so nothing is pinned until the target has proven itself.
compose() {
  local limit=$1
  shift
  timeout "$limit" docker compose -f "$ROOT/docker-compose.production.yml" \
    --project-directory "$ROOT" "$@"
}

# Pin .env to release $1 (temporary file and rename, mode 600), as the manual procedure does.
# Multi-line quoted values such as the CA pass through unchanged.
pin_env() {
  local tmp
  tmp=$(mktemp "$ROOT/.env.XXXXXX") || return 1
  if ! awk -v v="$1" '/^TARUBOT_IMAGE_TAG=/ { print "TARUBOT_IMAGE_TAG=" v; next } { print }' \
    "$ROOT/.env" >"$tmp" || ! chmod 600 "$tmp" || ! mv -f "$tmp" "$ROOT/.env"; then
    rm -f "$tmp"
    return 1
  fi
  [[ $(grep -c '^TARUBOT_IMAGE_TAG=' "$ROOT/.env") == 1 ]] &&
    grep -qx "TARUBOT_IMAGE_TAG=$1" "$ROOT/.env"
}

# ---------------------------------------------------------------------------------------------
# Entry: parse, then start or attach to the run's worker and follow its public log.
# ---------------------------------------------------------------------------------------------

entry() {
  trap 'exit 1' ERR
  local req=${SSH_ORIGINAL_COMMAND-}
  if ! parse_request "$req"; then
    say usage
    log "refused request: $(printf '%s' "$req" | tr -c 'A-Za-z0-9 ._:-' '?' | cut -c1-200)"
    exit 64
  fi
  prune
  RUN=$STATE/runs/$R
  if [[ ! -d $RUN ]] && too_many_workers; then refuse_unstarted; fi
  mkdir -p "$RUN"
  exec 8>>"$RUN/lock"
  if flock -n 8; then
    if retryable "$RUN"; then
      if too_many_workers; then refuse_unstarted; fi
      start_over
    fi
    if [[ -f $RUN/request && $(<"$RUN/request") != "$req" ]]; then conflict; fi
    if [[ -f $RUN/result ]]; then
      exec 8>&-
      replay
    fi
    if [[ -f $RUN/step ]]; then
      worker_died
      exec 8>&-
      replay
    fi
    printf '%s\n' "$req" >"$RUN/request"
    : >>"$RUN/public.log"
    log "run $R: $ACTION $V started"
    launch
  elif [[ -f $RUN/request && $(<"$RUN/request") != "$req" ]]; then
    conflict
  fi
  exec 8>&-
  follow
}

# The run id already carries another request, and that run counts: it is running, or it got past
# the approval check. Refused like a malformed request.
conflict() {
  say usage
  log "run $R already carries a different request"
  exit 64
}

# True when MAX_WORKERS workers already hold their run locks (a run with no result whose lock
# is taken).
too_many_workers() {
  local dir count=0
  for dir in "$STATE"/runs/*/; do
    [[ -f ${dir}lock && ! -f ${dir}result ]] || continue
    if ! flock -n "${dir}lock" true; then count=$((count + 1)); fi
  done
  ((count >= MAX_WORKERS))
}

# Refuse a run while too many workers run, before it gets a run directory or a worker. Nothing
# changed, and the workflow reports the reason.
refuse_unstarted() {
  say line "result outcome=refused version=$V previous=- path=none downtime=- commands=skipped backup=- restore_point=- reason=too-many-runs"
  log "run $R: refused, $MAX_WORKERS workers already run"
  exit 1
}

# True when run directory $1 ended refused before its approval was confirmed (RETRYABLE).
retryable() {
  local line
  [[ -f $1/result && -f $1/public.log && $(<"$1/result") == refused ]] || return 1
  line=$(grep -E '^result ' "$1/public.log" | tail -n 1) || return 1
  [[ $line =~ $RESULT_FORM && $line =~ $RETRYABLE ]]
}

# Called while holding the run lock: clear a retryable run so it starts from the beginning, for
# the same request or a new one. worker.log keeps the earlier attempt.
start_over() {
  log "run $R: starting over after a refusal before the approval was confirmed"
  rm -f -- "$RUN/result" "$RUN/step" "$RUN/request"
  : >"$RUN/public.log"
}

# Start the worker in its own session, so it outlives this SSH session, with a clean environment:
# nothing sshd accepted reaches Compose's interpolation. It inherits fd 8 and so the run lock.
launch() {
  env -i HOME="$HOME" PATH="$SAFE_PATH" LC_ALL=C \
    setsid -f "$SELF" __worker "$ACTION" "$V" "$C" "$D" "$R" "$F" \
    </dev/null >>"$RUN/worker.log" 2>&1
}

# Print public.log's complete lines after byte OFFSET, and move OFFSET past them.
emit_new() {
  local line size
  [[ -f $RUN/public.log ]] || return 0
  # A run that started over has a new, shorter log: read it from its beginning.
  size=$(stat -c %s "$RUN/public.log") || return 0
  if ((size < OFFSET)); then OFFSET=0; fi
  while IFS= read -r line; do
    say line "$line"
    OFFSET=$((OFFSET + ${#line} + 1))
  done < <(tail -c "+$((OFFSET + 1))" "$RUN/public.log")
}

# Exit by the run's outcome: 0 when production runs the requested release (or a newer one).
exit_by_result() {
  case $(<"$RUN/result") in
    deployed | already-live | superseded) exit 0 ;;
    *) exit 1 ;;
  esac
}

# The run is over: print its whole public log and exit by its outcome.
replay() {
  OFFSET=0
  emit_new
  exit_by_result
}

# Follow a running worker's public log every 2 s until its result. A free run lock with no result
# means the worker is gone.
follow() {
  OFFSET=0
  while :; do
    emit_new
    if [[ -f $RUN/result ]]; then
      emit_new
      exit_by_result
    fi
    exec 7>>"$RUN/lock"
    if flock -n 7; then
      [[ -f $RUN/result ]] || worker_died
      exec 7>&-
      emit_new
      exit_by_result
    fi
    exec 7>&-
    sleep 2
  done
}

# Called while holding the run lock, with no result: a worker that wrote a step died (a host
# reboot, the OOM killer, a kill) and the owner finishes by hand (docs/HOSTING.md, "When the
# worker dies"). Without a step file it never started, so nothing changed.
worker_died() {
  local last
  LIVE_V=- PATH_KIND=none DOWNTIME=- COMMANDS=skipped BACKUP=- RESTORE_POINT=-
  if [[ -f $RUN/step ]]; then
    last=$(<"$RUN/step")
    public "step $(token step "$last")"
    write_result needs-you worker-died
  else
    write_result refused worker-not-started
  fi
}

# Remove finished runs after 90 days, and retryable ones (nothing happened in them) after 10
# minutes; entry.log keeps a line for each run's start.
prune() {
  local dir
  while IFS= read -r -d '' dir; do
    [[ -f $dir/result ]] || continue
    if retryable "$dir" || [[ -n $(find "$dir" -maxdepth 0 -mtime +90) ]]; then rm -rf -- "$dir"; fi
  done < <(find "$STATE/runs" -mindepth 1 -maxdepth 1 -type d -mmin +10 -print0)
}

# Keep entry.log to its last megabyte.
trim_log() {
  local file=$STATE/entry.log
  if [[ -f $file ]] && (($(stat -c %s "$file") > 1048576)); then
    tail -c 1048576 "$file" >"$file.tmp" && mv -f "$file.tmp" "$file"
  fi
}

# ---------------------------------------------------------------------------------------------
# Worker: preflight (nothing changes), classification, then one path.
# ---------------------------------------------------------------------------------------------

worker() {
  local req="$1 $2 $3 $4 $5"
  if [[ $1 == rollback ]]; then req+=" $6"; elif [[ $6 != - ]]; then exit 64; fi
  parse_request "$req" || exit 64
  [[ $ACTION == "$1" ]] || exit 64
  RUN=$STATE/runs/$R
  [[ -d $RUN ]] || exit 64
  exec 2>>"$RUN/worker.log"
  # fd 8 is the run lock, inherited from the entry: the same open file, so this is a no-op.
  if ! { : >&8; } 2>/dev/null || ! flock -n 8; then
    log "the run lock is not held"
    exit 70
  fi
  WORKER_PID=$BASHPID
  LIVE_V=- LIVE_C='' LIVE_IMAGE='' CID='' PROJECT='' PIN='' TARGET_ID=''
  PATH_KIND=none DOWNTIME=- COMMANDS=skipped BACKUP=- RESTORE_POINT=-
  STAGED=0 CHANGED=0 CLOCK=$SECONDS
  trap 'unexpected "$?" "$LINENO"' ERR
  cd "$ROOT"
  step preflight
  preflight
  classify
  # The run is checked again just before the first change: a cancel, or a Deploy job that ended,
  # during the waits, the fetch and the pull stops the worker while nothing has changed.
  case $PATH_KIND in
    none)
      check_run_active
      already_live
      ;;
    plain | rollback)
      stage
      check_run_active
      restart_path
      ;;
    migration)
      stage
      check_run_active
      migration_path
      ;;
  esac
  needs_you unexpected-error
}

preflight() {
  check_approval
  exec 9>>"$STATE/lock"
  flock -w 300 9 || refuse busy
  check_clone
  check_env
  check_host
  read_live
  wait_for_backup
  check_target
}

# The run must be this repository's deploy.yml, in progress on main, first attempt, titled with
# exactly this target, and its Deploy job must be running (after that job fails, the run stays in
# progress while notify runs). Unreadable answers fail closed.
check_run_active() {
  local run jobs title
  run=$(api "actions/runs/$R") || refuse approval-unverified
  jobs=$(api "actions/runs/$R/jobs") || refuse approval-unverified
  jq -e 'type == "object"' <<<"$run" >/dev/null 2>&1 || refuse approval-unverified
  jq -e '.jobs | type == "array"' <<<"$jobs" >/dev/null 2>&1 || refuse approval-unverified
  if [[ $ACTION == rollback ]]; then title="Deploy $V rollback from $F"; else title="Deploy $V"; fi
  jq -e --arg wf "$WORKFLOW" --arg repo "$REPO" --arg action "$ACTION" --arg commit "$C" \
    --arg title "$title" '
      .path == $wf and .head_branch == "main" and .head_repository.full_name == $repo
      and .status == "in_progress" and .run_attempt == 1
      and ((.event == "workflow_run" and $action == "deploy" and .display_title == ("Deploy " + $commit))
        or (.event == "workflow_dispatch" and .display_title == $title))' \
    <<<"$run" >/dev/null 2>&1 || refuse not-approved
  jq -e 'any(.jobs[]; .name == "Deploy" and .status == "in_progress")' \
    <<<"$jobs" >/dev/null 2>&1 || refuse not-approved
}

# The run is active (above) and the owner approved it for production, matched by login and
# numeric id.
check_approval() {
  local approvals
  if ! command -v jq >/dev/null || ! command -v curl >/dev/null; then refuse missing-tool; fi
  check_run_active
  approvals=$(api "actions/runs/$R/approvals") || refuse approval-unverified
  jq -e 'type == "array"' <<<"$approvals" >/dev/null 2>&1 || refuse approval-unverified
  jq -e --arg who "$REVIEWER" --argjson id "$REVIEWER_ID" '
      any(.[]; .state == "approved" and .user.login == $who and .user.id == $id
        and any(.environments[]?; .name == "production"))' \
    <<<"$approvals" >/dev/null 2>&1 || refuse not-approved
  log "run $R: approved by $REVIEWER for production"
}

# The clone must be on main with no tracked change, as the manual procedure leaves it.
check_clone() {
  local branch dirty
  branch=$(git symbolic-ref --quiet --short HEAD) || refuse clone-not-clean
  dirty=$(git status --porcelain --untracked-files=no) || refuse clone-not-clean
  [[ $branch == main && -z $dirty ]] || refuse clone-not-clean
}

# .env: a private regular file with exactly one plain pin, no image override, and a log level
# that keeps the lease evidence.
check_env() {
  local pins level
  [[ -f .env && ! -L .env ]] || refuse env-file
  [[ $(stat -c %a .env) == 600 ]] || refuse env-file
  pins=$(grep -c '^TARUBOT_IMAGE_TAG=' .env) || pins=0
  PIN=$(sed -n 's/^TARUBOT_IMAGE_TAG=//p' .env)
  [[ $pins == 1 && $PIN =~ $VERSION ]] || refuse env-file
  if grep -q '^TARUBOT_IMAGE=.' .env; then refuse env-file; fi
  level=$(sed -n 's/^LOG_LEVEL=//p' .env | tail -n 1)
  log_level_ok "$level" || refuse log-level
}

# Docker answers (every bare docker call is bounded by timeout(1), as compose() is, so a hung
# daemon takes the caller's failure branch) and / has 2 GB free.
check_host() {
  local avail
  timeout 60 docker info >/dev/null 2>&1 || refuse host
  avail=$(df --output=avail -B1 / | tail -n 1 | tr -d ' ') || refuse host
  if ! [[ $avail =~ ^[0-9]+$ ]] || ((avail < 2147483648)); then refuse host; fi
}

# The live release: the one tarubot container, running (or restarting), its labels, and the pin.
read_live() {
  local ids json status
  ids=$(compose 60 ps -a -q tarubot) || refuse host
  [[ $ids =~ ^[0-9a-f]{12,64}$ ]] || refuse bot-not-running
  CID=$ids
  json=$(timeout 60 docker inspect "$CID") || refuse bot-not-running
  status=$(field "$json" '.[0].State.Status')
  [[ $status == running || $status == restarting ]] || refuse bot-not-running
  LIVE_V=$(field "$json" '.[0].Config.Labels["org.opencontainers.image.version"]')
  LIVE_C=$(field "$json" '.[0].Config.Labels["org.opencontainers.image.revision"]')
  LIVE_IMAGE=$(field "$json" '.[0].Image')
  PROJECT=$(field "$json" '.[0].Config.Labels["com.docker.compose.project"]')
  if ! [[ $LIVE_V =~ $VERSION && $LIVE_C =~ ^[0-9a-f]{40}$ &&
    $LIVE_IMAGE =~ ^sha256:[0-9a-f]{64}$ && $PROJECT =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    LIVE_V=-
    refuse live-unknown
  fi
  [[ $PIN == "$LIVE_V" ]] || refuse manual-change-in-progress
}

# Wait up to 300 s for a running `backup` container (the nightly dump, about 6 s, or one run by
# hand). The waits here and on the host lock stay short so that a slow run still reports to the
# workflow before its reconnect deadline.
wait_for_backup() {
  local i running
  for ((i = 0; i <= 30; i++)); do
    running=$(timeout 60 docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
      --filter label=com.docker.compose.service=backup) || refuse host
    [[ -z $running ]] && return 0
    ((i < 30)) && sleep 10
  done
  refuse busy
}

# The target commit is on main and carries the requested version, at or above the floor.
check_target() {
  local version
  timeout 120 git fetch --quiet origin main || refuse fetch-failed
  git merge-base --is-ancestor "$C" origin/main || refuse not-on-main
  version=$(git show "$C:package.json" | jq -r .version) || refuse version-mismatch
  [[ $version == "$V" ]] || refuse version-mismatch
  if version_lt "$V" "$FLOOR"; then refuse below-floor; fi
}

# Git alone decides the path: a healthy live container proves the schema matches LIVE_C's.
classify() {
  local changes
  if [[ $ACTION == deploy ]]; then
    if version_lt "$V" "$LIVE_V"; then finish superseded; fi
    if [[ $V == "$LIVE_V" ]]; then
      [[ $C == "$LIVE_C" ]] || refuse commit-mismatch
      return 0
    fi
    git merge-base --is-ancestor "$LIVE_C" "$C" || refuse not-descendant
    changes=$(git diff --name-status --no-renames "$LIVE_C" "$C" -- migrations/) ||
      refuse not-descendant
    case $(migration_kind "$changes") in
      none) PATH_KIND=plain ;;
      added) PATH_KIND=migration ;;
      *) refuse applied-migration-changed ;;
    esac
  else
    [[ $LIVE_V == "$F" ]] || refuse live-changed
    version_lt "$V" "$LIVE_V" || refuse rollback-not-older
    git diff --quiet "$C" "$LIVE_C" -- migrations/ || refuse rollback-across-migration
    PATH_KIND=rollback
  fi
}

# Pull the target without pinning it, prove it is the approved digest, and move the clone to it.
stage() {
  local json
  step pull
  TARUBOT_IMAGE_TAG=$V compose 600 pull --quiet tarubot || refuse pull-failed
  json=$(timeout 60 docker image inspect "$IMAGE:$V") || refuse digest-mismatch
  jq -e --arg digest "$IMAGE@$D" '.[0].RepoDigests | any(.[]; . == $digest)' \
    <<<"$json" >/dev/null 2>&1 || refuse digest-mismatch
  [[ $(field "$json" '.[0].Config.Labels["org.opencontainers.image.version"]') == "$V" &&
    $(field "$json" '.[0].Config.Labels["org.opencontainers.image.revision"]') == "$C" ]] ||
    refuse label-mismatch
  TARGET_ID=$(field "$json" '.[0].Id')
  [[ $TARGET_ID =~ ^sha256:[0-9a-f]{64}$ ]] || refuse label-mismatch
  git reset --quiet --keep "$C" || refuse clone-reset
  STAGED=1
  # A new required ${VAR:?} that the host's .env lacks stops here, before anything stops.
  TARUBOT_IMAGE_TAG=$V compose 60 config --quiet || refuse compose-config
}

# The running release is the target: check its health and register its commands.
already_live() {
  local json
  json=$(timeout 60 docker inspect "$CID") || needs_you live-unhealthy
  [[ $(field "$json" '.[0].State.Health.Status') == healthy ]] || needs_you live-unhealthy
  commands_then already-live
}

# No migration: Compose replaces the container (the old bot stops first and frees the lease).
# Every `up` names the tarubot service: a profile-gated service added later (such as the v3 web
# proxy, issue #43) never starts with, or fails, a bot deploy. Today it is equivalent to a bare `up`.
restart_path() {
  step up
  CHANGED=1
  CLOCK=$SECONDS
  if TARUBOT_IMAGE_TAG=$V compose 300 up -d --wait --wait-timeout 180 --remove-orphans tarubot; then
    DOWNTIME=$((SECONDS - CLOCK))
    verify_started
    commands_then deployed
  fi
  DOWNTIME=$((SECONDS - CLOCK))
  recover_restart
}

# Migration files added: stop, back up, migrate in the new image, start.
migration_path() {
  local out ok=0
  if in_maintenance_window; then
    public "warning db-maintenance-window"
    log "the migration runs during the cluster's Tuesday maintenance window"
  fi
  step stop
  CHANGED=1
  CLOCK=$SECONDS
  compose 90 stop tarubot || restore_previous stop-failed previous-failed
  step backup
  if out=$(timeout 900 "$ROOT/ops/backup.sh"); then ok=1; fi
  log "ops/backup.sh: ${out//$'\n'/ | }"
  if ((ok)) && [[ $out =~ $BACKUP_DONE ]]; then
    BACKUP=daily/tarubot-${BASH_REMATCH[1]}.dump.age
  else
    restore_previous backup-failed previous-failed
  fi
  step migrate
  ok=0
  if out=$(TARUBOT_IMAGE_TAG=$V compose 600 run --rm --no-deps -T tarubot bun dist/scripts/migrate.js); then
    ok=1
  fi
  log "migrate.js: ${out//$'\n'/ | }"
  if ((ok)) && [[ $'\n'$out$'\n' == *$'\nSchema ready.\n'* ]]; then
    RESTORE_POINT=$(restore_point "$out")
    # The old image can't run on the new schema, so the pin moves at once.
    pin_env "$V" || needs_you pin-failed
    step migrated
  else
    stop_one_offs
    restore_previous migration-failed migration-may-have-committed
  fi
  step up
  if compose 300 up -d --wait --wait-timeout 180 --remove-orphans tarubot; then
    DOWNTIME=$((SECONDS - CLOCK))
    verify_started
    commands_then deployed
  fi
  DOWNTIME=$((SECONDS - CLOCK))
  needs_you new-release-failed
}

# A migrate.js left running (the timeout) holds its transaction open; stopping it rolls it back.
stop_one_offs() {
  local ids
  local -a list
  ids=$(timeout 60 docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter label=com.docker.compose.oneoff=True \
    --filter label=com.docker.compose.service=tarubot) || ids=
  if [[ -n $ids ]]; then
    mapfile -t list <<<"$ids"
    timeout 60 docker stop "${list[@]}" || log "could not stop the migrate.js container"
  fi
}

# `up --wait` passed, so the target answered readiness and held the writer lease. It must be the
# approved image and still be healthy a minute later; either way .env pins it now.
verify_started() {
  local json restarts
  CID=$(compose 60 ps -a -q tarubot) || CID=
  json=$(timeout 60 docker inspect "$CID" 2>/dev/null) || json='[]'
  if [[ $(field "$json" '.[0].Image') != "$TARGET_ID" ||
    $(field "$json" '.[0].Config.Labels["org.opencontainers.image.version"]') != "$V" ||
    $(field "$json" '.[0].Config.Labels["org.opencontainers.image.revision"]') != "$C" ]]; then
    pin_env "$V" || log "could not pin .env to $V"
    needs_you image-mismatch
  fi
  restarts=$(field "$json" '.[0].RestartCount')
  sleep 60
  json=$(timeout 60 docker inspect "$CID" 2>/dev/null) || json='[]'
  if [[ $(field "$json" '.[0].RestartCount') != "$restarts" ||
    $(field "$json" '.[0].State.Status') != running ||
    $(field "$json" '.[0].State.Health.Status') != healthy ]]; then
    pin_env "$V" || log "could not pin .env to $V"
    needs_you unstable
  fi
  pin_env "$V" || needs_you pin-failed
}

# Register the release's commands globally and read them back (the token stays on the host).
run_commands() {
  step commands
  if compose 120 exec -T tarubot bun dist/scripts/register.js --global &&
    compose 180 exec -T tarubot bun dist/scripts/commands.js list; then
    COMMANDS=registered
    return 0
  fi
  COMMANDS=failed
  return 1
}

# Finish with outcome $1 once the commands are registered, or ask for a retry.
commands_then() {
  if run_commands; then finish "$1"; fi
  needs_you commands-failed
}

# What Compose shows for the tarubot service after a failed start. TC_STATE is "none" (ps lists
# no container), "previous" (exactly one, on the live release's image), "target" (exactly one, on
# the target's image) or "unknown": ps or inspect failed, several containers (Compose stopped in
# the middle of a recreate), or another image. TC_ID names the container for previous and target.
target_container() {
  local ids json image
  TC_STATE=unknown TC_ID=''
  ids=$(compose 60 ps -a -q tarubot) || return 0
  if [[ -z $ids ]]; then
    TC_STATE=none
    return 0
  fi
  [[ $ids =~ ^[0-9a-f]{12,64}$ ]] || return 0
  json=$(timeout 60 docker inspect "$ids" 2>/dev/null) || return 0
  image=$(field "$json" '.[0].Image')
  if [[ -n $image && $image == "$TARGET_ID" ]]; then
    TC_STATE=target TC_ID=$ids
  elif [[ -n $image && $image == "$LIVE_IMAGE" ]]; then
    TC_STATE=previous TC_ID=$ids
  fi
}

# The writer-lease evidence for the target's container $1: EV_LEASE counts "Database writer lease
# acquired" lines, and EV_COMPLETE says the logs were readable and reached "Modules loaded", which
# main.ts logs before it can ask for the lease. No container id is incomplete evidence.
evidence() {
  local logs
  EV_LEASE=0 EV_COMPLETE=0
  [[ -n $1 ]] || return 0
  logs=$(timeout 60 docker logs "$1" 2>&1) || return 0
  EV_COMPLETE=1
  EV_LEASE=$(grep -c -F "$LEASE_LINE" <<<"$logs") || EV_LEASE=0
  grep -q -F "$MODULES_LINE" <<<"$logs" || EV_COMPLETE=0
  log "evidence for $1: $EV_LEASE lease lines, complete=$EV_COMPLETE"
}

# The restart or rollback did not come up. The previous release returns only when the target
# never got a container, or its container provably never held the writer lease. Otherwise the
# target stays for the owner, with .env pinned to it when Compose showed its container; when
# Compose showed no single container of either release, nothing is guessed and nothing is pinned.
recover_restart() {
  target_container
  case $TC_STATE in
    none | previous) restore_previous did-not-start previous-failed ;;
    target) ;;
    *)
      log "Compose showed no single container of either release; nothing restored or pinned"
      needs_you lease-evidence-incomplete
      ;;
  esac
  evidence "$TC_ID"
  if ((!EV_COMPLETE)); then
    pin_env "$V" || log "could not pin .env to $V"
    needs_you lease-evidence-incomplete
  fi
  if ((EV_LEASE > 0)); then
    pin_env "$V" || log "could not pin .env to $V"
    needs_you new-release-took-lease
  fi
  if ! compose 90 stop tarubot; then
    pin_env "$V" || log "could not pin .env to $V"
    needs_you lease-evidence-incomplete
  fi
  # Count again: the lease may have come between the first count and the stop.
  evidence "$TC_ID"
  if ((!EV_COMPLETE || EV_LEASE > 0)); then
    TARUBOT_IMAGE_TAG=$V compose 300 up -d tarubot || log "could not start $V again"
    pin_env "$V" || log "could not pin .env to $V"
    if ((EV_LEASE > 0)); then needs_you new-release-took-lease; fi
    needs_you lease-evidence-incomplete
  fi
  restore_previous did-not-start previous-failed
}

# Put the previous release back: the clone at its commit, the unchanged .env, `up --wait`, and
# the previous image healthy. Its own Compose file decides what runs (--remove-orphans drops a
# service only the target's file had). $1 is the reason when it is back, $2 when it isn't.
restore_previous() {
  local json
  git reset --quiet --keep "$LIVE_C" || log "could not put the clone back at $LIVE_C"
  STAGED=0
  if compose 300 up -d --wait --wait-timeout 180 --remove-orphans tarubot; then
    DOWNTIME=$((SECONDS - CLOCK))
    CID=$(compose 60 ps -a -q tarubot) || CID=
    json=$(timeout 60 docker inspect "$CID" 2>/dev/null) || json='[]'
    if [[ $(field "$json" '.[0].Image') == "$LIVE_IMAGE" &&
      $(field "$json" '.[0].Config.Labels["org.opencontainers.image.version"]') == "$LIVE_V" &&
      $(field "$json" '.[0].State.Health.Status') == healthy ]]; then
      finish recovered "$1"
    fi
  fi
  DOWNTIME=$((SECONDS - CLOCK))
  needs_you "$2"
}

main() {
  umask 077
  export LC_ALL=C PATH=$SAFE_PATH
  SELF=$(readlink -f "$0")
  ROOT=$(cd "$(dirname "$SELF")/.." && pwd)
  STATE=$HOME/.local/state/tarubot-deploy
  install -d -m 700 "$STATE" "$STATE/runs"
  trim_log
  exec 2>>"$STATE/entry.log"
  if (($# == 0)); then entry; fi
  if [[ $1 == __worker && $# -eq 7 ]]; then
    shift
    worker "$@"
  fi
  exit 64
}

# Only a direct run starts main; tests source the file for its functions. Bash reads this whole
# compound command before running it, so the clone moving under the script can't change what runs.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
  exit
fi
