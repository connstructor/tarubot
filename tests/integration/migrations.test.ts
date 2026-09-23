/**
 * Migration 005 rehearsals in private PostgreSQL schemas, isolated from persistence.test.ts's public
 * schema: import/activation backfill, the new CHECKs, an empty database, and the real migrate() runner.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asc, eq, sql } from "drizzle-orm";
import type { PoolClient, QueryResult } from "pg";
import * as t from "../../src/infrastructure/postgres/schema.js";
import {
  Database,
  orm,
  SCHEMA_VERSION,
  SESSION_OPTIONS,
} from "../../src/infrastructure/postgres/database.js";

const url = process.env.TEST_DATABASE_URL;
const LAUNCH = "005_launch_access_policy.sql";
const directory = fileURLToPath(new URL("../../migrations", import.meta.url));

/** Migration files in runner order; those before 005 form the schema-004 baseline it upgrades. */
async function migrationFiles(): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
}
async function baseline(): Promise<string[]> {
  return (await migrationFiles()).filter((name) => name < LAUNCH);
}
const migration = (name: string): Promise<string> => Bun.file(join(directory, name)).text();

/** Synthetic guilds covering every history the 005 backfill distinguishes. */
const guild = {
  /** Created by /setup and managed live, never imported: DevBot's shape. */
  devbot: "500001",
  /** Imported under 2.12.x and published, never activated (a rehearsal database). */
  pending: "500002",
  /** Imported and activated: effects on. */
  activated: "500003",
  /** Never imported and effects off, e.g. a guild row created before its first activation. */
  dormant: "500004",
  /** Imported, activated, then switched off again. */
  disabled: "500005",
};
const user = { approved: "600001", manual: "600002", imported: "600003", visitor: "600004" };

describe.skipIf(!url)("migration 005 launch access policy", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const db = new Database(url);
  afterAll(async () => {
    await db.close();
  });

  /** One rolled-back transaction whose unqualified migration SQL resolves inside a private schema. */
  async function rehearse(schema: string, body: (client: PoolClient) => Promise<void>) {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      // Schema names are fixed test constants; the migrations themselves stay unqualified.
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      for (const file of await baseline()) await client.query(await migration(file));
      await body(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  /** Assert a CHECK violation without aborting the surrounding rehearsal transaction. */
  async function checkViolation(client: PoolClient, operation: () => Promise<unknown>) {
    await client.query("SAVEPOINT expected_violation");
    // Drizzle builders are thenables, so adopt them into a Promise; the driver error and its
    // SQLSTATE stay in `cause`.
    await expect(Promise.resolve(operation())).rejects.toMatchObject({ cause: { code: "23514" } });
    await client.query("ROLLBACK TO SAVEPOINT expected_violation");
  }

  test("migration 005 backfills the layout switch and grandfathering marker from import/activation history", async () => {
    await rehearse("m005_rehearsal", async (client) => {
      // Schema-004 rows use SQL: the Drizzle mappings already include the columns 005 adds.
      await client.query(
        `INSERT INTO guilds (id, member_role_id, guest_role_id, officer_role_id, leader_role_id,
           lobby_channel_id, officer_channel_id, access_policy_enabled, effects_enabled, revision)
         VALUES ($1, '700001', '700002', '700003', '700004', '700005', '700006', true, true, 11)`,
        [guild.devbot],
      );
      await client.query(
        "INSERT INTO guilds (id, effects_enabled, revision) VALUES ($1, false, 3), ($2, true, 4), ($3, false, 5), ($4, false, 6)",
        [guild.pending, guild.activated, guild.dormant, guild.disabled],
      );
      await client.query(
        `INSERT INTO audit (guild_id, action, target) VALUES
           ($1, 'migration.import', 'fingerprint'),
           ($2, 'migration.import', 'fingerprint'), ($2, 'activation', $2),
           ($3, 'migration.import', 'fingerprint'), ($3, 'activation', $3),
           ($4, 'config.set', 'guest_role_id')`,
        [guild.pending, guild.activated, guild.disabled, guild.devbot],
      );
      // Existing grants of every schema-004 provenance must survive the CHECK replacement.
      await client.query("INSERT INTO users (id) VALUES ($1), ($2), ($3), ($4)", [
        user.approved,
        user.manual,
        user.imported,
        user.visitor,
      ]);
      await client.query(
        "INSERT INTO guild_users (guild_id, user_id) VALUES ($1, $2), ($1, $3), ($1, $4), ($5, $6)",
        [guild.devbot, user.approved, user.manual, user.imported, guild.pending, user.visitor],
      );
      await client.query(
        `INSERT INTO guest_grants (guild_id, user_id, provenance, source_key) VALUES
           ($1, $2, 'approved', 'application:1'), ($1, $3, 'manual', 'manual:1'),
           ($1, $4, 'imported_guest', 'import:1')`,
        [guild.devbot, user.approved, user.manual, user.imported],
      );

      await client.query(await migration(LAUNCH));

      const store = orm(client);
      expect(
        await store
          .select({
            id: t.guilds.id,
            layout: t.guilds.role_layout_enabled,
            marker: t.guilds.guest_grandfather,
            at: t.guilds.guest_grandfathered_at,
            revision: t.guilds.revision,
          })
          .from(t.guilds)
          .orderBy(asc(t.guilds.id)),
      ).toEqual([
        // DevBot keeps today's layout, is never grandfathered, and keeps its revision.
        { id: guild.devbot, layout: true, marker: null, at: null, revision: 11n },
        { id: guild.pending, layout: false, marker: "pending", at: null, revision: 3n },
        { id: guild.activated, layout: false, marker: null, at: null, revision: 4n },
        { id: guild.dormant, layout: true, marker: null, at: null, revision: 5n },
        { id: guild.disabled, layout: false, marker: null, at: null, revision: 6n },
      ]);
      expect(
        (
          await store
            .select({ provenance: t.guestGrants.provenance })
            .from(t.guestGrants)
            .orderBy(asc(t.guestGrants.provenance))
        ).map((row) => row.provenance),
      ).toEqual(["approved", "imported_guest", "manual"]);
      // The migration writes no audit rows of its own.
      expect(await store.$count(t.auditEvents)).toBe(6);
      // Catalog probe: the replaced inline CHECK keeps its name and now admits 'grandfathered'.
      const definitions = await client.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'guest_grants'::regclass AND conname = 'guest_grants_provenance_check'",
      );
      expect(definitions.rows).toHaveLength(1);
      expect(definitions.rows[0]?.definition).toContain("'grandfathered'");

      // Grandfathered grants are accepted; unknown provenances are still refused.
      await store.insert(t.guestGrants).values({
        guild_id: guild.pending,
        user_id: user.visitor,
        provenance: "grandfathered",
        source_key: `grandfather:${guild.pending}:${user.visitor}`,
      });
      await checkViolation(client, () =>
        store.insert(t.guestGrants).values({
          guild_id: guild.pending,
          user_id: user.visitor,
          provenance: "bogus",
          source_key: `bogus:${guild.pending}:${user.visitor}`,
        }),
      );
      // The marker admits only pending/completed, and the timestamp exists exactly when completed.
      const pending = eq(t.guilds.id, guild.pending);
      await checkViolation(client, () =>
        store.update(t.guilds).set({ guest_grandfather: sql`'started'` }).where(pending),
      );
      await checkViolation(client, () =>
        store.update(t.guilds).set({ guest_grandfather: "completed" }).where(pending),
      );
      await checkViolation(client, () =>
        store.update(t.guilds).set({ guest_grandfathered_at: new Date() }).where(pending),
      );
      const completedAt = new Date("2026-09-23T12:00:00Z");
      await store
        .update(t.guilds)
        .set({ guest_grandfather: "completed", guest_grandfathered_at: completedAt })
        .where(pending);
      expect(
        await store
          .select({ marker: t.guilds.guest_grandfather, at: t.guilds.guest_grandfathered_at })
          .from(t.guilds)
          .where(pending),
      ).toEqual([{ marker: "completed", at: completedAt }]);
    });
  });

  test("migration 005 is a no-op on an empty database and new guilds start with the layout on", async () => {
    await rehearse("m005_empty", async (client) => {
      // A multi-statement file yields one result per statement; flat() also accepts a single result.
      const results: QueryResult[] = [await client.query(await migration(LAUNCH))].flat();
      expect(
        results.filter((result) => result.command === "UPDATE").map((result) => result.rowCount),
      ).toEqual([0, 0]);
      // A guild created later by /setup or /config takes the column defaults: layout on, no marker.
      const store = orm(client);
      await store.insert(t.guilds).values({ id: guild.devbot, effects_enabled: true });
      expect(
        await store
          .select({
            layout: t.guilds.role_layout_enabled,
            marker: t.guilds.guest_grandfather,
            at: t.guilds.guest_grandfathered_at,
          })
          .from(t.guilds),
      ).toEqual([{ layout: true, marker: null, at: null }]);
    });
  });

  test("Database.migrate upgrades a schema-004 database once and then skips every file by checksum", async () => {
    const schema = "m005_runner";
    const staged = await mkdtemp(join(tmpdir(), "tarubot-schema-004-"));
    // A second pool confined to the private schema through its startup options. Connection-string
    // options replace the pool's own, so the Database's UTC and statement-timeout settings are restated.
    const confined = new URL(url);
    confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${schema}`);
    const runner = new Database(confined.toString());
    try {
      // migrate() commits, so this schema is created fresh and always dropped afterwards.
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.query(`CREATE SCHEMA ${schema}`);
      // Fail before migrating if the runner would resolve names anywhere but the private schema.
      expect(await runner.query("SELECT current_schema() AS schema")).toEqual([{ schema }]);
      for (const file of await baseline())
        await copyFile(join(directory, file), join(staged, file));
      await runner.migrate(staged);
      // A 2.13.0 build refuses a schema-004 database until the pending migration is applied.
      await expect(runner.schema()).rejects.toMatchObject({ code: "schema" });
      // check-restore --schema-version: this build can still verify a database at its earlier head
      // (the pre-migration restore rehearsal), against its own copy of that migration file.
      const previous = (await baseline()).at(-1) ?? "";
      await runner.schema(previous);
      await expect(runner.schema("../005_launch_access_policy.sql")).rejects.toMatchObject({
        code: "input",
      });
      await runner.query(
        `INSERT INTO guilds (id, member_role_id, guest_role_id, officer_role_id, leader_role_id,
           lobby_channel_id, officer_channel_id, access_policy_enabled, effects_enabled, revision)
         VALUES ($1, '700001', '700002', '700003', '700004', '700005', '700006', true, true, 11),
                ($2, NULL, NULL, NULL, NULL, NULL, NULL, false, false, 3)`,
        [guild.devbot, guild.pending],
      );
      await runner.query(
        "INSERT INTO audit (guild_id, action, target) VALUES ($1, 'migration.import', 'fingerprint')",
        [guild.pending],
      );

      // 001-004 match their recorded checksums and are skipped; only 005 runs.
      await runner.migrate(directory);
      await runner.schema();
      // Once migrated, the earlier head no longer matches.
      await expect(runner.schema(previous)).rejects.toMatchObject({ code: "schema" });
      // The runner's own bookkeeping table has no ORM mapping; observe it directly.
      const history = "SELECT version, applied_at FROM schema_migrations ORDER BY version";
      const recorded = await runner.query<{ version: string; applied_at: Date }>(history);
      expect(recorded.map((row) => row.version)).toEqual(await migrationFiles());
      expect(recorded.at(-1)?.version).toBe(SCHEMA_VERSION);
      // A repeated run is a checksum-verified no-op: nothing is re-applied or re-recorded.
      await runner.migrate(directory);
      expect(await runner.query(history)).toEqual(recorded);
      expect(
        await runner.orm
          .select({
            id: t.guilds.id,
            layout: t.guilds.role_layout_enabled,
            marker: t.guilds.guest_grandfather,
            revision: t.guilds.revision,
          })
          .from(t.guilds)
          .orderBy(asc(t.guilds.id)),
      ).toEqual([
        { id: guild.devbot, layout: true, marker: null, revision: 11n },
        { id: guild.pending, layout: false, marker: "pending", revision: 3n },
      ]);
    } finally {
      await runner.close();
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await rm(staged, { recursive: true, force: true });
    }
  });
});
