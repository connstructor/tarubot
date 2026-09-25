/**
 * Channel posts and DMs: every catalog state follows the house style; the approved ledger posts
 * (ledger#29 and #32) and the reply-spec states are reproduced exactly; ledger posts color by
 * operation, use U+2212 and grouped gil, show the full escaped note and are byte-identical for the
 * same entry; the review message has one embed, disabled controls once decided and escaped answers;
 * the decision DM speaks to the applicant, with or without the server name; the update post
 * (2.25.0) lists at most ten releases without cutting anything and is byte-identical per view; and
 * the gateway sends each through Discord's REST API with content '', allowed_mentions {parse: []}
 * and the unchanged nonce keys, while officer notices stay plain text.
 */
import { createHash } from "node:crypto";
import { describe, expect, spyOn, test } from "bun:test";
import { ClientUser, DiscordAPIError, embedLength } from "discord.js";
import type { APIEmbed } from "discord.js";
import type {
  ApplicationRecord,
  ChangelogPostView,
  LedgerPostView,
} from "../../src/application/records.js";
import { DiscordGateway } from "../../src/discord/gateway.js";
import { CHANGELOG_POST_KINDS, changelogPost } from "../../src/discord/presenters/changelog.js";
import { gilText, plain } from "../../src/discord/presenters/format.js";
import {
  decisionDm,
  GUEST_POST_KINDS,
  guestReviewPost,
} from "../../src/discord/presenters/guests.js";
import { LEDGER_POST_KINDS, ledgerPost } from "../../src/discord/presenters/ledger.js";
import { DISCORD_LIMITS, HOUSE_LIMITS } from "../../src/discord/presenters/style.js";
import { Failure, MAX_GIL } from "../../src/domain/values.js";
import {
  buttonsOf,
  expectHouseStyle,
  onlyEmbed,
  stress,
  visibleText,
} from "../fixtures/replies.js";
import { catalogTests } from "../fixtures/replies/index.js";
import { E42, E43, entry, IMPORTED } from "../fixtures/replies/ledger.js";
import {
  APPLICATIONS,
  application,
  CHANGELOG_POST,
  COOLDOWN,
  CORRECTION_POST,
  DEPOSIT_POST,
  OPENING_POST,
  POST_CASES,
  WITHDRAW_POST,
} from "../fixtures/replies/posts.js";
import { GUEST_ID, GUILD_ID, OFFICER_ID } from "../fixtures/results.js";

catalogTests("posts", POST_CASES);

/** The embed a case renders. */
const embedOf = (kind: keyof typeof POST_CASES) => onlyEmbed(POST_CASES[kind].render());
/** A field's value by name, or undefined. */
const fieldOf = (embed: APIEmbed, name: string) =>
  embed.fields?.find((field) => field.name === name)?.value;
/** Field names in order. */
const namesOf = (embed: APIEmbed) => (embed.fields ?? []).map((field) => field.name);
/** Button labels, custom IDs and disabled flags, in order. */
const controlsOf = (presented: Parameters<typeof buttonsOf>[0]) =>
  buttonsOf(presented).map((button) => ({
    label: "label" in button ? button.label : undefined,
    id: "custom_id" in button ? button.custom_id : undefined,
    style: button.style,
    disabled: button.disabled ?? false,
  }));

test("the catalog covers every post and DM kind", () => {
  expect(Object.keys(POST_CASES).sort()).toEqual(
    [...LEDGER_POST_KINDS, ...GUEST_POST_KINDS, ...CHANGELOG_POST_KINDS].sort(),
  );
});

test("every post and DM is one embed with content '' that never pings", () => {
  for (const [kind, reply] of Object.entries(POST_CASES)) {
    const presented = reply.render();
    expect({ kind, post: presented.kind }).toEqual({ kind, post: "post" });
    expect(presented.options.content).toBe("");
    expect(presented.options.allowedMentions).toEqual({ parse: [] });
    expect(presented.options.files).toBeUndefined();
  }
});

describe("ledger posts", () => {
  test("ledger#29: the approved deposit post", () => {
    expect(embedOf("post.deposit")).toEqual({
      color: 0x57f287,
      title: "Deposit · +10,005,000 gil",
      description: "Sold housing furnishings on the market board",
      fields: [
        { name: "Balance", value: "120,450,000 gil", inline: true },
        { name: "Recorded by", value: "<@345678901234567890>", inline: true },
        { name: "Entry", value: "#41", inline: true },
      ],
      footer: { text: "Entry 5b8e0c7a-4d2f-4e61-9a3b-2f0c1d9e8a77" },
      timestamp: DEPOSIT_POST.entry.event_at.toISOString(),
    });
    expect(buttonsOf(POST_CASES["post.deposit"].render())).toEqual([]);
  });

  test("ledger#32: the approved correction post, naming the entry it corrects", () => {
    expect(embedOf("post.correction")).toEqual({
      color: 0xe67e22,
      title: "Correction · −50,000 gil",
      description: "Withdrawal #42 was actually 2,550,000 gil (receipt in officer chat)",
      fields: [
        { name: "Previous balance", value: "117,950,000 gil", inline: true },
        { name: "New balance", value: "117,900,000 gil", inline: true },
        { name: "Corrects", value: "#42", inline: true },
        { name: "Recorded by", value: "<@456789012345678901>", inline: true },
        { name: "Entry", value: "#43", inline: true },
      ],
      footer: { text: "Entry 9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b" },
      timestamp: E43.event_at.toISOString(),
    });
  });

  test("reply specs #30 and #31: withdrawal and opening balance posts", () => {
    expect(embedOf("post.withdraw")).toEqual({
      color: 0x5865f2,
      title: "Withdrawal · −2,500,000 gil",
      description: "Company workshop materials for airship parts",
      fields: [
        { name: "Balance", value: "117,950,000 gil", inline: true },
        { name: "Recorded by", value: "<@456789012345678901>", inline: true },
        { name: "Entry", value: "#42", inline: true },
      ],
      footer: { text: "Entry 7c1d2e3f-8a9b-4c0d-8e1f-2a3b4c5d6e7f" },
      timestamp: E42.event_at.toISOString(),
    });
    // The opening amount is the balance, so it is unsigned and has no Balance field.
    expect(embedOf("post.opening")).toEqual({
      color: 0x5865f2,
      title: "Opening balance · 95,000,000 gil",
      description: "Counted the FC chest after the weekly reset",
      fields: [
        { name: "Recorded by", value: "<@456789012345678901>", inline: true },
        { name: "Entry", value: "#1", inline: true },
      ],
      footer: { text: "Entry 3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d" },
      timestamp: OPENING_POST.entry.event_at.toISOString(),
    });
  });

  test("color encodes the operation: deposit success, withdrawal and opening info, correction warning", () => {
    expect(
      Object.fromEntries(LEDGER_POST_KINDS.map((kind) => [kind, POST_CASES[kind].tone] as const)),
    ).toEqual({
      "post.deposit": "success",
      "post.withdraw": "info",
      "post.opening": "info",
      "post.correction": "warning",
    });
    // An imported opening balance never posts, but would read as an unsigned opening.
    const imported = onlyEmbed(ledgerPost({ entry: IMPORTED, correctionSequence: null }));
    expect(imported.color).toBe(0x5865f2);
    expect(imported.title).toBe(`Imported opening balance · ${gilText(IMPORTED.balance)}`);
    expect(namesOf(imported)).toEqual(["Recorded by", "Entry"]);
  });

  test("amounts use U+2212 and grouped gil, exact to the largest storable balance", () => {
    const title = onlyEmbed(ledgerPost(WITHDRAW_POST)).title ?? "";
    expect(title).toContain("−");
    expect(title).not.toMatch(/-\d/u);
    const largest = expectHouseStyle(
      ledgerPost({
        entry: entry({ operation: "withdraw", delta: -MAX_GIL, balance: 0n }),
        correctionSequence: null,
      }),
    );
    expect(largest.title).toBe("Withdrawal · −9,223,372,036,854,775,807 gil");
    expect(fieldOf(largest, "Balance")).toBe("0 gil");
  });

  test("the note is the full escaped description, beyond the house limit posts are exempt from", () => {
    const note = stress.text(1_000);
    const presented = ledgerPost({ entry: entry({ note }), correctionSequence: null });
    const embed = expectHouseStyle(presented);
    // Escaped for where it renders, and whole: nothing was cut.
    expect(embed.description).toBe(plain(note, DISCORD_LIMITS.description));
    expect(embed.description?.endsWith("…")).toBe(false);
    expect(embed.description?.length ?? 0).toBeGreaterThan(HOUSE_LIMITS.description);
    // User text never renders a mention, channel or timestamp.
    expect(embed.description).not.toMatch(/(?<!\\)<[@#t]/u);
  });

  test("a correction without a corrected entry omits Corrects; a legacy entry names no actor", () => {
    const embed = onlyEmbed(
      ledgerPost({ entry: { ...CORRECTION_POST.entry, actor_id: null }, correctionSequence: null }),
    );
    expect(namesOf(embed)).toEqual(["Previous balance", "New balance", "Recorded by", "Entry"]);
    expect(fieldOf(embed, "Recorded by")).toBe("Legacy import");
  });

  test("the same entry always renders byte-identical JSON, so a nonce retry is identical", () => {
    for (const view of [DEPOSIT_POST, WITHDRAW_POST, OPENING_POST, CORRECTION_POST]) {
      const first = JSON.stringify(ledgerPost(view).options);
      expect(JSON.stringify(ledgerPost(view).options)).toBe(first);
      // Nothing about the send time or attempt reaches the post.
      expect(first).not.toContain(new Date().toISOString().slice(0, 13));
    }
  });
});

describe("the update post (2.25.0)", () => {
  test("one field per release note under 'What's new', linking the CHANGELOG, with no timestamp", () => {
    expect(embedOf("changelog.update")).toEqual({
      color: 0x5865f2,
      title: "TaruBot updated to v2.25.0",
      url: "https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md",
      description: "What's new since v2.24.2.",
      fields: [
        {
          name: "v2.25.0",
          value:
            "Officers can now pick a channel where TaruBot shares what's new for members when an update changes something for them.",
        },
      ],
    });
    // No button: the title is the post's only link.
    expect(buttonsOf(POST_CASES["changelog.update"].render())).toEqual([]);
  });

  test("the largest post lists ten releases, counts the rest in the footer and cuts nothing", () => {
    // Twelve releases with prerelease versions and 300-character notes, newest first.
    const note = `${"Members see a change here. ".repeat(12).slice(0, 299)}.`;
    expect(note).toHaveLength(HOUSE_LIMITS.userText);
    const view: ChangelogPostView = {
      version: "12.11.0-rc.11",
      previous: "11.0.0",
      notes: Array.from({ length: 12 }, (_, index) => ({
        version: `12.${11 - index}.0-rc.${11 - index}`,
        note,
      })),
      url: CHANGELOG_POST.url,
    };
    const presented = changelogPost(view);
    const embed = expectHouseStyle(presented, { tone: "info", timestamp: false });
    expect(presented.truncated).toBe(false);
    expect(embed.fields).toHaveLength(HOUSE_LIMITS.fields);
    expect(embed.fields?.[0]?.name).toBe("v12.11.0-rc.11");
    for (const field of embed.fields ?? []) {
      expect(field.name.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldName);
      // Nothing was cut: every note is shown whole.
      expect(field.value).toBe(note);
    }
    expect(embed.footer?.text).toBe("…and 2 more in the full changelog");
    expect(embedLength(embed)).toBeLessThanOrEqual(DISCORD_LIMITS.embedTotal);
    expect(embed.title?.length ?? 0).toBeLessThanOrEqual(HOUSE_LIMITS.title);
  });

  test("the same view renders byte-identical JSON, so a nonce retry is identical", () => {
    const first = JSON.stringify(changelogPost(CHANGELOG_POST).options);
    expect(JSON.stringify(changelogPost(CHANGELOG_POST).options)).toBe(first);
    // Nothing about the send time reaches the post.
    expect(first).not.toContain(new Date().toISOString().slice(0, 13));
    expect(onlyEmbed(changelogPost(CHANGELOG_POST)).url).toStartWith("https://");
  });

  test("notes are escaped like user text, so they never render a mention or a link", () => {
    const embed = expectHouseStyle(
      changelogPost({
        ...CHANGELOG_POST,
        notes: [{ version: "2.25.0", note: stress.text(300) }],
      }),
    );
    for (const field of embed.fields ?? []) {
      expect(field.value).not.toMatch(/(?<!\\)<[@#t]/u);
      expect(field.value.length).toBeLessThanOrEqual(HOUSE_LIMITS.userText);
    }
  });
});

/** The approved review message's two buttons, enabled while pending. */
const reviewControls = (id: string, disabled: boolean) => [
  { label: "Approve", id: `guest:approve:${id}`, style: 3, disabled },
  { label: "Deny", id: `guest:deny:${id}`, style: 4, disabled },
];

describe("the review message", () => {
  test("reply spec guests#29: a pending application, with Approve and Deny", () => {
    const presented = POST_CASES["review.pending"].render();
    expect(onlyEmbed(presented)).toEqual({
      color: 0xfee75c,
      title: "Guest application",
      description:
        "<@234567890123456789> applied for Guest access. Officer review is required; submitting the form does not grant access.",
      fields: [
        { name: "Applicant", value: "<@234567890123456789>\n`234567890123456789`", inline: true },
        { name: "Joined server", value: "<t:1789905600:R>", inline: true },
        { name: "Submitted", value: "<t:1790150400:R>", inline: true },
        {
          name: "Introduce yourself",
          value:
            "Hi! I play Example Character on Diabolos and met a few of you in a raid party last week.",
        },
        {
          name: "Why join this server?",
          value:
            "I'm looking for a friendly group for weekly content, and an FC member suggested I apply here.",
        },
      ],
      footer: { text: "Application 3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b" },
      timestamp: APPLICATIONS.pending.created_at.toISOString(),
    });
    expect(controlsOf(presented)).toEqual(reviewControls(APPLICATIONS.pending.id, false));
  });

  test("reply spec guests#30: a decided application keeps its answers and disables the controls", () => {
    const presented = POST_CASES["review.approved"].render();
    const embed = onlyEmbed(presented);
    expect(embed.description).toBe("<@234567890123456789> applied for Guest access.");
    expect(namesOf(embed)).toEqual([
      "Applicant",
      "Submitted",
      "Decision",
      "Introduce yourself",
      "Why join this server?",
    ]);
    expect(fieldOf(embed, "Decision")).toBe(`Approved by <@${OFFICER_ID}> <t:1790164800:R>`);
    expect(controlsOf(presented)).toEqual(reviewControls(APPLICATIONS.approved.id, true));
    for (const kind of ["review.denied", "review.cancelled", "review.superseded"] as const)
      expect(controlsOf(POST_CASES[kind].render()).every((button) => button.disabled)).toBe(true);
  });

  test("each outcome says who decided and why", () => {
    const denied = embedOf("review.denied");
    expect(fieldOf(denied, "Decision")).toBe(`Denied by <@${OFFICER_ID}> <t:1790164800:R>`);
    expect(fieldOf(denied, "Reason")).toBe(
      "Please tell us a little more about how you found the Free Company.",
    );
    expect(fieldOf(embedOf("review.cancelled"), "Decision")).toBe(
      "Cancelled automatically <t:1790164800:R>: applicant left or rejoined",
    );
    expect(fieldOf(embedOf("review.superseded"), "Decision")).toBe(
      "Closed automatically <t:1790164800:R>: applicant now qualifies through the FC or a registered character",
    );
    const byOfficer = (state: string) =>
      onlyEmbed(
        guestReviewPost({
          ...APPLICATIONS.cancelled,
          state,
          reviewer_id: OFFICER_ID,
          reason: "Guest access revoked after a report",
        }),
      );
    expect(fieldOf(byOfficer("cancelled"), "Decision")).toBe(
      `Cancelled by <@${OFFICER_ID}> <t:1790164800:R>`,
    );
    expect(fieldOf(byOfficer("cancelled"), "Reason")).toBe("Guest access revoked after a report");
    expect(fieldOf(byOfficer("superseded"), "Decision")).toBe(
      `Closed by <@${OFFICER_ID}> <t:1790164800:R>: applicant already qualifies`,
    );
  });

  test("a legacy application keeps its note instead of fabricated answers", () => {
    const embed = embedOf("review.legacy");
    expect(embed.description).toBe(
      "<@234567890123456789> applied for Guest access. Officer review is required; submitting the form does not grant access.\nSubmitted before application forms were introduced.",
    );
    expect(namesOf(embed)).toEqual(["Applicant", "Joined server", "Submitted"]);
  });

  test("answers are escaped whole and reasons are capped at 300 characters", () => {
    const answer = stress.text(300);
    const presented = guestReviewPost(
      application({
        state: "denied",
        reviewer_id: OFFICER_ID,
        decided_at: new Date(1_790_164_800_000),
        reason: stress.text(1_000),
        introduction: answer,
        interest: "*visitor* ".repeat(30),
      }),
    );
    const embed = expectHouseStyle(presented, { tone: "warning" });
    expect(fieldOf(embed, "Introduce yourself")).toBe(plain(answer));
    expect(fieldOf(embed, "Introduce yourself")?.endsWith("…")).toBe(false);
    expect(fieldOf(embed, "Why join this server?")).toBe("\\*visitor\\* ".repeat(30).trim());
    expect(fieldOf(embed, "Reason")?.length).toBeLessThanOrEqual(HOUSE_LIMITS.userText);
    // Applicant and officer text never renders a mention, channel or timestamp.
    for (const name of ["Introduce yourself", "Reason"])
      expect(fieldOf(embed, name)).not.toMatch(/(?<!\\)<[@#t]/u);
  });

  test("a state from a newer release shows raw, as info, with the controls disabled", () => {
    const presented = guestReviewPost(application({ state: "expired" }));
    const embed = expectHouseStyle(presented, { tone: "info" });
    expect(embed.title).toBe("Guest application · expired");
    expect(controlsOf(presented).every((button) => button.disabled)).toBe(true);
  });
});

/** When the reply specs' application was decided, as the DM's embed timestamp. */
const DECIDED_ISO = new Date(1_790_164_800_000).toISOString();

describe("the decision DM", () => {
  test("reply spec guests#31: approved, with and without the server name", () => {
    expect(embedOf("dm.approved")).toEqual({
      color: 0x57f287,
      title: "Your guest application was approved",
      description:
        "You now have Guest access in the server where you applied. Your roles update shortly.",
      footer: { text: "Application 3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b" },
      timestamp: DECIDED_ISO,
    });
    const named = onlyEmbed(
      decisionDm(APPLICATIONS.approved, { cooldownSeconds: COOLDOWN, serverName: "Example *FC*" }),
    );
    expect(named.description).toBe(
      "You now have Guest access in **Example \\*FC\\***. Your roles update shortly.",
    );
  });

  test("reply spec guests#32: denied, with the reason and when to apply again", () => {
    expect(embedOf("dm.denied")).toEqual({
      color: 0xe67e22,
      title: "Your guest application was not approved",
      description: "Officers reviewed your application for the server where you applied.",
      fields: [
        {
          name: "Reason",
          value: "Please tell us a little more about how you found the Free Company.",
        },
        { name: "Apply again", value: "From <t:1790251200:R>, if applications are open" },
      ],
      footer: { text: "Application 3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b" },
      timestamp: DECIDED_ISO,
    });
    const bare = onlyEmbed(
      decisionDm(
        { ...APPLICATIONS.denied, reason: null },
        { cooldownSeconds: 0, serverName: "Example Server" },
      ),
    );
    expect(bare.description).toBe("Officers reviewed your application for **Example Server**.");
    expect(fieldOf(bare, "Reason")).toBe("No reason was given.");
    expect(fieldOf(bare, "Apply again")).toBe("Any time, if applications are open");
    const long = onlyEmbed(
      decisionDm(
        { ...APPLICATIONS.denied, reason: stress.text(1_000) },
        { cooldownSeconds: COOLDOWN, serverName: null },
      ),
    );
    expect(fieldOf(long, "Reason")?.length).toBeLessThanOrEqual(HOUSE_LIMITS.userText);
  });

  test("the DM shows the applicant no guild, user or reviewer IDs", () => {
    for (const kind of ["dm.approved", "dm.denied"] as const) {
      const text = visibleText(POST_CASES[kind].render());
      for (const id of [GUILD_ID, GUEST_ID, OFFICER_ID]) expect(text).not.toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The gateway sends each post through Discord's REST API

/** The gateway's nonce for a durable post key: a short decimal from the key's SHA-256. */
const nonceOf = (key: string): string =>
  BigInt(`0x${createHash("sha256").update(key).digest("hex").slice(0, 15)}`).toString();

/** A message Discord returns for a send, in the channel it was sent to. */
const sentMessage = (channelId: string) => ({
  id: "222",
  channel_id: channelId,
  author: { id: "900", username: "bot", discriminator: "0", avatar: null, bot: true },
  content: "",
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
});

/**
 * Run `body` against a gateway whose REST calls are recorded: guild 100 ('Example Server'), text
 * channel 200 and user 400 exist, channel checks pass, and every POST is captured by route.
 */
async function withGateway(
  body: (gateway: DiscordGateway, posts: { route: string; body: unknown }[]) => Promise<void>,
  failPost?: (route: string) => unknown,
): Promise<void> {
  const gateway = new DiscordGateway();
  const posts: { route: string; body: unknown }[] = [];
  const bot: unknown = Reflect.construct(ClientUser, [
    gateway.client,
    { id: "900", username: "bot", discriminator: "0", avatar: null, bot: true },
  ]);
  if (!(bot instanceof ClientUser)) throw new Error("Missing SDK bot identity");
  gateway.client.user = bot;
  const permission = spyOn(gateway, "validateChannel").mockResolvedValue(undefined);
  const get = spyOn(gateway.client.rest, "get").mockImplementation(async (route) => {
    if (route === "/guilds/100")
      return { id: "100", name: "Example Server", owner_id: "300", roles: [], unavailable: false };
    if (route === "/channels/200")
      return { id: "200", guild_id: "100", type: 0, name: "fc-ledger", permission_overwrites: [] };
    if (route === "/users/400")
      return { id: "400", username: "applicant", discriminator: "0", avatar: null };
    throw new Error(`Unexpected read ${route}`);
  });
  const post = spyOn(gateway.client.rest, "post").mockImplementation(async (route, options) => {
    const failure = failPost?.(route);
    if (failure) throw failure;
    if (route === "/users/@me/channels")
      return { id: "500", type: 1, recipients: [{ id: "400", username: "applicant" }] };
    posts.push({ route, body: options?.body });
    return sentMessage(route.split("/")[2] ?? "200");
  });
  try {
    await body(gateway, posts);
  } finally {
    permission.mockRestore();
    get.mockRestore();
    post.mockRestore();
    await gateway.client.destroy();
  }
}

/** A ledger post view in the fixture guild. */
const fixtureView: LedgerPostView = {
  entry: { ...DEPOSIT_POST.entry, actor_id: "400" },
  correctionSequence: null,
};

/** A decided application in the fixture guild. */
const fixtureApplication = (overrides: Partial<ApplicationRecord> = {}): ApplicationRecord =>
  application({ guild_id: "100", channel_id: "200", user_id: "400", ...overrides });

describe("the gateway renders posts through the presenters", () => {
  test("a ledger post is the presenter's embed, content '', under the ledger:<entry> nonce", async () => {
    await withGateway(async (gateway, posts) => {
      // A guild channel resolves only once its guild is cached, as it is in the running bot.
      await gateway.client.guilds.fetch("100");
      expect(
        await gateway.send("100", "200", { kind: "ledger", view: fixtureView }, "ledger:x"),
      ).toBe("222");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.route).toBe("/channels/200/messages");
      expect(posts[0]?.body).toEqual({
        ...(posts[0]?.body as object),
        content: "",
        embeds: ledgerPost(fixtureView).options.embeds,
        components: [],
        allowed_mentions: { parse: [] },
        nonce: nonceOf("ledger:x"),
        enforce_nonce: true,
      });
    });
  });

  test("a review post carries its controls; officer notices stay escaped plain text", async () => {
    await withGateway(async (gateway, posts) => {
      await gateway.client.guilds.fetch("100");
      const pending = fixtureApplication();
      await gateway.send("100", "200", { kind: "review", application: pending }, "review:x");
      expect(posts[0]?.body).toMatchObject({
        content: "",
        embeds: guestReviewPost(pending).options.embeds,
        components: guestReviewPost(pending).options.components,
        allowed_mentions: { parse: [] },
        nonce: nonceOf("review:x"),
      });
      await gateway.send("100", "200", { kind: "text", text: "x".repeat(2_500) }, "officer:1");
      expect(posts[1]?.body).toMatchObject({
        content: "x".repeat(1_950),
        embeds: [],
        components: [],
        allowed_mentions: { parse: [] },
        nonce: nonceOf("officer:1"),
      });
    });
  });

  test("an update post is the presenter's embed under the changelog:<guild>:<version> nonce", async () => {
    await withGateway(async (gateway, posts) => {
      await gateway.client.guilds.fetch("100");
      await gateway.send(
        "100",
        "200",
        { kind: "changelog", view: CHANGELOG_POST },
        "changelog:100:2.25.0",
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]?.route).toBe("/channels/200/messages");
      expect(posts[0]?.body).toEqual({
        ...(posts[0]?.body as object),
        content: "",
        embeds: changelogPost(CHANGELOG_POST).options.embeds,
        components: [],
        allowed_mentions: { parse: [] },
        nonce: nonceOf("changelog:100:2.25.0"),
        enforce_nonce: true,
      });
    });
  });

  test("the decision DM names the cached server and keeps the dm_blocked mapping", async () => {
    await withGateway(async (gateway, posts) => {
      const approved = fixtureApplication({
        state: "approved",
        reviewer_id: "300",
        decided_at: new Date(1_790_164_800_000),
      });
      // Before the guild is cached the DM says 'the server where you applied'.
      await gateway.dm("400", { kind: "decision", application: approved, cooldownSeconds: 60 });
      expect(sentEmbed(posts[0]?.body).description).toContain("the server where you applied");
      await gateway.client.guilds.fetch("100");
      await gateway.dm("400", { kind: "decision", application: approved, cooldownSeconds: 60 });
      expect(posts[1]).toMatchObject({
        route: "/channels/500/messages",
        body: { content: "", allowed_mentions: { parse: [] }, components: [] },
      });
      expect(sentEmbed(posts[1]?.body)).toEqual(
        onlyEmbed(decisionDm(approved, { cooldownSeconds: 60, serverName: "Example Server" })),
      );
    });
    await withGateway(
      async (gateway) => {
        const denied = fixtureApplication({ state: "denied", decided_at: new Date() });
        await expect(
          gateway.dm("400", { kind: "decision", application: denied, cooldownSeconds: 60 }),
        ).rejects.toMatchObject({ code: "dm_blocked" });
        await expect(
          gateway.dm("400", { kind: "decision", application: denied, cooldownSeconds: 60 }),
        ).rejects.toBeInstanceOf(Failure);
      },
      (route) =>
        route === "/channels/500/messages"
          ? new DiscordAPIError(
              { code: 50007, message: "Cannot send messages to this user" },
              50007,
              403,
              "POST",
              route,
              { body: undefined, files: undefined },
            )
          : undefined,
    );
  });
});

/** The single embed of a recorded message body. */
function sentEmbed(body: unknown): APIEmbed {
  const embeds =
    typeof body === "object" && body !== null && "embeds" in body ? body.embeds : undefined;
  if (!Array.isArray(embeds) || embeds.length !== 1) throw new Error("Expected one embed");
  return embeds[0] as APIEmbed;
}
