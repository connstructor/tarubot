/** Multiple independent handlers may subscribe to one Discord event. */
import { Events } from "discord.js";
import { defineEvent } from "../../../../src/bot/event.js";
export default defineEvent({
  id: "fixture-first",
  event: Events.Debug,
  execute(context, text) {
    context.report(new Error(`first:${text}`), "fixture-observation");
  },
});
