/** Submit or retrieve a caller's durable application for their current join context. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";

export default defineCommand({
  data: command("apply", "Submit a persistent guest application"),
  requires: [applicationKey],
  async execute({ actor, services }) {
    return dataReply(await services.get(applicationKey).apply(actor));
  },
});
