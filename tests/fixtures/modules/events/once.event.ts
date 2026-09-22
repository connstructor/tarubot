/** Once-only subscriptions must survive type erasure at the discovery boundary. */
import { Events } from "discord.js";
import { defineEvent } from "../../../../src/bot/event.js";
export default defineEvent({
  id: "fixture-once",
  event: Events.Debug,
  once: true,
  execute(context, text) {
    context.report(new Error(`once:${text}`), "fixture-observation");
  },
});
