/** Read-only restore verification: compare complete data and schema support objects exactly. */
import { Database } from "../src/infrastructure/postgres/database.js";
import { json } from "../src/domain/values.js";

const original = process.env.DATABASE_URL;
const recovered = process.env.RESTORE_DATABASE_URL;
if (!original || !recovered) throw new Error("DATABASE_URL and RESTORE_DATABASE_URL are required.");
const source = new Database(original);
const target = new Database(recovered);
/** Catalog identifiers still need SQL quoting; unlike values, identifiers cannot be bind parameters. */
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
try {
  await source.schema();
  await target.schema();
  const catalog = "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename";
  const tables = await source.query<{ tablename: string }>(catalog);
  if (json(tables) !== json(await target.query(catalog)))
    throw new Error("Restored table inventory differs.");
  for (const { tablename } of tables) {
    // Hash exact PostgreSQL text, so JSON parsing never rounds bigint values.
    const sql = `SELECT count(*)::text AS rows,md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) AS checksum FROM public.${quote(tablename)} t`;
    const expected = await source.query<{ rows: string; checksum: string }>(sql);
    const actual = await target.query(sql);
    if (json(expected) !== json(actual)) throw new Error(`Restore mismatch: ${tablename}`);
    console.log(json({ table: tablename, rows: expected[0]?.rows, verified: true }));
  }
  for (const sql of [
    "SELECT sequencename,last_value::text,increment_by::text FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename",
    "SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname",
    "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conname,definition",
  ]) {
    if (json(await source.query(sql)) !== json(await target.query(sql))) {
      throw new Error("Restored sequence, trigger, or constraint definitions differ.");
    }
  }
  console.log(
    "Restore verified: every application row, sequence, trigger, and constraint matches.",
  );
} finally {
  await source.close();
  await target.close();
}
