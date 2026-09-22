/** Inspect persisted run/child-work status after an interaction's response token expires. */
import { z } from "zod";
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";

export default defineCommand({
  data: command("sync", "Inspect durable synchronization and delivery work").addSubcommand((sub) =>
    sub
      .setName("status")
      .setDescription("Inspect your requests, or guild-wide work as an officer")
      .addStringOption(string("run_id", "Synchronization run ID")),
  ),
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    const run = interaction.options.getString("run_id");
    if (run) z.uuid().parse(run);
    return dataReply(await services.get(applicationKey).syncStatus(actor, run));
  },
});
