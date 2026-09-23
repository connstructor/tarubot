/** Real SDK form acknowledgements and boundary validation need no Discord credentials. */
import { expect, spyOn, test } from "bun:test";
import {
  ClientUser,
  ComponentType,
  DiscordAPIError,
  InteractionResponseType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { applicationKey } from "../../src/application/keys.js";
import { Service } from "../../src/application/service.js";
import { defineCommand } from "../../src/bot/command.js";
import type { BotContext } from "../../src/bot/context.js";
import { defineComponent } from "../../src/bot/component.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { Services } from "../../src/bot/services.js";
import apply from "../../src/commands/guests/apply.command.js";
import {
  GUEST_APPLICATIONS_CLOSED,
  guestApplicationInput,
} from "../../src/domain/guest-application.js";
import { Failure } from "../../src/domain/values.js";
import {
  guestApplicationEmbeds,
  guestApplicationModal,
  guestApplicationSubmission,
} from "../../src/discord/guest-application.js";
import { interactionFixture } from "../fixtures/interactions.js";
import type { ApplicationRecord } from "../../src/application/records.js";
import { DiscordGateway } from "../../src/discord/gateway.js";

/**
 * /apply requires the application capability; only its pre-form availability read runs here, so
 * a prototype-backed instance with that one method replaced is enough (no database or Discord).
 */
function applicationServices(open: (guildId: string) => Promise<boolean>): Services {
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  app.guestApplicationsOpen = open;
  return new Services().provide(applicationKey, app);
}

/** Actor lookup intentionally records acknowledgement order so a slow DB cannot delay the modal. */
function context(
  fixture: ReturnType<typeof interactionFixture>,
  services = applicationServices(async () => true),
): BotContext {
  return {
    client: fixture.client,
    services,
    allowsGuild: () => true,
    isStopping: () => false,
    report: () => {},
    resolveActor: async (guildId, userId) => {
      expect(fixture.requests.at(-1)?.body).toMatchObject({
        type: InteractionResponseType.DeferredChannelMessageWithSource,
      });
      return { guildId, userId, officer: false, manageRoles: false };
    },
  };
}

test("apply opens labeled inputs as the first acknowledgement for raw and cached guilds", async () => {
  const fixture = interactionFixture();
  const checked: string[] = [];
  const runtime = {
    ...context(
      fixture,
      applicationServices(async (guildId) => {
        checked.push(guildId);
        return true;
      }),
    ),
    resolveActor: async () => {
      throw new Error("Modal opener must not fetch an actor");
    },
  };
  const router = new InteractionRouter(runtime, new Map([[apply.name, apply]]), new Map());
  try {
    for (const cached of [false, true]) {
      if (cached) await fixture.client.guilds.fetch(fixture.member.guildId);
      const interaction = fixture.slash();
      expect(interaction.inCachedGuild()).toBe(cached);
      await router.handle(interaction);
      expect(interaction.deferred).toBe(false);
      expect(interaction.replied).toBe(true);
      expect(fixture.requests.at(-1)?.body).toMatchObject({
        type: InteractionResponseType.Modal,
        data: {
          title: "Guest application",
          custom_id: "guest-apply:100:400:1767225600000",
          components: [
            {
              type: ComponentType.Label,
              component: {
                type: ComponentType.TextInput,
                custom_id: "introduction",
                required: true,
                min_length: 10,
                max_length: 300,
              },
            },
            {
              type: ComponentType.Label,
              component: {
                type: ComponentType.TextInput,
                custom_id: "interest",
                required: true,
                min_length: 10,
                max_length: 300,
              },
            },
          ],
        },
      });
    }
    expect(fixture.requests).toHaveLength(2);
    // An open server costs one availability read per form, for the verified guild only.
    expect(checked).toEqual(["100", "100"]);
  } finally {
    await fixture.close();
  }
});

test("apply refuses a closed server before the form opens, with one ephemeral reply", async () => {
  const fixture = interactionFixture();
  const checked: string[] = [];
  const reports: unknown[] = [];
  const closed = applicationServices(async (guildId) => {
    checked.push(guildId);
    return false;
  });
  const runtime = {
    ...context(fixture, closed),
    report: (error: unknown) => reports.push(error),
    resolveActor: async () => {
      throw new Error("The pre-form check must not fetch an actor");
    },
  };
  try {
    const router = new InteractionRouter(runtime, new Map([[apply.name, apply]]), new Map());
    const interaction = fixture.slash();
    await router.handle(interaction);
    expect(checked).toEqual(["100"]);
    // The refusal is the only acknowledgement: no modal, no defer, and no operation suffix.
    expect(interaction.deferred).toBe(false);
    expect(interaction.replied).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.body).toMatchObject({
      type: InteractionResponseType.ChannelMessageWithSource,
      data: {
        content: GUEST_APPLICATIONS_CLOSED,
        flags: MessageFlags.Ephemeral,
        allowed_mentions: { parse: [] },
      },
    });
    // A closed server is an expected state, not an operation failure to report.
    expect(reports).toHaveLength(0);
    // The observed test guild's public-response override applies to the refusal as to any reply.
    const observed = new InteractionRouter(
      { ...runtime, publicResponseGuildId: "100" },
      new Map([[apply.name, apply]]),
      new Map(),
    );
    await observed.handle(fixture.slash());
    expect(fixture.requests.at(-1)?.body).toMatchObject({
      type: InteractionResponseType.ChannelMessageWithSource,
      data: { content: GUEST_APPLICATIONS_CLOSED },
    });
    expect(fixture.requests.at(-1)?.body).not.toMatchObject({
      data: { flags: MessageFlags.Ephemeral },
    });
  } finally {
    await fixture.close();
  }
});

test("a failing, slow or late-rejecting pre-modal check still opens the form and is reported", async () => {
  const fixture = interactionFixture();
  const reports: unknown[] = [];
  let check: () => Promise<string | null> = async () => {
    throw new Error("Injected availability read failure");
  };
  // A generic modal command exercises the router contract independently of /apply.
  const gated = defineCommand({
    data: new SlashCommandBuilder().setName("gated-form").setDescription("Gated form fixture"),
    beforeModal: () => check(),
    modal: guestApplicationModal,
  });
  // A 20 ms budget stands in for the production acknowledgement budget.
  const router = new InteractionRouter(
    { ...context(fixture), report: (error: unknown) => reports.push(error) },
    new Map([[gated.name, gated]]),
    new Map(),
    20,
  );
  try {
    await router.handle(fixture.slash("gated-form"));
    check = () => new Promise<null>(() => {});
    await router.handle(fixture.slash("gated-form"));
    // Rejecting after the budget must not surface as an unhandled rejection.
    check = () =>
      new Promise<null>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Late availability failure")), 40),
      );
    await router.handle(fixture.slash("gated-form"));
    await Bun.sleep(60);
    expect(fixture.requests.map((request) => request.body)).toMatchObject([
      { type: InteractionResponseType.Modal },
      { type: InteractionResponseType.Modal },
      { type: InteractionResponseType.Modal },
    ]);
    expect(reports).toHaveLength(3);
    expect(reports[0]).toMatchObject({ message: "Injected availability read failure" });
    for (const overrun of reports.slice(1)) {
      expect(overrun).toBeInstanceOf(Failure);
      expect(overrun).toMatchObject({ code: "unavailable" });
    }
  } finally {
    await fixture.close();
  }
});

test("form opening rejects bots, DMs, restricted guilds and missing join data with one safe reply", async () => {
  const fixture = interactionFixture();
  let checks = 0;
  const open = applicationServices(async () => {
    checks++;
    return true;
  });
  try {
    for (const failure of ["bot", "dm", "scope", "join"]) {
      fixture.member.bot = failure === "bot";
      fixture.member.guildId = failure === "dm" ? "" : "100";
      fixture.member.joinedAt = failure === "join" ? "" : "2026-01-01T00:00:00.000Z";
      const router = new InteractionRouter(
        { ...context(fixture, open), allowsGuild: () => failure !== "scope" },
        new Map([[apply.name, apply]]),
        new Map(),
      );
      await router.handle(fixture.slash());
      expect(fixture.requests.at(-1)?.body).toMatchObject({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } },
      });
    }
    expect(fixture.requests).toHaveLength(4);
    // Bots, DMs and restricted guilds are refused before the availability read; only the
    // missing-join case reaches it, then fails while building the form.
    expect(checks).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("modal submissions defer, resolve a fresh actor and enforce user/guild/type bindings", async () => {
  const fixture = interactionFixture();
  let executions = 0;
  const submission = defineComponent({
    prefix: "guest-apply",
    execute({ interaction, actor }) {
      if (!interaction.isModalSubmit()) throw new Error("Wrong submission type");
      const input = guestApplicationInput.parse(guestApplicationSubmission(interaction, actor));
      expect(input.joinedAt.toISOString()).toBe(fixture.member.joinedAt);
      executions++;
      return { content: "Accepted" };
    },
  });
  try {
    const id = guestApplicationModal(fixture.slash()).toJSON().custom_id;
    const router = new InteractionRouter(
      { ...context(fixture), publicResponseGuildId: "100" },
      new Map(),
      new Map([[submission.prefix, submission]]),
    );
    await router.handle(fixture.submit(id));
    expect(executions).toBe(1);
    expect(fixture.requests[0]?.body).toMatchObject({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: 0 },
    });
    for (const forged of [
      id.replace(":400:", ":401:"),
      id.replace(":100:", ":101:"),
      `${id}:extra`,
      "guest-apply:bad",
    ]) {
      await router.handle(fixture.submit(forged));
      expect(fixture.requests.at(-1)?.body).toMatchObject({
        content: expect.stringContaining("This form belongs to someone else"),
      });
    }
    expect(executions).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("officer component authorization still happens after fresh lookup, before any decision", async () => {
  const fixture = interactionFixture();
  let executions = 0;
  const review = defineComponent({
    prefix: "guest",
    access: "officer",
    execute: () => {
      executions++;
      return { content: "Unexpected" };
    },
  });
  try {
    const router = new InteractionRouter(
      context(fixture),
      new Map(),
      new Map([[review.prefix, review]]),
    );
    await router.handle(fixture.button("guest:approve:fixture"));
    expect(executions).toBe(0);
    expect(fixture.requests[0]?.body).toMatchObject({ data: { flags: MessageFlags.Ephemeral } });
    expect(fixture.requests.at(-1)?.body).toMatchObject({
      content: expect.stringContaining("Only FC officers"),
    });
  } finally {
    await fixture.close();
  }
});

test("answer limits reject blank, oversized and PostgreSQL-incompatible text", () => {
  const valid = {
    joinedAt: new Date(),
    introduction: "  I play games with friends.  ",
    interest: "My friend invited me to this server.",
  };
  expect(guestApplicationInput.parse(valid).introduction).toBe("I play games with friends.");
  for (const introduction of [
    " \n ",
    "too short",
    "x".repeat(301),
    `${"a".repeat(20)}\0`,
    `${"a".repeat(20)}\ud800`,
  ])
    expect(guestApplicationInput.safeParse({ ...valid, introduction }).success).toBe(false);
  expect(guestApplicationInput.safeParse({ ...valid, joinedAt: new Date("invalid") }).success).toBe(
    false,
  );
});

test("review embeds escape full answers and identify legacy applications without fabricated text", () => {
  const application: ApplicationRecord = {
    id: "ca875e74-d944-4ff7-aab9-970314715306",
    guild_id: "100",
    user_id: "400",
    joined_at: new Date(),
    created_at: new Date(),
    state: "pending",
    channel_id: "200",
    message_id: null,
    reviewer_id: null,
    decided_at: null,
    reason: null,
    introduction: "*visitor* ".repeat(30),
    interest: "_friends_ ".repeat(30),
  };
  const review = guestApplicationEmbeds(application)[0]?.toJSON();
  expect(review?.fields).toEqual([
    { name: "Introduce yourself", value: "\\*visitor\\* ".repeat(30) },
    { name: "Why join this server?", value: "\\_friends\\_ ".repeat(30) },
  ]);
  const legacy = guestApplicationEmbeds({
    ...application,
    introduction: null,
    interest: null,
  })[0]?.toJSON();
  expect(legacy?.description).toContain("before application forms");
  expect(legacy?.fields ?? []).toHaveLength(0);
});

test("deleted review repair and later edits keep answer embeds and current decision controls", async () => {
  const gateway = new DiscordGateway();
  const writes: unknown[] = [];
  const application: ApplicationRecord = {
    id: "ca875e74-d944-4ff7-aab9-970314715306",
    guild_id: "100",
    user_id: "400",
    joined_at: new Date(),
    created_at: new Date(),
    state: "pending",
    channel_id: "200",
    message_id: "111",
    reviewer_id: null,
    decided_at: null,
    reason: null,
    introduction: "I enjoy games and meeting friends.",
    interest: "A friend invited me to join the community.",
  };
  const message = {
    id: "222",
    channel_id: "200",
    author: { id: "900", username: "bot", discriminator: "0", avatar: null, bot: true },
    content: "Review",
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    components: [],
    pinned: false,
    type: 0,
  };
  const bot: unknown = Reflect.construct(ClientUser, [gateway.client, message.author]);
  if (!(bot instanceof ClientUser)) throw new Error("Missing SDK bot identity");
  gateway.client.user = bot;
  const permission = spyOn(gateway, "validateChannel").mockResolvedValue(undefined);
  const get = spyOn(gateway.client.rest, "get").mockImplementation(async (route) => {
    if (route === "/guilds/100")
      return { id: "100", name: "Review fixture", owner_id: "300", roles: [], unavailable: false };
    if (route === "/channels/200")
      return {
        id: "200",
        guild_id: "100",
        type: 0,
        name: "officer-chat",
        permission_overwrites: [],
      };
    if (route === "/channels/200/messages/111")
      throw new DiscordAPIError(
        { code: 10008, message: "Unknown Message" },
        10008,
        404,
        "GET",
        route,
        { body: undefined, files: undefined },
      );
    if (route === "/channels/200/messages/222") return message;
    throw new Error(`Unexpected review fixture read ${route}`);
  });
  const post = spyOn(gateway.client.rest, "post").mockImplementation(async (_route, options) => {
    writes.push(options?.body);
    return message;
  });
  const patch = spyOn(gateway.client.rest, "patch").mockImplementation(async (_route, options) => {
    writes.push(options?.body);
    return message;
  });
  try {
    await gateway.client.guilds.fetch("100");
    expect(await gateway.editReview(application, "Pending review")).toBe("222");
    expect(
      await gateway.editReview(
        { ...application, message_id: "222", state: "approved" },
        "Approved review",
      ),
    ).toBe("222");
    expect(writes).toHaveLength(2);
    for (const [index, body] of writes.entries())
      expect(body).toMatchObject({
        allowed_mentions: { parse: [] },
        embeds: [
          {
            fields: [
              { name: "Introduce yourself", value: application.introduction },
              { name: "Why join this server?", value: application.interest },
            ],
          },
        ],
        components: [
          {
            components: [
              { custom_id: `guest:approve:${application.id}`, disabled: index === 1 },
              { custom_id: `guest:deny:${application.id}`, disabled: index === 1 },
            ],
          },
        ],
      });
  } finally {
    permission.mockRestore();
    get.mockRestore();
    post.mockRestore();
    patch.mockRestore();
    await gateway.client.destroy();
  }
});
