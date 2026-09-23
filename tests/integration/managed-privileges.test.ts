/**
 * The managed-PostgreSQL privilege model: on DigitalOcean the app's login (`tarubot`) is neither a
 * superuser nor the database owner, and PostgreSQL 15+ gives PUBLIC no CREATE on the public schema.
 * A throwaway login and database prove that every migration through SCHEMA_VERSION runs with only
 * the documented grants and leaves every object owned by the application login. It needs an admin
 * that may create roles and databases, and uses no state in the shared test database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Database, SCHEMA_VERSION } from "../../src/infrastructure/postgres/database.js";

const url = process.env.TEST_DATABASE_URL;

/** Whether the test login can create (and later drop) a role and a database. */
async function provisioner(address: string): Promise<boolean> {
  const probe = new Database(address);
  try {
    const [row] = await probe.query<{ capable: boolean }>(
      "SELECT rolsuper OR (rolcreatedb AND rolcreaterole) AS capable FROM pg_roles WHERE rolname=current_user",
    );
    return row?.capable === true;
  } finally {
    await probe.close();
  }
}
const capable = url ? await provisioner(url) : false;

describe.skipIf(!capable)("managed PostgreSQL privileges", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  // Random names keep concurrent or interrupted runs apart; the suffix marks the database disposable.
  const suffix = randomBytes(4).toString("hex");
  const role = `tarubot_grant_${suffix}`;
  const database = `tarubot_grant_${suffix}_test`;
  const password = randomBytes(16).toString("hex");
  /** The same server as TEST_DATABASE_URL, with another database and optionally another login. */
  const address = (login?: { user: string; password: string }) => {
    const target = new URL(url);
    target.pathname = `/${database}`;
    if (login) {
      target.username = login.user;
      target.password = login.password;
    }
    return target.toString();
  };
  const admin = new Database(url);
  const opened: Database[] = [];
  /** A pool closed in afterAll, before its database is dropped. */
  const open = (target: string) => {
    const pool = new Database(target);
    opened.push(pool);
    return pool;
  };
  /** Identifiers and the password are quoted by PostgreSQL itself (format %I/%L). */
  async function execute(on: Database, template: string, ...values: string[]): Promise<void> {
    const placeholders = values.map((_, index) => `$${index + 1}::text`).join(",");
    const [row] = await on.query<{ statement: string }>(
      `SELECT format('${template}',${placeholders}) AS statement`,
      values,
    );
    if (!row) throw new Error("format() returned no statement");
    await on.query(row.statement);
  }

  beforeAll(async () => {
    await execute(admin, "CREATE ROLE %I LOGIN PASSWORD %L", role, password);
    // template0 has PostgreSQL's pristine defaults: the public schema grants PUBLIC only USAGE.
    await execute(admin, "CREATE DATABASE %I TEMPLATE template0", database);
  });
  afterAll(async () => {
    for (const pool of opened) await pool.close();
    await execute(admin, "DROP DATABASE IF EXISTS %I WITH (FORCE)", database);
    await execute(admin, "DROP ROLE IF EXISTS %I", role);
    await admin.close();
  });

  test("the application login migrates only after the documented public-schema grant and owns every object", async () => {
    const owner = open(address());
    const application = open(address({ user: role, password }));

    // Negative control: without the grant, the first CREATE in public is refused (42501) and the
    // migration transaction leaves nothing behind.
    await expect(application.migrate()).rejects.toMatchObject({ code: "42501" });
    expect(
      await owner.query("SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1", [
        "schema_migrations",
      ]),
    ).toHaveLength(0);

    // The provider prerequisite, run by the admin connected to the application database.
    await execute(owner, "GRANT CONNECT ON DATABASE %I TO %I", database, role);
    await execute(owner, "GRANT USAGE, CREATE ON SCHEMA public TO %I", role);
    // The runbook's verification query reports both privileges.
    expect(
      await owner.query(
        `SELECT has_schema_privilege($1,'public','USAGE') AS usage,
                has_schema_privilege($1,'public','CREATE') AS "create"`,
        [role],
      ),
    ).toEqual([{ usage: true, create: true }]);

    await application.migrate();
    await application.schema();
    const [head] = await application.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
    );
    expect(head?.version).toBe(SCHEMA_VERSION);
    // A second run is the idempotent pre-deploy job of every later deployment.
    await application.migrate();

    // Tables, and every relation, type and function the migrations create, belong to the login,
    // so no superuser-only statement or admin-owned object is needed at runtime.
    const tables = await owner.query<{ owner: string }>(
      "SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname='public'",
    );
    expect(tables).toEqual([{ owner: role }]);
    const objects = await owner.query<{ owner: string }>(
      `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relnamespace='public'::regnamespace
       UNION SELECT pg_get_userbyid(typowner) FROM pg_type WHERE typnamespace='public'::regnamespace
       UNION SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE pronamespace='public'::regnamespace`,
    );
    expect(objects).toEqual([{ owner: role }]);
  });
});
