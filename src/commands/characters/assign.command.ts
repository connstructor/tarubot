/** Officer assignment uses the same identity resolution as claims and records its reason. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";
import { resolveCharacter, userId } from "../../discord/selectors.js";
import { authorize } from "../../domain/policy.js";

export default defineCommand({
  data: command("assign", "Assign a trusted character link to a member")
    .addStringOption(string("member", "Discord user ID or mention", true))
    .addStringOption(string("reason", "Assignment reason", true))
    .addStringOption(string("character", "Character ID or canonical Lodestone URL"))
    .addStringOption(string("forename", "Exact forename"))
    .addStringOption(string("surname", "Exact surname"))
    .addStringOption(string("world", "Exact world")),
  access: "officer",
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    authorize(actor, actor.guildId, "officer");
    const app = services.get(applicationKey);
    await app.guild(actor);
    return dataReply(
      await app.assign(
        actor,
        userId(interaction.options.getString("member", true)),
        await resolveCharacter(app, interaction),
        interaction.options.getString("reason", true),
      ),
    );
  },
});
