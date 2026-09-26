/** Read-only metadata for the invoking channel. */
import { PermissionFlagsBits } from "discord.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { isObfuscated } from "../../discord/obfuscation.js";
import { channelReply } from "../../discord/presenters/utility.js";

export default defineCommand({
  data: command("channel", "Show this channel's ID, name, and type"),
  execute({ interaction }) {
    // The channel is resolved from the client cache; an uncached one still has its ID.
    const channel = interaction.channel;
    // Discord obfuscates a channel TaruBot can't view (#47): its cached entry is `___hidden___`, or,
    // once a channel option has patched it, a real name over synthetic permissions. The payload's
    // app_permissions are never obfuscated, so without View Channel there (or with the flag still
    // set) the reply shows the "can't see this channel's details" card instead of either name.
    const unseen =
      !interaction.appPermissions.has(PermissionFlagsBits.ViewChannel) || isObfuscated(channel);
    if (unseen || !channel)
      return channelReply({ id: interaction.channelId, name: null, type: null });
    return channelReply({
      id: interaction.channelId,
      name: "name" in channel && typeof channel.name === "string" ? channel.name : null,
      type: channel.type,
    });
  },
});
