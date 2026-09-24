/** Read-only metadata for the invoking channel. */
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { channelReply } from "../../discord/presenters/utility.js";

export default defineCommand({
  data: command("channel", "Show this channel's ID, name, and type"),
  execute({ interaction }) {
    // The channel is resolved from the client cache; an uncached one still has its ID.
    const channel = interaction.channel;
    return channelReply({
      id: interaction.channelId,
      name: channel && "name" in channel && typeof channel.name === "string" ? channel.name : null,
      type: channel ? channel.type : null,
    });
  },
});
