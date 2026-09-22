/** Disable work when removed while retaining the guild's audit and policy history. */
import { Events } from "discord.js";
import { guildEventsKey } from "../application/keys.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "guild-left",
  event: Events.GuildDelete,
  requires: [guildEventsKey],
  async execute(context, guild) {
    if (context.allowsGuild(guild.id))
      await context.services.get(guildEventsKey).guildLeft(guild.id);
  },
});
