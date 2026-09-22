/** Apply an explicitly scoped public-response override to commands and components alike. */
import { MessageFlags } from "discord.js";
import type { InteractionDeferReplyOptions } from "discord.js";

/** Discord fixes visibility at acknowledgement time; later editReply calls cannot change it. */
export function replyAcknowledgement(
  guildId: string | null,
  defaultEphemeral: boolean,
  publicGuildId?: string,
): InteractionDeferReplyOptions {
  const publicOverride = Boolean(publicGuildId) && guildId === publicGuildId;
  return defaultEphemeral && !publicOverride ? { flags: MessageFlags.Ephemeral } : {};
}
