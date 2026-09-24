/** A component namespace is independently discoverable from slash commands. */
import { defineComponent } from "../../../../src/bot/component.js";
import { reply } from "../../../../src/discord/presenters/reply.js";
export default defineComponent({
  prefix: "fixture",
  // Handlers return presenter replies; the router adds visibility and forces mentions off.
  execute: () => reply({ tone: "neutral", title: "Component response" }),
});
