/** Throwing handlers exercise the common event failure boundary. */
import { Events } from "discord.js";
import { defineEvent } from "../../../../src/bot/event.js";
export default defineEvent({
  id: "fixture-failure",
  event: Events.Warn,
  async execute(_context, text) {
    await Promise.resolve();
    throw new Error(text);
  },
});
