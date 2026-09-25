/** Maintenance CLI: publish fresh roster evidence for a guild without running Discord effects. */
import { randomUUID } from "node:crypto";
import { assertToolScope } from "../src/config/deployment.js";
import { configuration } from "../src/config/env.js";
import { DiscordGateway } from "../src/discord/gateway.js";
import { Service } from "../src/application/service.js";
import { Synchronization } from "../src/application/synchronization.js";
import { Database } from "../src/infrastructure/postgres/database.js";
import { Lodestone } from "../src/infrastructure/lodestone/client.js";
import { enqueue } from "../src/jobs/queue.js";
import { id, json } from "../src/domain/values.js";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import * as t from "../src/infrastructure/postgres/schema.js";

const config = configuration();
const guild = id(process.argv[2]);
// The guild and database must belong to this env's deployment profile before any connection.
assertToolScope(process.env, {
  tool: "acquire",
  guilds: [guild],
  discord: "none",
  databases: ["DATABASE_URL"],
});
const db = new Database(config.DATABASE_URL);
// The parser runs in this process (2.21.0). Like the bot, it parses with the selector repository's
// HEAD, checked once here; the bundled set stays if GitHub can't be reached or HEAD is rejected.
const lodestone = new Lodestone();
await lodestone.refresh();
try {
  await db.schema();
  const [configured] = await db.orm
    .select({ fc_id: t.guilds.fc_id })
    .from(t.guilds)
    .where(and(eq(t.guilds.id, guild), eq(t.guilds.active, true)));
  const fc = configured?.fc_id;
  if (!fc) throw new Error("Guild has no linked FC.");
  const key = await enqueue(db.pool, "roster", `roster:${fc}`, { fcId: fc });
  // Reuse the same deduplicated job and lease fence as the background worker.
  const token = randomUUID();
  const [job] = await db.orm
    .update(t.jobs)
    .set({
      status: "running",
      lease_token: token,
      lease_until: sql`now()+interval '6 minutes'`,
      attempts: sql`${t.jobs.attempts}+1`,
    })
    .where(and(eq(t.jobs.id, key), ne(t.jobs.status, "running")))
    .returning();
  if (!job?.lease_token) throw new Error("Another worker owns this refresh; use /sync status.");
  const service = new Service(
    // Constructing the gateway supplies the port contract; this acquisition never logs into Discord.
    db,
    new DiscordGateway(),
    lodestone,
    config,
  );
  const sync = new Synchronization(service);
  const result = await sync.roster({ ...job, lease_token: job.lease_token }, async () => {
    // Even a one-shot operator must relinquish results after losing work ownership.
    const rows = await db.orm
      .select({ id: t.jobs.id })
      .from(t.jobs)
      .where(
        and(eq(t.jobs.id, key), eq(t.jobs.lease_token, token), gt(t.jobs.lease_until, sql`now()`)),
      );
    if (!rows.length) throw new Error("Acquisition lease expired");
  });
  await db.orm
    .update(t.jobs)
    .set({
      status: "succeeded",
      lease_until: null,
      result: result === null ? sql`'null'::jsonb` : result,
    })
    .where(and(eq(t.jobs.id, key), eq(t.jobs.lease_token, token)));
  console.log(json(result));
} finally {
  await db.close();
}
