/** Explicit nickname opt-in/out; restoration is a durable reconciliation effect. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { preferencesReply } from "../../discord/presenters/characters.js";

export default defineCommand({
  data: command(
    "nickname",
    "Enable or disable character-based nickname management",
  ).addBooleanOption((option) =>
    option.setName("enabled").setDescription("Enable character nicknames").setRequired(true),
  ),
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    return preferencesReply(
      await services
        .get(applicationKey)
        .preferences(actor, null, interaction.options.getBoolean("enabled", true)),
      viewer,
      // The cached guild names its owner, whose nickname Discord never lets a bot change.
      { command: "nickname", guildOwner: interaction.guild?.ownerId === actor.userId },
    );
  },
});
