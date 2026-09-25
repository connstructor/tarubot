# TaruBot — working guide for Claude Code

@AGENTS.md

AGENTS.md holds the repository rules: branching, SemVer, signing, Drizzle, migrations. This file adds what a Claude session needs to work here. For current state, start with docs/SESSION_HANDOFF.md. The backlog is in docs/OPEN_ITEMS.md, and the owner's policy decisions are in REQUIREMENTS.md, including its "Approved launch amendments (2026-09-23)", "Approved reply-session amendments (2026-09-24)", "Approved hosting amendment (2026-09-24)" (with its 2026-09-25 follow-up), "Approved Lodestone amendments (2026-09-24)", "Approved issue-reporting amendments (2026-09-24)", and "Approved public-suggestion amendments (2026-09-25)".

## Project map

- `src/main.ts`: composition root. It wires the database, Discord gateway, Lodestone adapter, services, and job queue.
- `src/bot/`: module contracts, recursive discovery, the service registry, and the router. The router handles actor resolution, authorization, acknowledgement, and the optional pre-modal check a modal command can declare with `beforeModal`. `shape.ts` refuses a subcommand or option the release doesn't declare (another release's registration) with the stale card.
- `src/commands/<feature>/*.command.ts` (one root command per file), `src/events/*.event.ts`, and `src/components/*.component.ts`: all discovered automatically. See docs/MODULES.md.
- `src/application/`: durable business operations.
  - `service.ts`: facade covering claims, ledger, guests, and config, including `/config role_layout` and `adopt_holders`.
  - `synchronization.ts`: roster acquisition and per-user reconciliation.
  - `guild-access.ts`: channel policy.
  - `role-administration.ts`: `/setup` and officers.
  - `access-facts.ts` and `rank-policy.ts`: eligibility inputs.
  - `lifecycle.ts`: readiness, startup, and the database writer lease.
  - `activation.ts` and `grandfathering.ts`: imported-guild activation and first-activation grandfathering.
  - `heartbeat.ts`: the healthchecks.io dead-man's switch (2.22.0), pinged every five minutes while ready (`HEALTHCHECKS_PING_URL`; empty is off).
  - `issue-reports.ts` and `recent-logs.ts`: issue reports to the private GitHub repository (`/issue`, unexpected errors, failed jobs, repeated trouble). Pure helpers such as redaction and fingerprints live in `src/domain/reports.ts`, and the client in `src/infrastructure/github/issues.ts`.
  - `suggestions.ts`: `/suggest` (2.26.0), public feature suggestions posted at once to `deconfined/tarubot` as the TaruBot GitHub App (`src/infrastructure/github/app.ts` signs the JWT and mints an installation token per post), with limits counted from the audit table. The pure cleaning, public format and final check live in `src/domain/suggestions.ts`.
- `src/domain/`: pure logic.
  - `policy.ts` computes desired access (the multi-character union, ROLE-07).
  - `grandfathering.ts` holds the plan and checksum, and `role-layout.ts` the layout planner.
  - `values.ts` holds `Failure`, `json`, and ID parsing.
- `src/config/`: `env.ts` validates runtime configuration. `deployment.ts` is the maintenance tools' deployment-identity guard; since 2.26.0 its production guild list also gates `/suggest` at runtime.
- `src/discord/`: the gateway adapter, option builders, and replies. `inspection.ts` holds pure helpers over raw REST payloads.
- `src/jobs/`: `queue.ts` (leases, generation fences, `jobOutcome` log levels) and `dispatch.ts` (job kinds, and the authoritative role-layout gate).
- `src/infrastructure/postgres/`: `schema.ts` holds the Drizzle mappings. `database.ts` handles migrations, the startup schema check (`SCHEMA_VERSION`), and `orm(client)`.
- `src/import/`: the legacy MariaDB importer. Imports keep the legacy review channel with the guest-application switch off, and start with layout off and grandfathering pending.
- `scripts/`: one-shot operator tools: migrate, register, commands (scope read-back and cleanup), snapshot, import, acquire, preview, activate, retry, check-restore, discord-inspect, discord-smoke, selectors-update (the bundled selector set), and host-env-backup (the encrypted off-host copy of the production `.env`, run on the operator machine). Host-side files live in `ops/`: `backup.sh` (the daily encrypted dump to Linode Object Storage, 04:30 UTC from `tarubot`'s crontab), `bucket-lifecycle.xml` and `age-recipients.txt`.
- `src/infrastructure/lodestone/`: the Lodestone adapter, in the bot process since 2.21.0 (there is no sidecar and no Nodestone).
  - `client.ts` (`Lodestone`): parse slots (`LODESTONE_CONCURRENCY`, waiting rather than refusing), retries, reachability, and validation of every parsed field.
  - `runner.ts` fetches under the network policy (region, `gate.ts` spacing and 429 cooldown, body bound, private-profile detection), then parses in a fresh worker (`worker.ts`), terminated at the deadline.
  - `parser.ts` is TaruBot's own parser: it applies `lodestone-css-selectors` definitions with linkedom and matched Nodestone's output on live pages. `pages.ts` says which page, files and keys each operation reads.
  - Selectors follow upstream HEAD live, in memory: `selectors.ts` downloads and validates them, and `upstreams.ts` checks HEAD. `bundled.ts` is the set shipped with the release (`bun run selectors:update` refreshes it).
- `migrations/NNN_*.sql`: the schema authority. Never edit an applied migration. `SCHEMA_VERSION` must name the newest file (currently `008_issue_reports.sql`; 2.17.x required `007_profile_checks.sql`).

## Commands

```sh
bun install --frozen-lockfile
bun run typecheck && bun run lint && bun run format:check && bun run build
bun run test:unit && bun run test:contract          # fast, no database
bun run test:docker                                  # full suite: disposable PostgreSQL + supplied tarubot_backup.sql
bun run test:fixture && LEGACY_FIXTURE_PATH=.cache/ci/legacy.sql bun run test:docker   # synthetic CI input
CI_BASE_SHA=$(git rev-parse origin/main) bun run ci:version                           # the gate CI runs last
```

Run a single file with `bun test tests/unit/<name>.test.ts`. Integration tests need PostgreSQL, so run them through `test:docker`.

## Every change set

1. Branch from `origin/main`. Local `main` may lag.
2. Bump `package.json`. Add `## X.Y.Z — Title` to CHANGELOG.md and update its current-version sentence.
3. Sync the version everywhere it appears:
   - `test-plans/current.json`;
   - the current-version sentences in docs/CONFIGURATION.md and docs/PERSISTENCE.md.

   Record the evidence in docs/VERIFICATION.md, and state changes in docs/OPEN_ITEMS.md and docs/DEV_GUILD.md.
4. In `test-plans/current.json`, each actor's list must fit in one 1,024-character embed field (`tests/unit/test-session.test.ts`).
5. Run the checks above, then commit with the configured SSH signing key (`~/.ssh/id_git`, `gpg.format=ssh`; see docs/SESSION_HANDOFF.md). If signing fails, ask the owner; never create an unsigned commit. Push or open PRs only when the owner asks.
6. Merging to `main` requires a PR, a strict up-to-date `CI result`, signed commits, and the CodeQL gate (no new high-severity security alerts or error-level results). Only merge and squash are allowed. Actions must be pinned to full commit SHAs.

## DevBot operations

- Always pass both Compose files: `docker compose -f docker-compose.yml -f docker-compose.devbot.yml …`. That targets the `tarubot_dev` database and test guild `1040379370159743139`. Pin releases with `TARUBOT_IMAGE_TAG=X.Y.Z`.
- Docker on this Linux machine needs the `docker` group. When the session predates the group change, run Compose through `sg docker -c '…'`; don't change group membership yourself.
- The tool guard's DevBot profile requires local tools to name `…/tarubot_dev`, on loopback or `postgres`, with an empty CA. The one exception is `migrate.js --restore-rehearsal`, which requires a `*_restore_test` copy instead. If the owner's `.env` still says `…/tarubot`, local tools are refused. Changing it is the owner's action; never edit `.env` yourself.
- Updating DevBot (see docs/OPERATIONS.md and docs/DEV_GUILD.md):
  1. Stop `tarubot`.
  2. `pg_dump` to `.cache/backups/tarubot_dev-before-X.Y.Z-<sha>.dump`.
  3. Restore it into `tarubot_dev_restore_test` and run `dist/scripts/check-restore.js`. Use the currently deployed build, or the new build with `--schema-version <current head>.sql`, because both databases are still on the old schema.
  4. If there is a migration, rehearse it on the restore first: `docker compose -f docker-compose.yml -f docker-compose.devbot.yml run --rm --no-deps -T tarubot sh -c 'DATABASE_URL="${DATABASE_URL%/*}/tarubot_dev_restore_test" exec bun dist/scripts/migrate.js --restore-rehearsal'` must print `Schema ready.` Then run a plain `dist/scripts/migrate.js` against `tarubot_dev`.
  5. `up -d --wait --remove-orphans tarubot` (`--remove-orphans` clears a pre-2.21.0 sidecar container).
  6. Register guild commands, then confirm with `dist/scripts/commands.js list`.
  7. Check readiness (including `writerLease`), logs, and the plan posted in #chat.
- Run one-off tools inside the image: `… run --rm --no-deps -T tarubot bun dist/scripts/<tool>.js`. For other database names, derive the URL inside the container (`${DATABASE_URL%/*}/<db>`) instead of printing credentials.
- Ask the owner before stopping or restarting DevBot, running migrations, or writing to Discord. Read-only checks don't need approval.
- `.env` belongs to DevBot (app `943291473477128243`). Never put production credentials in it.

## Production and cutover

- Production went live on 2026-09-24. Since that evening it runs on the Linode Docker host `tarubot@tarubot.deconfined.com` (`~/tarubot`, `docker-compose.production.yml`, a mode-600 `.env`), attached to Linode managed PostgreSQL `tarubot-pgsql` (database and user `tarubot`, direct port 27520, never the 27521 pool). See docs/HOSTING.md. App Platform is retired (2.21.0): the Lodestone returns 403 to DigitalOcean's addresses, and with the parser inside the bot it could not serve as a fallback. docs/APP_PLATFORM.md stays as the record; its spec and tooling were removed.
- Production tools never run from this checkout or its `.env`. They run from a clean clone of the deployed release as `env -i HOME="$HOME" PATH="$PATH" bun --env-file="$HOME/tarubot-cutover/production.env" dist/scripts/<tool>.js`, never `bun run`. The file is a copy of `production.env.example`. Before the window, token use is limited to read-only REST inspection and rehearsal logins against `tarubot_rehearsal`, under `TARUBOT_ENVIRONMENT=rehearsal`, which the guard keeps read-only on Discord. See docs/MIGRATION.md E0–E2.
- The production application `965294750741692416` must not be installed in the dev guild; the owner removes it before cutover.
- Production registers commands only with `register.js --global`; the guard refuses a production `--guild` registration, which would show every command twice.
- Cutover rules live in the REQUIREMENTS.md launch and reply-session amendments and docs/MIGRATION.md. Read them before touching import, activation, access policy, or tooling:
  - registered-user Guest applies in every guild, as the union over linked characters;
  - first activation writes one-time `grandfathered` grants from a checksum-confirmed preview;
  - the role layout is off for imported guilds;
  - guest applications and onboarding are off, and `/setup` is not run in production. The import keeps the legacy review channel with the guest-application switch off; `activate.js` changes the switch only with `--guest-applications open|closed`, and reopening after launch is `/config guest_applications enabled:true`;
  - officers come from the in-game rank, with the legacy role bound `adopt_holders:false`. At W15 the order is `/config officer_rank`, then `/officer grant` for each approved exception (recorded while no role is bound), then the binding, whose repair pass would otherwise strip exceptions;
  - the order is acquire twice → preview → activate → register → full deploy;
  - the cutover used release 2.16.0 (2.14.0 added the reply embeds; 2.15.0 the reply-session fixes and features, with migration 006; 2.16.0 the deployment safeguards: the migration guard, the schema re-check after the writer lease, and the stale card for undeclared command shapes). After launch: 2.16.1 moved the docs and tooling to the Linode host, 2.17.0 hardened Lodestone handling (migration 007), 2.18.0 added the issue reporter, 2.19.0 live selectors, 2.20.0 TaruBot's own parser, 2.21.0 moved the parser into the bot (no sidecar), and 2.22.0 adds the healthchecks.io heartbeat; then OPS-10/OPS-11.
- Nothing here authorizes provider actions. Cluster, app, trusted-source, token, and registration changes each need the owner's explicit go-ahead.

## Gotchas

- The shell is zsh:
  - A variable holding a command doesn't word-split; wrap the command in a function instead.
  - `$var:l…` and `$var:s…` are parsed as modifiers, so write `${var}:latest`.
- Bun auto-loads `.env` for every `bun` command run in this directory.
  - A `bun run` child reloads it even when the parent used `--env-file`.
  - Shell exports override an env file.
  - The tool guard refuses production and rehearsal runs that could merge these values.
- One bot process writes to a database. It holds the writer lease (PostgreSQL advisory lock `714882494`) from before login until shutdown, and checks the lease session every 30 seconds, exiting with status 1 if it errors, goes silent or no longer holds the lock (also when shutdown then hangs, through the 27-second deadline). Every lease statement, including each wait attempt, has a 10-second client-side deadline; a waiting process whose session goes silent exits with status 1 too. A second instance logs `Waiting for the database writer lease…`, stays unready (readiness 503) and does nothing until the lease frees, then checks the schema again before logging in. Since 2.16.0 `migrate.js` takes the same lease (transaction-scoped) whenever a migration is pending, waits up to `MIGRATE_WRITER_WAIT_SECONDS` (90) for a stopping bot and then refuses, so stop the bot before migrating; with nothing pending it ignores the lease. Before migrate, import, activate, or restore, still check `pg_locks` for that key (docs/OPERATIONS.md).
- Queue waits (`busy`, `ordered`, `cooldown`, `superseded`, and since 2.17.0 the Lodestone's `rate_limited`) are expected and log at debug. `lease_lost` logs at warn, and only terminal failures log at error. Throttling shows instead as one bot log line per Lodestone 429 ("The Lodestone throttled TaruBot") and in `/health/ready` (`lodestone.cooldownSeconds`).
- Profile refreshes (2.17.0):
  - The scheduler uses `scheduleJob`, which never touches an active job; `enqueue` pulls one forward. It stamps `characters.profile_retry_at` an hour ahead for each character it queues.
  - A private profile (`private_profile`) completes the job as `{status: "private"}` and waits for the profile interval.
  - A 404 follows the two-404 rule (`Service.profileMissing`). The first is recorded in `profile_missing_at`. One at least an hour later ends every active link through the same `endLink` path as `/unclaim`, audited with a null actor, with an `officer.notify` per link.
- Guild configuration changes (`/config` fields, officer rank, FC unlink, `/setup`, activation) bump `guilds.revision` and queue a full repair pass (`reconcile.guild`). A repeat that matches what is saved is a no-op (no revision bump, audit or repair pass) for `/config officer_rank` (the saved rank, or `unset_rank` with none set), `/config guest_applications`, `/config fc link` naming the linked FC, and an `activate.js` rerun on a live guild without `--requeue`. Role and channel fields save again even when unchanged. The exception is `/config role_layout`: it bumps the revision (fencing in-flight work) but queues no repair pass. Enabling queues one `roles.layout` pass, disabling queues nothing, and repeating the current value changes nothing (no revision bump and no audit).
- `/config guest_applications` saves `enabled`, `channel` and `unset_channel` in one revision with one repair pass, auditing each changed setting. It validates the channel that will take applications (a named one, or the stored one, such as an imported legacy channel, when the call switches applications on), never when switching off or unsetting, and refuses with the "Server settings changed" conflict if, under the row lock, the change would leave applications on with a channel other than the one it validated. No `/config` option is named `clear`: unsetting uses `unset_channel`, `unset_role` or `unset_rank`.
- Member overrides (`/officer grant|revoke|reset`, `/guest grant|revoke|reset`) leave the revision alone and queue `reconcile.user` for that member. The `/officer` trio needs a server manager (Manage Server and Manage Roles), and while an Officer role is bound each first runs `validateRole` on it: the bot must manage it and the manager's highest role must be above it (the server owner is exempt). The `/guest` trio needs bot officer access. `/officer reset` deletes the officer override so the rank decides, and like a revoke it works for a member who left. `/guest reset` lifts the revocation and ends every active grant of any provenance (kept as history); grandfathering still counts ended grants (basis `existing_grant`), so a reset before first activation stands. A reset with nothing to remove audits and queues nothing.
- Issue reports (2.18.0):
  - The composition root wraps the reporter: every error-level report also calls `IssueReports.error`, and every job that ends failed at error level calls `jobFailed`. Both never reject; `issue.report` failures never report themselves.
  - Reports are saved in `issue_reports` first and delivered by `issue.report` jobs. Repeats of a fingerprint count occurrences, and context is re-collected at most once a minute. Delivery opens the issue, comments on repeats at most hourly, and opens a new issue after a close. Daily caps (10 issues, 50 comments) apply to automatic reports only.
  - The lifecycle's `tick` option runs the trouble checks every five minutes. `GITHUB_REPORTS_TOKEN` empty means saved, not sent. DevBot's `.env` needs the owner to add the token.
- Public suggestions (2.26.0):
  - Text reaches the public repository only through `normalise`, `clean` (the shared `PUBLIC_PATTERNS`, repeated until nothing changes) and `assertPublic`, never through `IssueReports`. A change to the rules changes both the cleaner and the check.
  - `/suggest` needs the bound Member or Guest role in an allowlisted server (production's `deployments.production.guilds`, or DevBot's test guild). Officer access alone doesn't qualify.
  - `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_PRIVATE_KEY` are production-only: they go in `docker-compose.production.yml` and the host's `.env`, never in `docker-compose.yml` or DevBot's `.env`. DevBot previews into the reports repository with `GITHUB_REPORTS_TOKEN`. Either app setting empty switches `/suggest` off.
  - Nothing is saved first. Limits come from `audit` rows (`suggestion.posted`, `suggestion.unconfirmed`); any GitHub error other than `rate_limited`, `invalid_data` or `configuration` writes `suggestion.unconfirmed`.
  - Any new workflow gated on the OWNER, MEMBER or COLLABORATOR association must also skip issues carrying `SUGGESTION_MARKER` ("Suggested in Discord with TaruBot"), as `claude.yml` does. A trusted `@claude` comment on a `from-discord` issue still hands the member's text to the agent.
- With `role_layout_enabled` off, `roles.layout` jobs complete as `skipped: layout disabled`. That is intended, not a failure.
- `/setup` enables onboarding, switches guest applications on (adopting the officer room as the review channel when none is set, and validating a kept one first), and adopts every Officer-role holder.
- Leave the old `feat/lobby-access` stash alone. It has been superseded. It exists only in the original Mac clone; this Linux clone has no stashes.
