/** Bounded, mention-safe presentations shared by modules returning structured results. */
import { AttachmentBuilder } from "discord.js";
import type { InteractionEditReplyOptions } from "discord.js";
import { json } from "../domain/values.js";

/** Preserve complete authorized data in an attachment when it exceeds message limits. */
export function dataReply(value: unknown): InteractionEditReplyOptions {
  const text = json(value, 2).replaceAll("`", "\\u0060");
  if (text.length <= 1800)
    return { content: `\`\`\`json\n${text}\n\`\`\``, allowedMentions: { parse: [] } };
  return {
    content: "The complete authorized result is attached.",
    files: [new AttachmentBuilder(Buffer.from(json(value, 2)), { name: "tarubot-result.json" })],
    allowedMentions: { parse: [] },
  };
}
