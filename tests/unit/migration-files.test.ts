/**
 * The numbered migrations, checked without a database: every file matches MIGRATION_FILE, the
 * numbers run 001..N with no gap or repeat, and SCHEMA_VERSION names the newest file. CI's
 * integration run would notice a missing head only once PostgreSQL is up; a second 009 (two branches
 * taking the same number) or a SCHEMA_VERSION left behind fails here first.
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { MIGRATION_FILE, SCHEMA_VERSION } from "../../src/infrastructure/postgres/database.js";

const directory = fileURLToPath(new URL("../../migrations", import.meta.url));

test("migrations are numbered 001..N without gaps or repeats, and SCHEMA_VERSION is the last", async () => {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files)
    expect({ file, named: MIGRATION_FILE.test(file) }).toEqual({ file, named: true });
  // Each file's three-digit prefix is its position in runner order.
  expect(files.map((file) => file.slice(0, 3))).toEqual(
    files.map((_, index) => String(index + 1).padStart(3, "0")),
  );
  expect(files.at(-1)).toBe(SCHEMA_VERSION);
});
