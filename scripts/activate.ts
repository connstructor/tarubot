/** Maintenance CLI: validate an imported guild and atomically enable its queued effects. */
import { Events } from "discord.js";
import { configuration } from "../src/config/env.js";
import { DiscordGateway } from "../src/discord/gateway.js";
import { Database, audit, orm } from "../src/infrastructure/postgres/database.js";
import { enqueue } from "../src/jobs/queue.js";
import { id } from "../src/domain/values.js";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import * as t from "../src/infrastructure/postgres/schema.js";

const config = configuration();
const guildId = id(process.argv[2]);
const db = new Database(config.DATABASE_URL);
const gateway = new DiscordGateway();
try {
  await db.schema();
  const [guild] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, guildId));
  if (!guild) throw new Error("Unknown guild");
  if (guild.fc_id) {
    const fresh = await db.orm
      .select({ id: t.freeCompanies.id })
      .from(t.freeCompanies)
      .where(
        and(
          eq(t.freeCompanies.id, guild.fc_id),
          gt(
            t.freeCompanies.last_successful_roster_at,
            sql`now()-${config.ROSTER_INTERVAL_SECONDS}*interval '1 second'`,
          ),
        ),
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
    const store = orm(client);
    await store
      .update(t.guilds)
      .set({ active: true, effects_enabled: true, revision: sql`${t.guilds.revision}+1` })
      .where(eq(t.guilds.id, guildId));
    await audit(client, guildId, null, "activation", guildId);
    await store
      .update(t.jobs)
      .set({ status: "queued", due_at: sql`now()`, attempts: 0 })
      .where(and(eq(t.jobs.guild_id, guildId), inArray(t.jobs.status, ["disabled", "blocked"])));
    await enqueue(client, "reconcile.guild", `guild:${guildId}`, {}, guildId);
  });
  console.log("Guild activated. Run the sole bot writer with ENABLE_EFFECTS=true.");
} finally {
  gateway.client.destroy();
  await db.close();
}
