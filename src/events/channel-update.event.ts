/** Permission and category drift is coalesced, including the bot's own gateway echoes. */
import { Events } from "discord.js";
import { guildEventsKey } from "../application/keys.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "channel-updated",
  event: Events.ChannelUpdate,
  requires: [guildEventsKey],
  async execute(context, _before, channel) {
    if ("guild" in channel && context.allowsGuild(channel.guild.id))
      await context.services.get(guildEventsKey).channelChanged(channel.guild.id);
  },
});
