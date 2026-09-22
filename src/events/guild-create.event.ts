/** Resume retained state when the bot joins or rediscovers an already configured guild. */
import { Events } from "discord.js";
import { guildEventsKey } from "../application/keys.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "guild-joined",
  event: Events.GuildCreate,
  requires: [guildEventsKey],
  async execute(context, guild) {
    if (context.allowsGuild(guild.id))
      await context.services.get(guildEventsKey).guildJoined(guild.id);
  },
});
