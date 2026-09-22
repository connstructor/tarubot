/** Self-service ownership proof; reply visibility follows the active guild's presentation policy. */
import { escapeMarkdown } from "discord.js";
import { z } from "zod";
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";
import { resolveCharacter } from "../../discord/selectors.js";

export default defineCommand({
  data: command("claim", "Claim a character by proving control of its Lodestone biography")
    .addStringOption(string("character", "Character ID or canonical Lodestone URL"))
    .addStringOption(string("forename", "Exact forename"))
    .addStringOption(string("surname", "Exact surname"))
    .addStringOption(string("world", "Exact world")),
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    const app = services.get(applicationKey);
    await app.guild(actor);
    const result = await app.claim(actor, await resolveCharacter(app, interaction));
    const proof = z
      .object({
        status: z.literal("pending"),
        token: z.string(),
        character: z.string(),
        name: z.string(),
        world: z.string(),
        expiresAt: z.date(),
      })
      .safeParse(result);
    if (!proof.success) return dataReply(result);
    // Plaintext exists only in the reply and temporary verification memory; PostgreSQL stores its hash.
    const value = proof.data;
    return {
      content: `**${escapeMarkdown(value.name).slice(0, 200)} @ ${escapeMarkdown(value.world).slice(0, 100)}**\nPlace this exact token in the character's public Lodestone biography:\n\`\`\`\n${value.token}\n\`\`\`\nThen use \`/verify character:${value.character}\`. It expires <t:${Math.floor(value.expiresAt.getTime() / 1000)}:R>. Publication can take several minutes.`,
      allowedMentions: { parse: [] },
    };
  },
});
