/** Primary selection resolves stored links, independent of profile availability. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeCharacter } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";
import { id } from "../../domain/values.js";

export default defineCommand({
  data: command("main", "Choose your guild-specific primary character").addStringOption(
    string("character", "Active trusted character ID", true, true),
  ),
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    return dataReply(
      await services
        .get(applicationKey)
        .preferences(
          actor,
          id(interaction.options.getString("character", true), "character"),
          null,
        ),
    );
  },
  autocomplete: (context) => completeCharacter(context),
});
