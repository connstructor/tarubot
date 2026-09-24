/** A colliding custom-ID namespace must be rejected instead of winning by filesystem ordering. */
import { defineComponent } from "../../../../src/bot/component.js";
import { reply } from "../../../../src/discord/presenters/reply.js";
export default defineComponent({
  prefix: "collide",
  execute: () => reply({ tone: "neutral", title: "First" }),
});
