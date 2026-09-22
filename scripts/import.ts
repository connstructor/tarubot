/** Legacy import CLI: decode/validate first, print a dry run or publish the complete mapped import. */
import { readDump } from "../src/import/dump.js";
import {
  importLegacy,
  importReport,
  mappings,
  mappingSchema,
  snapshotSchema,
} from "../src/import/importer.js";
import { Database } from "../src/infrastructure/postgres/database.js";
import { json } from "../src/domain/values.js";

const args = process.argv.slice(2);
/** Read named file/timezone options; validation below rejects missing required arguments. */
const option = (key: string) => {
  const index = args.indexOf(key);
  return index < 0 ? undefined : args[index + 1];
};
const file = option("--file");
if (!file)
  throw new Error(
    "Use --file DUMP.sql [--snapshot SNAPSHOT.json] [--mapping MAP.json] [--dry-run] [--source-timezone UTC].",
  );
if (option("--source-timezone") && option("--source-timezone") !== "UTC")
  throw new Error(
    "This migration uses the owner-approved UTC interpretation. Supply --source-timezone UTC.",
  );
const data = readDump(await Bun.file(file).text());
const mappingPath = option("--mapping");
const mapping = mappings(
  data,
  mappingPath ? mappingSchema.parse(await Bun.file(mappingPath).json()) : undefined,
);
const snapshotPath = option("--snapshot");
const snapshot = snapshotPath ? snapshotSchema.parse(await Bun.file(snapshotPath).json()) : null;
if (args.includes("--dry-run")) {
  // Dry runs do not construct a database connection or change application state.
  console.log(json(importReport(data, snapshot, mapping)));
} else {
  if (!snapshot) throw new Error("A complete --snapshot is required to publish an import.");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = new Database(url);
  try {
    await db.schema();
    console.log(json(await importLegacy(db, data, snapshot, mapping)));
  } finally {
    await db.close();
  }
}
