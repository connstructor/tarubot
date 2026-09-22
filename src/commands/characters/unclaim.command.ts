/** Remove a self-owned link using local identity, including during Lodestone outages. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeCharacter } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";
import { id } from "../../domain/values.js";

export default defineCommand({
  data: command("unclaim", "Remove your local character link").addStringOption(
    string("character", "Stored character ID", true, true),
  ),
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    return dataReply(
      await services
        .get(applicationKey)
        .unclaim(actor, actor.userId, id(interaction.options.getString("character", true))),
    );
  },
  autocomplete: (context) => completeCharacter(context),
});
