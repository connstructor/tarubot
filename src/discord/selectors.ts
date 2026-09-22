/** Character/user selectors shared by the character command modules. */
import type { ChatInputCommandInteraction } from "discord.js";
import { z } from "zod";
import type { Service } from "../application/service.js";
import type { CharacterIdentity } from "../infrastructure/nodestone/client.js";
import { Failure, id, lodestoneId } from "../domain/values.js";

/** User IDs remain usable after a member leaves the server; mentions are presentation sugar. */
export const userId = (value: string): string => id(/^<@!?([0-9]+)>$/.exec(value)?.[1] ?? value);

/** Resolve exactly one selector form, including complete paginated exact-match searches. */
export async function resolveCharacter(
  app: Service,
  interaction: ChatInputCommandInteraction,
): Promise<CharacterIdentity> {
  const options = interaction.options;
  const selector = options.getString("character");
  const forename = options.getString("forename");
  const surname = options.getString("surname");
  const world = options.getString("world");
  if (selector) {
    if (forename !== null || surname !== null || world !== null)
      throw new Failure(
        "input",
        "Use either a character ID/URL or the complete name/world selector.",
      );
    return app.lodestone.profile(lodestoneId(selector, "character"));
  }
  if (!forename?.trim() || !surname?.trim() || !world?.trim())
    throw new Failure(
      "input",
      "Supply a character ID/URL, or all of forename, surname, and world.",
    );
  const name = z.string().max(100).parse(`${forename.trim()} ${surname.trim()}`);
  const server = z.string().max(80).parse(world.trim());
  const matches = await app.lodestone.search(name, server);
  if (!matches.length)
    throw new Failure("not_found", "The complete search found no exact name/world match.");
  if (matches.length !== 1)
    throw new Failure(
      "ambiguous",
      `${matches.length} exact matches were found. Repeat the command with an explicit character ID or profile URL. IDs (up to 25 shown): ${matches
        .slice(0, 25)
        .map((value) => value.id)
        .join(", ")}`,
    );
  const found = matches[0];
  if (!found) throw new Error("Missing match");
  return app.lodestone.profile(found.id);
}
