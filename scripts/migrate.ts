/** One-shot schema migration; execution is serialized and checksums are verified by Database. */
import { Database } from "../src/infrastructure/postgres/database.js";
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
