#!/usr/bin/env bash
# Daily encrypted off-site backup of the production database (2.24.0; the owner's 2026-09-25
# decision to make the host robust and disposable). It runs on the production host from the
# tarubot user's crontab; docs/HOSTING.md ("Backups and recovery") has the setup and the restore.
#
#   1. pg_dump (custom format) runs in the pinned PostgreSQL 18 image through the production Compose
#      file's `backup` service, with the bot's DATABASE_URL and CA from the host's .env.
#   2. The dump streams straight into age, encrypted for ops/age-recipients.txt. The plaintext never
#      touches the disk, and the host holds no key that could decrypt what it wrote.
#   3. curl uploads it to the Linode Object Storage bucket, signing with SigV4: daily/ every day,
#      and monthly/ on the 1st. The bucket's lifecycle rules expire old copies.
#   4. The host's .env is encrypted and uploaded as well (env/), keeping the off-host settings copy
#      current without the operator machine.
#   5. healthchecks.io hears /start, then success with the sizes, or /fail naming the failed step.
#
# Settings, read from the host's .env (single-line values): BACKUP_STORAGE_ENDPOINT (the bucket's
# URL, such as tarubot-backups.us-iad-18.linodeobjects.com; https:// is added when missing),
# BACKUP_STORAGE_ACCESS_KEY, BACKUP_STORAGE_SECRET_KEY, BACKUP_STORAGE_REGION (the SigV4 region,
# us-iad-2 by default; Linode accepts any) and HEALTHCHECKS_BACKUP_URL.
# Secrets reach curl through --config on stdin, never through its arguments, which `ps` shows.
set -Eeuo pipefail
umask 077
cd "$(dirname "$(readlink -f "$0")")/.."

readonly ENV_FILE=.env
readonly RECIPIENTS=ops/age-recipients.txt
compose() { docker compose -f docker-compose.production.yml "$@"; }

# One single-line setting from .env, without surrounding quotes; empty when unset.
setting() {
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

ENDPOINT=$(setting BACKUP_STORAGE_ENDPOINT)
case "$ENDPOINT" in "" | http://* | https://*) ;; *) ENDPOINT="https://$ENDPOINT" ;; esac
ENDPOINT=${ENDPOINT%/}
REGION=$(setting BACKUP_STORAGE_REGION)
REGION=${REGION:-us-iad-2}
ACCESS_KEY=$(setting BACKUP_STORAGE_ACCESS_KEY)
SECRET_KEY=$(setting BACKUP_STORAGE_SECRET_KEY)
PING_URL=$(setting HEALTHCHECKS_BACKUP_URL)

# Tell healthchecks.io how the run went: $1 is "", /start or /fail, $2 a short note. A ping that
# can't be delivered never fails the backup itself.
notify() {
  [ -n "$PING_URL" ] || return 0
  printf 'url = "%s%s"\n' "$PING_URL" "$1" |
    curl --config - --silent --show-error --fail --max-time 10 --retry 3 \
      --data-raw "$2" --output /dev/null || true
}

step=settings
trap 'notify /fail "backup failed at: $step"; echo "$(date -u +%FT%TZ) backup failed at: $step" >&2' ERR
for name in ENDPOINT ACCESS_KEY SECRET_KEY; do
  if [ -z "${!name}" ]; then
    echo "BACKUP_STORAGE_$name is not set in $ENV_FILE." >&2
    false
  fi
done
case "$ENDPOINT" in https://*) ;; *)
  echo "BACKUP_STORAGE_ENDPOINT must use https." >&2
  false
  ;;
esac

# Upload file $1 to key $2 in the bucket; the credentials go to curl on stdin.
put() {
  printf 'user = "%s:%s"\n' "$ACCESS_KEY" "$SECRET_KEY" |
    curl --config - --silent --show-error --fail --max-time 300 --retry 3 \
      --aws-sigv4 "aws:amz:$REGION:s3" --upload-file "$1" --output /dev/null \
      "$ENDPOINT/$2"
}

notify /start "backup starting"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step=dump
compose run --rm --no-deps -T backup | age --encrypt --recipients-file "$RECIPIENTS" --output "$work/db.age"
db_bytes=$(stat -c %s "$work/db.age")
# A real custom-format dump of this database is far larger; a tiny file means pg_dump wrote nothing.
step="dump size ($db_bytes bytes)"
[ "$db_bytes" -gt 4096 ]

step=settings-copy
age --encrypt --recipients-file "$RECIPIENTS" --output "$work/env.age" "$ENV_FILE"
env_bytes=$(stat -c %s "$work/env.age")

step=upload
put "$work/db.age" "daily/tarubot-$stamp.dump.age"
if [ "$(date -u +%d)" = 01 ]; then put "$work/db.age" "monthly/tarubot-$stamp.dump.age"; fi
put "$work/env.age" "env/tarubot-env-$stamp.age"

notify "" "daily/tarubot-$stamp.dump.age: $db_bytes bytes; env/tarubot-env-$stamp.age: $env_bytes bytes"
echo "$(date -u +%FT%TZ) backup ok: tarubot-$stamp ($db_bytes bytes, settings $env_bytes bytes)"
