/** New guild channels inherit the onboarding visibility policy through durable reconciliation. */
import { Events } from "discord.js";
import { guildEventsKey } from "../application/keys.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "channel-created",
  event: Events.ChannelCreate,
  requires: [guildEventsKey],
  async execute(context, channel) {
    if ("guild" in channel && context.allowsGuild(channel.guild.id))
      await context.services.get(guildEventsKey).channelChanged(channel.guild.id);
  },
});
