# TaruBot

A Bun/TypeScript Discord bot for Final Fantasy XIV Free Companies. It verifies character ownership through Lodestone biographies, reconciles FC access from complete roster observations, manages guest applications and nicknames, and maintains an exact, transactional gil ledger.

## Stack

| Component | Pinned version |
| --- | --- |
| Bun | 1.4.2 |
| TypeScript | 7.0.2 |
| Discord.js | 14.27.0 |
| PostgreSQL | 18.4 |

The normal Compose services are `tarubot`, `nodestone`, and `postgres`. First-party production code is compiled ESM. Nodestone runs as a separately built, bounded HTTP sidecar, compiled from the **`vendor/nodestone` Git submodule**. Its update workflow follows upstream HEAD; each checked build records exact parser and selector revisions. See [the sidecar contract](docs/NODESTONE.md).

Normal deployments pull **`ghcr.io/connstructor/tarubot:latest`** and **`ghcr.io/connstructor/tarubot-nodestone:latest`**. They need the Compose configuration and environment, rather than a source checkout. Feature branches run PR checks; merges to `main` publish tested AMD64/ARM64 images. See [CI_CD.md](docs/CI_CD.md) for tags, first-publication package access, and source-build overrides.

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

See [OPEN_ITEMS.md](docs/OPEN_ITEMS.md) for the remaining requirements-backed implementation, live acceptance, and production-delivery work. Every coherent change set increments SemVer and updates [CHANGELOG.md](CHANGELOG.md).

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
| **Manage Roles** | Create or reuse, rename, arrange, and display managed roles separately; assign and remove Member, Guest, Officer, and FC Leader roles during reconciliation. |
| **Manage Nicknames** | Apply and restore character-based nicknames when users enable nickname management. |
| **View Channel** | Access configured ledger, officer-notification, guest-review, and development test-plan channels. |
| **Send Messages** | Deliver ledger and officer notifications, guest review messages, and startup test plans. |
| **Embed Links** | Render startup-plan and `/version` embeds and other embedded bot responses. |
| **Read Message History** | Find existing bot-owned messages for notification deduplication and guest-review updates or repair. |

Keep bot **Administrator** disabled. Place its role above all four managed roles and the members whose nicknames it will manage. Member/guest roles must be distinct ordinary roles without Administrator, Manage Server, or Manage Roles. See [SETUP.md](docs/SETUP.md) for officer authorization, role-selection authority, and server-manager requirements.

All commands are guild-only. Responses use the declared privacy defaults, with public replies enabled for the observed DevBot test guild through `PUBLIC_TEST_RESPONSES`. Review/ledger/officer messages go to their configured destinations. Notifications default to no parsed mentions.

## Configure and start

Create `.env` using `.env.example` and supply the token, application ID, and database password. Use a URL-safe PostgreSQL password; set the same credential in `DATABASE_URL` for local tools. Tokens are runtime configuration.

```sh
docker compose pull
docker compose up -d --wait postgres nodestone
docker compose run --rm --no-deps tarubot bun dist/scripts/migrate.js
docker compose run --rm --no-deps tarubot bun dist/scripts/register.js --guild YOUR_TEST_GUILD_ID
```

For a fresh test guild, set `TEST_GUILD_ID` and `ENABLE_EFFECTS=true`, then:

```sh
docker compose up -d tarubot
docker compose logs -f tarubot
```

The configured **DevBot** test session uses `docker-compose.devbot.yml` and its own `tarubot_dev` database. See [DEV_GUILD.md](docs/DEV_GUILD.md) for its exact launch commands and completed live checks.

Use `/config fc link`, `/config roles member`, `/config roles guest`, and the three notification-channel configuration commands. `/config show` and `/config validate` explain enabled and blocked capabilities. Role configuration makes the selected roles authoritative bot-managed access roles.

`/setup` can create or reuse Member, Guest, Officer, and FC Leader roles in one operation. An optional in-game officer rank enables automatic bot-only Officer access; explicit manager grants/revocations are also supported. See [SETUP.md](docs/SETUP.md).

Every development startup posts the current responsibility-separated session plan to `#chat`. Update `test-plans/current.json` for the next session; see [TEST_PLANS.md](docs/TEST_PLANS.md).

For the supplied legacy data, follow the [migration runbook](docs/MIGRATION.md) before enabling effects. An imported guild has its own persisted activation flag as well as the process-wide `ENABLE_EFFECTS` setting.

To run the compiled bot or one-shot tools locally, publish loopback-only dependency ports explicitly:

```sh
docker compose -f docker-compose.yml -f docker-compose.tools.yml up -d --wait postgres nodestone
bun run build
bun run start
```

The normal Compose configuration keeps dependency ports private. Use a separate database and development application for test-guild work.

## Daily use

- `/version [commits]` shows the running SemVer and recent commits from GitHub (`main`): five by default, up to ten, with linked IDs/titles and ✅ for verified signatures. History is cached for up to five minutes; version output remains available during GitHub outages. See [CHANGELOG.md](CHANGELOG.md) for the versioned development milestones.
- `/claim` resolves an ID/profile URL or an exact full-name/world match. Put its proof token in the public biography, then use `/verify`. Tokens expire after 30 minutes by default.
- `/characters`, `/main`, and `/nickname` manage local identity preferences. Existing-link operations use stored IDs and work during Lodestone outages.
- Imported users select `/main character:ID` and `/nickname enabled:true` explicitly to opt in to nicknames.
- `/refresh` returns an inspectable run ID; `/sync status` reports durable work. Officer-only `force:true` bypasses freshness while retaining rate limits and locks.
- `/apply` opens a durable guest application. Officers can use its persistent review buttons or `/guest approve` and `/guest deny`. `/guest grant` and `/guest revoke` record explicit access decisions.
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
| `bun run preview GUILD_ID` | Read-only role/nickname reconciliation preview |
| `bun run activate GUILD_ID` | Validate resources and enable an imported guild's effects |
| `bun run jobs:retry GUILD_ID JOB_ID` | Retry delivery independently of a committed decision |

One-shot commands execute compiled scripts; run `bun run build` after source changes. The equivalent container commands use `bun dist/scripts/NAME.js`.

Local probes are `/health/live` and `/health/ready` on port 3000 inside the bot container. Readiness depends on initialization, schema/database availability, and Discord connectivity. Capability metrics include pending/blocked work, accepted-roster age, and degraded FCs; Lodestone outages preserve available local operations. The sidecar exposes `/health` on port 8080.

The bot handles SIGTERM with a 30-second container stop period. Decisions, jobs, and outbox deliveries remain in PostgreSQL across restarts. [Recovery and backup procedures](docs/OPERATIONS.md) explain inspection, retries, and restoration.

## Layout

- `src/domain`: identifiers, exact money, authorization, access and transition policy.
- `src/application`: transactional operations and reconciliation.
- `src/bot`: reusable module discovery, contracts, service injection, and interaction dispatch.
- `src/commands`, `src/events`, `src/components`: independently loaded feature adapters.
- `src/discord`: Discord effects, shared option builders, selectors, and reply presentation.
- `src/infrastructure`: PostgreSQL and typed Nodestone HTTP adaptation.
- `src/jobs`: recoverable work leases, deduplication, and outbox dispatch.
- `src/import`: bounded MySQL/MariaDB dump decoding and atomic import.
- `sidecar`: Nodestone worker isolation, source compatibility transformations, and transport controls.
- `vendor/nodestone`: upstream parser Git submodule, required for local and Docker builds.
- `migrations`, `scripts`, `tests`, `docs`: schema, operational tooling, verification, and runbooks.

## License

TaruBot's first-party code is licensed under the [GNU Affero General Public License v3.0](LICENSE), SPDX **AGPL-3.0-only**. `/version` provides source-code and license links. The Nodestone submodule and other third-party dependencies retain their own licenses.
