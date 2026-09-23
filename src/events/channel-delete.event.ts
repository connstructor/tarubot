/** Deleted onboarding resources become actionable blocked work until setup repairs their bindings. */
import { Events } from "discord.js";
import { guildEventsKey } from "../application/keys.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "channel-deleted",
  event: Events.ChannelDelete,
  requires: [guildEventsKey],
  async execute(context, channel) {
    if ("guild" in channel && context.allowsGuild(channel.guild.id))
      await context.services.get(guildEventsKey).channelChanged(channel.guild.id);
  },
});
