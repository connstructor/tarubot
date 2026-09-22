/** Request a durable refresh; force authorization is enforced even with fresh cached data. */
import { synchronizationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";

export default defineCommand({
  data: command("refresh", "Refresh FC evidence when due and reconcile access").addBooleanOption(
    (option) => option.setName("force").setDescription("Officer-only bypass of roster freshness"),
  ),
  requires: [synchronizationKey],
  async execute({ actor, interaction, services }) {
    return dataReply(
      await services
        .get(synchronizationKey)
        .refresh(actor, interaction.options.getBoolean("force") ?? false),
    );
  },
});
