/**
 * Character commands end to end at the module boundary: the real option resolver parses raw
 * payloads, prototype-backed Service stubs return catalog results, and each command returns its
 * presenter's single embed (no flags: the router owns visibility; content only for the /claim
 * token). Through the router, an ownership conflict shows its current owner to an officer on
 * /assign and to no member (owner decision O3).
 */
import { afterEach, expect, test } from "bun:test";
import { ApplicationCommandOptionType } from "discord.js";
import type { APIEmbed } from "discord.js";
import { applicationKey } from "../../src/application/keys.js";
import { Service } from "../../src/application/service.js";
import type { Command } from "../../src/bot/command.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { Services } from "../../src/bot/services.js";
import assignCommand from "../../src/commands/characters/assign.command.js";
import charactersCommand from "../../src/commands/characters/characters.command.js";
import claimCommand from "../../src/commands/characters/claim.command.js";
import mainCommand from "../../src/commands/characters/main.command.js";
import nicknameCommand from "../../src/commands/characters/nickname.command.js";
import unassignCommand from "../../src/commands/characters/unassign.command.js";
import unclaimCommand from "../../src/commands/characters/unclaim.command.js";
import verifyCommand from "../../src/commands/characters/verify.command.js";
import { viewerOf } from "../../src/discord/presenters/audience.js";
import { Presented } from "../../src/discord/presenters/reply.js";
import type { Actor } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { interactionFixture, type RecordedRequest } from "../fixtures/interactions.js";
import { CHARACTER_RESULTS as R, TARGET_ID, TOKEN } from "../fixtures/replies/characters.js";
import { CHARACTER, GUEST_ID } from "../fixtures/results.js";

/** The fixture's interaction user (400 in guild 100), as a member and as a server manager. */
const MEMBER: Actor = { guildId: "100", userId: "400", officer: false, manageRoles: false };
const MANAGER: Actor = { ...MEMBER, officer: true, manageRoles: true, serverManager: true };

/** The Lodestone profile the stubbed sidecar returns for any character selector. */
const IDENTITY = { ...CHARACTER, dc: "Crystal", fcId: null };

const S = ApplicationCommandOptionType;
/** A raw string option payload. */
const text = (name: string, value: string) => ({ type: S.String, name, value });

/** One recorded service call: the method, the actor's user ID and the remaining arguments. */
type Call = [string, string, ...unknown[]];

/**
 * A prototype-backed Service whose methods return `results[method]` (or throw it when it is an
 * Error), recording every call; the Lodestone profile lookup returns IDENTITY.
 */
function stubService(results: Readonly<Record<string, unknown>>) {
  const calls: Call[] = [];
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  for (const method of [
    "guild",
    "claim",
    "verify",
    "unclaim",
    "characters",
    "preferences",
    "assign",
  ] as const)
    Object.assign(app, {
      [method]: async (actor: Actor, ...args: unknown[]) => {
        calls.push([method, actor.userId, ...args]);
        const result = results[method] ?? {};
        if (result instanceof Error) throw result;
        return result;
      },
    });
  Object.assign(app, { lodestone: { profile: async () => IDENTITY } });
  return { app, calls };
}

/** The fixture of the test being run, closed after each test. */
let open: ReturnType<typeof interactionFixture> | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** Run a command's execute directly with the stub service and the actor's viewer. */
async function run(command: Command, options: unknown[], actor: Actor, app: Service) {
  // One fixture at a time: the previous path's client is closed first.
  await open?.close();
  const fixture = interactionFixture();
  open = fixture;
  return command.execute?.({
    client: fixture.client,
    services: new Services().provide(applicationKey, app),
    allowsGuild: () => true,
    isStopping: () => false,
    report: () => {},
    resolveActor: async () => actor,
    actor,
    viewer: viewerOf(actor, "1290000000000000001"),
    interaction: fixture.slash(command.name, options),
  });
}

/** Each character command path: its options, actor, stubbed result, expected title and call. */
const PATHS: readonly {
  readonly command: Command;
  readonly options: unknown[];
  readonly actor: Actor;
  readonly results: Record<string, unknown>;
  readonly title: string;
  readonly call: Call;
  readonly content?: string;
}[] = [
  {
    command: claimCommand,
    options: [text("character", "12345678")],
    actor: MEMBER,
    results: { claim: R.claimPending },
    title: "Verify Example Character @ Diabolos",
    call: ["claim", "400", IDENTITY],
    content: `\`\`\`\n${TOKEN}\n\`\`\``,
  },
  {
    command: claimCommand,
    options: [text("character", "12345678")],
    actor: MEMBER,
    results: { claim: R.claimLinked },
    title: "Already linked to you",
    call: ["claim", "400", IDENTITY],
  },
  {
    command: verifyCommand,
    options: [text("character", "12345678")],
    actor: MEMBER,
    results: { verify: R.verified },
    title: "Example Character is verified",
    call: ["verify", "400", "12345678"],
  },
  {
    command: verifyCommand,
    options: [text("character", "12345678")],
    actor: MEMBER,
    results: { verify: R.alreadyVerified },
    title: "Already verified",
    call: ["verify", "400", "12345678"],
  },
  {
    command: unclaimCommand,
    options: [text("character", "12345678")],
    actor: MEMBER,
    results: { unclaim: R.unclaimed },
    title: "Example Character unlinked",
    call: ["unclaim", "400", "400", "12345678"],
  },
  {
    command: charactersCommand,
    options: [],
    actor: MEMBER,
    results: { characters: R.selfList },
    title: "Your characters",
    call: ["characters", "400", "400"],
  },
  {
    // An officer's own record without the member option stays the personal view.
    command: charactersCommand,
    options: [],
    actor: MANAGER,
    results: { characters: R.selfList },
    title: "Your characters",
    call: ["characters", "400", "400"],
  },
  {
    command: charactersCommand,
    options: [text("member", `<@${TARGET_ID}>`)],
    actor: MANAGER,
    results: { characters: R.officerList },
    title: "Linked characters",
    call: ["characters", "400", TARGET_ID],
  },
  {
    command: mainCommand,
    options: [text("character", "12345678")],
    actor: MEMBER,
    results: { preferences: R.mainSaved },
    title: "Main character updated",
    call: ["preferences", "400", "12345678", null],
  },
  {
    command: nicknameCommand,
    options: [{ type: S.Boolean, name: "enabled", value: true }],
    actor: MEMBER,
    results: { preferences: R.mainSaved },
    title: "Nickname sync on",
    call: ["preferences", "400", null, true],
  },
  {
    command: nicknameCommand,
    options: [{ type: S.Boolean, name: "enabled", value: false }],
    actor: MEMBER,
    results: { preferences: R.nicknameUnchanged },
    title: "Nickname sync already off",
    call: ["preferences", "400", null, false],
  },
  {
    command: assignCommand,
    options: [
      text("member", TARGET_ID),
      text("reason", "Confirmed in-game with the member."),
      text("character", "12345678"),
    ],
    actor: MANAGER,
    results: { assign: R.assigned },
    title: "Character assigned",
    call: ["assign", "400", TARGET_ID, IDENTITY, "Confirmed in-game with the member."],
  },
  {
    command: unassignCommand,
    options: [
      text("member", TARGET_ID),
      text("character", "12345678"),
      text("reason", "Character transferred to another account."),
    ],
    actor: MANAGER,
    results: { unclaim: R.unassigned },
    title: "Character unassigned",
    call: ["unclaim", "400", TARGET_ID, "12345678", "Character transferred to another account."],
  },
];

test("every character command returns its presenter's one embed, with content only for /claim", async () => {
  for (const path of PATHS) {
    const { app, calls } = stubService(path.results);
    const result = await run(path.command, path.options, path.actor, app);
    if (!(result instanceof Presented)) throw new Error(`/${path.command.name} returned no reply`);
    expect({ command: path.command.name, title: result.options.embeds[0]?.title }).toEqual({
      command: path.command.name,
      title: path.title,
    });
    expect(result.options.embeds).toHaveLength(1);
    // Visibility belongs to the router's acknowledgement; a handler never sets flags.
    expect(result.options).not.toHaveProperty("flags");
    expect(result.options.content).toBe(path.content ?? "");
    expect(calls.filter(([method]) => method !== "guild")).toEqual([path.call]);
  }
});

/** The one embed a recorded edit carries. */
function embedOf(request: RecordedRequest | undefined): APIEmbed {
  const body = request?.body;
  const embeds = typeof body === "object" && body !== null && "embeds" in body ? body.embeds : [];
  if (!Array.isArray(embeds) || embeds.length !== 1) throw new Error("Expected one embed");
  return embeds[0] as APIEmbed;
}

/** Run one slash command through the router as `actor` and return the card it edited in. */
async function routed(command: Command, options: unknown[], actor: Actor, error: Failure) {
  const { app } = stubService({ claim: error, verify: error, assign: error });
  await open?.close();
  const fixture = interactionFixture();
  open = fixture;
  const router = new InteractionRouter(
    {
      client: fixture.client,
      services: new Services().provide(applicationKey, app),
      allowsGuild: () => true,
      isStopping: () => false,
      resolveActor: async (guildId, userId) => ({ ...actor, guildId, userId }),
      report: () => {},
    },
    new Map([[command.name, command]]),
    new Map(),
  );
  await router.handle(fixture.slash(command.name, options));
  return { embed: embedOf(fixture.requests.at(-1)), sent: JSON.stringify(fixture.requests) };
}

test("ownership conflicts show the owner to officers on /assign and to no member (O3)", async () => {
  // Built the way the service's throw site builds it: the owner is only in the detail.
  const conflict = new Failure(
    "ownership_conflict",
    "This character is already linked to a different member of this server.",
    0,
    { kind: "ownership", character: CHARACTER, owner: GUEST_ID },
  );
  const officer = await routed(
    assignCommand,
    [text("member", TARGET_ID), text("reason", "Vouched"), text("character", "12345678")],
    MANAGER,
    conflict,
  );
  expect(officer.embed).toMatchObject({
    title: "Linked to another member",
    fields: [{ name: "Linked to", value: `<@${GUEST_ID}> (\`${GUEST_ID}\`)` }],
  });
  expect(officer.embed.description).toContain("`/unassign`");
  for (const command of [claimCommand, verifyCommand]) {
    const member = await routed(command, [text("character", "12345678")], MEMBER, conflict);
    expect(member.embed.title).toBe("Linked to another member");
    expect(member.sent).not.toContain(GUEST_ID);
  }
});
