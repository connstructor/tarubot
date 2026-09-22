/** A departure invalidates pending review context, without deleting durable ownership/grants. */
import { Events } from "discord.js";
import { guildEventsKey } from "../application/keys.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "member-left",
  event: Events.GuildMemberRemove,
  requires: [guildEventsKey],
  async execute(context, member) {
    if (context.allowsGuild(member.guild.id))
      await context.services.get(guildEventsKey).memberLeft(member.guild.id, member.id);
  },
});
