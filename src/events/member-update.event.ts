/** Coalesce role/nickname drift, including delayed echoes of the bot's own REST writes. */
import { Events } from "discord.js";
import { guildEventsKey } from "../application/keys.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "member-drift",
  event: Events.GuildMemberUpdate,
  requires: [guildEventsKey],
  async execute(context, before, after) {
    if (!context.allowsGuild(after.guild.id) || after.user.bot) return;
    // The reconciler checks fresh state before classifying a nickname change as manual.
    if (before.nickname !== after.nickname || !before.roles.cache.equals(after.roles.cache)) {
      await context.services.get(guildEventsKey).memberChanged(after.guild.id, after.id);
    }
  },
});
