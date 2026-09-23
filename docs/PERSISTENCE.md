# Drizzle persistence

TaruBot uses pinned **Drizzle ORM 0.45.3** with **node-postgres 8.23.0**. `src/infrastructure/postgres/schema.ts` maps application tables; `database.ts` owns the pool, transaction lifecycle, migration checks, and shared audit/user writes. `connection.ts` supports provider-supplied CA certificates through `DATABASE_CA_CERT`, retaining certificate/hostname verification despite URL SSL settings. Persisted application record contracts and leased-job fields derive from these mappings.

## Query and transaction conventions

- Use `db.orm` for pooled application reads/writes. Use Drizzle selections, joins, conflict targets, `returning`, and explicit row locks for ordinary persistence.
- Inside `db.transaction(async (client) => ...)`, obtain `const store = orm(client)` and use it for every part of that decision. Pass the same `client` to `audit`, `ensureUser`, `enqueue`, and reconciliation helpers. The adapter is cached by connection identity; a pooled query would escape the transaction.
- Keep Discord and Lodestone requests outside decision transactions. Existing session advisory locks serialize FC acquisition, user delivery, and setup/layout across remote calls. Always release those locks and checked-out clients in `finally`.
- Use schema column objects in `sql` expressions. Bind dynamic values through Drizzle; do not interpolate user strings as SQL identifiers or fragments. Alias computed selections when composing subqueries or insert-from-select operations.
- The work queue uses a typed CTE with `FOR UPDATE OF jobs SKIP LOCKED` and one `UPDATE ... RETURNING` claim. Preserve lease-token, expiry, generation, and configuration guards when changing queue or delivery queries. Active-job upserts use the literal predicate from the partial unique index so prepared plans can infer it.

## Exact values

| Value | Mapping |
| --- | --- |
| Discord/Lodestone identifiers | `external_id` domain mapped to decimal strings, including unsigned 64-bit maximum |
| Money, sequences, revisions, identity counters | PostgreSQL `bigint` mapped to JavaScript `bigint`; no floating-point conversion |
| Instants | `timestamptz` mapped to `Date`; connections use UTC |
| JSONB | Application `json()` serializer preserves bigint as decimal strings; node-postgres already decodes returned JSON values |

Pass objects/scalars directly into JSONB fields, rather than pre-serializing them. A returned scalar JSON string is already decoded and must not be parsed again. Drizzle treats a JavaScript `null` parameter as SQL NULL; use ``sql`'null'::jsonb` `` when a required payload intentionally contains JSON null. Audit and queue helpers handle that distinction. Nullable columns continue to use normal SQL NULL.

Drizzle query failures retain the PostgreSQL driver error in `cause`, including its SQLSTATE. Domain `Failure` exceptions remain the approved user-facing diagnostic boundary. Logs, Discord replies, and job diagnostics continue to omit arbitrary database exception messages and bound parameters; tests inspecting database-enforced failures assert the driver cause.

## Schema changes and deployment

Numbered SQL files in `migrations/` are the schema authority. They define domains, foreign keys, partial indexes, checks, and immutable-ledger triggers. The ORM mappings describe those tables for application queries; they are not a complete schema-generation manifest.

For a future schema change:

1. Add a new numbered SQL migration; preserve every applied migration and checksum.
2. Update the Drizzle mapping and `SCHEMA_VERSION` together.
3. Verify migration/schema parity and relevant behavior in disposable PostgreSQL with both migration fixtures.
4. Increment the application version/changelog and follow the PR/check/publication workflow. Apply the matching migration during the documented deployment window.

The **2.9.0 adoption added no migration** and used `002_setup_and_ranks.sql`. Migration `003_guild_access.sql` added opt-in channel policy bindings and first-observed recovery snapshots. The current **2.12.2** source uses `004_guest_application_form.sql`, introduced in **2.12.0**: paired nullable introduction/interest fields preserve existing applications, and a database constraint bounds supplied answers. New form answers, submission audit, and review work commit on the same client. It still maps 25 application tables and keeps all prior migration checksums immutable. The 2.12.1 documentation and 2.12.2 CI/security maintenance milestones add no schema change. `bun run db:migrate` remains the deployment command; there is no Drizzle Kit push or automatic runtime schema mutation. See [SETUP.md](SETUP.md) and [APP_PLATFORM.md](APP_PLATFORM.md) for deployment.

Raw SQL is limited to transaction/migration control, advisory locks, health probes, and independent catalog/restore verification. The dump reader still decodes legacy SQL as data. Integration tests also use independent SQL observations and fault injection to validate ORM behavior rather than relying exclusively on the same mappings under test.

## Regression coverage

The PostgreSQL suite compares every application table/column/type/null/default mapping to the migrated catalog. It exercises unsigned IDs, maximum bigint money, large sequences, UTC dates, scalar/nested JSON and JSON null, isolation and rollback across policy/audit/outbox writes, simultaneous `SKIP LOCKED` claims, superseding generations, expired leases, and empty/shared-FC capability aggregates. Existing ownership, ledger, guest, roster, nickname, import, and recovery tests exercise the converted application paths.

```sh
bun run test:docker
bun run test:fixture
LEGACY_FIXTURE_PATH=.cache/ci/legacy.sql bun run test:docker
```

The harness creates disposable `_test` databases and removes its containers/volumes. The first command uses the locally supplied private dump; the second run selects generated synthetic input suitable for public CI.
