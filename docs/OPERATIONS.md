# Operations and recovery

## Configuration

`.env.example` lists application settings. Bun and TypeScript are exactly pinned. Standard service ports are private; `docker-compose.tools.yml` explicitly publishes loopback-only dependency ports for local tooling.

Normal deployments use published GHCR images. Pull updates with `docker compose pull`, then recreate with `docker compose up -d --wait`; follow the maintenance-window migration procedure when the schema changes. `TARUBOT_IMAGE_TAG` selects a matched latest/SemVer/SHA tag, and full `TARUBOT_IMAGE` / `NODESTONE_IMAGE` overrides support digest pinning. Local source builds explicitly add `docker-compose.build.yml`. See [CI_CD.md](CI_CD.md).

| Setting | Default / purpose |
| --- | --- |
| `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID` | Required runtime credentials/identity |
| `POSTGRES_PASSWORD` | Required Compose database credential |
| `DATABASE_URL` | Local-tool connection string; Compose supplies its internal connection string |
| `DATABASE_CA_CERT` | Optional PEM provider CA; enables verified PostgreSQL TLS and takes precedence over URL SSL switches |
| `RESTORE_DATABASE_CA_CERT` | Optional CA for `check-restore`'s `RESTORE_DATABASE_URL` (a PITR fork); empty reuses `DATABASE_CA_CERT` |
| `TARUBOT_ENVIRONMENT` | Maintenance-tool deployment profile: `production`, `rehearsal`, `devbot`, or empty to infer it; see [CONFIGURATION.md](CONFIGURATION.md#maintenance-tool-profiles) |
| `NODESTONE_URL` | `http://nodestone:8080` inside Compose |
| `ENABLE_EFFECTS` | `false`; process-wide delivery switch |
| `TEST_GUILD_ID` | Optional development interaction restriction |
| `PUBLIC_TEST_RESPONSES` | Public command/component replies in that test guild; false by base default, true in the DevBot overlay |
| `LOG_LEVEL` | `info`; structured logs with redacted/sanitized diagnostics |
| `ROSTER_INTERVAL_SECONDS` | 21,600; shared FC refresh interval |
| `PROFILE_INTERVAL_SECONDS` | 86,400; bounded identity refresh interval |
| `VERIFICATION_SECONDS` | 1,800; proof challenge lifetime |
| `GUEST_COOLDOWN_SECONDS` | 86,400; denied-application cooldown |
| `HEALTH_PORT` | 3,000 inside the bot container |

Request, worker, retry, body, pagination, and region settings are in [NODESTONE.md](NODESTONE.md). The bot's initial schema check rejects incompatible versions. Migrations are serialized with an advisory transaction lock and checksum-verified against applied versions.

App Platform uses [`.do/app.yaml`](../.do/app.yaml), which attaches the owner-provisioned Managed PostgreSQL cluster `tarubot-pg` (database and user `tarubot`). Follow [APP_PLATFORM.md](APP_PLATFORM.md) for provider prerequisites, bound credentials/CA, the worker-free deployment phases, and the update procedure that stops the old worker before pre-deploy migrations and a replacement worker start. Production maintenance tools run from a clean build of the deployed release with an explicit production env file ([MIGRATION.md](MIGRATION.md) E0), never from a checkout's `.env`.

## Inspect and repair

Every reply is one embed in the house style of [REPLIES.md](REPLIES.md). Officer read views that summarize or cut records offer **Full details (JSON)**, which re-runs the read for the officer who clicked and attaches the complete result as `tarubot-<view>.json`.

- `/config show` and `/config validate`: every setting, and a read-only checklist of `[OK]`, `[WARN]`, `[FAIL]`, `[OFF]` and `[WAIT]` lines for resource existence, permissions and hierarchy, the linked FC and its roster freshness, onboarding, Discord changes, the role layout and pending grandfathering. The title gives the verdict (problems, warnings, ready for activation, or all checks passed); **Run health check** and **Re-check** re-run it in place.
- `/config role_layout enabled:<true|false>`: a server manager with Manage Server and Manage Roles turns managed-role display and ordering on or off. Disabling leaves the current display as it is; a queued `roles.layout` job then completes as `skipped: layout disabled` (`– SKIPPED`).
- `/sync status`: run outcomes and queued, running, blocked, paused and failed work as [status markers](#status-markers). Officers see guild-wide runs, outstanding work, what runs next and what needs attention, with raw job kinds, short job IDs, attempts and diagnostics, plus Full details; other users see their own requests and pending work in plain words. `/sync status run_id:<uuid>` shows one run.
- `/guest status`: durable decisions, grants with their provenance (Application approved, Granted by an officer, Imported from the previous bot, Granted at launch), revocations, and the member's own delivery work. An officer who names a member gets the record view with the latest three deliveries and Full details. `/guest revoke` is the lasting removal for every kind of Guest access; a later `/guest grant` restores it as a manual grant.
- `/ledger balance` / `/ledger history`: committed balances and entries. Members see how many recent entries are waiting to be posted; officers see each recent post's state, entry UUIDs in history, and Full details.
- `commands.js list`: reads back the application's global and guild command scopes and exits 0 only when the declared scope matches exactly and every other scope is empty; `commands.js clear-guild` removes leftover guild-scoped commands after a fingerprint-confirmed dry run.
- `preview.js GUILD_ID --late-joiners`: a database-only list of humans who joined after an imported guild's first-activation enumeration and hold neither a guest grant nor an active link, for an officer `/guest grant` decision.

Job attempt outcomes are logged by severity, with job ID, kind, generation, attempts, code, status, category, the stored diagnostic, and duration/queue-wait/age timings; payloads are never logged. Expected waits (`ordered`, `busy`, `cooldown`, and `superseded` when reconciliation inputs changed) log at debug and return their attempt, escalating to warn once a job has waited continuously for 10 minutes. A lost lease (`lease_lost`) logs at warn and writes nothing, because another worker owns or will reclaim the row. Blocked, disabled, and retrying work logs at warn, gone work at info, and terminal failures at error. `reconcile.user` results keep an `applied` list of role changes (newest 20), including those made by a pass that was later superseded.

Job diagnostics are scoped. Repair the configured resource or permissions, then let reconciliation/backoff resume. For a terminal delivery failure, an operator can explicitly retry the job using database credentials:

```sh
bun run jobs:retry GUILD_ID JOB_ID
```

Against production, run the compiled tool with the production env file instead, as `prod dist/scripts/retry.js GUILD_ID JOB_ID` ([MIGRATION.md](MIGRATION.md) E0).

Retries recompute current desired roles/nicknames. Ledger notifications refer to their original immutable entry and preserve account order. An ambiguous Discord acknowledgement can produce a duplicate visible message; the stable entry ID identifies the same financial mutation. PostgreSQL remains authoritative.

Useful read-only SQL:

```sql
SELECT id, kind, guild_id, user_id, status, attempts, due_at, last_error, result
FROM jobs WHERE status IN ('queued','running','blocked','failed','disabled')
ORDER BY created_at;

SELECT id, last_attempt_at, last_successful_roster_at, last_error
FROM free_companies
WHERE id IN (SELECT fc_id FROM guilds WHERE active);

SELECT account_id, sequence, id, operation, delta, balance, event_at
FROM ledger_entries ORDER BY account_id, sequence;
```

Readiness uses database/schema initialization, the database writer lease (below), and Discord connectivity; liveness is local. Probes do not acquire Lodestone pages. Logs periodically include queue counts, blocked work, oldest accepted-roster age, and degraded FC counts.

Expired challenges are pruned after seven days. Active links/grants, membership evidence, audits, ledger entries, imports, and work history are retained. Operators can establish a bounded diagnostic-retention policy while retaining financial and access-policy evidence.

## Interaction logs

Every interaction failure is logged once, under the interaction ID, at the level its catalog category sets (`src/domain/failures.ts`):

| Level | Message | Categories |
| --- | --- | --- |
| info | `Interaction refused with an approved reason.` | input, forbidden, setup, not found, ambiguous, conflict, stale, wait, eligible |
| warn | `Operation could not complete; a dependency or setting needs attention.` | upstream (Lodestone, Discord), blocked, paused; also an interaction that can no longer be answered (expired token, already acknowledged), a failure while sending a reply, and a pre-form check that errored or overran (the form opened anyway) |
| error | `Operation failed; inspect scoped work status.` | unexpected, and every lifecycle, gateway-event, queue-worker and shutdown report |

Each entry carries these fields; payloads, option values, tokens and SDK error text are never logged:

| Field | Content |
| --- | --- |
| `operation` | The interaction ID, which replies show as **Ref** (a job ID or named task for non-interaction reports) |
| `code` | The catalog code: the `Failure`'s own, a mapped raw Discord error's (`blocked`, `forbidden`, `unavailable`), or `unexpected` for anything else |
| `category` | The code's presentation category |
| `source` | The error class: `Failure`, `DiscordAPIError[50013]`, `ZodError`, or `unknown` |
| `scope` | The interaction path, such as `/ledger withdraw`, `/config roles officer`, `button ledger` or `modal guest-apply`, never option values |
| `diagnostic` | The approved `Failure` message only |

Routine refusals log at info so a Ref stays findable at the default `LOG_LEVEL`. Autocomplete failures log with scope `autocomplete /<command>` and return an empty list; one that can no longer be answered (Discord's three-second window passed, or it was already answered) logs at warn and sends nothing.

## Reply references and error codes

Every failure reply ends with `Code <code> · Ref <interaction ID>`. **Ref is the interaction ID, and the log's `operation` field holds the same value**, so a member's screenshot leads straight to the log entry and its `code`, `source`, `scope` and `diagnostic`:

```sh
# Compose (add -f docker-compose.devbot.yml for DevBot)
docker compose logs tarubot | grep '"operation":"1290000000000000001"'
```

On App Platform, search the `tarubot` worker's runtime logs for the same string (control panel, or `doctl apps logs <app-id> tarubot --type run`).

| Code | Members see | Cause | Operator action |
| --- | --- | --- | --- |
| `input`, `invalid_data` | Check your input | A malformed option: a typed name where an ID belongs, a blank note, a bad cursor | None; the reply names the option and shows an example |
| `forbidden` | Officers only, Server managers only, Only your own records, FC membership needed, That role is above yours, Not available here, Test instance | The actor lacks the access the command needs, or used a DM, a bot or another guild | None, unless the member should have access: check `/config officer_rank`, the Officer role and `/officer` overrides |
| `setup` | TaruBot isn't set up here yet, No Free Company linked, Ledger isn't set up, Guest applications are closed (officers: Finish setup first) | A guild, FC, ledger channel, Officer role, review channel or Guest role isn't configured | Run the command the officer reply names, then `/config validate` |
| `not_found` | Character not found, Link not found, Entry not found, … | The record or Lodestone page does not exist | None; check the ID the user gave |
| `ambiguous` | Several characters match, Choose which role/channel to use | A search or `/setup` name matched several candidates | Rerun with an ID, or bind the resource explicitly with `/config` |
| `ownership_conflict` | Linked to another member | The character is linked to someone else | An officer runs `/unassign` first if the link is wrong |
| `fc_linked` | Another FC is linked | `/config fc link` while a different FC is linked | Unlink the current FC first |
| `initialized`, `uninitialized` | Opening balance already set / not set | The ledger's opening balance state | An officer runs `/ledger initialize` once, or `/ledger adjust` |
| `insufficient_funds` | Not enough recorded gil | A withdrawal below zero | None; check `/ledger balance` |
| `conflict`, `superseded` | Settings changed — try again | A configuration revision changed while the command ran | None; run it again |
| `stale` | This control is out of date, Please reopen /apply, This review message is out of date | A button, form or review message from an older state or release | Re-register commands after a deploy if it persists |
| `expired` | Token expired during verification | The claim token expired while being checked | None; `/claim` again |
| `pending_proof` | Token not on the Lodestone yet | The Lodestone has not published the biography token yet | None; wait and use Check again |
| `cooldown`, `rate_limited`, `busy`, `transient`, `stopping` | Please wait a moment (and the claim and apply limits) | A limit, contention, a temporary Discord change or shutdown | None; the reply gives the retry time |
| `eligible` | No application needed | The visitor already qualifies for access | None |
| `unavailable`, `incomplete`, `invalid_response` | The Lodestone isn't responding, Discord isn't responding, … | The Lodestone, the Nodestone sidecar or Discord failed or returned something unusable, including a malformed Lodestone ID in sidecar output (`invalid_response`) or a member Discord sent without a join time (`incomplete`, naming that member) | Check sidecar health and Discord status; logged at warn |
| `blocked` | Server setup issue (officers: Discord permissions need attention) | A missing permission, the role hierarchy, or a deleted role or channel | Fix what the officer reply names (Affected, and How to fix when TaruBot's role position or channel permissions are the cause; otherwise the reply's own text), then `/config validate` |
| `disabled` | Discord changes paused | Effects are off (awaiting activation or `ENABLE_EFFECTS=false`) | Activate the guild or re-enable effects |
| `unexpected` (and internal codes such as `idempotency_conflict`) | Something went wrong | An error with no approved explanation | Find the Ref in the logs (`source`, `scope`) and investigate; logged at error |

**Renamed codes.** Queries that span releases before 2.14.0 must match both names:

- `funds` became `insufficient_funds` (below zero only); passing the storable maximum is now `input`.
- `pending` became `pending_proof`.
- Missing links, members, applications, ledger entries and accounts, claims and FC links became `not_found` (they were `input` or `expired`).
- Ambiguous role and channel choices became `ambiguous`, a second FC link `fc_linked`, and idempotency-key collisions `idempotency_conflict` (they were `conflict` or `input`).
- An obsolete command, button, form, review message or join context became `stale` (it was `input` or `forbidden`).
- An error that is not an approved `Failure` logs `code: "unexpected"` with its class in `source`; 2.13.0 and earlier logged the class name as the code, and a reply ended with `Operation: <id>` instead of `Code · Ref`. Raw Discord permission, unknown-channel or unknown-role errors (50001, 50013, 10003, 10011) now log as `blocked`, unknown member or user (10007, 10013) as `forbidden`, and rate limits and server errors as `unavailable`.

## Status markers

Replies describe background work with text markers (see [REPLIES.md](REPLIES.md#status-markers)). They map from the stored job row:

| Job row | Marker | Member wording |
| --- | --- | --- |
| `succeeded` | `✓ DONE` | The kind's completion phrase, such as "Roles and nickname updated" |
| `succeeded` with a `skipped` result | `– SKIPPED` | "nothing to do" |
| `running` | `… IN PROGRESS` | The kind's label |
| `queued`, no `last_error` | `… QUEUED` | The kind's label |
| `queued` with `ordered`, `busy`, `cooldown`, `superseded` or `lease_lost` | `↻ WAITING` | "next" and the due time |
| `queued` with any other `last_error` | `↻ WAITING` | "retrying" and the due time |
| `blocked` | `! BLOCKED` | "an officer needs to fix permissions" |
| `disabled` | `‖ PAUSED` | "waiting for activation" or "Discord changes are off for this deployment" |
| `failed` | `✗ FAILED` | "stopped and won't retry"; a closed-DM decision DM says the decision still stands |

Members see labels (Role update, Server-wide role check, FC roster check, Departure confirmation, Character profile refresh, Channel access, Role layout, Ledger post, Guest review message, Decision DM, Officer notice). Officers see the raw kind (`reconcile.user`), the first 8 characters of the job ID, the attempt, the next time and the stored `last_error` quoted and cut to 150 characters; the job ID prefix matches `SELECT … FROM jobs WHERE id::text LIKE '1a2b3c4d%'`. Immediate replies never use completion words; `… QUEUED` or `‖ PAUSED` there only means the work was saved.

## Single database writer

Exactly one bot process writes to a database. The bot enforces this with a PostgreSQL session advisory lock, the **writer lease**, key **`714882494`** (`WRITER_LEASE_LOCK` in `src/application/lifecycle.ts`). Other fixed keys are transaction locks: `714882490` serializes migrations, `714882491` character claims, and `714882492` legacy import.

- **Startup.** After the schema check, the bot checks out one dedicated pool connection and runs `pg_try_advisory_lock(714882494)` every 5 seconds until it succeeds. It holds that connection for the life of the process; it is one of the pool's 12 connections. The queue does not start and the bot does not log in to Discord until the lease is held. Each attempt, and each probe of the holder, has the same 10-second client-side deadline as the lease check below. If the connection stops answering or fails while the bot waits, the bot logs an error, destroys that connection and exits with status 1, so its supervisor restarts it with a fresh connection instead of leaving it live but unready until TCP gives up.
- **While waiting.** Each attempt logs `Waiting for the database writer lease…` with the holder's backend `holderPid`, at info for the first 60 seconds and at warn after that. `/health/live` stays 200, so App Platform's liveness check keeps the waiting process; `/health/ready` is 503 with `writerLease: false`, so the Compose health check reports it unhealthy (Compose does not restart it for that). An overlapping deployment therefore waits for the previous writer to stop instead of running beside it.
- **Shutdown.** SIGTERM wakes a waiting process at once, and it exits without logging in. A running writer unlocks after its workers and Discord client stop and before its pool closes, so the next writer acquires within one retry. A process that is killed releases the lease when PostgreSQL ends its session: at once for a normal kill, and after a lost host or network partition once the server's TCP keepalive gives up (about 60 seconds with the pool's session settings). Shutdown has a 27-second deadline, after which the process exits anyway: with status 0 for an ordinary stop, and with status 1 after a lost lease.
- **Lost session.** If the lease connection ends (database restart, failover or a terminated backend), PostgreSQL frees the lock. The bot logs an error, shuts down and exits with status 1, so its supervisor restarts it and it waits for the lease again.
- **Silent loss.** A connection can also die without any error reaching the bot, for example when a failover removes the old primary's host (advisory locks are not replicated to a promoted standby, so the lock is already gone) or a network path drops the idle socket (the old session may still hold the lock until the server's keepalive ends it). Every 30 seconds the bot therefore asks the lease connection itself whether it still holds the lock, with a 10-second client-side deadline. No answer, an error or a missing lock counts as a lost lease, so a silent loss is detected within about 40 seconds. The bot then stops, destroys that connection instead of unlocking over it, and exits with status 1 as above. The same failure can leave workers' pool connections hanging so the pool never closes; the shutdown deadline then still exits with status 1. The pool enables client TCP keepalive so the bot notices a vanished peer sooner, and sets server-side `tcp_keepalives_idle=30`, `tcp_keepalives_interval=10` and `tcp_keepalives_count=3` so PostgreSQL ends an orphaned session, and frees its lease, in about a minute.
- **Stale holder.** If a restarted bot keeps logging the same `holderPid` for more than a few minutes while App Platform shows only the waiting instance, confirm the holder is idle from before the restart with `SELECT pid, state, backend_start, state_change, client_addr FROM pg_stat_activity WHERE pid = <holderPid>`, then run `SELECT pg_terminate_backend(<holderPid>)` as `tarubot`. The waiting writer acquires the lease on its next 5-second attempt.

The lease needs a direct PostgreSQL connection; a transaction-mode pool (PgBouncer) cannot hold a session lock.

**Runbook gate.** Before running migrate, import, activate or a restore against a database, confirm that no bot writer holds the lease. This read-only query must return no rows:

```sql
SELECT l.pid, a.application_name, a.client_addr, a.backend_start
FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory' AND l.granted
  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND l.classid = 0 AND l.objid = 714882494 AND l.objsubid = 1;
```

A single bigint advisory key appears in `pg_locks` as `classid` (high 32 bits), `objid` (low 32 bits) and `objsubid = 1`. A role without `pg_read_all_stats` sees null `client_addr` and `backend_start` for other roles' sessions; the `pid` row alone means a writer is connected. The tools themselves do not take the lease, so this check is the operator's.

## Shutdown and restart

The Compose stop grace period is 30 seconds. SIGTERM stops new interaction handling and scheduling, aborts outstanding Nodestone requests, waits up to 20 seconds for workers, then closes Discord/database resources. Persisted leases are recoverable after expiry. A worker must own its current lease before publishing results; superseded reconciliation is recomputed.

Use a maintenance window for migrations, final capture/import, command replacement/cutover, or restoration. Normal backups can run against the active database; a consistent dump uses PostgreSQL's snapshot semantics.

## Backup (local Compose and DevBot)

The following stores a custom-format archive inside the PostgreSQL container, then copies it into the project. Create the destination directory first. DevBot's database is `tarubot_dev`; add `-f docker-compose.devbot.yml` and use that name.

```sh
mkdir -p artifacts/backups
docker compose exec -T postgres pg_dump -U tarubot -d tarubot -Fc -f /tmp/tarubot-backup.dump
docker compose cp postgres:/tmp/tarubot-backup.dump artifacts/backups/tarubot-backup.dump
```

Keep backups and the original import/snapshot/report together in your operational backup storage. For post-activation recovery with no loss of acknowledged decisions, use PostgreSQL WAL/PITR or capture and reconcile all changes newer than the restored backup.

## Restore rehearsal (local Compose and DevBot)

Restore into a separate database first:

```sh
docker compose exec -T postgres createdb -U tarubot tarubot_restore_test
docker compose cp artifacts/backups/tarubot-backup.dump postgres:/tmp/tarubot-restore.dump
docker compose exec -T postgres pg_restore -U tarubot -d tarubot_restore_test --exit-on-error /tmp/tarubot-restore.dump
```

Compare ledger account balances, entry counts/sequences/idempotency keys, links, guest decisions, import fingerprints, accepted observations, and pending jobs. Start a test instance with effects disabled against the restored database; verify schema/readiness and inspect work before any activation.

With the writer stopped, the compiled read-only comparison tool checks all application rows using exact PostgreSQL text checksums, plus sequence state, triggers, and constraints. Supply the original and restored connection strings through the environment:

```sh
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/tarubot RESTORE_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/tarubot_restore_test bun dist/scripts/check-restore.js
```

The deployment guard applies here too. Under DevBot's profile, `DATABASE_URL` must name `tarubot_dev` and the restore target must end in `_restore_test` (for example `tarubot_dev_restore_test`). The one exception is `migrate.js --restore-rehearsal` below. Other local installations use the unmanaged profile and any names.

`check-restore` requires both databases to report this build's `SCHEMA_VERSION`. A **pre-migration** rehearsal therefore runs from the currently deployed build, or from the newer build with `--schema-version` naming the migration both databases still report, for example `bun dist/scripts/check-restore.js --schema-version 004_guest_application_form.sql` before applying `005_launch_access_policy.sql`. Rehearse the new migration on the restored copy before applying it to the live database.

Under DevBot's profile, only `migrate.js --restore-rehearsal` may name the restore copy as `DATABASE_URL`, and with that flag it must end in `_restore_test`. Run the new release's migrate inside its image, deriving the URL in the container so no credential is printed:

```sh
docker compose -f docker-compose.yml -f docker-compose.devbot.yml run --rm --no-deps -T tarubot \
  sh -c 'DATABASE_URL="${DATABASE_URL%/*}/tarubot_dev_restore_test" exec bun dist/scripts/migrate.js --restore-rehearsal'
```

It must print `Schema ready.` Then migrate `tarubot_dev` itself with a plain `bun dist/scripts/migrate.js`. The production application never uses the flag; its migrations are rehearsed in `tarubot_rehearsal` ([MIGRATION.md](MIGRATION.md) E2).

For actual recovery, stop the writer, preserve the newest available state, restore/replay to the required recovery point, validate invariants and configuration, then restart exactly one writer. Unacknowledged outbound effects resume from durable jobs. Already acknowledged application decisions must be present before resuming.

## Managed PostgreSQL backups and recovery

Production on App Platform uses the managed cluster's backups plus independent exports; [APP_PLATFORM.md](APP_PLATFORM.md#backups-pitr-and-recovery) describes the provider behavior (7-day daily backups and PITR, restores that fork a new cluster) and the repoint procedure.

**Independent export.** Take it before every maintenance window and on the owner's schedule, as `tarubot` over verified TLS with a PostgreSQL 18 client, and store it off the provider:

```sh
read -rs 'PGPASSWORD?tarubot password: '; export PGPASSWORD
docker run --rm -e PGPASSWORD -v "$HOME/tarubot-cutover/work:/work" postgres:18.4-alpine \
  pg_dump "host=CLUSTER_HOST port=25060 dbname=tarubot user=tarubot sslmode=verify-full sslrootcert=/work/ca-certificate.crt" \
  -Fc -f /work/backups/tarubot-YYYYMMDD.dump
```

**Restore rehearsal.** In a maintenance window with the worker removed (the `maintenance` phase), either fork the cluster at a recorded time or restore the export into a scratch database on the same cluster. For the scratch path, `doadmin` creates `tarubot_restore` with the documented grants, then:

```sh
docker run --rm -e PGPASSWORD -v "$HOME/tarubot-cutover/work:/work" postgres:18.4-alpine \
  pg_restore -d "host=CLUSTER_HOST port=25060 dbname=tarubot_restore user=tarubot sslmode=verify-full sslrootcert=/work/ca-certificate.crt" \
  --no-owner --no-privileges --exit-on-error /work/backups/tarubot-YYYYMMDD.dump
```

Add `RESTORE_DATABASE_URL` to the production env file and run `prod dist/scripts/check-restore.js` (`prod` is defined in [MIGRATION.md](MIGRATION.md) E0). The production profile accepts `tarubot_restore` on the primary's host or `tarubot` on another host (a PITR fork), with `RESTORE_DATABASE_CA_CERT` when the fork's CA differs; the rehearsal profile accepts `*_restore_test`. `doadmin` drops the scratch database, or the owner destroys the billed fork, afterwards.

**Recovery (OPS-13).** Stop the writer with the `maintenance` phase, fork at the latest point that keeps every acknowledged decision, repoint `cluster_name` and the local production tooling (see [APP_PLATFORM.md](APP_PLATFORM.md#backups-pitr-and-recovery)), and apply `full`. A database restore never reverts Discord role changes the worker already applied; see the cutover recovery limits in [MIGRATION.md](MIGRATION.md) E4.

## Volumes

`postgres_data` is mounted at `/var/lib/postgresql`, the parent-volume layout expected by PostgreSQL 18 images. Container recreation retains that volume. Removing a volume is a separate destructive operator action.
