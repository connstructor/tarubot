/** A changed community-updates binding changes the channel policy's protected scope. */
import { Events } from "discord.js";
import { guildEventsKey } from "../application/keys.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "guild-community-updated",
  event: Events.GuildUpdate,
  requires: [guildEventsKey],
  async execute(context, before, after) {
    if (
      before.publicUpdatesChannelId !== after.publicUpdatesChannelId &&
      context.allowsGuild(after.id)
    )
      await context.services.get(guildEventsKey).channelChanged(after.id);
  },
});
