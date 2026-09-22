/** Keep gateway errors observable, including errors emitted while resources are closing. */
import { Events } from "discord.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "gateway-errors",
  event: Events.Error,
  duringShutdown: true,
  execute(context, error) {
    context.report(error, "discord");
  },
});
