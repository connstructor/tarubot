/** Discovery fixture: metadata, execution, and autocomplete belong to one command object. */
import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "../../../../src/bot/command.js";
import { reply } from "../../../../src/discord/presenters/reply.js";
export default defineCommand({
  data: new SlashCommandBuilder().setName("fixture-second").setDescription("Second test command"),
  execute() {
    // Handlers return presenter replies; the router adds visibility and forces mentions off.
    return reply({ tone: "neutral", title: "Second module" });
  },
});
