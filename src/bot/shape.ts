/**
 * Whether a slash-command invocation matches the shape this release declares.
 *
 * Discord delivers whatever command set is registered, which can briefly belong to another release
 * (a registration before or after a deploy, or a rollback). A handler that reads an undeclared
 * subcommand or option would guess, and some fall through to a default action, so the router
 * answers any undeclared shape with the stale-command card instead of running the handler.
 */
import { ApplicationCommandOptionType } from "discord.js";

/** The declared option tree, as a command's toJSON() returns it. */
export interface DeclaredOption {
  readonly name: string;
  readonly type: number;
  readonly options?: readonly DeclaredOption[] | undefined;
}

/** The invoked option tree, as discord.js exposes it on `interaction.options.data`. */
export interface InvokedOption {
  readonly name: string;
  readonly type: number;
  readonly options?: readonly InvokedOption[] | undefined;
}

const nesting = new Set<number>([
  ApplicationCommandOptionType.SubcommandGroup,
  ApplicationCommandOptionType.Subcommand,
]);

/**
 * Describe the first part of `invoked` that `declared` doesn't define, or return null when the
 * invocation fits: every subcommand group and subcommand exists at its level, a declared
 * subcommand level isn't skipped, and every supplied option exists with the same type.
 */
export function undeclaredShape(
  declared: readonly DeclaredOption[] | undefined,
  invoked: readonly InvokedOption[],
): string | null {
  let level = declared ?? [];
  let supplied = invoked;
  const path: string[] = [];
  for (;;) {
    const nested = supplied.find((option) => nesting.has(option.type));
    if (!nested) break;
    // Discord sends a subcommand group or subcommand as the level's only option.
    if (supplied.length !== 1) return `a mixed option list at "${path.join(" ")}"`;
    const match = level.find(
      (option) => option.name === nested.name && option.type === nested.type,
    );
    path.push(nested.name);
    if (!match) return `the subcommand "${path.join(" ")}"`;
    level = match.options ?? [];
    supplied = nested.options ?? [];
  }
  // This release requires a subcommand here, so an invocation without one is another release's.
  if (level.some((option) => nesting.has(option.type)))
    return `a missing subcommand after "${path.join(" ")}"`;
  for (const option of supplied) {
    const match = level.find((candidate) => candidate.name === option.name);
    if (!match || match.type !== option.type) return `the option "${option.name}"`;
  }
  return null;
}
