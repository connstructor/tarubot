/** Shared local-link completion; permission checks also run inside the application service. */
import { applicationKey } from "../application/keys.js";
import type { AutocompleteContext } from "../bot/command.js";

/** Complete only the selected owner's stored links/challenges, never live Lodestone searches. */
export function completeCharacter(
  context: AutocompleteContext,
  kind: "character" | "verify" = "character",
  owner = context.actor.userId,
) {
  return context.services
    .get(applicationKey)
    .autocomplete(context.actor, kind, owner, String(context.interaction.options.getFocused()));
}
