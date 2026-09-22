/** Public development output is a scoped acknowledgement policy, not a permission bypass. */
import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { replyAcknowledgement } from "../../src/bot/reply-visibility.js";

test("the selected development guild overrides private command/component defaults", () => {
  expect(replyAcknowledgement("123", true, "123")).toEqual({});
  expect(replyAcknowledgement("123", false, "123")).toEqual({});
});
test("other guilds and unscoped interactions retain their declared visibility", () => {
  expect(replyAcknowledgement("456", true, "123")).toEqual({ flags: MessageFlags.Ephemeral });
  expect(replyAcknowledgement(null, true, "123")).toEqual({ flags: MessageFlags.Ephemeral });
  expect(replyAcknowledgement("123", true)).toEqual({ flags: MessageFlags.Ephemeral });
  expect(replyAcknowledgement("456", false, "123")).toEqual({});
});
