/** Audited officer removal supports stored owners who have left Discord. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeCharacter } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";
import { userId } from "../../discord/selectors.js";
import { authorize } from "../../domain/policy.js";
import { id } from "../../domain/values.js";

export default defineCommand({
  data: command("unassign", "Remove a user's local character link")
    .addStringOption(string("member", "Stored owner ID, including users who left Discord", true))
    .addStringOption(string("character", "Stored character ID", true, true))
    .addStringOption(string("reason", "Audited reason", true)),
  access: "officer",
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    authorize(actor, actor.guildId, "officer");
    return dataReply(
      await services
        .get(applicationKey)
        .unclaim(
          actor,
          userId(interaction.options.getString("member", true)),
          id(interaction.options.getString("character", true)),
          interaction.options.getString("reason", true),
        ),
    );
  },
  autocomplete(context) {
    // The selected owner, not the invoking officer, scopes the autocomplete query.
    authorize(context.actor, context.actor.guildId, "officer");
    return completeCharacter(
      context,
      "character",
      userId(context.interaction.options.getString("member", true)),
    );
  },
});
