/**
 * Reply components through the real router, discord.js interactions and a local REST recorder:
 * 'I've added it — verify now' opens a new reply so the /claim token message is never edited;
 * 'Check again' re-renders its own private card in place, throttled by the card's timestamps; and
 * 'Full details (JSON)' is refused to members before it runs and re-reads for officers.
 */
import { afterEach, expect, test } from "bun:test";
import { InteractionResponseType, MessageFlags } from "discord.js";
import type { APIEmbed } from "discord.js";
import { applicationKey } from "../../src/application/keys.js";
import { Service } from "../../src/application/service.js";
import type { Component } from "../../src/bot/component.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { Services } from "../../src/bot/services.js";
import details from "../../src/components/details.component.js";
import verify from "../../src/components/verify.component.js";
import type { Actor } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { interactionFixture, type RecordedRequest } from "../fixtures/interactions.js";
import { CHARACTER_RESULTS as R } from "../fixtures/replies/characters.js";
import { at, CHARACTER } from "../fixtures/results.js";

/** Actors the fixture member (user 400 in guild 100) resolves as. */
const MEMBER: Actor = { guildId: "100", userId: "400", officer: false, manageRoles: false };
const OFFICER: Actor = { ...MEMBER, officer: true };

/** One recorded service call: the method, the actor's user ID and the remaining arguments. */
type Call = [string, string, ...unknown[]];

/** The fixture's REST recorder of the harness a test built, closed after each test. */
let open: ReturnType<typeof interactionFixture> | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/**
 * A router over the real verify and details components and a prototype-backed Service whose
 * verify and characters methods run `verify` and return the officer list, recording each call.
 */
function harness(actor: Actor, verifyResult: () => unknown) {
  const fixture = interactionFixture();
  open = fixture;
  const calls: Call[] = [];
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  app.verify = async (caller, characterId) => {
    calls.push(["verify", caller.userId, characterId]);
    return verifyResult() as Awaited<ReturnType<Service["verify"]>>;
  };
  app.characters = async (caller, owner) => {
    calls.push(["characters", caller.userId, owner]);
    return R.officerList;
  };
  const components: readonly Component[] = [verify, details];
  const router = new InteractionRouter(
    {
      client: fixture.client,
      services: new Services().provide(applicationKey, app),
      allowsGuild: () => true,
      isStopping: () => false,
      resolveActor: async (guildId, userId) => ({ ...actor, guildId, userId }),
      report: () => {},
    },
    new Map(),
    new Map(components.map((component) => [component.prefix, component])),
  );
  return { fixture, calls, router };
}

/** The interaction callback type a recorded acknowledgement used (5 reply, 6 update). */
const callbackType = (request: RecordedRequest | undefined): unknown =>
  typeof request?.body === "object" && request.body !== null && "type" in request.body
    ? request.body.type
    : undefined;

/** The one embed a recorded edit or follow-up carries. */
function embedOf(request: RecordedRequest | undefined): APIEmbed {
  const body = request?.body;
  const embeds = typeof body === "object" && body !== null && "embeds" in body ? body.embeds : [];
  if (!Array.isArray(embeds) || embeds.length !== 1) throw new Error("Expected one embed");
  return embeds[0] as APIEmbed;
}

/** A source message last rendered long enough ago that Check again isn't throttled. */
const SETTLED = { ephemeral: true, editedAt: new Date(Date.now() - 60_000).toISOString() };

test("verify now opens a new reply, so the /claim message and its token are never edited", async () => {
  const { fixture, calls, router } = harness(MEMBER, () => R.verified);
  // The /claim message is public in the observed test guild and belongs to another tester.
  await router.handle(fixture.button("verify:claim:12345678", "123456789", { ownerId: "401" }));
  expect(fixture.requests.map(callbackType)).not.toContain(
    InteractionResponseType.DeferredMessageUpdate,
  );
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
  expect(fixture.requests[0]?.body).toMatchObject({ data: { flags: MessageFlags.Ephemeral } });
  // The clicking member's own claim is checked, whoever's message the button sat on.
  expect(calls).toEqual([["verify", "400", "12345678"]]);
  expect(embedOf(fixture.requests[1]).title).toBe("Example Character is verified");
});

test("verify now on the presser's own private claim card still opens a new reply", async () => {
  const { fixture, router } = harness(MEMBER, () => R.verified);
  await router.handle(fixture.button("verify:claim:12345678", "123456789", { ephemeral: true }));
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
});

test("Check again updates its private card; a verified result clears the buttons", async () => {
  const { fixture, calls, router } = harness(MEMBER, () => R.verified);
  await router.handle(fixture.button("verify:again:12345678", "123456789", SETTLED));
  expect(callbackType(fixture.requests[0])).toBe(InteractionResponseType.DeferredMessageUpdate);
  expect(calls).toEqual([["verify", "400", "12345678"]]);
  expect(fixture.requests[1]).toMatchObject({
    method: "patch",
    body: {
      content: "",
      components: [],
      attachments: [],
      embeds: [{ title: "Example Character is verified" }],
    },
  });
});

test("a token still missing re-renders the pending card in place with Check again", async () => {
  const { fixture, router } = harness(MEMBER, () => {
    throw new Failure("pending_proof", "Not yet.", 0, {
      kind: "proof",
      character: CHARACTER,
      expiresAt: at(1_200),
    });
  });
  const press = fixture.button("verify:again:12345678", "123456789", SETTLED);
  await router.handle(press);
  expect(fixture.requests.map((request) => request.method)).toEqual(["post", "patch"]);
  expect(fixture.requests[1]?.body).toMatchObject({
    embeds: [
      {
        title: "Token not on the Lodestone yet",
        footer: { text: `Code pending_proof · Ref ${press.id}` },
      },
    ],
    components: [{ components: [{ label: "Check again", custom_id: "verify:again:12345678" }] }],
  });
});

test("Check again within 15 seconds of the last render follows up and skips the service", async () => {
  const { fixture, calls, router } = harness(MEMBER, () => R.verified);
  const press = fixture.button("verify:again:12345678", "123456789", {
    ephemeral: true,
    editedAt: new Date().toISOString(),
  });
  await router.handle(press);
  expect(calls).toEqual([]);
  expect(callbackType(fixture.requests[0])).toBe(InteractionResponseType.DeferredMessageUpdate);
  // The source view stays; the wait arrives as a private follow-up.
  expect(fixture.requests[1]).toMatchObject({
    method: "post",
    route: expect.stringMatching(/^\/webhooks\//u),
    body: { flags: MessageFlags.Ephemeral },
  });
  const embed = embedOf(fixture.requests[1]);
  expect(embed).toMatchObject({
    title: "Please wait a moment",
    footer: { text: `Code cooldown · Ref ${press.id}` },
  });
  expect(embed.fields?.find((field) => field.name === "Try again")).toBeDefined();
});

test("Check again on someone else's public card replies instead of editing it", async () => {
  const { fixture, router } = harness(MEMBER, () => R.verified);
  await router.handle(
    fixture.button("verify:again:12345678", "123456789", {
      ownerId: "401",
      editedAt: SETTLED.editedAt,
    }),
  );
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
});

test("a malformed verify control is out of date and never reaches the service", async () => {
  const { fixture, calls, router } = harness(MEMBER, () => R.verified);
  for (const customId of ["verify:again:0123", "verify:later:12345678", "verify:claim"]) {
    const press = fixture.button(customId, "123456789", SETTLED);
    const before = fixture.requests.length;
    await router.handle(press);
    const sent = fixture.requests.slice(before);
    // A malformed ID can't choose update mode, so the card is a new reply.
    expect(callbackType(sent[0])).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
    expect(embedOf(sent[1])).toMatchObject({
      title: "This control is out of date",
      footer: { text: `Code stale · Ref ${press.id}` },
    });
  }
  expect(calls).toEqual([]);
});

test("a member pressing Full details is refused before the component runs", async () => {
  const { fixture, calls, router } = harness(MEMBER, () => R.verified);
  const press = fixture.button("details:characters:123456789012345678", "123456789", {
    ephemeral: true,
  });
  await router.handle(press);
  expect(calls).toEqual([]);
  expect(embedOf(fixture.requests[1])).toMatchObject({
    title: "Officers only",
    footer: { text: `Code forbidden · Ref ${press.id}` },
  });
  expect(JSON.stringify(fixture.requests)).not.toContain("tarubot-characters.json");
});

test("an officer's Full details re-reads the member's links and attaches them as JSON", async () => {
  const { fixture, calls, router } = harness(OFFICER, () => R.verified);
  await router.handle(
    fixture.button("details:characters:123456789012345678", "123456789", { ephemeral: true }),
  );
  expect(callbackType(fixture.requests[0])).toBe(
    InteractionResponseType.DeferredChannelMessageWithSource,
  );
  expect(calls).toEqual([["characters", "400", "123456789012345678"]]);
  expect(fixture.requests[1]).toMatchObject({
    method: "patch",
    files: ["tarubot-characters.json"],
    body: { embeds: [{ title: "Full details · characters" }] },
  });
});

test("a details view this release renders no button for is out of date", async () => {
  const { fixture, calls, router } = harness(OFFICER, () => R.verified);
  await router.handle(fixture.button("details:config", "123456789", { ephemeral: true }));
  expect(calls).toEqual([]);
  expect(embedOf(fixture.requests[1]).title).toBe("This control is out of date");
});
