/** A colliding route must be rejected instead of winning by filesystem ordering. */
import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "../../../../src/bot/command.js";
import { reply } from "../../../../src/discord/presenters/reply.js";
export default defineCommand({
  data: new SlashCommandBuilder().setName("duplicate").setDescription("First duplicate"),
  execute: () => reply({ tone: "neutral", title: "First" }),
});
