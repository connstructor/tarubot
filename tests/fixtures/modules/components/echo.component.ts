/** A component namespace is independently discoverable from slash commands. */
import { defineComponent } from "../../../../src/bot/component.js";
export default defineComponent({
  prefix: "fixture",
  execute: () => ({ content: "Component response" }),
});
