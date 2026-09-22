/** Operator CLI: requeue failed/blocked delivery without repeating its committed decision. */
import { z } from "zod";
import { id } from "../src/domain/values.js";
import { audit, Database } from "../src/infrastructure/postgres/database.js";
const guild = id(process.argv[2]);
const job = z.uuid().parse(process.argv[3]);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = new Database(url);
try {
  await db.schema();
  await db.transaction(async (client) => {
    // The supplied guild must own the job; completed effects cannot be replayed through this tool.
    const rows = await client.query(
      "UPDATE jobs SET status='queued',attempts=0,due_at=now(),last_error=NULL WHERE id=$1 AND guild_id=$2 AND status IN ('blocked','failed','disabled') RETURNING id",
      [job, guild],
    );
    if (!rows.rowCount) throw new Error("No retryable job with that ID belongs to this guild.");
    await audit(client, guild, null, "job.retry", job);
  });
  console.log("Committed work queued for independent delivery retry.");
} finally {
  await db.close();
}
