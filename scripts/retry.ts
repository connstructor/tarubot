/** Operator CLI: requeue failed/blocked delivery without repeating its committed decision. */
import { z } from "zod";
import { id } from "../src/domain/values.js";
import { audit, Database, orm } from "../src/infrastructure/postgres/database.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as t from "../src/infrastructure/postgres/schema.js";
const guild = id(process.argv[2]);
const job = z.uuid().parse(process.argv[3]);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = new Database(url);
try {
  await db.schema();
  await db.transaction(async (client) => {
    // The supplied guild must own the job; completed effects cannot be replayed through this tool.
    const rows = await orm(client)
      .update(t.jobs)
      .set({ status: "queued", attempts: 0, due_at: sql`now()`, last_error: null })
      .where(
        and(
          eq(t.jobs.id, job),
          eq(t.jobs.guild_id, guild),
          inArray(t.jobs.status, ["blocked", "failed", "disabled"]),
        ),
      )
      .returning({ id: t.jobs.id });
    if (!rows.length) throw new Error("No retryable job with that ID belongs to this guild.");
    await audit(client, guild, null, "job.retry", job);
  });
  console.log("Committed work queued for independent delivery retry.");
} finally {
  await db.close();
}
