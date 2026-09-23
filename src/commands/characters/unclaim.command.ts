/** Remove a self-owned link using local identity, including during Lodestone outages. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeCharacter } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import { unlinkReply } from "../../discord/presenters/characters.js";
import { id } from "../../domain/values.js";

export default defineCommand({
  data: command("unclaim", "Remove your local character link").addStringOption(
    string("character", "Stored character ID", true, true),
  ),
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    return unlinkReply(
      await services
        .get(applicationKey)
        .unclaim(
          actor,
          actor.userId,
          id(interaction.options.getString("character", true), "character"),
        ),
      viewer,
      { command: "unclaim" },
    );
  },
  autocomplete: (context) => completeCharacter(context),
});
