/**
 * One-shot schema migration; execution is serialized and checksums are verified by Database.
 *
 *   bun dist/scripts/migrate.js                        (the profile's own database)
 *   bun dist/scripts/migrate.js --restore-rehearsal    (a disposable *_restore_test copy first)
 *
 * --restore-rehearsal is DevBot's pre-migration rehearsal on its restored copy (docs/OPERATIONS.md):
 * the deployment guard then accepts DATABASE_URL only when it names a *_restore_test database.
 */
import { assertToolScope, type ToolScope } from "../src/config/deployment.js";
import { Failure } from "../src/domain/values.js";
import { Database } from "../src/infrastructure/postgres/database.js";

/** The only option is --restore-rehearsal; anything else is refused before any I/O. */
export function migrateArguments(argv: readonly string[]): { restoreRehearsal: boolean } {
  let restoreRehearsal = false;
  for (const argument of argv) {
    if (argument === "--restore-rehearsal" && !restoreRehearsal) restoreRehearsal = true;
    else throw new Failure("input", `Unexpected argument ${argument}.`);
  }
  return { restoreRehearsal };
}

/**
 * The deployment guard's view of a migration: DATABASE_URL only, and a *_restore_test copy only
 * with --restore-rehearsal. Exported so tests check exactly what migrate.js declares.
 */
export function migrateToolScope(args: { restoreRehearsal: boolean }): ToolScope {
  return {
    tool: "migrate",
    guilds: [],
    discord: "none",
    databases: ["DATABASE_URL"],
    restoreRehearsal: args.restoreRehearsal,
  };
}

if (import.meta.main) {
  const args = migrateArguments(process.argv.slice(2));
  // The database must belong to this env's deployment profile before any connection.
  assertToolScope(process.env, migrateToolScope(args));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = new Database(url);
  try {
    await db.migrate();
    await db.schema();
    console.log("Schema ready.");
  } finally {
    await db.close();
  }
}
