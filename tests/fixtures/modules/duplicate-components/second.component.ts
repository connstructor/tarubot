/** Companion prefix-collision fixture for deterministic startup validation. */
import { defineComponent } from "../../../../src/bot/component.js";
import { reply } from "../../../../src/discord/presenters/reply.js";
export default defineComponent({
  prefix: "collide",
  execute: () => reply({ tone: "neutral", title: "Second" }),
});
