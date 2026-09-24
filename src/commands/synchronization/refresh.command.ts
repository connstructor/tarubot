/** Request a durable refresh; force authorization is enforced even with fresh cached data. */
import { synchronizationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { refreshReply } from "../../discord/presenters/synchronization.js";

export default defineCommand({
  data: command("refresh", "Refresh FC evidence when due and reconcile access").addBooleanOption(
    (option) => option.setName("force").setDescription("Officer-only bypass of roster freshness"),
  ),
  requires: [synchronizationKey],
  async execute({ actor, viewer, interaction, services }) {
    // The service refuses force:true from a member and a server without a linked FC; the
    // failure presenter renders both, so the receipt only ever describes a requested run.
    return refreshReply(
      await services
        .get(synchronizationKey)
        .refresh(actor, interaction.options.getBoolean("force") ?? false),
      viewer,
    );
  },
});
