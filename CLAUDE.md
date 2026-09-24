# TaruBot — working guide for Claude Code

@AGENTS.md

AGENTS.md holds the repository rules: branching, SemVer, signing, Drizzle, migrations. This file adds what a Claude session needs to work here. For current state, start with docs/SESSION_HANDOFF.md. The backlog is in docs/OPEN_ITEMS.md, and the owner's policy decisions are in REQUIREMENTS.md, including its "Approved launch amendments (2026-09-23)".

## Project map

- `src/main.ts`: composition root. It wires the database, Discord gateway, Nodestone client, services, and job queue.
- `src/bot/`: module contracts, recursive discovery, the service registry, and the router. The router handles actor resolution, authorization, acknowledgement, and the optional pre-modal check a modal command can declare with `beforeModal`.
- `src/commands/<feature>/*.command.ts` (one root command per file), `src/events/*.event.ts`, and `src/components/*.component.ts`: all discovered automatically. See docs/MODULES.md.
- `src/application/`: durable business operations.
  - `service.ts`: facade covering claims, ledger, guests, and config, including `/config role_layout` and `adopt_holders`.
  - `synchronization.ts`: roster acquisition and per-user reconciliation.
  - `guild-access.ts`: channel policy.
  - `role-administration.ts`: `/setup` and officers.
  - `access-facts.ts` and `rank-policy.ts`: eligibility inputs.
  - `lifecycle.ts`: readiness, startup, and the database writer lease.
  - `activation.ts` and `grandfathering.ts`: imported-guild activation and first-activation grandfathering.
- `src/domain/`: pure logic.
  - `policy.ts` computes desired access (the multi-character union, ROLE-07).
  - `grandfathering.ts` holds the plan and checksum, and `role-layout.ts` the layout planner.
  - `values.ts` holds `Failure`, `json`, and ID parsing.
- `src/config/`: `env.ts` validates runtime configuration. `deployment.ts` is the maintenance tools' deployment-identity guard.
- `src/discord/`: the gateway adapter, option builders, and replies. `inspection.ts` holds pure helpers over raw REST payloads.
- `src/jobs/`: `queue.ts` (leases, generation fences, `jobOutcome` log levels) and `dispatch.ts` (job kinds, and the authoritative role-layout gate).
- `src/infrastructure/postgres/`: `schema.ts` holds the Drizzle mappings. `database.ts` handles migrations, the startup schema check (`SCHEMA_VERSION`), and `orm(client)`.
- `src/import/`: the legacy MariaDB importer. Imports start with applications closed, layout off, and grandfathering pending.
- `scripts/`: one-shot operator tools: migrate, register, commands (scope read-back and cleanup), snapshot, import, acquire, preview, activate, retry, check-restore, discord-inspect, discord-smoke, and app-spec (App Platform phases).
- `sidecar/` and `vendor/nodestone`: the bounded Lodestone parser service. Update it only through `bun run nodestone:update`.
- `migrations/NNN_*.sql`: the schema authority. Never edit an applied migration. `SCHEMA_VERSION` must name the newest file (currently `005_launch_access_policy.sql`).

## Commands

```sh
git submodule update --init --recursive && bun install --frozen-lockfile
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
   - `.do/app.yaml` `tag: &release` (unit-tested);
   - `test-plans/current.json`;
   - the current-version sentences in docs/APP_PLATFORM.md, docs/CONFIGURATION.md, and docs/PERSISTENCE.md.

   Record the evidence in docs/VERIFICATION.md, and state changes in docs/OPEN_ITEMS.md and docs/DEV_GUILD.md.
4. In `test-plans/current.json`, each actor's list must fit in one 1,024-character embed field (`tests/unit/test-session.test.ts`).
5. Run the checks above, then commit with the configured SSH signing key (`~/.ssh/id_git`, `gpg.format=ssh`; see docs/SESSION_HANDOFF.md). If signing fails, ask the owner; never create an unsigned commit. Push or open PRs only when the owner asks.
6. Merging to `main` requires a PR, a strict up-to-date `CI result`, signed commits, and the CodeQL gate (no new high-severity security alerts or error-level results). Only merge and squash are allowed. Actions must be pinned to full commit SHAs.

## DevBot operations

- Always pass both Compose files: `docker compose -f docker-compose.yml -f docker-compose.devbot.yml …`. That targets the `tarubot_dev` database and test guild `1040379370159743139`. Pin releases with `TARUBOT_IMAGE_TAG=X.Y.Z`.
- The tool guard's DevBot profile requires local tools to name `…/tarubot_dev`, on loopback or `postgres`, with an empty CA. The one exception is `migrate.js --restore-rehearsal`, which requires a `*_restore_test` copy instead. If the owner's `.env` still says `…/tarubot`, local tools are refused. Changing it is the owner's action; never edit `.env` yourself.
- Updating DevBot (see docs/OPERATIONS.md and docs/DEV_GUILD.md):
  1. Stop `tarubot`.
  2. `pg_dump` to `.cache/backups/tarubot_dev-before-X.Y.Z-<sha>.dump`.
  3. Restore it into `tarubot_dev_restore_test` and run `dist/scripts/check-restore.js`. Use the currently deployed build, or the new build with `--schema-version <current head>.sql`, because both databases are still on the old schema.
  4. If there is a migration, rehearse it on the restore first: `docker compose -f docker-compose.yml -f docker-compose.devbot.yml run --rm --no-deps -T tarubot sh -c 'DATABASE_URL="${DATABASE_URL%/*}/tarubot_dev_restore_test" exec bun dist/scripts/migrate.js --restore-rehearsal'` must print `Schema ready.` Then run a plain `dist/scripts/migrate.js` against `tarubot_dev`.
  5. `up -d --wait tarubot nodestone`.
  6. Register guild commands, then confirm with `dist/scripts/commands.js list`.
  7. Check readiness (including `writerLease`), logs, and the plan posted in #chat.
- Run one-off tools inside the image: `… run --rm --no-deps -T tarubot bun dist/scripts/<tool>.js`. For other database names, derive the URL inside the container (`${DATABASE_URL%/*}/<db>`) instead of printing credentials.
- Ask the owner before stopping or restarting DevBot, running migrations, or writing to Discord. Read-only checks don't need approval.
- `.env` belongs to DevBot (app `943291473477128243`). Never put production credentials in it.

## Production and cutover

- Production is App Platform attached to the owner-provisioned Managed PostgreSQL cluster `tarubot-pg` (database and user `tarubot`). The app is created from the worker-free `foundation` phase (`scripts/app-spec.ts`); the worker arrives only at activation. See docs/APP_PLATFORM.md.
- Production tools never run from this checkout or its `.env`. They run from a clean clone of the deployed release as `env -i HOME="$HOME" PATH="$PATH" bun --env-file="$HOME/tarubot-cutover/production.env" dist/scripts/<tool>.js`, never `bun run`. The file is a copy of `production.env.example`. Before the window, token use is limited to read-only REST inspection and rehearsal logins against `tarubot_rehearsal`, under `TARUBOT_ENVIRONMENT=rehearsal`, which the guard keeps read-only on Discord. See docs/MIGRATION.md E0–E2.
- The production application `965294750741692416` must not be installed in the dev guild; the owner removes it before cutover.
- Production registers commands only with `register.js --global`; the guard refuses a production `--guild` registration, which would show every command twice.
- Cutover rules live in the REQUIREMENTS.md launch amendments and docs/MIGRATION.md. Read them before touching import, activation, access policy, or tooling:
  - registered-user Guest applies in every guild, as the union over linked characters;
  - first activation writes one-time `grandfathered` grants from a checksum-confirmed preview;
  - the role layout is off for imported guilds;
  - `/apply` and onboarding are off, and `/setup` is not run in production;
  - officers come from the in-game rank, with the legacy role bound `adopt_holders:false`. At W15 the order is `/config officer_rank`, then `/officer grant` for each approved exception (recorded while no role is bound), then the binding, whose repair pass would otherwise strip exceptions;
  - the order is acquire twice → preview → activate → register → full deploy;
  - the cutover uses a published release ≥ 2.15.0 (2.14.0 adds the reply embeds; 2.15.0 adds the OPS-10/OPS-11 telemetry and officer alerts).
- Nothing here authorizes provider actions. Cluster, app, trusted-source, token, and registration changes each need the owner's explicit go-ahead.

## Gotchas

- The shell is zsh:
  - A variable holding a command doesn't word-split; wrap the command in a function instead.
  - `$var:l…` and `$var:s…` are parsed as modifiers, so write `${var}:latest`.
- Bun auto-loads `.env` for every `bun` command run in this directory.
  - A `bun run` child reloads it even when the parent used `--env-file`.
  - Shell exports override an env file.
  - The tool guard refuses production and rehearsal runs that could merge these values.
- One bot process writes to a database. It holds the writer lease (PostgreSQL advisory lock `714882494`) from before login until shutdown, and checks the lease session every 30 seconds, exiting with status 1 if it errors, goes silent or no longer holds the lock (also when shutdown then hangs, through the 27-second deadline). Every lease statement, including each wait attempt, has a 10-second client-side deadline; a waiting process whose session goes silent exits with status 1 too. A second instance logs `Waiting for the database writer lease…`, stays unready (readiness 503) and does nothing until the lease frees. Before migrate, import, activate, or restore, check `pg_locks` for that key (docs/OPERATIONS.md).
- Queue waits (`busy`, `ordered`, `cooldown`, `superseded`) are expected and log at debug. `lease_lost` logs at warn, and only terminal failures log at error.
- Guild configuration changes (`/config` fields, officer rank, FC unlink, `/setup`, activation) bump `guilds.revision` and queue a full repair pass (`reconcile.guild`). The exception is `/config role_layout`: it bumps the revision (fencing in-flight work) but queues no repair pass. Enabling queues one `roles.layout` pass, disabling queues nothing, and repeating the current value changes nothing (no revision bump and no audit).
- With `role_layout_enabled` off, `roles.layout` jobs complete as `skipped: layout disabled`. That is intended, not a failure.
- `/setup` enables onboarding, opens `/apply` (it adopts the officer room as the review channel), and adopts every Officer-role holder.
- Leave the old `feat/lobby-access` stash alone. It has been superseded.
