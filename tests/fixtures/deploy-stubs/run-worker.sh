#!/usr/bin/env bash
# Runs one ops/deploy.sh worker in this shell for tests/unit/deploy-script.test.ts, the way the
# entry would have launched it: the run directory, the request and the run lock on fd 8. Tools
# come from the test's PATH (the stubs first); the clock and sleep are replaced so windows and
# waits cost nothing. Env: DEPLOY_SCRIPT, DEPLOY_ROOT, DEPLOY_STATE, REQUEST, SIM_NOW ("<day> <hour>").
set -Eeuo pipefail
# shellcheck source=/dev/null
source "$DEPLOY_SCRIPT"
ROOT=$DEPLOY_ROOT STATE=$DEPLOY_STATE SELF=$DEPLOY_SCRIPT
now_utc() { printf '%s\n' "${SIM_NOW:-4 12}"; }
sleep() { :; }
install -d -m 700 "$STATE" "$STATE/runs"
parse_request "$REQUEST"
RUN=$STATE/runs/$R
mkdir -p "$RUN"
printf '%s\n' "$REQUEST" >"$RUN/request"
exec 8>>"$RUN/lock"
flock -n 8
worker "$ACTION" "$V" "$C" "$D" "$R" "$F"
