/** Human joins restore presence and enqueue access/nickname policy reconciliation. */
import { Events } from "discord.js";
import { guildEventsKey } from "../application/keys.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "member-joined",
  event: Events.GuildMemberAdd,
  requires: [guildEventsKey],
  async execute(context, member) {
    if (!context.allowsGuild(member.guild.id) || member.user.bot) return;
    await context.services
      .get(guildEventsKey)
      .memberJoined(member.guild.id, member.id, member.joinedAt ?? new Date());
  },
});
