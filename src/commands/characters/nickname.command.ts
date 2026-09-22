/** Explicit nickname opt-in/out; restoration is a durable reconciliation effect. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";

export default defineCommand({
  data: command(
    "nickname",
    "Enable or disable character-based nickname management",
  ).addBooleanOption((option) =>
    option.setName("enabled").setDescription("Enable character nicknames").setRequired(true),
  ),
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    return dataReply(
      await services
        .get(applicationKey)
        .preferences(actor, null, interaction.options.getBoolean("enabled", true)),
    );
  },
});
