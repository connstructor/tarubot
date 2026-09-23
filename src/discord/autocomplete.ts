/** Shared local-link completion; permission checks also run inside the application service. */
import { applicationKey } from "../application/keys.js";
import type { AutocompleteContext } from "../bot/command.js";
import { characterChoice } from "./presenters/characters.js";

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
