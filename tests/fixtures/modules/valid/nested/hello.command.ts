/** Discovery fixture: a nested command works without appearing in a central import list. */
import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "../../../../../src/bot/command.js";
export default defineCommand({
  data: new SlashCommandBuilder().setName("fixture-hello").setDescription("Nested test command"),
  execute({ actor }) {
    return { content: `Hello ${actor.userId}` };
  },
  autocomplete() {
    return [{ name: "fixture choice", value: "fixture" }];
  },
});
