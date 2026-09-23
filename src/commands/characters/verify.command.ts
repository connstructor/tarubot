/** Complete a caller-bound persisted challenge using a fresh profile. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeCharacter } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import { verifyReply } from "../../discord/presenters/characters.js";
import { id } from "../../domain/values.js";

export default defineCommand({
  data: command("verify", "Verify your pending profile challenge").addStringOption(
    string("character", "Character ID", true, true),
  ),
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    // A token not yet visible fails as pending_proof, which the router shows with Check again.
    return verifyReply(
      await services
        .get(applicationKey)
        .verify(actor, id(interaction.options.getString("character", true), "character")),
      viewer,
    );
  },
  autocomplete: (context) => completeCharacter(context, "verify"),
});
