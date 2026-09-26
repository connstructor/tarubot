/**
 * Discord's channel obfuscation (announced 2026-08-12, enforced from 2026-11-16). For a channel a
 * bot can't view:
 * - the gateway still dispatches it, but as `___hidden___` with the CHANNEL_OBFUSCATED flag and one
 *   synthetic overwrite denying @everyone View Channel; only its id, type, position and parent_id
 *   are real;
 * - GET /guilds/{id}/channels leaves it out entirely. GET /channels/{id} answers 50001 Missing
 *   Access today, but Discord doesn't document the single-channel answer from the date, so callers
 *   treat a 10003 or a 200 as hidden too when the channel still looks hidden: a 10003 while the
 *   gateway's entry is obfuscated or its cached overwrites deny TaruBot View Channel
 *   (`cachedAsHidden`), a 200 that is obfuscated or denies it (see guild-access.ts refuseHidden);
 * - interactions are not obfuscated. A slash-command channel option patches the cached entry with
 *   the real name and flags (clearing CHANNEL_OBFUSCATED) but no overwrites, so the synthetic
 *   overwrite survives under an ordinary-looking entry.
 *
 * So the flag is a secondary signal only. What decides whether TaruBot can read a channel is
 * whether this pass's REST list returned it; the flag catches an entry that became hidden since.
 * One module holds these rules so onboarding, /channel and the inspector (and #46) agree.
 */
import { ChannelFlags, DiscordAPIError, PermissionFlagsBits } from "discord.js";
import type { ChannelFlagsBitField, GuildMember, NonThreadGuildBasedChannel } from "discord.js";

/** The name Discord gives a channel it obfuscates. Never shown to anyone as a real name. */
export const OBFUSCATED_CHANNEL_NAME = "___hidden___";

/** Discord's JSON error code for a channel TaruBot can't view (or one in a server it isn't in). */
export const MISSING_ACCESS = 50001;
/** Discord's JSON error code for a channel that no longer exists. */
export const UNKNOWN_CHANNEL = 10003;

/**
 * Whether a cached (gateway) channel entry carries CHANNEL_OBFUSCATED, so its name and overwrites
 * are synthetic. False does not prove the entry is real: an interaction option can clear the flag
 * while the synthetic overwrite stays, so callers also check this pass's REST list.
 */
export function isObfuscated(
  channel: { readonly flags: Readonly<ChannelFlagsBitField> | null } | null | undefined,
): boolean {
  return channel?.flags?.has(ChannelFlags.ChannelObfuscated) ?? false;
}

/**
 * Whether the gateway's cached entry for a channel shows one TaruBot can't view: it is obfuscated,
 * or its cached overwrites deny TaruBot View Channel. The second covers an entry a slash-command
 * option un-flagged, which keeps the synthetic @everyone deny. Callers use it to read a 10003 for a
 * channel Discord may be hiding: an entry TaruBot could view is a deleted channel's stale entry
 * instead. `bot` must be a fresh GuildMember and the guild's roles cached, as permissionsFor needs.
 */
export function cachedAsHidden(channel: NonThreadGuildBasedChannel, bot: GuildMember): boolean {
  return isObfuscated(channel) || !channel.permissionsFor(bot).has(PermissionFlagsBits.ViewChannel);
}

/**
 * What GET /channels/{id}'s error code said about a channel the guild's REST list left out: 50001
 * means it is hidden from TaruBot, 10003 that it is unknown (normally deleted; the caller still
 * checks `cachedAsHidden` on the gateway's entry). Anything else (an outage, a rate limit, another
 * code) is not an answer and returns null, so the caller rethrows it.
 */
export function unlistedChannel(error: unknown): "hidden" | "deleted" | null {
  if (!(error instanceof DiscordAPIError)) return null;
  const code = Number(error.code);
  if (code === MISSING_ACCESS) return "hidden";
  if (code === UNKNOWN_CHANNEL) return "deleted";
  return null;
}
