/** Maintenance CLI: publish fresh roster evidence for a guild without running Discord effects. */
import { randomUUID } from "node:crypto";
import { configuration } from "../src/config/env.js";
import { DiscordGateway } from "../src/discord/gateway.js";
import { Service } from "../src/application/service.js";
import { Synchronization } from "../src/application/synchronization.js";
import { Database } from "../src/infrastructure/postgres/database.js";
import { Nodestone } from "../src/infrastructure/nodestone/client.js";
import { enqueue, type Job } from "../src/jobs/queue.js";
import { id, json } from "../src/domain/values.js";

const config = configuration();
const guild = id(process.argv[2]);
const db = new Database(config.DATABASE_URL);
try {
  await db.schema();
  const fc = (
    await db.query<{ fc_id: string | null }>("SELECT fc_id FROM guilds WHERE id=$1 AND active", [
      guild,
    ])
  )[0]?.fc_id;
  if (!fc) throw new Error("Guild has no linked FC.");
  const key = await enqueue(db.pool, "roster", `roster:${fc}`, { fcId: fc });
  // Reuse the same deduplicated job and lease fence as the background worker.
  const token = randomUUID();
  const job = (
    await db.query<Job>(
      "UPDATE jobs SET status='running',lease_token=$2,lease_until=now()+interval '6 minutes',attempts=attempts+1 WHERE id=$1 AND status<>'running' RETURNING *",
      [key, token],
    )
  )[0];
  if (!job) throw new Error("Another worker owns this refresh; use /sync status.");
  const service = new Service(
    // Constructing the gateway supplies the port contract; this acquisition never logs into Discord.
    db,
    new DiscordGateway(),
    new Nodestone(config.NODESTONE_URL),
    config,
  );
  const sync = new Synchronization(service);
  const result = await sync.roster(job, async () => {
    // Even a one-shot operator must relinquish results after losing work ownership.
    const rows = await db.query(
      "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND lease_until>now()",
      [key, token],
    );
    if (!rows.length) throw new Error("Acquisition lease expired");
  });
  await db.query(
    "UPDATE jobs SET status='succeeded',lease_until=NULL,result=$3 WHERE id=$1 AND lease_token=$2",
    [key, token, json(result)],
  );
  console.log(json(result));
} finally {
  await db.close();
}
