/** Primary selection resolves stored links, independent of profile availability. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeCharacter } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import { preferencesReply } from "../../discord/presenters/characters.js";
import { id } from "../../domain/values.js";

export default defineCommand({
  data: command("main", "Choose your guild-specific primary character").addStringOption(
    string("character", "Active trusted character ID", true, true),
  ),
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    return preferencesReply(
      await services
        .get(applicationKey)
        .preferences(
          actor,
          id(interaction.options.getString("character", true), "character"),
          null,
        ),
      viewer,
      // The cached guild names its owner, whose nickname Discord never lets a bot change.
      { command: "main", guildOwner: interaction.guild?.ownerId === actor.userId },
    );
  },
  autocomplete: (context) => completeCharacter(context),
});
