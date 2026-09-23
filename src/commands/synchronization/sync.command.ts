/** Inspect persisted run/child-work status after an interaction's response token expires. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { syncStatusReply } from "../../discord/presenters/synchronization.js";
import { uuid } from "../../discord/selectors.js";

export default defineCommand({
  data: command("sync", "Inspect durable synchronization and delivery work").addSubcommand((sub) =>
    sub
      .setName("status")
      .setDescription("Inspect your requests, or guild-wide work as an officer")
      .addStringOption(string("run_id", "Synchronization run ID")),
  ),
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    const option = interaction.options.getString("run_id");
    const run = option ? uuid(option, "run") : null;
    // The service scopes runs and work to what the actor may see; the presenter picks the view.
    return syncStatusReply(await services.get(applicationKey).syncStatus(actor, run), viewer, {
      run,
    });
  },
});
