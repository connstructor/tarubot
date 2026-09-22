/** Read-only metadata for the invoking channel. */
import { ChannelType } from "discord.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";

export default defineCommand({
  data: command("channel", "Show this channel's ID, name, and type"),
  execute({ interaction }) {
    return dataReply({
      id: interaction.channelId,
      name: interaction.channel && "name" in interaction.channel ? interaction.channel.name : null,
      type: interaction.channel ? ChannelType[interaction.channel.type] : null,
    });
  },
});
