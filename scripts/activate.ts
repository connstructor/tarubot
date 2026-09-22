/** Maintenance CLI: validate an imported guild and atomically enable its queued effects. */
import { Events } from "discord.js";
import { configuration } from "../src/config/env.js";
import { DiscordGateway } from "../src/discord/gateway.js";
import { Database, audit } from "../src/infrastructure/postgres/database.js";
import { enqueue } from "../src/jobs/queue.js";
import { id } from "../src/domain/values.js";
import type { GuildRecord } from "../src/application/records.js";

const config = configuration();
const guildId = id(process.argv[2]);
const db = new Database(config.DATABASE_URL);
const gateway = new DiscordGateway();
try {
  await db.schema();
  const guild = (await db.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1", [guildId]))[0];
  if (!guild) throw new Error("Unknown guild");
  if (guild.fc_id) {
    const fresh = await db.query(
      "SELECT id FROM free_companies WHERE id=$1 AND last_successful_roster_at>now()-$2*interval '1 second'",
      [guild.fc_id, config.ROSTER_INTERVAL_SECONDS],
    );
    if (!fresh.length)
      throw new Error("Acquire a fresh complete roster and review the preview before activation.");
  }
  await gateway.client.login(config.DISCORD_TOKEN);
  // This one-shot client awaits readiness without installing the live bot's feature events.
  if (!gateway.client.isReady())
    await new Promise<void>((resolve) => gateway.client.once(Events.ClientReady, () => resolve()));
  for (const role of [
    guild.member_role_id,
    guild.guest_role_id,
    guild.officer_role_id,
    guild.leader_role_id,
  ])
    if (role) await gateway.validateRole(guildId, role);
  for (const channel of [
    guild.ledger_channel_id,
    guild.officer_notifications_channel_id,
    guild.guest_application_channel_id,
  ])
    if (channel) await gateway.validateChannel(guildId, channel);
  await db.transaction(async (client) => {
    // Activation changes policy and queued work together; Discord delivery follows afterward.
    await client.query(
      "UPDATE guilds SET active=true,effects_enabled=true,revision=revision+1 WHERE id=$1",
      [guildId],
    );
    await audit(client, guildId, null, "activation", guildId);
    await client.query(
      "UPDATE jobs SET status='queued',due_at=now(),attempts=0 WHERE guild_id=$1 AND status IN ('disabled','blocked')",
      [guildId],
    );
    await enqueue(client, "reconcile.guild", `guild:${guildId}`, {}, guildId);
  });
  console.log("Guild activated. Run the sole bot writer with ENABLE_EFFECTS=true.");
} finally {
  gateway.client.destroy();
  await db.close();
}
