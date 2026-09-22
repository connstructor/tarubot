# Operations and recovery

## Configuration

`.env.example` lists application settings. Bun and TypeScript are exactly pinned. Standard service ports are private; `docker-compose.tools.yml` explicitly publishes loopback-only dependency ports for local tooling.

Normal deployments use published GHCR images. Pull updates with `docker compose pull`, then recreate with `docker compose up -d --wait`; follow the maintenance-window migration procedure when the schema changes. `TARUBOT_IMAGE_TAG` selects a matched latest/SemVer/SHA tag, and full `TARUBOT_IMAGE` / `NODESTONE_IMAGE` overrides support digest pinning. Local source builds explicitly add `docker-compose.build.yml`. See [CI_CD.md](CI_CD.md).

| Setting | Default / purpose |
| --- | --- |
| `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID` | Required runtime credentials/identity |
| `POSTGRES_PASSWORD` | Required Compose database credential |
| `DATABASE_URL` | Local-tool connection string; Compose supplies its internal connection string |
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

## Inspect and repair

- `/config show` and `/config validate`: resource existence, permissions/hierarchy, linked FC, and freshness.
- `/sync status`: run outcomes and queued/running/blocked/failed work. Officers see guild-wide work; other users see their authorized requests and effects.
- `/guest status`: durable decisions, grants, revocations, and separate delivery work.
- `/ledger balance` / `/ledger history`: committed balances/entries and delivery status.

Job diagnostics are scoped. Repair the configured resource or permissions, then let reconciliation/backoff resume. For a terminal delivery failure, an operator can explicitly retry the job using database credentials:

```sh
bun run jobs:retry GUILD_ID JOB_ID
```

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

Readiness uses database/schema initialization and Discord connectivity; liveness is local. Probes do not acquire Lodestone pages. Logs periodically include queue counts, blocked work, oldest accepted-roster age, and degraded FC counts.

Expired challenges are pruned after seven days. Active links/grants, membership evidence, audits, ledger entries, imports, and work history are retained. Operators can establish a bounded diagnostic-retention policy while retaining financial and access-policy evidence.

## Shutdown and restart

The Compose stop grace period is 30 seconds. SIGTERM stops new interaction handling and scheduling, aborts outstanding Nodestone requests, waits up to 20 seconds for workers, then closes Discord/database resources. Persisted leases are recoverable after expiry. A worker must own its current lease before publishing results; superseded reconciliation is recomputed.

Use a maintenance window for migrations, final capture/import, command replacement/cutover, or restoration. Normal backups can run against the active database; a consistent dump uses PostgreSQL's snapshot semantics.

## Backup

The following stores a custom-format archive inside the PostgreSQL container, then copies it into the project. Create the destination directory first.

```sh
mkdir -p artifacts/backups
docker compose exec -T postgres pg_dump -U tarubot -d tarubot -Fc -f /tmp/tarubot-backup.dump
docker compose cp postgres:/tmp/tarubot-backup.dump artifacts/backups/tarubot-backup.dump
```

Keep backups and the original import/snapshot/report together in your operational backup storage. For post-activation recovery with no loss of acknowledged decisions, use PostgreSQL WAL/PITR or capture and reconcile all changes newer than the restored backup.

## Restore rehearsal

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

For actual recovery, stop the writer, preserve the newest available state, restore/replay to the required recovery point, validate invariants and configuration, then restart exactly one writer. Unacknowledged outbound effects resume from durable jobs. Already acknowledged application decisions must be present before resuming.

`postgres_data` is mounted at `/var/lib/postgresql`, the parent-volume layout expected by PostgreSQL 18 images. Container recreation retains that volume. Removing a volume is a separate destructive operator action.
