/** Private link inventory; inspecting another user requires officer permission. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";
import { userId } from "../../discord/selectors.js";
import { authorize } from "../../domain/policy.js";

export default defineCommand({
  data: command("characters", "List local characters and verification provenance").addStringOption(
    string("member", "Discord user ID; officers may inspect another user"),
  ),
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    const owner = userId(interaction.options.getString("member") ?? actor.userId);
    authorize(actor, actor.guildId, "user", owner);
    return dataReply(await services.get(applicationKey).characters(actor, owner));
  },
});
