/** Gateway latency utility; demonstrates a command with no game-service dependency. */
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";

export default defineCommand({
  data: command("ping", "Report Discord gateway latency"),
  execute({ client }) {
    // Discord reports -1 until a heartbeat measurement is available.
    return dataReply({ discordGatewayLatencyMs: client.ws.ping >= 0 ? client.ws.ping : null });
  },
});
