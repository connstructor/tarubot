/**
 * validateChannel's two refusals: a channel TaruBot can't use (including one Discord hides from it,
 * 50001 Missing Access) gets the permissions refusal with its How to fix step, while a deleted,
 * non-text or other-server channel is "unavailable" with no permissions remedy. The SDK's guild and
 * channel managers are stubbed, so no Discord credentials are needed.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { ChannelType, Collection, DiscordAPIError } from "discord.js";
import { DiscordGateway } from "../../src/discord/gateway.js";
import { failureReply } from "../../src/discord/presenters/failure.js";
import { Failure } from "../../src/domain/values.js";
import { onlyEmbed } from "../fixtures/replies.js";
import { REF, VIEWERS } from "../fixtures/results.js";

/** The configured channel the checks below validate. */
const CHANNEL = "323456789012345601";

/** Discord's answer to GET /channels/{id} with the given JSON error code and HTTP status. */
const discordError = (code: number, status: number) =>
  new DiscordAPIError(
    { code, message: "Raw Discord text that must never be shown" },
    code,
    status,
    "GET",
    `/channels/${CHANNEL}`,
    { body: undefined, files: undefined },
  );

/** Gateways created by a test, destroyed afterwards so no client outlives it. */
const created: DiscordGateway[] = [];
afterEach(async () => {
  for (const gateway of created.splice(0)) await gateway.client.destroy();
});

/**
 * A gateway whose guild 100 lists `listed` channels in its cache (Discord sends hidden channels
 * there too), and whose channel fetch answers with `fetched` or rejects with it.
 */
function gatewayWith(listed: Record<string, ChannelType>, fetched: unknown): DiscordGateway {
  const gateway = new DiscordGateway();
  created.push(gateway);
  const guild = {
    id: "100",
    roles: { fetch: async () => new Collection() },
    members: { fetchMe: async () => ({ id: "900" }) },
    channels: {
      cache: new Collection(Object.entries(listed).map(([id, type]) => [id, { id, type }])),
    },
  };
  spyOn(gateway.client.guilds, "fetch").mockImplementation(async () => guild as never);
  spyOn(gateway.client.channels, "fetch").mockImplementation(async () => {
    if (fetched instanceof Error) throw fetched;
    return fetched as never;
  });
  return gateway;
}

/** The refusal validateChannel throws for the stubbed channel. */
async function refusal(gateway: DiscordGateway): Promise<unknown> {
  return gateway.validateChannel("100", CHANNEL).then(
    () => new Error("Expected validateChannel to refuse"),
    (caught: unknown) => caught,
  );
}

/** The officer card's field names for a refusal, as /config validate would show it. */
const officerFields = (error: unknown) =>
  onlyEmbed(
    failureReply(error, { ref: REF, viewer: VIEWERS.officer, scope: "/config validate" }),
  ).fields?.map((field) => field.name);

/** The permissions refusal's approved wording and typed detail. */
const PERMISSIONS = {
  code: "blocked",
  message: `TaruBot needs View Channel, Send Messages, Embed Links and Read Message History in <#${CHANNEL}>, and it must be a text channel in this server.`,
  detail: { kind: "resource", resource: "channel", id: CHANNEL, fix: "channel_permissions" },
};

/** The unavailable refusal's wording and detail: no permissions remedy. */
const UNAVAILABLE = {
  code: "blocked",
  message: `<#${CHANNEL}> is unavailable: it no longer exists or isn't a text channel in this server. Choose another with /config.`,
  detail: { kind: "resource", resource: "channel", id: CHANNEL },
};

test("a text channel TaruBot can't view (50001 Missing Access) is a permissions problem with a fix", async () => {
  // A private channel whose overwrites hide it from TaruBot's role: the most common misconfiguration.
  const error = await refusal(
    gatewayWith({ [CHANNEL]: ChannelType.GuildText }, discordError(50001, 403)),
  );
  expect(error).toBeInstanceOf(Failure);
  expect(error).toMatchObject(PERMISSIONS);
  expect(officerFields(error)).toEqual(["Affected", "How to fix", "Then"]);
});

test("a deleted channel (10003) is unavailable, with no permissions remedy", async () => {
  const error = await refusal(gatewayWith({}, discordError(10003, 404)));
  expect(error).toMatchObject(UNAVAILABLE);
  expect(Reflect.get(Reflect.get(error as object, "detail") as object, "fix")).toBeUndefined();
  expect(officerFields(error)).toEqual(["Affected", "Then"]);
});

test("50001 for a channel this server doesn't list (another server's) is unavailable", async () => {
  const error = await refusal(gatewayWith({}, discordError(50001, 403)));
  expect(error).toMatchObject(UNAVAILABLE);
  expect(officerFields(error)).toEqual(["Affected", "Then"]);
});

test("a visible text channel missing a permission keeps the permissions refusal", async () => {
  const channel = {
    id: CHANNEL,
    type: ChannelType.GuildText,
    guildId: "100",
    permissionsFor: () => ({ has: () => false }),
  };
  const error = await refusal(gatewayWith({ [CHANNEL]: ChannelType.GuildText }, channel));
  expect(error).toMatchObject(PERMISSIONS);
  expect(officerFields(error)).toEqual(["Affected", "How to fix", "Then"]);
});

test("other Discord errors from the channel fetch are not turned into a refusal", async () => {
  const error = await refusal(gatewayWith({}, discordError(0, 500)));
  expect(error).toBeInstanceOf(DiscordAPIError);
});
