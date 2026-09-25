# TaruBot

A Bun/TypeScript Discord bot for Final Fantasy XIV Free Companies. It verifies character ownership through Lodestone biographies, reconciles FC access from complete roster observations, manages guest applications and nicknames, and maintains an exact, transactional gil ledger.

## Stack

| Component | Pinned version |
| --- | --- |
| Bun | 1.4.2 |
| TypeScript | 7.0.2 |
| Discord.js | 14.27.0 |
| Drizzle ORM / node-postgres | 0.45.3 / 8.23.0 |
| PostgreSQL | 18.4 |

The normal Compose services are `tarubot`, `nodestone`, and `postgres`. First-party production code is compiled ESM. Nodestone runs as a separately built, bounded HTTP sidecar, compiled from the **`vendor/nodestone` Git submodule**. Its update workflow follows upstream HEAD; each checked build records exact parser and selector revisions. See [the sidecar contract](docs/NODESTONE.md).

**Production** runs on a Linode Docker host with [`docker-compose.production.yml`](docker-compose.production.yml). That file holds the bot and Nodestone only, pinned to one release and attached to Linode managed PostgreSQL. See [HOSTING.md](docs/HOSTING.md). The DigitalOcean App Platform setup below is superseded, because the Lodestone refuses DigitalOcean's addresses. It is kept validated as a fallback.

For **DigitalOcean App Platform**, [`.do/app.yaml`](.do/app.yaml) attaches the owner-provisioned **Managed PostgreSQL cluster** `tarubot-pg` (database/user `tarubot`) and defines a single bot worker, an internal Nodestone service, and a migration job. It uses the published images and provider-bound database credentials/CA. The app is created from a derived worker-free phase and the worker is added only at activation; a PostgreSQL writer lease keeps exactly one bot writer. See [APP_PLATFORM.md](docs/APP_PLATFORM.md) for provider prerequisites, deployment phases, and single-writer updates.

Normal deployments pull **`ghcr.io/deconfined/tarubot:latest`** and **`ghcr.io/deconfined/tarubot-nodestone:latest`**. They need the Compose configuration and environment, rather than a source checkout. Feature branches run PR checks; merges to `main` publish tested AMD64/ARM64 images. See [CI_CD.md](docs/CI_CD.md) for tags, first-publication package access, and source-build overrides.

The sidecar checks both upstream repositories hourly and exposes update availability through `/health` and its logs. Refresh, verify, and deploy current upstream sources with:

```sh
bun run nodestone:check
bun run nodestone:update --deploy
```

For registry deployments, run dependency updates in a source checkout, merge the verified update PR, and pull its published images. The `--deploy` form performs an explicit local source rebuild using the Compose build override.

## Modular commands and events

Add a `*.command.ts` under `src/commands/`, a `*.event.ts` under `src/events/`, or a `*.component.ts` under `src/components/`. Discovery is recursive. Each command keeps its definition, execution, and autocomplete together; event modules have typed Discord arguments and independent handler IDs. Both runtime and command deployment use the same discovered inventory.

`src/bot/` provides the general module contracts, typed service registry, loader, and router. Modules can use Discord directly or declare injected capabilities. `src/main.ts` is the composition root. Builds clean generated output so removed modules cannot linger in production.

See [MODULES.md](docs/MODULES.md) for complete command/event/component examples and service injection, and [CONFIGURATION.md](docs/CONFIGURATION.md) for configuration-code commentary.

**Continuing in a new session? Start with [SESSION_HANDOFF.md](docs/SESSION_HANDOFF.md)** for the current merged/published/deployed state and immediate next steps. [OPEN_ITEMS.md](docs/OPEN_ITEMS.md) tracks the remaining requirements-backed v2 release work; [ROADMAP.md](docs/ROADMAP.md) records the planned v3–v6 dashboard, ModMail, and profile milestones. Every coherent change set increments SemVer and updates [CHANGELOG.md](CHANGELOG.md).

## Persistence

Drizzle ORM provides typed table mappings and queries over the existing node-postgres pool. Transactional decisions, audit, and outbox writes share one checked-out client; external IDs, bigint money, and UTC instants retain their exact representations. Numbered, checksum-verified SQL migrations own the schema and PostgreSQL constraints/triggers. See [PERSISTENCE.md](docs/PERSISTENCE.md) for schema changes, transaction binding, JSON handling, and the limited raw-SQL boundary.

## Development install and check

Clone with `git clone --recurse-submodules REPOSITORY_URL`, or initialize the submodule in an existing checkout before installing dependencies. Run these commands from this directory:

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run lint
bun run format:check
bun run test:unit
bun run test:contract
bun run test:docker
```

`test:docker` creates a uniquely named disposable PostgreSQL project, copies the selected SQL fixture into an ephemeral test container, runs the full test suite, and removes its test containers and volume. Its default is the locally supplied `tarubot_backup.sql`. CI instead generates synthetic input with `bun run test:fixture` and selects it through `LEGACY_FIXTURE_PATH=.cache/ci/legacy.sql`. Container images exclude SQL inputs, local environment files, repository metadata, caches, and import reports.

For an existing **disposable** test database whose name ends in `_test`:

```sh
TEST_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/tarubot_test bun run test:integration
```

The integration suite recreates that test database's `public` schema. Tests use controlled Discord/Lodestone fixtures and real PostgreSQL; live Discord acceptance is described in [VERIFICATION.md](docs/VERIFICATION.md).

## Discord setup

1. Create a development Discord application and install it in the test guild. Production cutover reuses the existing production application.
2. Install with the `bot` and `applications.commands` scopes.
3. Enable **Server Members Intent** in the Discord Developer Portal and grant the permissions listed below.

### Gateway intents

| Intent | Reason required |
| --- | --- |
| `Guilds` | Receive guild, role, and channel lifecycle updates and maintain the guild context needed by commands and managed-role checks. |
| `GuildMembers` — **Server Members Intent** (privileged) | Fetch complete member lists and observe joins, departures, role changes, and nickname changes for reconciliation. |

### Bot permissions

Grant the guild-level management permissions and the channel permissions in each configured destination.

| Permission | Reason required |
| --- | --- |
| **Manage Roles** | Manage Member/Guest/Officer/FC Leader roles and channel permission overwrites; remove the public View Channel default when onboarding is enabled. |
| **Manage Channels** | Create/reuse onboarding rooms, detach the lobby from gated categories, and maintain channel visibility. |
| **Manage Nicknames** | Apply and restore character-based nicknames when users enable nickname management. |
| **View Channel** | Access configured ledger, officer-notification, guest-review, and development test-plan channels. |
| **Send Messages** | Deliver ledger and officer notifications, guest review messages, and startup test plans. |
| **Embed Links** | Render startup-plan and `/version` embeds and other embedded bot responses. |
| **Attach Files** | Deliver structured command results and retain explicit bot access in managed onboarding channels. |
| **Read Message History** | Find existing bot-owned messages for notification deduplication and guest-review updates or repair. |

Keep bot **Administrator** disabled. Place its role above all four managed roles and the members whose nicknames it will manage. Access roles must be distinct ordinary roles without Administrator, Manage Server, or Manage Roles; onboarding also excludes Manage Channels. Give the bot's own role View Channel and ensure it can view/manage every channel it will secure. Discord's configured community-updates channel and its parent category are excluded from onboarding and its permission preflight. See [SETUP.md](docs/SETUP.md) for authority checks and the onboarding visibility matrix.

All commands are guild-only. Responses use the declared privacy defaults, with public replies enabled for the observed DevBot test guild through `PUBLIC_TEST_RESPONSES`. Review/ledger/officer messages go to their configured destinations. Notifications default to no parsed mentions.

## Configure and start

Create `.env` using `.env.example` and supply the token, application ID, and database password. Use a URL-safe PostgreSQL password; set the same credential in `DATABASE_URL` for local tools. Tokens are runtime configuration.

```sh
docker compose pull
docker compose up -d --wait postgres nodestone
docker compose run --rm --no-deps tarubot bun dist/scripts/migrate.js
docker compose run --rm --no-deps tarubot bun dist/scripts/register.js --guild YOUR_TEST_GUILD_ID
```

Stop the `tarubot` service before migrating an existing database: since 2.16.0, `migrate.js` refuses to apply a pending migration while a running bot holds the database writer lease ([OPERATIONS.md](docs/OPERATIONS.md#single-database-writer)).

For a fresh test guild, set `TEST_GUILD_ID` and `ENABLE_EFFECTS=true`, then:

```sh
docker compose up -d tarubot
docker compose logs -f tarubot
```

The configured **DevBot** test session uses `docker-compose.devbot.yml` and its own `tarubot_dev` database. See [DEV_GUILD.md](docs/DEV_GUILD.md) for its exact launch commands and completed live checks.

Use `/config fc link`, `/config roles member`, `/config roles guest`, and the three notification-channel configuration commands. `/config show` and `/config validate` explain enabled and blocked capabilities. Role configuration makes the selected roles authoritative bot-managed access roles. `/config role_layout enabled:true|false` (server managers with Manage Roles) turns automatic managed-role display and ordering on or off for the guild; it is on by default and off for imported guilds. `/config roles officer` accepts `adopt_holders:false` to bind an Officer role without granting its current holders officer access.

`/setup` creates or reuses Member, Guest, Officer, and FC Leader roles plus a lobby and a separate `#officer-chat`. Running it explicitly enables the server's onboarding policy: newcomers see the lobby, ordinary Members/Guests see ordinary managed channels, and Officers/FC Leaders see managed staff areas and the lobby. Existing private managed areas remain staff-only. Optional `lobby` and `officers` selections resolve existing-room ambiguity. The community-updates channel and its parent retain their existing policy. An optional in-game officer rank enables automatic bot-only Officer access. `/setup` also switches guest applications on (adopting the officer room as their review channel when none is set) and adopts current Officer-role holders, so it is not run in the imported production guild at launch. See [SETUP.md](docs/SETUP.md) for provisioning, migration, and policy ownership.

Every development startup posts the current responsibility-separated session plan to `#chat`. Update `test-plans/current.json` for the next session; see [TEST_PLANS.md](docs/TEST_PLANS.md).

For the supplied legacy data, follow the [migration runbook](docs/MIGRATION.md) before enabling effects. An imported guild has its own persisted activation flag as well as the process-wide `ENABLE_EFFECTS` setting, and starts with guest applications closed, the role layout off, and one first-activation grandfathering run owed.

**Production maintenance tools** never use this checkout's `.env`. They run from a clean clone of the deployed release as `env -i HOME="$HOME" PATH="$PATH" bun --env-file=PRODUCTION_ENV dist/scripts/TOOL.js`, with a production env file copied from [`production.env.example`](production.env.example) and an isolated Nodestone sidecar on `127.0.0.1:18080`. A deployment guard checks the application, test scope, guilds, and databases against one profile (production, rehearsal, or DevBot) before any I/O; see [CONFIGURATION.md](docs/CONFIGURATION.md#maintenance-tool-profiles) and [MIGRATION.md](docs/MIGRATION.md) E0.

To run the compiled bot or one-shot tools locally (development only), publish loopback-only dependency ports explicitly:

```sh
docker compose -f docker-compose.yml -f docker-compose.tools.yml up -d --wait postgres nodestone
bun run build
bun run start
```

The normal Compose configuration keeps dependency ports private. Use a separate database and development application for test-guild work.

## Daily use

- `/issue description:…` sends a problem report to TaruBot's maintainers, with a snapshot of the member's account and the bot's state (one per member per 10 minutes). Unexpected errors, failed jobs and repeated trouble are reported automatically. See [OPERATIONS.md](docs/OPERATIONS.md#issue-reports).
- `/version [commits]` shows the running SemVer and recent commits from GitHub (`main`): five by default, up to ten, with linked IDs/titles and `✓ verified` for verified signatures. History is cached for up to five minutes; version output remains available during GitHub outages. See [CHANGELOG.md](CHANGELOG.md) for the versioned development milestones.
- `/claim` resolves an ID/profile URL or an exact full-name/world match. Put its proof token in the public biography, then use `/verify`. Tokens expire after 30 minutes by default.
- `/characters`, `/main`, and `/nickname` manage local identity preferences. Existing-link operations use stored IDs and work during Lodestone outages.
- Imported users select `/main character:ID` and `/nickname enabled:true` explicitly to opt in to nicknames.
- `/refresh` returns an inspectable run ID; `/sync status` reports durable work. Officer-only `force:true` bypasses freshness while retaining rate limits and locks.
- `/apply` opens a short guest application form for visitors without a verified character while the guild's guest-application switch is on and a review channel and Guest role are set: introduce yourself and explain why you want to join (10–300 characters each). Answers go to the configured officer review room; submission grants no access. Officers use persistent Approve/Deny buttons or `/guest approve` and `/guest deny`. `/config guest_applications enabled:true|false` turns applications on or off separately from the review channel (`channel:#…`, `unset_channel:true`); switching on first validates the review channel that will take them, including one kept from an import. While applications are closed (imported guilds start switched off, with their legacy review channel kept), `/apply` explains that applications are not open before any form appears. `/guest status` reports progress and grant provenance, `/guest grant` and `/guest revoke` record explicit access decisions, and `/guest reset` removes them so FC membership and registered characters decide again.
- In every guild, with or without onboarding, trusted linked characters qualify their owners for Guest when current evidence excludes FC membership for all of them, or when no FC is linked. Any confirmed FC character gives Member instead, and any FC character with the configured officer rank adds Officer. Explicit Guest revocation remains authoritative; `/guest status` reports derived eligibility separately from durable grants.
- `/ledger deposit`, `/ledger withdraw`, `/ledger initialize`, and `/ledger adjust` require notes. `/ledger balance` and `/ledger history` expose immutable entries and notification delivery state.
- A confirmed departure requires two complete accepted observations at least 60 seconds apart. Former-member guest eligibility is scoped to the currently linked FC. Explicit revocation overrides guest eligibility; FC membership takes precedence.

## Operations

| Script | Purpose |
| --- | --- |
| `bun run db:migrate` | Apply checksum-verified, serialized migrations |
| `bun run commands:register --guild ID` | Reconcile test-guild commands to the declared inventory |
| `bun run commands:register --global` | Reconcile production commands during cutover |
| `bun run snapshot --dump FILE --output FILE` | Capture complete human membership, roles, join contexts, and nicknames |
| `bun run import:legacy --file FILE --dry-run` | Read-only SQL validation and mapping report |
| `bun run import:legacy --file FILE --snapshot FILE` | Atomically publish a validated legacy import |
| `bun run roster:acquire GUILD_ID` | Acquire/publish a complete roster during a maintenance window |
| `bun run preview GUILD_ID [--output PLAN.json]` | Read-only role/nickname preview plus the grandfathering plan and checksum, pending departures, and the guest-application, onboarding, and role-layout state (with what enabling the layout would change) |
| `bun run preview GUILD_ID --late-joiners` | Database-only list of humans who joined after first activation's enumeration and hold no grant or link |
| `bun run activate GUILD_ID --grandfather-plan SHA [--grandfather-plan-file PLAN.json] [--guest-applications closed\|open] [--requeue]` | Validate resources, grandfather an imported guild once from the confirmed plan, and enable its effects; a rerun on a live guild changes nothing without `--requeue` |
| `bun run jobs:retry GUILD_ID JOB_ID` | Retry delivery independently of a committed decision |
| `bun run commands:list [--guild ID ...] [--declared-scope global\|ID]` | Read back every command scope; exits 0 only when the declared scope matches and every other scope is empty |
| `bun run commands:clear-guild GUILD_ID --application APP_ID [--confirm FINGERPRINT]` | Dry-run, then fingerprint-confirmed removal of one guild scope's leftover commands |
| `bun run app:spec PHASE INPUT OUTPUT` | Derive the `foundation`, `maintenance`, or `full` App Platform spec |
| `bun dist/scripts/discord-inspect.js` | Read-only REST preflight: DevBot mode, or (production/rehearsal profile) intents, guilds, permissions, managed-role hierarchy, and channel access with `--guild ID --dump FILE`, plus repeatable `--role ID` for roles the dump does not name (the Officer role) |

One-shot commands execute compiled scripts; run `bun run build` after source changes. The equivalent container commands use `bun dist/scripts/NAME.js`. The `bun run` forms are for development: production and rehearsal tools run the compiled files directly with `bun --env-file` (see above).

Local probes are `/health/live` and `/health/ready` on port 3000 inside the bot container. Readiness depends on initialization, schema/database availability, the database writer lease, and Discord connectivity; a second bot process against the same database stays unready until the first releases the lease. Capability metrics include pending/blocked work, accepted-roster age, and degraded FCs; Lodestone outages preserve available local operations. The sidecar exposes `/health` on port 8080.

The bot handles SIGTERM with a 30-second container stop period. Decisions, jobs, and outbox deliveries remain in PostgreSQL across restarts. [Recovery and backup procedures](docs/OPERATIONS.md) explain inspection, retries, and restoration.

## Layout

- `src/domain`: identifiers, exact money, authorization, access and transition policy.
- `src/application`: transactional operations and reconciliation.
- `src/bot`: reusable module discovery, contracts, service injection, and interaction dispatch.
- `src/commands`, `src/events`, `src/components`: independently loaded feature adapters.
- `src/discord`: Discord effects, shared option builders, selectors, and reply presentation.
- `src/infrastructure`: Drizzle/PostgreSQL schema and connection boundary, plus typed Nodestone HTTP adaptation.
- `src/jobs`: recoverable work leases, deduplication, and outbox dispatch.
- `src/import`: bounded MySQL/MariaDB dump decoding and atomic import.
- `sidecar`: Nodestone worker isolation, source compatibility transformations, and transport controls.
- `vendor/nodestone`: upstream parser Git submodule, required for local and Docker builds.
- `migrations`, `scripts`, `tests`, `docs`: schema, operational tooling, verification, and runbooks.

## License

TaruBot's first-party code is licensed under the [GNU Affero General Public License v3.0](LICENSE), SPDX **AGPL-3.0-only**. `/version` provides source-code and license links. The Nodestone submodule and other third-party dependencies retain their own licenses.
