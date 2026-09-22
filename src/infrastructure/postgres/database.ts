/** PostgreSQL boundary: exact decoding, short transactions, schema checks, and shared writes. */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { Failure, json } from "../../domain/values.js";

// OID 20 covers balances, sequences, and counts; Number would silently lose large integers.
pg.types.setTypeParser(20, (value) => BigInt(value));
/** Both a transaction client and the pool can execute these parameterized helper operations. */
export type Connection = Pick<PoolClient, "query">;
export const SCHEMA_VERSION = "002_setup_and_ranks.sql";
/** The pool is application-owned; remote Discord/Lodestone work stays outside transactions. */
export class Database {
  readonly pool: pg.Pool;
  healthy = false;
  /** Bound connection/query waits and normalize all database-generated instants to UTC. */
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 12,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      options: "-c timezone=UTC -c statement_timeout=15000",
    });
    this.pool.on("error", () => {
      this.healthy = false;
    });
    this.pool.on("connect", (client) => {
      // Session advisory locks can keep a client checked out during remote I/O.
      client.on("error", () => {
        this.healthy = false;
      });
    });
  }
  /** Typed result contracts describe our own SQL/schema; values are always parameterized. */
  async query<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    try {
      const result = await this.pool.query<T>(sql, values);
      this.healthy = true;
      return result.rows;
    } catch (error) {
      this.healthy = false;
      throw error;
    }
  }
  /** Roll back the complete decision on failure, then release the checked-out client. */
  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  /** A matching filename and checksum are required before startup accepts work. */
  async schema(): Promise<void> {
    try {
      const rows = await this.query<{ version: string; checksum: string }>(
        "SELECT version,checksum FROM schema_migrations ORDER BY version DESC LIMIT 1",
      );
      const expected = createHash("sha256")
        .update(await Bun.file(`migrations/${SCHEMA_VERSION}`).text())
        .digest("hex");
      if (rows[0]?.version !== SCHEMA_VERSION || rows[0].checksum !== expected)
        throw new Failure(
          "schema",
          "Schema version/checksum mismatch. Use matching versioned migrations and application image.",
        );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "42P01")
        throw new Failure("schema", "Run db:migrate before starting the application.");
      throw error;
    }
  }
  /** Serialize migration runners and reject edits to any previously applied migration. */
  async migrate(directory = "migrations"): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(714882490)");
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const file of (await readdir(directory))
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        const sql = await Bun.file(`${directory}/${file}`).text();
        const checksum = createHash("sha256").update(sql).digest("hex");
        const existing = await client.query<{ checksum: string }>(
          "SELECT checksum FROM schema_migrations WHERE version=$1",
          [file],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum)
            throw new Error(`Modified applied migration: ${file}`);
          continue;
        }
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [
          file,
          checksum,
        ]);
      }
    });
  }
  /** Drain idle/returned clients during process shutdown and one-shot tooling completion. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Record decisions in the caller's transaction so audit and state cannot diverge. */
export async function audit(
  client: Connection,
  guildId: string,
  actor: string | null,
  action: string,
  target: string | null,
  details: unknown = {},
): Promise<void> {
  await client.query(
    "INSERT INTO audit(guild_id,actor_id,action,target,details) VALUES($1,$2,$3,$4,$5)",
    [guildId, actor, action, target, json(details)],
  );
}

/** Preserve durable user policy while refreshing presence and resetting an obsolete join baseline. */
export async function ensureUser(
  client: Connection,
  guildId: string,
  userId: string,
  joinedAt?: Date,
): Promise<void> {
  await client.query("INSERT INTO users(id) VALUES($1) ON CONFLICT DO NOTHING", [userId]);
  await client.query(
    "INSERT INTO guild_users(guild_id,user_id,present,joined_at) VALUES($1,$2,$3,$4) ON CONFLICT(guild_id,user_id) DO UPDATE SET present=CASE WHEN $3 THEN true ELSE guild_users.present END,nickname_baseline_set=CASE WHEN $3 AND guild_users.joined_at IS DISTINCT FROM $4 THEN false ELSE guild_users.nickname_baseline_set END,nickname_pending=CASE WHEN $3 AND guild_users.joined_at IS DISTINCT FROM $4 THEN false ELSE guild_users.nickname_pending END,joined_at=COALESCE($4,guild_users.joined_at)",
    [guildId, userId, joinedAt !== undefined, joinedAt ?? null],
  );
}
