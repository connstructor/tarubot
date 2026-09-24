/** Discovery fixture: a nested command works without appearing in a central import list. */
import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "../../../../../src/bot/command.js";
import { reply } from "../../../../../src/discord/presenters/reply.js";
export default defineCommand({
  data: new SlashCommandBuilder().setName("fixture-hello").setDescription("Nested test command"),
  execute({ actor }) {
    // Handlers answer with presenter replies; the router owns visibility and mentions.
    return reply({ tone: "neutral", title: `Hello ${actor.userId}` });
  },
  autocomplete() {
    return [{ name: "fixture choice", value: "fixture" }];
  },
});
