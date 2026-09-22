/** Deleted configured roles become scoped diagnostics during reconciliation. */
import { Events } from "discord.js";
import { guildEventsKey } from "../application/keys.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "role-deleted",
  event: Events.GuildRoleDelete,
  requires: [guildEventsKey],
  async execute(context, role) {
    if (context.allowsGuild(role.guild.id))
      await context.services.get(guildEventsKey).roleChanged(role.guild.id);
  },
});
