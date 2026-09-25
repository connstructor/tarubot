# Operations and recovery

## Configuration

`.env.example` lists application settings. Bun and TypeScript are exactly pinned. Standard service ports are private; `docker-compose.tools.yml` explicitly publishes loopback-only dependency ports for local tooling.

Normal deployments use published GHCR images. Pull updates with `docker compose pull`, then recreate with `docker compose up -d --wait`; follow the maintenance-window migration procedure when the schema changes. `TARUBOT_IMAGE_TAG` selects a matched latest/SemVer/SHA tag, and a full `TARUBOT_IMAGE` override supports digest pinning. Local source builds explicitly add `docker-compose.build.yml`. See [CI_CD.md](CI_CD.md).

| Setting | Default / purpose |
| --- | --- |
| `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID` | Required runtime credentials/identity |
| `POSTGRES_PASSWORD` | Required Compose database credential |
| `DATABASE_URL` | Local-tool connection string; Compose supplies its internal connection string |
| `DATABASE_CA_CERT` | Optional PEM provider CA; enables verified PostgreSQL TLS and takes precedence over URL SSL switches |
| `RESTORE_DATABASE_CA_CERT` | Optional CA for `check-restore`'s `RESTORE_DATABASE_URL` (a PITR fork); empty reuses `DATABASE_CA_CERT` |
| `TARUBOT_ENVIRONMENT` | Maintenance-tool deployment profile: `production`, `rehearsal`, `devbot`, or empty to infer it; see [CONFIGURATION.md](CONFIGURATION.md#maintenance-tool-profiles) |
| `ENABLE_EFFECTS` | `false`; process-wide delivery switch |
| `TEST_GUILD_ID` | Optional development interaction restriction |
| `PUBLIC_TEST_RESPONSES` | Public command/component replies in that test guild; false by base default, true in the DevBot overlay |
| `LOG_LEVEL` | `info`; structured logs with redacted/sanitized diagnostics |
| `ROSTER_INTERVAL_SECONDS` | 21,600; shared FC refresh interval |
| `PROFILE_INTERVAL_SECONDS` | 86,400; bounded identity refresh interval |
| `VERIFICATION_SECONDS` | 1,800; proof challenge lifetime |
| `GUEST_COOLDOWN_SECONDS` | 86,400; denied-application cooldown |
| `HEALTH_PORT` | 3,000 inside the bot container |
| `HEALTHCHECKS_PING_URL` | Empty (off); a healthchecks.io ping URL the ready bot pings every five minutes (2.22.0, [HOSTING.md](HOSTING.md#heartbeat)) |

Lodestone request, worker, retry, body, pagination, region and selector settings are in [LODESTONE.md](LODESTONE.md#settings). The bot's initial schema check rejects incompatible versions. Migrations are serialized with an advisory transaction lock and checksum-verified against applied versions.

Production runs on a Linode Docker host with [`docker-compose.production.yml`](../docker-compose.production.yml), attached to Linode managed PostgreSQL. [HOSTING.md](HOSTING.md) covers its layout, updates, backups, and rollback.

## Inspect and repair

Every reply is one embed in the house style of [REPLIES.md](REPLIES.md). Officer read views that summarize or cut records offer **Full details (JSON)**, which re-runs the read for the officer who clicked and attaches the complete result as `tarubot-<view>.json`.

- `/config show` and `/config validate`: every setting, and a read-only checklist of `[OK]`, `[WARN]`, `[FAIL]`, `[OFF]` and `[WAIT]` lines for resource existence, permissions and hierarchy, the linked FC and its roster freshness, onboarding, Discord changes, the role layout and pending grandfathering. The title gives the verdict (problems, warnings, ready for activation, or all checks passed); **Run health check** and **Re-check** re-run it in place.
- `/config role_layout enabled:<true|false>`: a server manager with Manage Server and Manage Roles turns managed-role display and ordering on or off. Disabling leaves the current display as it is; a queued `roles.layout` job then completes as `skipped: layout disabled` (`– SKIPPED`).
- `/config guest_applications [enabled:<true|false>] [channel:#…] [unset_channel:true]`: officers switch guest applications on or off separately from the review channel, in any combination and one revision. `/apply` opens only while the switch is on and a review channel and the Guest role are set. A named channel is always validated first, and switching on also validates the kept one it will use (such as an import's legacy channel), so a deleted or unusable channel refuses the call (`blocked`) before anything is saved. Switching off or `unset_channel:true` never validates the kept channel, so a deleted one never blocks closing. Switching off keeps the channel, and waiting applications stay reviewable. `/config show` reads "Off · reviews in #channel" while the switch is off, and `/config validate` lists the channel's check only while applications are on. See [SETUP.md](SETUP.md#unverified-visitor-applications).
- Unsetting a `/config` setting uses `unset_channel:true` (`ledger`, `officer_notifications`, `guest_applications`), `unset_role:true` (`roles …`) or `unset_rank:true` (`officer_rank`); these replaced `clear:true` in 2.15.0.
- Repeats change nothing (2.15.0). `/main` naming the current main, `/nickname` repeating the saved setting, a `/config guest_applications` request that matches what is saved, `/config officer_rank` naming the saved rank (or `unset_rank:true` with none set), and an `/officer reset` or `/guest reset` with no override to remove each reply with a `= NO CHANGE` card (info, or neutral for "Nickname sync already off"), save and audit nothing, advance no configuration revision, and queue no reconciliation. Resuming nickname sync that a manual nickname suspended is still a change.
- `/sync status`: run outcomes and queued, running, blocked, paused and failed work as [status markers](#status-markers). A failure stops being listed once the same work (its dedupe key) succeeds after it (2.24.1); the job row stays as history. The queue stamps a failed job's `completed_at` for this, and `retry.js` clears it when it requeues the row. Officers see guild-wide runs, outstanding work, what runs next and what needs attention, with raw job kinds, short job IDs, attempts and diagnostics, plus Full details; other users see their own requests and pending work in plain words. `/sync status run_id:<uuid>` shows one run.
- `/guest status`: durable decisions, grants with their provenance (Application approved, Granted by an officer, Imported from the previous bot, Granted at launch), revocations, and the member's own delivery work. An officer who names a member gets the record view with the latest three deliveries and Full details. `/guest revoke` is the lasting removal for every kind of Guest access; a later `/guest grant` restores it as a manual grant. `/guest reset` (2.15.0) removes both kinds of override: it lifts the revocation and ends every active grant, so FC membership and registered characters decide Guest again. Ended grants stay in `guest_grants` with `ended_at`, `ended_by` and `ended_reason`, and the `guest.reset` audit lists their provenances; they no longer appear in `/guest status`.
- `/officer grant|revoke|reset`: a server manager's officer overrides. While an Officer role is bound, all three first check that the manager's highest role is above it (the server owner is exempt) and that TaruBot can manage it. `/officer reset` (2.15.0) deletes the grant or revoke, audited as `officer.reset`, so the in-game rank decides again, or with no rank set only `/officer grant` confers officer access.
- `/ledger balance` / `/ledger history`: committed balances and entries. Members see how many recent entries are waiting to be posted; officers see each recent post's state, entry UUIDs in history, and Full details. `/ledger adjust entry:` takes the entry number history shows (`5` or `#5`, in the current FC account) or the entry UUID; one that isn't in that account is "Entry not found".
- `commands.js list`: reads back the application's global and guild command scopes and exits 0 only when the declared scope matches exactly and every other scope is empty; `commands.js clear-guild` removes leftover guild-scoped commands after a fingerprint-confirmed dry run.
- `preview.js GUILD_ID --late-joiners`: a database-only list of humans who joined after an imported guild's first-activation enumeration and hold neither a guest grant (including one `/guest reset` ended) nor an active link, for an officer `/guest grant` decision.

Every `member:` option (`/characters`, `/guest status|grant|revoke|reset`, `/officer grant|revoke|reset`, `/assign` and `/unassign`) suggests server members by display name, username, global name or nickname, from the member cache and then Discord's member search. A pasted user ID or mention is still accepted, so someone who has left can be named by ID. Where a member may only name themselves (`/characters` and `/guest status` for non-officers), they are offered only themselves.

Job attempt outcomes are logged by severity, with job ID, kind, generation, attempts, code, status, category, the stored diagnostic, and duration/queue-wait/age timings; payloads are never logged. Expected waits (`ordered`, `busy`, `cooldown`, and `superseded` when reconciliation inputs changed) log at debug and return their attempt, escalating to warn once a job has waited continuously for 10 minutes. A lost lease (`lease_lost`) logs at warn and writes nothing, because another worker owns or will reclaim the row. Blocked, disabled, and retrying work logs at warn, gone work at info, and terminal failures at error. `reconcile.user` results keep an `applied` list of role changes (newest 20), including those made by a pass that was later superseded, or closed as `skipped: superseded` when parked work was requeued.

Job diagnostics are scoped. Repair the configured resource or permissions, then let reconciliation/backoff resume. For a terminal delivery failure, an operator can explicitly retry the job using database credentials:

```sh
bun run jobs:retry GUILD_ID JOB_ID
```

Against production, run the compiled tool with the production env file instead, as `prod dist/scripts/retry.js GUILD_ID JOB_ID` ([MIGRATION.md](MIGRATION.md) E0).

The tool retries a blocked, failed or disabled job of that guild, clearing its diagnostic. It refuses, changing nothing, when a newer queued, running or blocked job for the same work already exists (the active-job index allows one), and prints that job's ID: retry the newer job instead if it is blocked; otherwise it runs on its own.

Retries recompute current desired roles/nicknames. Discord lets no bot change the server owner's nickname, so since 2.15.0 reconciliation never writes or restores the owner's nickname, even with sync on, drops any pending restore or write for the owner, and the job completes. Under 2.14.x the owner's `/nickname enabled:true` left a `reconcile.user` job blocked under Needs attention, and every `/config` change requeued it to block again; on 2.15.0 such a job no longer blocks on the nickname when it is next requeued (by a `/config` change or `retry.js`). Ledger notifications refer to their original immutable entry and preserve account order. An ambiguous Discord acknowledgement can produce a duplicate visible message; the stable entry ID identifies the same financial mutation. PostgreSQL remains authoritative.

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

| Code | Members see | Cause | Operator action |
| --- | --- | --- | --- |
| `input`, `invalid_data` | Check your input | A malformed option: a typed name not picked from the member suggestions, a blank note, a bad cursor | None; the reply names the option and shows an example (every option has one since 2.15.0) |
| `forbidden` | Officers only, Server managers only, Only your own records, FC membership needed, That role is above yours, Not available here, Test instance | The actor lacks the access the command needs, or used a DM, a bot or another guild | None, unless the member should have access: check `/config officer_rank`, the Officer role and `/officer` overrides (`/officer reset` removes one so the rank decides) |
| `setup` | TaruBot isn't set up here yet, No Free Company linked, Ledger isn't set up, Guest applications are closed (officers: Finish setup first) | A guild, FC, ledger channel, Officer role, review channel or Guest role isn't configured, or guest applications are switched off | Run the command the officer reply names, then `/config validate`; reopen switched-off applications with `/config guest_applications enabled:true` |
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
| `unavailable`, `incomplete`, `invalid_response` | The Lodestone isn't responding, Discord isn't responding, … | The Lodestone or Discord failed or returned something unusable, including a malformed Lodestone ID in parsed output (`invalid_response`) or a member Discord sent without a join time (`incomplete`, naming that member) | Check readiness's `lodestone` object and Discord status; logged at warn |
| `blocked` | Server setup issue (officers: Discord permissions need attention) | A missing permission, the role hierarchy, or a deleted role or channel | Fix what the officer reply names (Affected, and How to fix when TaruBot's role position or channel permissions are the cause; otherwise the reply's own text), then `/config validate` |
| `disabled` | Discord changes paused | Effects are off (awaiting activation or `ENABLE_EFFECTS=false`; a job's `last_error` names which) | Activate the guild, or restart with `ENABLE_EFFECTS=true`: startup requeues the held work of every activated guild, one row per dedupe key, and clears its paused diagnostic. Any `/config` change also requeues it; `activate.js --requeue` and `retry.js` (which refuses a job a newer active job already covers) are the fallbacks |
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
| `queued` with `ordered`, `busy`, `cooldown`, `superseded`, `lease_lost` or (since 2.17.0) `rate_limited` | `↻ WAITING` | "next" and the due time |
| `queued` with any other `last_error` | `↻ WAITING` | "retrying" and the due time |
| `blocked` | `! BLOCKED` | "an officer needs to fix permissions" |
| `disabled` | `‖ PAUSED` | "waiting for activation" or "Discord changes are off for this deployment" |
| `failed` | `✗ FAILED` | "stopped and won't retry"; a closed-DM decision DM says the decision still stands |

Members see labels (Role update, Server-wide role check, FC roster check, Departure confirmation, Character profile refresh, Channel access, Role layout, Ledger post, Guest review message, Decision DM, Officer notice). Officers see the raw kind (`reconcile.user`), the first 8 characters of the job ID, the attempt, the next time and the stored `last_error` quoted and cut to 150 characters; the job ID prefix matches `SELECT … FROM jobs WHERE id::text LIKE '1a2b3c4d%'`. Immediate replies never use completion words; `… QUEUED` or `‖ PAUSED` there only means the work was saved.

## Profile refreshes, private profiles and deleted characters

Since 2.17.0 (REQUIREMENTS.md "Approved Lodestone amendments"):

- **Pacing.** The scheduler queues a character's profile refresh at most once an hour, whatever happens to the job, by stamping `characters.profile_retry_at`. It never pulls a job that is backing off forward. Old failed `profile` rows from before 2.17.0 are history, and nothing needs retrying: the next scheduled refresh supersedes them.
- **Throttling.** A Lodestone 429 closes the gate for a shared cooldown (15 s, doubling to 5 min). Jobs wait it out as `↻ WAITING` without spending attempts. The bot logs "The Lodestone throttled TaruBot" once per 429, and `/health/ready` shows `lodestone.cooldownSeconds` and `strikes` (the sidecar's `/health` before 2.21.0).
- **Private profiles** complete as `{status: "private"}` and wait for the profile interval (`PROFILE_INTERVAL_SECONDS`). Links are unaffected, because membership comes from the roster.
- **Deleted characters.** A 404 is recorded in `characters.profile_missing_at` (`{status: "missing", confirmed: false}`). A second 404 at least an hour later ends every active link, audited as `character.unlink` with a null actor and `automatic: "lodestone_not_found"`, and posts an officer notice per link. A profile read, a private answer or a roster listing in between clears the mark.

To see what is waiting, private or pending confirmation:

```sql
SELECT id, name, world, profile_at, profile_retry_at, profile_missing_at
  FROM characters
 WHERE profile_missing_at IS NOT NULL OR profile_retry_at > now()
 ORDER BY profile_missing_at NULLS LAST, profile_retry_at;
```

To undo an automatic unlink (for example, a character that reappears after a rename or transfer glitch), the owner claims and verifies the character again, or an officer runs `/assign`.

## Live selectors

Since 2.19.0 TaruBot keeps `xivapi/lodestone-css-selectors` at its latest commit by itself ([LODESTONE.md](LODESTONE.md#live-selectors)); since 2.21.0 the bot does it in memory. To see which set is live, check readiness: `lodestone.selectors.revision`, with `source` `upstream` or `bundled`. Issue reports show it too. Each switch logs one "Lodestone selectors updated" line with `from` and `to`. A new revision that fails its download or validation logs "Lodestone selector revision rejected; the active set stays" with the reason, and the next check retries. After a restart the bundled set runs until the first check, moments later. Nothing needs doing on a switch. A persistent rejection means upstream changed the selector format and the parser may need attention.

## Issue reports

Since 2.18.0 (REQUIREMENTS.md "Approved issue-reporting amendments"), TaruBot opens issues in the private repository `GITHUB_REPORTS_REPO` (default `deconfined/tarubot-reports`) with `GITHUB_REPORTS_TOKEN`.

**What opens an issue:**
- `/issue` from any member: one per member per 10 minutes, twenty per server per day.
- Every error-level report: unexpected failures in interactions, events, the lifecycle and the queue worker.
- Every job that ends failed at error level, except `issue.report` itself.
- Every five minutes, repeated trouble: a linked FC whose roster hasn't been accepted for 12 hours, and no Lodestone answer for an hour. An FC with no accepted roster yet is reported only after the check has seen it that way for 12 hours, so linking one doesn't raise a false report. The Lodestone report needs failures to continue, with the last attempt within 30 minutes; one failure followed by quiet isn't an outage.

**How it's grouped:**
- Automatic reports share an issue per fingerprint of what failed and where. Repeats are counted, and a comment posts the count, with the newest context, at most hourly.
- A repeat after the issue was closed opens a new issue that names the old one. Close an issue once it's fixed; a recurrence then shows up as new.
- Each day allows at most 10 new automatic issues and 50 automatic comments; reports beyond that wait for the next day's allowance.
- Issues carry the labels `tarubot-report`, `source:user|error|job|trouble` and `env:production|devbot`, and titles start with the environment.

**What a report contains:** the deployment and version, readiness, the Lodestone's reachability, gate and live selectors, active and recently failed jobs, the server's settings and roster state, and for member reports the member's links, main, nickname state, guest and officer standing, recent work and audit, plus the newest log records. Known secret shapes (tokens, Authorization values, URL passwords, PEM blocks) and the deployment's own secret values are removed first.

**Delivery:** reports are rows in `issue_reports`, delivered by `issue.report` jobs. Without a token they are kept and sent once one is set and the bot restarts. To see what is waiting:

```sql
SELECT source, title, occurrences, posted_occurrences, issue_number, last_at
  FROM issue_reports
 WHERE issue_number IS NULL OR occurrences > posted_occurrences
 ORDER BY last_at DESC;
```

A refused token (401/403/404) fails the delivery job with `configuration`; fix the token or repository and retry the job. GitHub's rate limits and outages wait and retry on their own.

## Single database writer

Exactly one bot process writes to a database. The bot enforces this with a PostgreSQL session advisory lock, the **writer lease**, key **`714882494`** (`WRITER_LEASE_LOCK`, defined in `src/infrastructure/postgres/database.ts` and used by the lifecycle and by `migrate()`). Other fixed keys are transaction locks: `714882490` serializes migrations, `714882491` character claims, and `714882492` legacy import.

- **Startup.** After the schema check, the bot checks out one dedicated pool connection and runs `pg_try_advisory_lock(714882494)` every 5 seconds until it succeeds. It holds that connection for the life of the process; it is one of the pool's 12 connections. The queue does not start and the bot does not log in to Discord until the lease is held. Each attempt, and each probe of the holder, has the same 10-second client-side deadline as the lease check below. If the connection stops answering or fails while the bot waits, the bot logs an error, destroys that connection and exits with status 1, so its supervisor restarts it with a fresh connection instead of leaving it live but unready until TCP gives up.
- **Schema check again.** Once it holds the lease, the bot checks the schema a second time before it logs in. A bot that passed the first check and then waited, for example an old release restarting while a migration ran, would otherwise take the lease after the migration committed and write with old code. On a mismatch it releases the lease and exits with status 1 (since 2.16.0).
- **While waiting.** Each attempt logs `Waiting for the database writer lease…` with the holder's backend `holderPid`, at info for the first 60 seconds and at warn after that. `/health/live` stays 200, so a liveness check keeps the waiting process; `/health/ready` is 503 with `writerLease: false`, so the Compose health check reports it unhealthy (Compose does not restart it for that). An overlapping deployment therefore waits for the previous writer to stop instead of running beside it.
- **Shutdown.** SIGTERM wakes a waiting process at once, and it exits without logging in. A running writer unlocks after its workers and Discord client stop and before its pool closes, so the next writer acquires within one retry. A process that is killed releases the lease when PostgreSQL ends its session: at once for a normal kill, and after a lost host or network partition once the server's TCP keepalive gives up (about 60 seconds with the pool's session settings). Shutdown has a 27-second deadline, after which the process exits anyway: with status 0 for an ordinary stop, and with status 1 after a lost lease.
- **Lost session.** If the lease connection ends (database restart, failover or a terminated backend), PostgreSQL frees the lock. The bot logs an error, shuts down and exits with status 1, so its supervisor restarts it and it waits for the lease again.
- **Silent loss.** A connection can also die without any error reaching the bot, for example when a failover removes the old primary's host (advisory locks are not replicated to a promoted standby, so the lock is already gone) or a network path drops the idle socket (the old session may still hold the lock until the server's keepalive ends it). Every 30 seconds the bot therefore asks the lease connection itself whether it still holds the lock, with a 10-second client-side deadline. No answer, an error or a missing lock counts as a lost lease, so a silent loss is detected within about 40 seconds. The bot then stops, destroys that connection instead of unlocking over it, and exits with status 1 as above. The same failure can leave workers' pool connections hanging so the pool never closes; the shutdown deadline then still exits with status 1. The pool enables client TCP keepalive so the bot notices a vanished peer sooner, and sets server-side `tcp_keepalives_idle=30`, `tcp_keepalives_interval=10` and `tcp_keepalives_count=3` so PostgreSQL ends an orphaned session, and frees its lease, in about a minute.
- **Stale holder.** If a restarted bot keeps logging the same `holderPid` for more than a few minutes while only the waiting instance runs, confirm the holder is idle from before the restart with `SELECT pid, state, backend_start, state_change, client_addr FROM pg_stat_activity WHERE pid = <holderPid>`, then run `SELECT pg_terminate_backend(<holderPid>)` as `tarubot`. The waiting writer acquires the lease on its next 5-second attempt.

The lease needs a direct PostgreSQL connection; a transaction-mode pool (PgBouncer) cannot hold a session lock.

**Runbook gate.** Before running migrate, import, activate or a restore against a database, confirm that no bot writer holds the lease. This read-only query must return no rows:

```sql
SELECT l.pid, a.application_name, a.client_addr, a.backend_start
FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory' AND l.granted
  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND l.classid = 0 AND l.objid = 714882494 AND l.objsubid = 1;
```

A single bigint advisory key appears in `pg_locks` as `classid` (high 32 bits), `objid` (low 32 bits) and `objsubid = 1`. A role without `pg_read_all_stats` sees null `client_addr` and `backend_start` for other roles' sessions; the `pid` row alone means a writer is connected. Import, activate and restore don't take the lease, so the gate is the operator's for them.

**Migration guard (since 2.16.0).** `migrate.js` applies every pending migration in one transaction and, when anything is pending, takes the writer lease for that transaction with a transaction-scoped lock (`pg_try_advisory_xact_lock(714882494)`). That lock conflicts with a bot's session lock on the same key and ends at COMMIT or ROLLBACK.
- **A running bot blocks it.** The run waits up to `MIGRATE_WRITER_WAIT_SECONDS` (default 90, at most 600) for a stopping bot, retrying every 2 seconds, then refuses with `busy`, naming the holder's database process, and changes nothing. So stop the bot before migrating, on every host: production and DevBot.
- **With nothing pending,** it never touches the lease, so a deployment's pre-deploy job succeeds while the previous bot still runs.
- **Restore point.** When it applies files, it prints `Migration writer lease acquired at <time>; applied <files>; committing at <time>.` from the database clock. No bot wrote after the first time, so it is the point-in-time-recovery restore point for that migration.

The gate above still comes first for a migration: the guard is a safety net, not a replacement for stopping the writer.

## Shutdown and restart

The Compose stop grace period is 30 seconds. SIGTERM stops new interaction handling and scheduling, aborts outstanding Lodestone requests and parser workers, waits up to 20 seconds for workers, then closes Discord/database resources. Persisted leases are recoverable after expiry. A worker must own its current lease before publishing results; superseded reconciliation is recomputed.

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

`check-restore` requires both databases to report this build's `SCHEMA_VERSION`. A **pre-migration** rehearsal therefore runs from the currently deployed build, or from the newer build with `--schema-version` naming the migration both databases still report, for example `bun dist/scripts/check-restore.js --schema-version 005_launch_access_policy.sql` before applying `006_guest_application_switch.sql` (2.15.0). Rehearse the new migration on the restored copy before applying it to the live database.

Under DevBot's profile, only `migrate.js --restore-rehearsal` may name the restore copy as `DATABASE_URL`, and with that flag it must end in `_restore_test`. Run the new release's migrate inside its image, deriving the URL in the container so no credential is printed:

```sh
docker compose -f docker-compose.yml -f docker-compose.devbot.yml run --rm --no-deps -T tarubot \
  sh -c 'DATABASE_URL="${DATABASE_URL%/*}/tarubot_dev_restore_test" exec bun dist/scripts/migrate.js --restore-rehearsal'
```

It must print `Schema ready.` Then migrate `tarubot_dev` itself with a plain `bun dist/scripts/migrate.js`. The production application never uses the flag; its migrations are rehearsed in `tarubot_rehearsal` ([MIGRATION.md](MIGRATION.md) E2).

For actual recovery, stop the writer, preserve the newest available state, restore/replay to the required recovery point, validate invariants and configuration, then restart exactly one writer. Unacknowledged outbound effects resume from durable jobs. Already acknowledged application decisions must be present before resuming.

## Managed PostgreSQL backups and recovery

Production uses the managed cluster's backups plus independent exports; [HOSTING.md](HOSTING.md#backups-and-recovery) describes them. (The retired App Platform setup's provider notes remain in [APP_PLATFORM.md](APP_PLATFORM.md#backups-pitr-and-recovery).)

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
