/** Shared local-link completion; permission checks also run inside the application service. */
import type { ApplicationCommandOptionChoiceData, Guild, GuildMember } from "discord.js";
import { applicationKey } from "../application/keys.js";
import type { AutocompleteContext } from "../bot/command.js";
import { characterChoice } from "./presenters/characters.js";
import { choice } from "./presenters/format.js";

/**
 * Complete only the selected owner's stored links/challenges, never live Lodestone searches. Each
 * choice goes through choice(), which keeps the label within Discord's 100 characters on grapheme
 * boundaries and refuses a value that would not fit.
 */
export async function completeCharacter(
  context: AutocompleteContext,
  kind: "character" | "verify" = "character",
  owner = context.actor.userId,
) {
  const rows = await context.services
    .get(applicationKey)
    .autocomplete(context.actor, kind, owner, String(context.interaction.options.getFocused()));
  return rows.map(characterChoice);
}

/** The option being completed; a command with several autocomplete options dispatches on it. */
export function focusedOption(context: AutocompleteContext): string {
  return context.interaction.options.getFocused(true).name;
}

/** Discord user IDs are 17–20 digits; a mention wraps one as <@id> or <@!id>. */
const PASTED_ID = /^(?:<@!?)?([0-9]{17,20})>?$/u;

/** How long the member search may take when the cache has no match (autocomplete has 3 s). */
const SEARCH_BUDGET_MS = 1_200;

/** How many suggestions Discord shows. */
const CHOICES = 25;

/** 'Display Name (@username)', or '@username' when they are identical; the value is the user ID. */
function memberChoice(member: GuildMember): ApplicationCommandOptionChoiceData<string> {
  const name = member.displayName;
  const username = member.user.username;
  return choice(name === username ? `@${username}` : `${name} (@${username})`, member.id);
}

/** Whether a member's display name, username, global name or nickname contains the query. */
function matches(member: GuildMember, query: string): boolean {
  return [member.displayName, member.user.username, member.user.globalName, member.nickname].some(
    (text) => text?.toLocaleLowerCase("en-US").includes(query) ?? false,
  );
}

/** Names that start with the query first, then alphabetical by display name. */
function rank(query: string) {
  return (left: GuildMember, right: GuildMember): number => {
    const starts = (member: GuildMember) =>
      [member.displayName, member.user.username].some((text) =>
        text.toLocaleLowerCase("en-US").startsWith(query),
      )
        ? 0
        : 1;
    return (
      starts(left) - starts(right) ||
      left.displayName.localeCompare(right.displayName, "en-US", { sensitivity: "base" })
    );
  };
}

/** Discord's member search, bounded so a slow answer still leaves time to respond. */
async function searchMembers(guild: Guild, query: string): Promise<GuildMember[]> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SEARCH_BUDGET_MS));
  const found = await Promise.race([
    guild.members.search({ query, limit: CHOICES }).catch(() => null),
    timeout,
  ]);
  return found ? [...found.values()] : [];
}

/**
 * Member suggestions for every free-text member option (owner decision, 2026-09-24: officers typed
 * names that the ID-only option refused). Typing filters the server's cached members by display
 * name, username, global name or nickname; when the cache has no match, Discord's member search
 * runs within a short budget. A pasted ID or mention is offered back as it is, so a member who has
 * left can still be named (/unassign names stored owners). `selfOnly` limits a member to their own
 * record, since naming anyone else is refused ("Only your own records"). Values are user IDs,
 * which selectors.userId() accepts.
 */
export async function completeMember(
  context: AutocompleteContext,
  selfOnly = false,
): Promise<ApplicationCommandOptionChoiceData<string>[]> {
  const guild = context.interaction.guild;
  const cache = guild?.members.cache;
  if (selfOnly) {
    const self = cache?.get(context.actor.userId);
    return [self ? memberChoice(self) : choice("You", context.actor.userId)];
  }
  const typed = String(context.interaction.options.getFocused()).trim();
  const pasted = PASTED_ID.exec(typed)?.[1];
  if (pasted) {
    const member = cache?.get(pasted);
    return [member ? memberChoice(member) : choice(`User ID ${pasted}`, pasted)];
  }
  if (!guild || !cache) return [];
  const query = typed.toLocaleLowerCase("en-US");
  let members = [...cache.values()].filter(
    (member) => !member.user.bot && (!query || matches(member, query)),
  );
  if (!members.length && query.length >= 2)
    members = (await searchMembers(guild, typed)).filter((member) => !member.user.bot);
  return members.sort(rank(query)).slice(0, CHOICES).map(memberChoice);
}
