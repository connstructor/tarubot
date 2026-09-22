/** Discovery fixture: metadata, execution, and autocomplete belong to one command object. */
import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "../../../../src/bot/command.js";
export default defineCommand({
  data: new SlashCommandBuilder().setName("fixture-second").setDescription("Second test command"),
  execute() {
    return { content: "Second module" };
  },
});
