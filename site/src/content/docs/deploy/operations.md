---
title: Updates, backups and recovery
description: Update to a new release, roll back, back up and restore the database, and keep a single writer.
sidebar:
  order: 5
---

These procedures assume the stock `docker-compose.yml` with its bundled PostgreSQL, run from the directory that holds it and `.env`. Every decision TaruBot makes, and all the Discord work it still owes, lives in PostgreSQL, so the database is the one thing to protect.

## Updating to a release

Read the [changelog](https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md) entries between your release and the new one first. Each says whether it adds a **migration** and whether its **commands changed**.

1. Pin the new release in `.env` and pull it. Nothing restarts yet.

   ```sh
   sed -i 's/^TARUBOT_IMAGE_TAG=.*/TARUBOT_IMAGE_TAG=X.Y.Z/' .env
   docker compose pull
   ```

2. Stop the bot: `docker compose stop tarubot`. It finishes its work in progress and exits within 30 seconds.
3. [Back up](#backup) the database.
4. Migrate, in the new image:

   ```sh
   docker compose run --rm --no-deps tarubot bun dist/scripts/migrate.js
   ```

   With a migration pending, it prints the files it applied and the restore point, then `Schema ready.` With nothing pending, it only prints `Schema ready.`
5. Start the bot: `docker compose up -d --wait`, then [check readiness](/tarubot/deploy/monitoring/#health-probes).
6. If the changelog says the commands changed, register them again with the same scope you used at install (`register.js --global` or `--guild YOUR_GUILD_ID`), and check with `commands.js list`; see [Maintenance tools](/tarubot/deploy/tools/).

For a release without a migration, steps 2 to 4 are optional: `docker compose up -d --wait` after the pull replaces the container, and Compose stops the old one first. The outage is a few seconds either way.

A new image never touches your database or restarts your bot by itself: updates happen only when you pull and recreate.

## Rollback

To go back, pin the previous `TARUBOT_IMAGE_TAG` and run `docker compose up -d --wait` again. That only works when no migration lies between the two releases: an older release refuses to start on a newer schema. After a migration, the way back is a fix release, or restoring the backup you took before migrating.

## Single database writer

Exactly one bot process may write to a database. TaruBot enforces this with a PostgreSQL session advisory lock, the **writer lease**, key **`714882494`**. Other fixed keys are transaction locks: `714882490` serializes migrations, `714882491` character claims, and `714882492` the legacy import.

- **Startup.** After checking the schema, the bot holds one dedicated database connection and tries to take the lease every 5 seconds. It doesn't start its work queue or log in to Discord until it holds the lease. Once it does, it checks the schema again, so a bot that waited while a migration ran exits instead of writing with old code.
- **While waiting.** Each attempt logs `Waiting for the database writer lease…` with the holder's `holderPid`, at info for the first minute and at warn after that. `/health/live` stays 200 and `/health/ready` is 503 with `writerLease: false`, so Compose reports the container unhealthy but doesn't restart it. A second bot started by mistake therefore waits instead of running beside the first.
- **Shutdown.** SIGTERM wakes a waiting process at once. A running writer releases the lease after its workers and Discord client stop, so the next writer takes it within one retry. If a bot is killed, PostgreSQL releases the lease when the session ends: at once for a normal kill, or after about a minute when the network or host is lost.
- **A lost session.** If the lease connection ends (a database restart, a failover, a terminated backend), the bot logs an error and exits with status 1, and Compose restarts it to wait for the lease again. Every 30 seconds the bot also asks the lease connection whether it still holds the lock, with a 10-second deadline, so a silently dropped connection is caught within about 40 seconds the same way.
- **A stale holder.** If a restarted bot keeps logging the same `holderPid` for more than a few minutes while it's the only bot running, check that the holder is an idle session from before the restart, then end it:

  ```sh
  docker compose exec -T postgres psql -U tarubot -d tarubot \
    -c "SELECT pid, state, backend_start, state_change, client_addr FROM pg_stat_activity WHERE pid = 12345"
  docker compose exec -T postgres psql -U tarubot -d tarubot -c "SELECT pg_terminate_backend(12345)"
  ```

  Replace `12345` with the logged `holderPid`. The waiting bot takes the lease on its next attempt.

The lease needs a direct PostgreSQL connection. A transaction-mode pool such as PgBouncer can't hold a session lock.

**Writer gate.** Before a migration, a restore or anything else that writes to the database outside the bot, confirm that no bot holds the lease. This read-only query must return no rows:

```sh
docker compose exec -T postgres psql -U tarubot -d tarubot -c "
SELECT l.pid, a.application_name, a.client_addr, a.backend_start
FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory' AND l.granted
  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND l.classid = 0 AND l.objid = 714882494 AND l.objsubid = 1;"
```

A single bigint advisory key appears in `pg_locks` as `classid` (high 32 bits), `objid` (low 32 bits) and `objsubid = 1`.

### Migration guard

`migrate.js` applies every pending migration in one transaction and, while anything is pending, takes the writer lease for that transaction. A running bot therefore blocks it: the run waits up to `MIGRATE_WRITER_WAIT_SECONDS` (90 by default) for a stopping bot, retrying every 2 seconds, then refuses with `busy`, names the holder's database process, and changes nothing. With nothing pending it never touches the lease.

When it applies files, it prints `Migration writer lease acquired at <time>; applied <files>; committing at <time>.` from the database clock. No bot wrote after the first time, so it is the restore point for that migration.

The guard is a safety net. Stop the bot before migrating anyway.

## Shutdown and restart

The Compose stop grace period is 30 seconds. On SIGTERM the bot stops taking new interactions and scheduling work, cancels Lodestone requests, waits up to 20 seconds for its workers, then closes Discord and the database. It exits within 27 seconds in any case. Work in progress is leased in the database: a job a stopped worker held is picked up again after its lease expires, and work superseded by a newer change is recomputed.

## Backup

`pg_dump` in custom format inside the PostgreSQL container, then copy the file out:

```sh
mkdir -p backups
docker compose exec -T postgres pg_dump -U tarubot -d tarubot -Fc -f /tmp/tarubot.dump
docker compose cp postgres:/tmp/tarubot.dump "backups/tarubot-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T postgres rm /tmp/tarubot.dump
```

A dump is consistent even while the bot runs, because `pg_dump` reads one snapshot. Back up on a schedule (a daily `cron` job is plenty) and before every update, and keep copies **off the host**, encrypted: the dump holds your members' links and the ledger. A backup you haven't restored isn't proven; rehearse a restore now and then (below).

The repository's `ops/` directory and `scripts/host-env-backup.ts` are the upstream instance's own backup tooling. They are tied to its Compose file, encryption key and host, so don't reuse them as they are.

## Restore rehearsal

Restore into a separate database, then compare it with the live one. Stop the bot first, so the two can match exactly.

1. Create the copy and restore the dump into it:

   ```sh
   docker compose exec -T postgres createdb -U tarubot tarubot_restore_test
   docker compose cp backups/tarubot-20260101T000000Z.dump postgres:/tmp/restore.dump
   docker compose exec -T postgres pg_restore -U tarubot -d tarubot_restore_test --exit-on-error /tmp/restore.dump
   ```

2. Compare every row, sequence, trigger and constraint with the live database, using exact checksums:

   ```sh
   docker compose run --rm --no-deps -T tarubot \
     sh -c 'RESTORE_DATABASE_URL="${DATABASE_URL%/*}/tarubot_restore_test" exec bun dist/scripts/check-restore.js'
   ```

   `check-restore.js` needs both databases at its own release's schema. If you already pinned a newer release whose migration isn't applied yet, add `--schema-version` with the newest migration the database has, which `SELECT max(version) FROM schema_migrations` shows.

3. Before an update with a migration, rehearse the migration on the copy first. It must print `Schema ready.`:

   ```sh
   docker compose run --rm --no-deps -T tarubot \
     sh -c 'DATABASE_URL="${DATABASE_URL%/*}/tarubot_restore_test" exec bun dist/scripts/migrate.js --restore-rehearsal'
   ```

   `--restore-rehearsal` accepts only a database whose name ends in `_restore_test`, so it can't be pointed at the live one by mistake.

4. Drop the copy: `docker compose exec -T postgres dropdb -U tarubot tarubot_restore_test`.

The `sh -c` form builds the copy's URL inside the container from the bot's own, so no password is typed or printed.

## Recovery

To recover from a broken or lost database:

1. Stop the bot: `docker compose stop tarubot`, and confirm with the [writer gate](#single-database-writer) that nothing holds the lease.
2. Keep the newest state you have, even a damaged one: rename the database instead of dropping it.
3. Restore the most recent good backup into a new `tarubot` database:

   ```sh
   docker compose exec -T postgres psql -U tarubot -d postgres -c "ALTER DATABASE tarubot RENAME TO tarubot_before_restore"
   docker compose exec -T postgres createdb -U tarubot tarubot
   docker compose cp backups/tarubot-20260101T000000Z.dump postgres:/tmp/restore.dump
   docker compose exec -T postgres pg_restore -U tarubot -d tarubot --exit-on-error /tmp/restore.dump
   ```

   Decisions acknowledged after that backup, such as new links, ledger entries and guest decisions, must be recorded again: a restore can't know about them.
4. If the backup is from an older release, run `migrate.js` as in an update.
5. Start exactly one bot: `docker compose up -d --wait`, and check readiness and `/config validate`.

Discord work the restored database still owes resumes from its durable jobs. A restore never undoes Discord changes the bot already made; the next reconciliation brings Discord in line with the restored decisions.

## Volumes

The database lives in the `postgres_data` volume, mounted at `/var/lib/postgresql` as PostgreSQL 18 images expect. Recreating or updating containers keeps it. `docker compose down -v` deletes it, and with it every record: never use `-v` unless you mean to start over.
