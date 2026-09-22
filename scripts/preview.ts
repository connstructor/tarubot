/** Read-only cutover CLI: compare current complete Discord membership to accepted policy evidence. */
import { randomUUID } from "node:crypto";
import { Events } from "discord.js";
import { configuration } from "../src/config/env.js";
import { DiscordGateway } from "../src/discord/gateway.js";
import { Service } from "../src/application/service.js";
import { Synchronization } from "../src/application/synchronization.js";
import { Database } from "../src/infrastructure/postgres/database.js";
import { Nodestone } from "../src/infrastructure/nodestone/client.js";
import { id, json } from "../src/domain/values.js";

const config = configuration();
const guild = id(process.argv[2]);
const db = new Database(config.DATABASE_URL);
const gateway = new DiscordGateway();
try {
  await db.schema();
  const fresh = await db.query(
    "SELECT g.id FROM guilds g JOIN free_companies f ON f.id=g.fc_id WHERE g.id=$1 AND f.last_successful_roster_at>now()-$2*interval '1 second'",
    [guild, config.ROSTER_INTERVAL_SECONDS],
  );
  if (!fresh.length)
    throw new Error("Acquire a fresh complete roster first with roster:acquire GUILD_ID.");
  await gateway.client.login(config.DISCORD_TOKEN);
  // Connection readiness is the only subscription needed by this isolated read-only tool.
  if (!gateway.client.isReady())
    await new Promise<void>((resolve) => gateway.client.once(Events.ClientReady, () => resolve()));
  const sync = new Synchronization(
    new Service(db, gateway, new Nodestone(config.NODESTONE_URL), config),
  );
  const actions = [];
  for (const member of await gateway.members(guild)) {
    // Preview mode uses a transient job-shaped context and never publishes it to the queue.
    if (member.bot) continue;
    actions.push(
      await sync.user(
        {
          id: randomUUID(),
          kind: "reconcile.user",
          guild_id: guild,
          user_id: member.id,
          payload: {},
          payload_version: 1,
          generation: 1,
          attempts: 0,
          lease_token: randomUUID(),
          message_id: null,
        },
        async () => {},
        true,
      ),
    );
  }
  console.log(
    json({
      guildId: guild,
      previewedAt: new Date().toISOString(),
      enumerationComplete: true,
      actions,
    }),
  );
} finally {
  gateway.client.destroy();
  await db.close();
}
