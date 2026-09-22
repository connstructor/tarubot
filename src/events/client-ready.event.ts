/** Startup is a once-only event module, using the same discovery path as feature events. */
import { Events } from "discord.js";
import { lifecycleKey } from "../application/keys.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "application-ready",
  event: Events.ClientReady,
  once: true,
  requires: [lifecycleKey],
  execute(context) {
    return context.services.get(lifecycleKey).start();
  },
});
