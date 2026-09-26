#!/usr/bin/env bash
# The detachment check for tests/unit/deploy-script.test.ts: start the stand-in worker through
# ops/deploy.sh's real launch while holding the run lock, then hang up this whole process group,
# as sshd's session teardown would. Env: DEPLOY_SCRIPT, DEPLOY_STATE, DEPLOY_SELF, REQUEST.
set -Eeuo pipefail
# shellcheck source=/dev/null
source "$DEPLOY_SCRIPT"
STATE=$DEPLOY_STATE SELF=$DEPLOY_SELF
parse_request "$REQUEST"
RUN=$STATE/runs/$R
mkdir -p "$RUN"
exec 8>>"$RUN/lock"
flock -n 8
launch
exec 8>&-
kill -HUP 0
