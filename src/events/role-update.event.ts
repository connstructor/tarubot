/** Role permissions and positions can change after configuration validation. */
import { Events } from "discord.js";
import { guildEventsKey } from "../application/keys.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "role-updated",
  event: Events.GuildRoleUpdate,
  requires: [guildEventsKey],
  async execute(context, _before, after) {
    if (context.allowsGuild(after.guild.id))
      await context.services.get(guildEventsKey).roleChanged(after.guild.id);
  },
});
