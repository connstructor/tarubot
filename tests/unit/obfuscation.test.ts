/**
 * Discord's channel obfuscation (#47): the shared flag and error helpers, and /channel in a channel
 * TaruBot can't view, which must show the "can't see this channel's details" card rather than the
 * obfuscated `___hidden___` name or a real name over synthetic permissions.
 */
import { expect, test } from "bun:test";
import {
  ChannelFlags,
  ChannelFlagsBitField,
  ChannelType,
  DiscordAPIError,
  OverwriteType,
  PermissionFlagsBits as P,
} from "discord.js";
import { Services } from "../../src/bot/services.js";
import channelCommand from "../../src/commands/utility/channel.command.js";
import {
  isObfuscated,
  OBFUSCATED_CHANNEL_NAME,
  unlistedChannel,
} from "../../src/discord/obfuscation.js";
import { viewerOf } from "../../src/discord/presenters/audience.js";
import { Presented } from "../../src/discord/presenters/reply.js";
import { discordAccessFixture } from "../fixtures/discord-access.js";
import { onlyEmbed } from "../fixtures/replies.js";
import { ACTORS, REF } from "../fixtures/results.js";

/** Discord's answer to GET /channels/{id} with the given JSON error code and HTTP status. */
const discordError = (code: number, status: number) =>
  new DiscordAPIError({ code, message: "Raw Discord text" }, code, status, "GET", "/channels/1", {
    body: undefined,
    files: undefined,
  });

test("the obfuscated flag is Discord's CHANNEL_OBFUSCATED bit", () => {
  expect(ChannelFlags.ChannelObfuscated).toBe(1 << 17);
  const flagged = new ChannelFlagsBitField(ChannelFlags.ChannelObfuscated | ChannelFlags.Pinned);
  expect(isObfuscated({ flags: flagged })).toBe(true);
  expect(isObfuscated({ flags: new ChannelFlagsBitField(ChannelFlags.Pinned) })).toBe(false);
  // Channels without flags (partial DM channels) and uncached channels are never obfuscated.
  expect(isObfuscated({ flags: null })).toBe(false);
  expect(isObfuscated(null)).toBe(false);
  expect(isObfuscated(undefined)).toBe(false);
  expect(OBFUSCATED_CHANNEL_NAME).toBe("___hidden___");
});

test("an unlisted channel's GET answer says hidden (50001) or deleted (10003), and nothing else", () => {
  expect(unlistedChannel(discordError(50001, 403))).toBe("hidden");
  expect(unlistedChannel(discordError(10003, 404))).toBe("deleted");
  // Other Discord answers, and anything that isn't a Discord answer, are rethrown by the caller.
  expect(unlistedChannel(discordError(50013, 403))).toBeNull();
  expect(unlistedChannel(discordError(0, 500))).toBeNull();
  expect(unlistedChannel(new Error("socket hang up"))).toBeNull();
});

/** Run /channel for `interaction`, with the context the router would give it. */
async function channelReplyFor(
  fixture: ReturnType<typeof discordAccessFixture>,
  interaction: ReturnType<ReturnType<typeof discordAccessFixture>["slash"]>,
) {
  const result = await channelCommand.execute?.({
    client: fixture.client,
    services: new Services(),
    allowsGuild: () => true,
    isStopping: () => false,
    report: () => {},
    resolveActor: async () => ACTORS.member,
    actor: ACTORS.member,
    viewer: viewerOf(ACTORS.member, REF),
    interaction,
  });
  if (!(result instanceof Presented)) throw new Error("/channel returned no reply");
  return onlyEmbed(result);
}

test("/channel in a channel TaruBot can't view shows the unavailable card, never ___hidden___", async () => {
  const fixture = discordAccessFixture();
  try {
    const hidden = fixture.add("secret", ChannelType.GuildText, [
      { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
    ]);
    const visible = fixture.add("general");
    const guild = await fixture.client.guilds.fetch("100");
    expect(guild.channels.cache.get(hidden.id)?.name).toBe(OBFUSCATED_CHANNEL_NAME);
    const unavailable = (embed: ReturnType<typeof onlyEmbed>) => ({
      fields: embed.fields?.map((field) => field.name),
      text: JSON.stringify(embed).includes(OBFUSCATED_CHANNEL_NAME),
    });
    const card = { fields: ["ID", "Details"], text: false };
    // The payload's app permissions lack View Channel; the cache holds the obfuscated entry.
    const denied = P.UseApplicationCommands | P.SendMessages;
    expect(unavailable(await channelReplyFor(fixture, fixture.slash(hidden.id, denied)))).toEqual(
      card,
    );
    // A channel option has since patched the entry with the real name; still no details.
    fixture.chooseInOption(hidden.id);
    expect(guild.channels.cache.get(hidden.id)?.name).toBe("secret");
    expect(unavailable(await channelReplyFor(fixture, fixture.slash(hidden.id, denied)))).toEqual(
      card,
    );
    // A still-obfuscated entry wins even over permissions that claim View Channel.
    const flagged = fixture.add("flagged", ChannelType.GuildText, [
      { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
    ]);
    await fixture.client.guilds.fetch({ guild: "100", force: true });
    expect(
      unavailable(
        await channelReplyFor(fixture, fixture.slash(flagged.id, P.ViewChannel | denied)),
      ),
    ).toEqual(card);
    // A channel TaruBot can view keeps its details.
    const details = await channelReplyFor(
      fixture,
      fixture.slash(visible.id, P.ViewChannel | denied),
    );
    expect(details.fields?.find((field) => field.name === "Name")?.value).toBe("general");
  } finally {
    await fixture.close();
  }
});
