/** Companion collision fixture for deterministic startup validation. */
import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "../../../../src/bot/command.js";
export default defineCommand({
  data: new SlashCommandBuilder().setName("duplicate").setDescription("Second duplicate"),
  execute: () => ({ content: "second" }),
});
