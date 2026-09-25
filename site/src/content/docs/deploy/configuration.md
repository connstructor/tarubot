---
title: Configuration
description: Every setting in .env, what reads it, and its default.
sidebar:
  order: 4
---

Settings live in `.env` next to `docker-compose.yml`, copied from your release's [`.env.example`](https://github.com/deconfined/tarubot/blob/main/.env.example) as [Install](/tarubot/deploy/install/#1-get-the-compose-file-and-settings-template) shows. Keep it private (`chmod 600 .env`) and out of Git: it holds the bot token and the database password.

The bot validates its settings at startup and refuses to start with an invalid one, naming the setting but never its value. Compose passes the bot container only the settings `docker-compose.yml` lists; a one-off `docker compose run` can add others with `-e NAME=value`. Settings removed in earlier releases are ignored; the [changelog](https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md) records each removal.

## Runtime

Read by the running bot.

| Setting | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | (required) | The bot token from the Developer Portal. Secret. |
| `DISCORD_APPLICATION_ID` | (required) | The application's ID. The bot checks that the token belongs to it. |
| `ENABLE_EFFECTS` | `false` | The deployment-wide switch for Discord changes. With `false`, decisions are saved and Discord changes wait as paused work; a restart with `true` requeues them. Set `true` for a working deployment. |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` or `fatal`. Logs are structured JSON; tokens and option values are never logged. |
| `ROSTER_INTERVAL_SECONDS` | `21600` | How often each linked FC's roster is read (at least 60), and how old a roster may be before it counts as stale. |
| `PROFILE_INTERVAL_SECONDS` | `86400` | How often each character's profile is refreshed (at least 300). |
| `VERIFICATION_SECONDS` | `1800` | How long a `/claim` token stays valid, from 60 to 86,400. |
| `GUEST_COOLDOWN_SECONDS` | `86400` | How long a denied applicant waits before applying again (0 or more). |
| `HEALTH_PORT` | `3000` | The port of `/health/live` and `/health/ready` inside the container. |
| `DATABASE_CA_CERT` | (empty) | A PEM root certificate for an external PostgreSQL over TLS. With it set, certificate and hostname checks are enforced, whatever the URL's SSL options say. Not needed for the bundled database. |
| `GITHUB_REPORTS_TOKEN` | (empty) | A fine-grained GitHub token with read and write access to the issues of one repository, for [issue reports](/tarubot/deploy/monitoring/#issue-reports). Empty saves reports in the database without sending them. Secret. |
| `GITHUB_REPORTS_REPO` | `deconfined/tarubot-reports` | The `owner/name` repository reports open issues in. The default is the upstream project's own private repository, so **set your own whenever you set the token**, or leave the token empty. |
| `HEALTHCHECKS_PING_URL` | (empty) | A [healthchecks.io](https://healthchecks.io) ping URL, such as `https://hc-ping.com/<your-check-uuid>`, which the ready bot pings every five minutes. Empty turns the [heartbeat](/tarubot/deploy/monitoring/#heartbeat) off. Keep it private: anyone with it can ping your check. |

## Lodestone

Read by the bot's Lodestone adapter, which fetches and parses Lodestone pages in the bot process. The defaults suit almost every deployment.

| Setting | Default | Purpose |
| --- | --- | --- |
| `LODESTONE_REGION` | `na` | `na`, `eu`, `fr`, `de` or `jp`: which regional Lodestone the bot reads. |
| `LODESTONE_CONCURRENCY` | `2` | Pages parsed at once, 1 to 4. More requests wait for a slot. |
| `LODESTONE_START_MS` | `1000` | The minimum spacing between request starts, process-wide, 1,000 to 60,000. |
| `LODESTONE_TIMEOUT_MS` | `15000` | The deadline for one page fetch, 1,000 to 60,000. |
| `LODESTONE_BODY_BYTES` | `2000000` | The largest page accepted, 1,024 to 8,000,000 bytes. |
| `LODESTONE_REQUEST_TIMEOUT_MS` | `35000` | The deadline for one attempt: waiting for a slot and the gate, fetching and parsing; 1,000 to 120,000. |
| `LODESTONE_JOB_TIMEOUT_MS` | `300000` | The deadline for a whole search or roster read, retries included; 35,000 to 900,000, and no less than the request deadline. |
| `LODESTONE_ATTEMPTS` | `3` | Attempts for a temporary outage, 1 to 3. |
| `LODESTONE_MAX_PAGES` | `100` | The most pages a search or roster may span, 1 to 100. |
| `LODESTONE_SELECTOR_CHECK_SECONDS` | `900` | How often to check the selector repository for a new version: at least 300, or 0 to keep the set bundled with the release (for offline use). See [live selectors](/tarubot/deploy/monitoring/#live-selectors). |

After a Lodestone "429 Too Many Requests", the bot pauses every Lodestone request for a shared cooldown: 15 seconds, doubling on each 429 in a row up to 5 minutes, or a longer Retry-After of up to 15 minutes. Background work waits it out without using up attempts. The contributor notes in [docs/LODESTONE.md](https://github.com/deconfined/tarubot/blob/main/docs/LODESTONE.md) cover the adapter in depth.

## Compose only

Read by `docker-compose.yml`, not by the bot.

| Setting | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | (required) | The bundled database's password, set when its volume is first created. Use letters, digits, `-` and `_`, because Compose builds the bot's connection URL from it. Changing it later doesn't change the existing database's password. Secret. |
| `TARUBOT_IMAGE_TAG` | `latest` | The image tag to run: a published version (recommended), `latest`, or `sha-<commit>`. |
| `TARUBOT_IMAGE` | (empty) | A complete image reference that overrides `TARUBOT_IMAGE_TAG`, for example one pinned by `@sha256:` digest. |

## Maintenance tools only

Read by the [one-shot tools](/tarubot/deploy/tools/), not by the running bot. `docker-compose.yml` doesn't pass these to the container, so a value in `.env` reaches only tools run outside it. For a tool in the container, pass the setting with that run:

```sh
docker compose run --rm --no-deps -e MIGRATE_WRITER_WAIT_SECONDS=300 tarubot bun dist/scripts/migrate.js
```

A setting derived from the bot's own connection, such as `RESTORE_DATABASE_URL`, uses the `sh -c` form in the [restore rehearsal](/tarubot/deploy/operations/#restore-rehearsal), so no password is typed.

| Setting | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | (template value) | The connection string for tools run **outside** the container, for example with the loopback port override. Under the stock Compose file the bot and the tools in its container get their own URL to the bundled database, and this line is unused. |
| `TARUBOT_ENVIRONMENT` | (empty) | The tools' deployment profile. Leave it empty: your deployment uses the unmanaged profile. The other values belong to the upstream project's own instances. |
| `RESTORE_DATABASE_URL` | (not set) | The restored copy that `check-restore.js` compares with `DATABASE_URL`. Set it only for that run, never in `.env`. |
| `RESTORE_DATABASE_CA_CERT` | (empty) | A CA for `RESTORE_DATABASE_URL` when it differs from the primary's; empty reuses `DATABASE_CA_CERT`. |
| `MIGRATE_WRITER_WAIT_SECONDS` | `90` | How long `migrate.js` waits for a stopping bot to release the database before refusing a pending migration, 0 to 600. In the container, pass it with `-e` as above. |

## Development only

For a development deployment attached to one test server. Leave them at these values on a real deployment.

| Setting | Default | Purpose |
| --- | --- | --- |
| `TEST_GUILD_ID` | (empty) | Confines the bot to one test server: it ignores every other server, posts the test-session plan there at startup, labels issue reports as development ones, and refuses global command registration. |
| `PUBLIC_TEST_RESPONSES` | `false` | With `true`, replies in the test server are visible to everyone there, so testers can watch a session. |
| `TEST_PLAN_CHANNEL_ID` | (empty) | Where the test-session plan is posted; empty looks for the test server's `#chat`. |
| `TEST_PLAN_FILE` | `test-plans/current.json` | The plan file posted at startup. |
