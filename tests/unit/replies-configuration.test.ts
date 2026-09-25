/**
 * Configuration replies: every catalog state follows the house style; the approved cards
 * (configuration#4, #7, #8, #9, #34, #37 and #41, with the gen.py title overrides) are reproduced
 * exactly and #18 as far as owner decision O2 allows; the health checklist's tokens, verdicts and
 * budgets; /config show's collapses and its documented field exemption (C3); every change receipt
 * and its three effects modes (C5); /setup and /officer; and the configuration failures render as
 * their approved concepts.
 */
import { describe, expect, test } from "bun:test";
import type { EffectsMode } from "../../src/application/results.js";
import { fcLinked } from "../../src/application/service.js";
import {
  changeReply,
  CONFIG_REPLY_KINDS,
  configurationChecks,
  fcUnlinkReply,
  guestApplicationsReply,
  healthReply,
  officerOverrideReply,
  officerRankReply,
  roleLayoutReply,
  setupReply,
  showReply,
} from "../../src/discord/presenters/configuration.js";
import { failureReply } from "../../src/discord/presenters/failure.js";
import { DISCORD_LIMITS, HOUSE_LIMITS } from "../../src/discord/presenters/style.js";
import type { FailureCode, FailureDetail } from "../../src/domain/failures.js";
import { authorize, authorizeRoleManager } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import {
  buttonsOf,
  expectFailure,
  expectHouseStyle,
  onlyEmbed,
  stress,
  visibleText,
} from "../fixtures/replies.js";
import {
  applications,
  CHANNEL,
  CONFIG_CASES,
  CONFIG_FC,
  CONFIG_RESULTS as R,
  configChange,
  configGuild,
  configReport,
  fcRow,
  layoutOn,
  override,
  rankResult,
  ROLE,
  setupResult,
  unlinked,
} from "../fixtures/replies/configuration.js";
import { catalogTests } from "../fixtures/replies/index.js";
import { ACTORS, at, NOW, REF, VIEWERS } from "../fixtures/results.js";

catalogTests("configuration", CONFIG_CASES);

/** The embed a case renders. */
const embedOf = (kind: keyof typeof CONFIG_CASES) => onlyEmbed(CONFIG_CASES[kind].render());
/** A field's value by name, or undefined. */
const fieldOf = (embed: ReturnType<typeof onlyEmbed>, name: string) =>
  embed.fields?.find((field) => field.name === name)?.value;
/** Every field name of an embed, in order. */
const namesOf = (embed: ReturnType<typeof onlyEmbed>) =>
  (embed.fields ?? []).map((field) => field.name);
/** The two modes that hold Discord changes. */
const PAUSED_MODES: readonly Exclude<EffectsMode, "live">[] = [
  "awaiting_activation",
  "deployment_disabled",
];
/** The officer viewer, the audience of /config show, validate and most changes. */
const officer = VIEWERS.officer;
const manager = VIEWERS.manager;
/** Every case renders against the mockups' clock. */
const now = NOW;
/** A mention that would render: '<@' not preceded by the escaping backslash. */
const UNESCAPED_MENTION = /(?<!\\)<@/u;

test("the catalog covers every configuration reply kind", () => {
  expect(Object.keys(CONFIG_CASES).sort()).toEqual([...CONFIG_REPLY_KINDS].sort());
});

describe("approved cards are reproduced exactly", () => {
  test("configuration#4: /config show for a configured, live server", () => {
    const presented = CONFIG_CASES["show.configured"].render();
    expect(onlyEmbed(presented)).toEqual({
      color: 0x5865f2,
      title: "Server configuration",
      description:
        "**Example Company** «EXMPL» · Diabolos\nDiscord changes **Live** · Onboarding **On** · Role layout **On**\nHealth: all 9 resource checks passed.",
      fields: [
        {
          name: "Free Company",
          value:
            "[Example Company «EXMPL»](https://na.finalfantasyxiv.com/lodestone/freecompany/9234567890123456789/) · Diabolos\nRoster read <t:1790143200:R>\nFC ID 9234567890123456789",
        },
        { name: "FC Leader role", value: "<@&223456789012345604>", inline: true },
        { name: "Officer role", value: "<@&223456789012345603>", inline: true },
        { name: "Member role", value: "<@&223456789012345601>", inline: true },
        { name: "Guest role", value: "<@&223456789012345602>", inline: true },
        {
          name: "Officer access",
          value: "In-game rank **Officer** + manual grants (/officer grant)",
        },
        { name: "Ledger channel", value: "<#323456789012345601>", inline: true },
        { name: "Officer notifications", value: "<#323456789012345602>", inline: true },
        { name: "Guest applications", value: "Open · <#323456789012345603>", inline: true },
        {
          name: "Onboarding",
          value: "On · lobby <#323456789012345604> · officer room <#323456789012345605>",
        },
        { name: "Discord changes", value: "Live", inline: true },
        { name: "Role layout", value: "On", inline: true },
      ],
      footer: { text: "Configuration revision 42 · /config validate tests each resource" },
      timestamp: NOW.toISOString(),
    });
    expect(buttonsOf(presented)).toEqual([
      {
        type: 2,
        style: 2,
        label: "Run health check",
        custom_id: "config:validate",
        disabled: false,
      },
    ]);
  });

  test("configuration#7: every check passed", () => {
    const presented = CONFIG_CASES["validate.healthy"].render();
    expect(onlyEmbed(presented)).toEqual({
      color: 0x57f287,
      title: "Configuration health · all checks passed",
      description: "13 checks passed. Nothing was changed.",
      fields: [
        {
          name: "Free Company",
          value: "[OK] Example Company «EXMPL» linked\n[OK] Roster read <t:1790143200:R>",
        },
        {
          name: "Access roles",
          value:
            "[OK] FC Leader <@&223456789012345604>\n[OK] Officer <@&223456789012345603>\n[OK] Member <@&223456789012345601>\n[OK] Guest <@&223456789012345602>",
        },
        {
          name: "Channels",
          value:
            "[OK] Ledger <#323456789012345601>\n[OK] Officer notifications <#323456789012345602>\n[OK] Guest applications <#323456789012345603>",
        },
        {
          name: "Onboarding",
          value: "[OK] Lobby <#323456789012345604>\n[OK] Officer room <#323456789012345605>",
        },
        { name: "Discord changes", value: "[OK] Live", inline: true },
        { name: "Role layout", value: "[OK] On", inline: true },
      ],
      footer: { text: "Read-only check · configuration revision 42" },
      timestamp: NOW.toISOString(),
    });
    expect(buttonsOf(presented)).toEqual([
      { type: 2, style: 2, label: "Re-check", custom_id: "config:validate", disabled: false },
    ]);
  });

  test("configuration#8: two problems and two warnings, with the approved paused warning", () => {
    expect(embedOf("validate.problems")).toEqual({
      color: 0xed4245,
      title: "Configuration health · 2 problems, 2 warnings",
      description:
        "Fix the items marked [FAIL], then run /config validate again. Nothing was changed.",
      fields: [
        {
          name: "Free Company",
          value:
            "[OK] Example Company «EXMPL» linked\n[WARN] Roster is stale: last good read <t:1790056800:R>; the attempt <t:1790146800:R> failed (Lodestone unavailable)",
        },
        {
          name: "Access roles",
          value:
            "[OK] FC Leader <@&223456789012345604>\n[FAIL] Officer <@&223456789012345603>: Give the bot Manage Roles and place its role above the configured access role.\n[OK] Member <@&223456789012345601>\n[OK] Guest <@&223456789012345602>",
        },
        {
          name: "Channels",
          value:
            "[OK] Ledger <#323456789012345601>\n[FAIL] Officer notifications <#323456789012345602>: Choose a text channel in this guild where the bot can view, send, embed links, and read message history.\n[OFF] Guest applications: not set, so /apply is closed",
        },
        { name: "Onboarding", value: "[OFF] Onboarding is off" },
        {
          name: "Discord changes",
          value: "[WARN] Paused: this server has not been activated",
          inline: true,
        },
        { name: "Role layout", value: "[OFF] Off: display and order untouched", inline: true },
      ],
      footer: { text: "Read-only check · configuration revision 42" },
      timestamp: NOW.toISOString(),
    });
  });

  test("configuration#9: an imported server ready for activation", () => {
    expect(embedOf("validate.ready")).toEqual({
      color: 0xfee75c,
      title: "Configuration health · ready for activation",
      description:
        "All configured resources passed. Discord changes stay paused until activation. Nothing was changed.",
      fields: [
        {
          name: "Free Company",
          value: "[OK] Example Company «EXMPL» linked\n[OK] Roster read <t:1790143200:R>",
        },
        {
          name: "Access roles",
          value:
            "[OFF] FC Leader: not managed\n[OK] Officer <@&223456789012345603>\n[OK] Member <@&223456789012345601>\n[OK] Guest <@&223456789012345602>",
        },
        {
          name: "Channels",
          value:
            "[OK] Ledger <#323456789012345601>\n[OK] Officer notifications <#323456789012345602>\n[OFF] Guest applications: closed, so /apply refuses",
        },
        { name: "Onboarding", value: "[OFF] Onboarding is off" },
        { name: "Discord changes", value: "[WAIT] Paused until activation", inline: true },
        { name: "Role layout", value: "[OFF] Off: display and order untouched", inline: true },
        {
          name: "Guest grandfathering",
          value: "[WAIT] Pending: runs once at activation",
          inline: true,
        },
      ],
      footer: { text: "Read-only check · configuration revision 7" },
      timestamp: NOW.toISOString(),
    });
  });

  test("configuration#18: adopt_holders:false, live, and its drawn paused state as errors#26", () => {
    // The drawn card shows a paused save as success; owner decision O2 makes a paused save the
    // pending errors-and-style#26 card, so #18 renders as drawn only while changes are live.
    const live = embedOf("role.officer_not_adopted");
    expect(live).toMatchObject({
      color: 0x57f287,
      title: "Officer role set without adopting holders",
      description:
        "<@&223456789012345603> is now the bot-managed Officer role. No manual grants were created for its current holders.",
      footer: { text: "Audited · adopt_holders:false" },
      timestamp: NOW.toISOString(),
    });
    expect(live.fields).toEqual([
      {
        name: "Who keeps the role",
        value:
          "Members whose linked character holds in-game rank **Officer**, plus anyone given /officer grant. Other holders lose the role once the roster confirms they don't hold that rank.",
      },
      { name: "Officer rank", value: "Officer", inline: true },
      { name: "Discord changes", value: "`… QUEUED` Server-wide role check", inline: true },
    ]);
    const held = embedOf("role.paused");
    expect(held.title).toBe("Saved, Discord changes paused");
    expect(held.description).toStartWith(live.description ?? "");
    expect(namesOf(held)).toEqual([
      "Saved",
      "Discord changes",
      "Who keeps the role",
      "Officer rank",
    ]);
  });

  test("configuration#34: role layout turned off", () => {
    expect(embedOf("layout.off")).toEqual({
      color: 0x57f287,
      title: "Role layout turned off",
      description:
        "Current role display and order are left as they are; the bot will no longer change them.",
      fields: [{ name: "Access roles", value: "Still assigned and removed as usual" }],
      footer: { text: "Audited as config.role_layout" },
      timestamp: NOW.toISOString(),
    });
  });

  test("configuration#37: a fresh /setup, with Check sync status", () => {
    const presented = CONFIG_CASES["setup.created"].render();
    expect(onlyEmbed(presented)).toEqual({
      color: 0x57f287,
      title: "Server setup complete",
      description:
        "TaruBot created 4 access roles, a lobby and an officer room. Channel permissions are being secured in the background.",
      fields: [
        {
          name: "Access roles",
          value:
            "FC Leader <@&223456789012345604> · created\nOfficer <@&223456789012345603> · created\nMember <@&223456789012345601> · created\nGuest <@&223456789012345602> · created",
        },
        { name: "Lobby", value: "<#323456789012345604> · created", inline: true },
        { name: "Officer room", value: "<#323456789012345605> · created", inline: true },
        {
          name: "Free Company",
          value: "FC 9234567890123456789 · roster read queued",
          inline: true,
        },
        { name: "Officer rank", value: "Officer", inline: true },
        {
          name: "Guest applications",
          value: "Open · reviews in <#323456789012345605>",
          inline: true,
        },
        { name: "Officer notifications", value: "<#323456789012345605>", inline: true },
        {
          name: "Role layout",
          value: "On · FC Leader > Officer > Member > Guest, displayed separately",
        },
        { name: "Channel access", value: "[WAIT] Securing channels · job 0b6f3c2e" },
        {
          name: "Next steps",
          value:
            "1. Run /sync status until channel access shows as completed.\n2. If you use the gil ledger, set a channel with /config ledger.\n3. Run /config validate.",
        },
      ],
      footer: { text: "Setup is safe to rerun: existing roles and rooms are reused" },
      timestamp: NOW.toISOString(),
    });
    expect(buttonsOf(presented)).toEqual([
      { type: 2, style: 2, label: "Check sync status", custom_id: "sync:status", disabled: false },
    ]);
  });

  test("configuration#41: an officer grant", () => {
    expect(embedOf("officer.granted")).toEqual({
      color: 0x57f287,
      title: "Officer access granted",
      description:
        "<@423456789012345678> now has bot officer access and will receive the Officer role. This grant doesn't depend on in-game rank and lasts until a server manager runs /officer revoke or /officer reset.",
      fields: [
        { name: "Member", value: "<@423456789012345678>", inline: true },
        { name: "Discord role", value: "Assignment queued", inline: true },
        { name: "Reason", value: "Runs FC events while the officer rank is vacant." },
      ],
      footer: { text: "Audited as officer.grant" },
      timestamp: NOW.toISOString(),
    });
  });
});

describe("/config validate", () => {
  /** One checklist section's lines for a report. */
  const checklist = (report: ReturnType<typeof configReport>, section: string) =>
    fieldOf(onlyEmbed(healthReply(report, officer, { now })), section);

  test("ENABLE_EFFECTS=false is a warning, whatever else the checklist says", () => {
    const embed = embedOf("validate.warnings");
    expect(fieldOf(embed, "Discord changes")).toBe("[WARN] Disabled for this deployment");
    expect(embed.description).toBe(
      "No problems found, but review the items marked [WARN]. Nothing was changed.",
    );
    // Beside a problem it still counts as one of the warnings.
    const failing = configReport({
      effectsMode: "deployment_disabled",
      capabilities: { ledger_channel_id: "TaruBot can't post there." },
    });
    expect(onlyEmbed(healthReply(failing, officer, { now })).title).toBe(
      "Configuration health · 1 problem, 1 warning",
    );
  });

  test("a review channel without a Guest role warns that /apply stays closed", () => {
    const report = configReport({ guild: configGuild({ guest_role_id: null }) });
    expect(checklist(report, "Channels")).toContain(
      "[WARN] Guest applications <#323456789012345603>: open, but no Guest role is set, so /apply stays closed",
    );
    expect(checklist(report, "Access roles")).toContain(
      "[WARN] Guest: not set, so no one receives Guest access",
    );
  });

  test("the roster lines: never read, stale, and a failure only when newer than the success", () => {
    const line = (row: Parameters<typeof fcRow>[0]) =>
      checklist(configReport({ fc: fcRow(row) }), "Free Company")?.split("\n")[1];
    expect(line({ last_successful_roster_at: null, fresh: false })).toBe(
      "[WARN] No successful roster read yet",
    );
    expect(
      line({
        last_successful_roster_at: null,
        fresh: false,
        last_attempt_at: at(-60),
        last_error: "rate_limited",
        attemptFailed: true,
      }),
    ).toBe(
      "[WARN] No successful roster read yet; the attempt <t:1790168940:R> failed (Lodestone rate limited)",
    );
    // A stale read whose latest attempt came before it has no failure clause.
    expect(
      line({
        last_successful_roster_at: at(-86_400),
        last_attempt_at: at(-90_000),
        fresh: false,
        last_error: "unavailable",
        attemptFailed: true,
      }),
    ).toBe("[WARN] Roster is stale: last good read <t:1790082600:R>");
    // An unknown stored code falls back to generic words; the code itself is never shown.
    expect(
      line({
        last_successful_roster_at: at(-86_400),
        last_attempt_at: at(-60),
        fresh: false,
        last_error: "lease_lost",
        attemptFailed: true,
      }),
    ).toEndWith("failed (roster read failed)");
    expect(checklist(configReport({ guild: configGuild({ fc_id: null }) }), "Free Company")).toBe(
      "[WARN] No FC linked, so no one can receive Member",
    );
  });

  test("activation pending is [WAIT] without problems and the approved [WARN] beside them", () => {
    const paused = configGuild({ effects_enabled: false });
    expect(checklist(configReport({ guild: paused }), "Discord changes")).toBe(
      "[WAIT] Paused until activation",
    );
    expect(
      checklist(
        configReport({ guild: paused, capabilities: { member_role_id: "Pick an ordinary role." } }),
        "Discord changes",
      ),
    ).toBe("[WARN] Paused: this server has not been activated");
  });

  test("with all nine capabilities failing, fields stay within 1,024 and the embed within 6,000", () => {
    // The gateway's rewritten messages name the resource; its mention survives the escaping.
    const rewritten = configReport({
      capabilities: {
        member_role_id: `TaruBot can't manage <@&${ROLE.member}>. Its own role must be above that role, and it needs Manage Roles.`,
        ledger_channel_id: `TaruBot needs View Channel, Send Messages, Embed Links and Read Message History in <#${CHANNEL.ledger}>, and it must be a text channel in this server.`,
      },
    });
    expect(checklist(rewritten, "Access roles")).toContain(
      `[FAIL] Member <@&${ROLE.member}>: TaruBot can't manage <@&${ROLE.member}>. Its own role must be above that role, and it needs Manage Roles.`,
    );
    const capabilities: Record<string, string> = {};
    for (const column of [
      "member_role_id",
      "guest_role_id",
      "officer_role_id",
      "leader_role_id",
      "ledger_channel_id",
      "officer_notifications_channel_id",
      "guest_application_channel_id",
      "lobby_channel_id",
      "officer_channel_id",
    ])
      capabilities[column] = stress.text(900);
    const presented = healthReply(
      configReport({
        guild: configGuild({ revision: 9_007_199_254_740_993n }),
        effectsMode: "deployment_disabled",
        capabilities,
      }),
      officer,
      { now },
    );
    const embed = expectHouseStyle(presented, {
      tone: "error",
      title: "Configuration health · 9 problems, 1 warning",
    });
    for (const field of embed.fields ?? [])
      expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue);
    // The revision is a bigint and is printed exactly, never through Number().
    expect(embed.footer?.text).toBe("Read-only check · configuration revision 9007199254740993");
  });

  test("configurationChecks marks exactly the configured roles and channels as resources", () => {
    const checks = configurationChecks(R.healthy);
    expect(checks.filter((row) => row.resource)).toHaveLength(9);
    expect(configurationChecks(R.partial).filter((row) => row.resource)).toHaveLength(0);
  });
});

describe("/config show", () => {
  test("unset roles and channels collapse into one field each, with next steps", () => {
    const embed = embedOf("show.partial");
    expect(namesOf(embed)).toEqual([
      "Free Company",
      "Access roles",
      "Officer access",
      "Channels",
      "Onboarding",
      "Discord changes",
      "Role layout",
      "Next steps",
    ]);
    expect(fieldOf(embed, "Channels")).toBe(
      "Ledger: not set\nOfficer notifications: not set\nGuest applications: closed",
    );
    expect(fieldOf(embed, "Next steps")).toBe(
      "1. Create or bind the access roles.\n2. Choose a ledger channel with /config ledger.\n3. Run /config validate.",
    );
  });

  test("guest applications read open, off (keeping the channel), or what keeps them closed", () => {
    const value = (overrides: Parameters<typeof configGuild>[0]) =>
      fieldOf(
        onlyEmbed(showReply(configReport({ guild: configGuild(overrides) }), officer, { now })),
        "Guest applications",
      );
    expect(value({})).toBe(`Open · <#${CHANNEL.reviews}>`);
    expect(value({ guest_application_channel_id: null })).toBe("Closed · no review channel");
    expect(value({ guest_role_id: null })).toBe("Closed · no Guest role");
    // The switch is separate from the channel (owner decision, 2026-09-24).
    expect(value({ guest_applications_enabled: false })).toBe(
      `Off · reviews in <#${CHANNEL.reviews}>`,
    );
    expect(value({ guest_applications_enabled: false, guest_application_channel_id: null })).toBe(
      "Off",
    );
  });

  test("validate lists the switch: off, on without a channel, or the checked channel", () => {
    const channels = (overrides: Parameters<typeof configGuild>[0]) =>
      fieldOf(
        onlyEmbed(healthReply(configReport({ guild: configGuild(overrides) }), officer, { now })),
        "Channels",
      ) ?? "";
    expect(channels({})).toContain(`[OK] Guest applications <#${CHANNEL.reviews}>`);
    // Off keeps the channel unchecked: an imported legacy channel may no longer exist.
    const off = channels({ guest_applications_enabled: false });
    expect(off).toContain("[OFF] Guest applications: closed, so /apply refuses");
    expect(off).not.toContain(`<#${CHANNEL.reviews}>`);
    expect(channels({ guest_application_channel_id: null })).toContain(
      "[WARN] Guest applications: on, but no review channel is set, so /apply stays closed",
    );
  });

  test("grandfathering shows while pending and when completed, and the paused note", () => {
    const paused = embedOf("show.paused");
    expect(paused.description).toContain("**Not activated yet.**");
    expect(fieldOf(paused, "Discord changes")).toBe("Paused · pending activation");
    expect(fieldOf(paused, "Guest grandfathering")).toBe("Pending · runs once at activation");
    const completed = onlyEmbed(
      showReply(
        configReport({
          guild: configGuild({
            guest_grandfather: "completed",
            guest_grandfathered_at: at(-3_600),
          }),
        }),
        officer,
        { now },
      ),
    );
    expect(fieldOf(completed, "Guest grandfathering")).toBe("Completed <t:1790165400:R>");
    const disabled = showReply(configReport({ effectsMode: "deployment_disabled" }), officer, {
      now,
    });
    expect(onlyEmbed(disabled).description).toContain(
      "Discord changes **Disabled for this deployment**",
    );
    expectHouseStyle(disabled, { tone: "pending", maxFields: HOUSE_LIMITS.configShowFields });
  });

  test("no FC linked, and a failing check turns the health line into a problem count", () => {
    const embed = onlyEmbed(
      showReply(
        configReport({
          guild: configGuild({ fc_id: null }),
          capabilities: { officer_role_id: "Pick an ordinary role." },
        }),
        officer,
        { now },
      ),
    );
    expect(embed.description?.split("\n")[0]).toBe("No Free Company linked");
    expect(embed.description).toContain("Health: 1 problem. Run /config validate.");
    expect(fieldOf(embed, "Free Company")).toBe(
      "Not linked. /config fc link fc_id:<ID or Lodestone URL>",
    );
  });

  test("the widest layout uses more than ten fields and stays within its exemption (C3)", () => {
    // Every role and two channels set, the ledger unset, grandfathering completed: 14 fields.
    const widest = showReply(
      configReport({
        guild: configGuild({
          ledger_channel_id: null,
          guest_grandfather: "completed",
          guest_grandfathered_at: at(-60),
          revision: 9_007_199_254_740_993n,
        }),
      }),
      officer,
      { now },
    );
    const embed = expectHouseStyle(widest, { maxFields: HOUSE_LIMITS.configShowFields });
    expect(embed.fields?.length).toBe(14);
    expect(embed.fields?.length).toBeGreaterThan(HOUSE_LIMITS.fields);
    expect(embed.footer?.text).toStartWith("Configuration revision 9007199254740993 · ");
    expect(visibleText(widest)).not.toContain("```json");
  });
});

describe("buttons", () => {
  test("show and validate re-check through config:validate; no configuration view offers details", () => {
    for (const [kind, reply] of Object.entries(CONFIG_CASES)) {
      const ids = buttonsOf(reply.render()).map((button) =>
        "custom_id" in button ? button.custom_id : "",
      );
      expect({ kind, details: ids.some((id) => id.startsWith("details:")) }).toEqual({
        kind,
        details: false,
      });
      if (kind.startsWith("show.") || kind.startsWith("validate."))
        expect({ kind, ids }).toEqual({ kind, ids: ["config:validate"] });
      else if (kind.startsWith("setup."))
        expect({ kind, ids }).toEqual({ kind, ids: ["sync:status"] });
      else expect({ kind, ids }).toEqual({ kind, ids: [] });
    }
  });
});

describe("configuration changes", () => {
  test("member and guest bindings show only the fields that apply", () => {
    const full = embedOf("role.set");
    expect(namesOf(full)).toEqual(["Replaced", "Discord changes", "Role layout", "Channel access"]);
    expect(fieldOf(full, "Replaced")).toBe(
      "<@&223456789012345699> is retired: TaruBot removes it from its current holders.",
    );
    const plainGuild = configGuild({ role_layout_enabled: false, access_policy_enabled: false });
    const bare = onlyEmbed(
      changeReply(configChange("guest_role_id", ROLE.guest, { guild: plainGuild }), officer, {
        now,
      }),
    );
    expect(bare.title).toBe("Guest role set");
    expect(bare.description).toContain("approved guests, members with a verified character");
    expect(namesOf(bare)).toEqual(["Discord changes"]);
    const held = onlyEmbed(
      changeReply(
        configChange("guest_role_id", ROLE.guest, { guild: plainGuild, requeued: 3 }),
        officer,
        { now },
      ),
    );
    expect(fieldOf(held, "Held work")).toBe("`… QUEUED` 3 held jobs queued again");
  });

  test("an adopting Officer binding lists twenty holders, then '+N more', or says no one holds it", () => {
    const sample = Array.from(
      { length: 20 },
      (_, index) => `4234567890123456${String(index).padStart(2, "0")}`,
    );
    const many = changeReply(
      configChange("officer_role_id", ROLE.officer, {
        officerHolders: { adopt: true, adopted: 27, sample },
      }),
      manager,
      { now },
    );
    const embed = expectHouseStyle(many, { tone: "success", title: "Officer role set" });
    const adopted = fieldOf(embed, "Adopted holders") ?? "";
    expect(adopted.match(/<@\d+>/gu)).toHaveLength(20);
    expect(adopted).toEndWith(" +7 more");
    expect(embed.description).toContain("27 current holders were adopted");
    const none = onlyEmbed(
      changeReply(
        configChange("officer_role_id", ROLE.officer, {
          officerHolders: { adopt: true, adopted: 0, sample: [] },
        }),
        manager,
        { now },
      ),
    );
    expect(none.description).toEndWith("No one holds this role yet.");
    expect(fieldOf(none, "Adopted holders")).toBeUndefined();
    expect(fieldOf(none, "Officer access")).toBe("Manual grants + in-game rank **Officer**");
  });

  test("re-binding the same Officer role is the info no-op that adopts nobody", () => {
    const embed = embedOf("role.unchanged");
    expect(embed.description).toBe(
      "`= NO CHANGE` <@&223456789012345603> was already the Officer role. No holders were adopted.",
    );
    // Clearing a role that was never set is the same no-op.
    const cleared = onlyEmbed(
      changeReply(configChange("leader_role_id", null, { rebound: true }), manager, { now }),
    );
    expect(cleared).toMatchObject({
      title: "FC Leader role already unset",
      description: "`= NO CHANGE` No FC Leader role was set.",
    });
  });

  test("adopt_holders:false without a rank warns that only manual grants keep the role", () => {
    const embed = embedOf("role.officer_no_rank");
    expect(fieldOf(embed, "Officer rank")).toBe(
      "Not set. Run /config officer_rank rank:<name>, or only /officer grant confers Officer.",
    );
    expect(fieldOf(embed, "Who keeps the role")).toStartWith("Only people given /officer grant");
  });

  test("a leader without a linked FC, and every unset is success", () => {
    expect(fieldOf(embedOf("role.leader_no_fc"), "Free Company")).toBe(
      "Not linked, so no one can receive this role yet. Link one with /config fc link.",
    );
    for (const [field, label] of [
      ["member_role_id", "Member"],
      ["guest_role_id", "Guest"],
      ["officer_role_id", "Officer"],
      ["leader_role_id", "FC Leader"],
    ] as const) {
      const presented = changeReply(
        configChange(field, null, {
          previous: ROLE.previous,
          guild: configGuild({ access_policy_enabled: false }),
        }),
        manager,
        { now },
      );
      const embed = expectHouseStyle(presented, {
        tone: "success",
        title: `${label} role unset`,
      });
      expect(embed.description).toContain("<@&223456789012345699> is retired");
      expect(fieldOf(embed, "Discord changes")).toBe("`… QUEUED` Role removal");
    }
    expect(embedOf("role.cleared").description).toStartWith(
      "TaruBot no longer manages an Officer role.",
    );
  });

  test("channel settings and unsets, and every /config guest_applications receipt", () => {
    expect(embedOf("applications.no_role")).toMatchObject({
      title: "Guest applications on; Guest role still needed",
      description:
        "<#323456789012345603> will receive applications, but /apply stays closed until a Guest role is set.",
    });
    expect(embedOf("applications.closed").description).toBe(
      "/apply now refuses before the form opens: “Guest applications are not open in this server. Ask an officer about Guest access.”",
    );
    expect(embedOf("applications.open").description).toBe(
      "/apply is open. Each application is posted in <#323456789012345603> with Approve and Deny buttons.",
    );
    // A new channel for applications that were already open never says they opened.
    expect(embedOf("applications.review_changed")).toMatchObject({
      title: "Review channel changed",
      description:
        "New applications are posted in <#323456789012345603>. Applications already posted stay reviewable in their original channel.",
    });
    expect(embedOf("applications.review_set").description).toBe(
      "Applications will be posted in <#323456789012345603> once you turn them on with /config guest_applications enabled:true.",
    );
    expect(embedOf("applications.no_channel").title).toBe(
      "Guest applications on; review channel needed",
    );
    expect(embedOf("applications.unchanged").description).toBe(
      "`= NO CHANGE` Applications are already on, reviewed in <#323456789012345603>.",
    );
    // Channel set and switch on in one call is the open card, with the channel named once.
    const both = onlyEmbed(
      guestApplicationsReply(
        applications({ enabled: [false, true], channel: [null, CHANNEL.reviews] }),
        officer,
        { now },
      ),
    );
    expect(both.title).toBe("Guest applications open");
    expect(fieldOf(both, "Review channel")).toBeUndefined();
    // Switching off while unsetting the channel names the unset channel on the closed card.
    const closedUnset = onlyEmbed(
      guestApplicationsReply(
        applications({ enabled: [true, false], channel: [CHANNEL.reviews, null] }),
        officer,
        { now },
      ),
    );
    expect(closedUnset.title).toBe("Guest applications closed");
    expect(fieldOf(closedUnset, "Review channel")).toBe("Unset");
    expect(fieldOf(embedOf("channel.ledger_no_fc"), "Free Company")).toBe(
      "Not linked, so ledger commands stay unavailable. Link one with /config fc link.",
    );
    expect(embedOf("channel.notifications_cleared").description).toContain("skipped, not held");
  });

  test("fc link saved and unchanged, and unlink", () => {
    const linked = embedOf("fc.linked");
    expect(linked.description).toBe(
      "[Example Company «EXMPL»](https://na.finalfantasyxiv.com/lodestone/freecompany/9234567890123456789/) on Diabolos is now linked to this server. A roster read is queued; member access updates when it finishes.",
    );
    expect(fieldOf(linked, "Roster")).toBe("`… QUEUED` Lodestone read");
    expect(fieldOf(linked, "Ledger account")).toBe("`• SAVED` Ready");
    expect(embedOf("fc.unchanged").description).toBe(
      "`= NO CHANGE` FC `9234567890123456789` is already linked to this server.",
    );
    const unlinkedEmbed = embedOf("fc.unlinked");
    expect(unlinkedEmbed.description).toStartWith(
      "**Example Company** «EXMPL» is no longer linked.",
    );
    // Before the FC's record was read, the typed ID names it.
    expect(
      onlyEmbed(fcUnlinkReply(unlinked({ company: null }), officer, { fcId: CONFIG_FC.id, now }))
        .description,
    ).toStartWith("FC `9234567890123456789` is no longer linked.");
  });

  test("officer_rank heads-up, clear, and a rank escaped and capped", () => {
    expect(fieldOf(embedOf("rank.heads_up"), "Heads-up")).toBe(
      "No FC is linked, so this rank can't match anyone yet.\nNo Officer role is bound; bind one with /config roles officer.",
    );
    expect(fieldOf(embedOf("rank.cleared"), "Mode")).toBe("Manual grants only");
    const hostile = officerRankReply(rankResult({ officerRank: stress.text(1_000) }), manager, {
      now,
    });
    // User text never renders a mention: every '<@' in it stays backslash-escaped.
    expect(onlyEmbed(hostile).description).not.toMatch(UNESCAPED_MENTION);
    expectHouseStyle(hostile, { tone: "success" });
  });

  test("role_layout on names the order and its job; repeats are no-ops", () => {
    const on = embedOf("layout.on");
    expect(fieldOf(on, "Order")).toBe(
      "<@&223456789012345604> > <@&223456789012345603> > <@&223456789012345601> > <@&223456789012345602>",
    );
    expect(fieldOf(on, "Layout pass")).toBe("`… QUEUED` job `0b6f3c2e`");
    expect(
      onlyEmbed(
        roleLayoutReply(
          { status: "unchanged", roleLayout: "disabled", effectsMode: "live" },
          manager,
          {
            now,
          },
        ),
      ).title,
    ).toBe("Role layout is already off");
  });
});

describe("effects modes (C5)", () => {
  /** Every receipt whose own effect is Discord work, rendered in a mode. */
  const DISCORD_WORK: readonly [string, (mode: EffectsMode) => ReturnType<typeof changeReply>][] = [
    ["fc link", (mode) => changeReply({ ...R.linked, effectsMode: mode }, officer, { now })],
    [
      "fc unlink",
      (mode) =>
        fcUnlinkReply(unlinked({ effectsMode: mode }), officer, { fcId: CONFIG_FC.id, now }),
    ],
    ["member role", (mode) => changeReply({ ...R.memberSet, effectsMode: mode }, officer, { now })],
    [
      "officer role",
      (mode) => changeReply({ ...R.officerAdopted, effectsMode: mode }, manager, { now }),
    ],
    [
      "role clear",
      (mode) =>
        changeReply(
          configChange("member_role_id", null, {
            previous: ROLE.member,
            effectsMode: mode,
            guild: configGuild({ access_policy_enabled: false }),
          }),
          officer,
          { now },
        ),
    ],
    [
      "officer rank",
      (mode) => officerRankReply(rankResult({ effectsMode: mode }), manager, { now }),
    ],
    ["role layout", (mode) => roleLayoutReply(layoutOn({ effectsMode: mode }), manager, { now })],
    ["setup", (mode) => setupReply(setupResult({ effectsMode: mode }), manager, { now })],
    [
      "officer grant",
      (mode) => officerOverrideReply(override({ effectsMode: mode }), manager, { now }),
    ],
  ];

  test("live receipts queue their work; paused ones are the approved paused-save card", () => {
    for (const [name, render] of DISCORD_WORK) {
      const live = onlyEmbed(render("live"));
      expect({ name, title: live.title }).not.toEqual({
        name,
        title: "Saved, Discord changes paused",
      });
      expect({ name, paused: JSON.stringify(live).includes("‖ PAUSED") }).toEqual({
        name,
        paused: false,
      });
      for (const mode of PAUSED_MODES) {
        const presented = render(mode);
        const embed = expectHouseStyle(presented, {
          tone: "pending",
          title: "Saved, Discord changes paused",
          timestamp: false,
        });
        expect({ name, mode, queued: JSON.stringify(embed).includes("… QUEUED` Server") }).toEqual({
          name,
          mode,
          queued: false,
        });
        expect(fieldOf(embed, "Discord changes")).toStartWith("`‖ PAUSED`");
        expect(namesOf(embed).slice(0, 2)).toEqual(["Saved", "Discord changes"]);
      }
    }
  });

  test("a paused channel setting is the #26 card with its own sentence; held work waits", () => {
    for (const mode of PAUSED_MODES) {
      const embed = expectHouseStyle(
        changeReply({ ...R.ledgerSet, effectsMode: mode }, officer, { now }),
        { tone: "pending", title: "Saved, Discord changes paused", timestamp: false },
      );
      expect(embed.footer?.text).toBe("Check progress any time with /sync status");
      // The receipt's own sentence leads, then the #26 sentence says when held work applies.
      expect(embed.description).toStartWith(
        `Ledger deposits, withdrawals, adjustments and initializations will be posted in <#${CHANNEL.ledger}>.`,
      );
      expect(namesOf(embed).slice(0, 2)).toEqual(["Saved", "Discord changes"]);
      expect(fieldOf(embed, "Held work")).toBe(
        mode === "awaiting_activation"
          ? "2 held jobs will retry once this server is activated"
          : "2 held jobs will retry once Discord changes are turned back on",
      );
    }
    expect(fieldOf(embedOf("channel.ledger"), "Held work")).toBe(
      "`… QUEUED` 2 held jobs queued again",
    );
  });

  test("a paused /setup keeps within ten fields by listing the rooms together", () => {
    const embed = embedOf("setup.paused");
    expect(namesOf(embed)).toEqual([
      "Saved",
      "Discord changes",
      "Access roles",
      "Rooms",
      "Free Company",
      "Officer rank",
      "Guest applications",
      "Officer notifications",
      "Role layout",
      "Next steps",
    ]);
    expect(fieldOf(embed, "Discord changes")).toBe(
      "`‖ PAUSED` until activation\nWhy: Server activation pending",
    );
    // Channel access is held with every other Discord change, so the first step says when it
    // runs instead of asking the manager to wait for a completion that can't come yet.
    for (const mode of PAUSED_MODES) {
      const paused = onlyEmbed(setupReply(setupResult({ effectsMode: mode }), VIEWERS.manager));
      expect(fieldOf(paused, "Next steps")).toStartWith(
        mode === "awaiting_activation"
          ? "1. Channel access is secured once this server is activated; until then /sync status shows it as paused."
          : "1. Channel access is secured once Discord changes are turned back on; until then /sync status shows it as paused.",
      );
      expect(paused.footer?.text).toBe("Check progress any time with /sync status");
    }
  });
});

describe("/setup and /officer", () => {
  test("a rerun that reused everything is 'Server setup refreshed' with the adopted count", () => {
    const embed = embedOf("setup.reused");
    expect(embed.description).toBe(
      "Existing roles and rooms were reused; nothing was duplicated. Channel permissions are being re-checked in the background.",
    );
    expect(fieldOf(embed, "Access roles")).toContain(
      "Officer <@&223456789012345603> · reused, 3 holders adopted as manual grants",
    );
    // With a ledger channel already set, the ledger step is left out.
    expect(fieldOf(embed, "Next steps")).toBe(
      "1. Run /sync status until channel access shows as completed.\n2. Run /config validate.",
    );
    const partly = onlyEmbed(
      setupReply(
        setupResult({
          roles: R.setup.roles.map((role, index) => ({ ...role, created: index === 0 })),
          lobby: { id: CHANNEL.lobby, created: true },
          officerChannel: { id: CHANNEL.officers, created: false },
          fcId: null,
          officerRank: null,
        }),
        manager,
        { now },
      ),
    );
    expect(partly.title).toBe("Server setup complete");
    expect(partly.description).toStartWith(
      "TaruBot created 1 access role and a lobby, and reused the rest.",
    );
    expect(fieldOf(partly, "Free Company")).toBe("Not linked · /config fc link");
    expect(fieldOf(partly, "Officer rank")).toBe("Not set · manual grants only");
  });

  test("an override that repeats, a departed member, and no Officer role yet", () => {
    expect(embedOf("officer.repeated").description).toBe(
      "`= NO CHANGE` <@423456789012345678> already had bot officer access, so only the reason was updated.",
    );
    expect(
      onlyEmbed(
        officerOverrideReply(override({ status: "revoked", previous: "revoked" }), manager, {
          now,
        }),
      ).description,
    ).toBe(
      "`= NO CHANGE` <@423456789012345678>'s officer access was already revoked, so only the reason was updated.",
    );
    expect(fieldOf(embedOf("officer.absent"), "Discord role")).toBe("Applies if they rejoin");
    const recorded = embedOf("officer.recorded");
    expect(recorded.description).toBe(
      "The officer grant for <@423456789012345678> is recorded. No Officer role is set yet, so it takes effect once /config roles officer binds one.",
    );
    expect(fieldOf(recorded, "Discord role")).toBe("Applies once an Officer role is set");
  });

  test("the reason is the manager's own text, escaped and capped at 300 characters", () => {
    const presented = officerOverrideReply(override({ reason: stress.text(1_000) }), manager, {
      now,
    });
    const reason = fieldOf(expectHouseStyle(presented), "Reason") ?? "";
    expect(reason.length).toBeLessThanOrEqual(HOUSE_LIMITS.userText);
    expect(reason).not.toMatch(UNESCAPED_MENTION);
  });
});

describe("configuration failures render as their approved concepts", () => {
  /** Render a failure for an audience from a command scope. */
  const refusal = (error: unknown, viewer: (typeof VIEWERS)[keyof typeof VIEWERS], scope: string) =>
    failureReply(error, { ref: REF, viewer, scope, now });
  const failure = (code: FailureCode, message: string, detail?: FailureDetail, retryAfter = 0) =>
    new Failure(code, message, retryAfter, detail);
  /** The error a guard throws. */
  const thrown = (guard: () => void): unknown => {
    try {
      guard();
    } catch (error) {
      return error;
    }
    throw new Error("Expected the guard to refuse");
  };

  test("permission refusals", () => {
    const officers = expectFailure(
      refusal(
        thrown(() => authorize(ACTORS.member, ACTORS.member.guildId, "officer")),
        VIEWERS.member,
        "/config show",
      ),
      { code: "forbidden", ref: REF, tone: "error", title: "Officers only" },
    );
    expect(officers.description).toStartWith("Only FC officers can use **/config**.");
    const managers = expectFailure(
      refusal(
        thrown(() => authorizeRoleManager(ACTORS.officer)),
        officer,
        "/config roles officer",
      ),
      { code: "forbidden", ref: REF, tone: "error", title: "Server managers only" },
    );
    expect(fieldOf(managers, "Missing permission")).toBe("Manage Server and Manage Roles");
    const manageRoles = expectFailure(
      refusal(
        failure("forbidden", "Choosing access roles needs Discord's Manage Roles permission.", {
          kind: "scope",
          scope: "manage_roles",
        }),
        officer,
        "/config roles member",
      ),
      { code: "forbidden", ref: REF, title: "Server managers only" },
    );
    expect(fieldOf(manageRoles, "Missing permission")).toBe("Manage Roles");
    expectFailure(
      refusal(
        failure("forbidden", "Your highest Discord role must be above that role to select it.", {
          kind: "scope",
          scope: "hierarchy",
        }),
        manager,
        "/config roles officer",
      ),
      { code: "forbidden", ref: REF, title: "That role is above yours" },
    );
  });

  test("blocked roles and channels name what is affected for officers only", () => {
    const blocked = failure("blocked", `TaruBot can't manage <@&${ROLE.officer}>.`, {
      kind: "resource",
      resource: "role",
      id: ROLE.officer,
    });
    const embed = expectFailure(refusal(blocked, manager, "/config roles officer"), {
      code: "blocked",
      ref: REF,
      title: "Discord permissions need attention",
    });
    expect(fieldOf(embed, "Affected")).toBe(`<@&${ROLE.officer}> (\`${ROLE.officer}\`)`);
    const channel = expectFailure(
      refusal(
        failure("blocked", "TaruBot needs permissions there.", {
          kind: "resource",
          resource: "channel",
          id: CHANNEL.ledger,
        }),
        officer,
        "/config ledger",
      ),
      { code: "blocked", ref: REF, title: "Discord permissions need attention" },
    );
    expect(fieldOf(channel, "Affected")).toBe(`<#${CHANNEL.ledger}> (\`${CHANNEL.ledger}\`)`);
    expectFailure(refusal(blocked, VIEWERS.member, "/config roles officer"), {
      code: "blocked",
      ref: REF,
      title: "Server setup issue",
    });
  });

  test("/setup busy, conflict and ambiguity", () => {
    // Busy is the approved errors-and-style#10 wait concept, with setup's own sentence.
    const busy = expectFailure(
      refusal(
        failure(
          "busy",
          "Another /setup for this server is in progress. Try again in a few seconds.",
        ),
        manager,
        "/setup",
      ),
      { code: "busy", ref: REF, tone: "pending", title: "Please wait a moment" },
    );
    expect(busy.description).toStartWith("Another /setup for this server is in progress.");
    const conflict = expectFailure(
      refusal(
        failure(
          "conflict",
          "Server settings changed during setup, so nothing was saved. Run /setup again; anything already created is reused.",
        ),
        manager,
        "/setup",
      ),
      { code: "conflict", ref: REF, title: "Settings changed — try again" },
    );
    expect(conflict.description).toContain("anything already created is reused");
    expectFailure(
      refusal(
        failure("ambiguous", "Several roles match.", {
          kind: "matches",
          resource: "role",
          name: "Officer",
          ids: [ROLE.officer, ROLE.previous],
        }),
        manager,
        "/setup",
      ),
      { code: "ambiguous", ref: REF, title: "Choose which role to use" },
    );
    expectFailure(
      refusal(
        failure("ambiguous", "Several channels match lobby.", {
          kind: "matches",
          resource: "channel",
          name: "lobby",
          ids: [CHANNEL.lobby, CHANNEL.officers],
        }),
        manager,
        "/setup",
      ),
      { code: "ambiguous", ref: REF, title: "Choose which channel to use" },
    );
  });

  test("FC link, unlink and Lodestone refusals", () => {
    expectFailure(refusal(fcLinked(CONFIG_FC.id), officer, "/config fc link"), {
      code: "fc_linked",
      ref: REF,
      title: "Another FC is linked",
    });
    expectFailure(
      refusal(
        failure("not_found", "FC 1 isn't the linked Free Company.", {
          kind: "resource",
          resource: "fc_link",
          id: "1",
        }),
        officer,
        "/config fc unlink",
      ),
      { code: "not_found", ref: REF, title: "That FC isn't linked" },
    );
    expectFailure(
      refusal(
        failure("not_found", "Lodestone not found.", {
          kind: "resource",
          resource: "freecompany",
          id: CONFIG_FC.id,
        }),
        officer,
        "/config fc link",
      ),
      { code: "not_found", ref: REF, title: "Free Company not found" },
    );
    expectFailure(
      refusal(failure("unavailable", "The Lodestone is unavailable."), officer, "/config fc link"),
      { code: "unavailable", ref: REF, title: "The Lodestone isn't responding" },
    );
  });

  test("an incomplete member list suggests adopt_holders:false", () => {
    const embed = expectFailure(
      refusal(
        failure("unavailable", "Discord didn't return the complete member list.", {
          kind: "discord",
          what: "member_list",
        }),
        manager,
        "/config roles officer",
      ),
      { code: "unavailable", ref: REF, title: "Couldn't read the member list" },
    );
    expect(fieldOf(embed, "Tip")).toContain("adopt_holders:false");
  });

  test("/officer on an unconfigured server, and for someone who isn't a member", () => {
    expectFailure(
      refusal(
        failure("setup", "This server has no TaruBot configuration yet.", {
          kind: "setup",
          missing: "guild",
        }),
        manager,
        "/officer grant",
      ),
      { code: "setup", ref: REF, tone: "warning", title: "Finish setup first" },
    );
    expectFailure(
      refusal(
        failure("not_found", "That user isn't a current member of this server, or is a bot.", {
          kind: "resource",
          resource: "member",
          id: "423456789012345678",
        }),
        manager,
        "/officer grant",
      ),
      { code: "not_found", ref: REF, title: "Member not found" },
    );
  });

  test("the input rewrites reach 'Check your input'", () => {
    for (const [message, option, scope] of [
      ["Choose a role or set clear:true, not both.", "role", "/config roles member"],
      ["Give a rank name or set clear:true, not both.", "rank", "/config officer_rank"],
      [
        "Use adopt_holders only when choosing an Officer role, not with clear:true.",
        "adopt_holders",
        "/config roles officer",
      ],
      [
        "Member, Guest, Officer and FC Leader must be four different roles.",
        "role",
        "/config roles guest",
      ],
    ] as const) {
      const embed = expectFailure(
        refusal(failure("input", message, { kind: "option", option }), officer, scope),
        { code: "input", ref: REF, tone: "warning", title: "Check your input" },
      );
      expect(embed.description).toStartWith(message);
    }
  });
});

describe("stored Lodestone tags (2.14.0 reply session, D1)", () => {
  // The parser stores a tag as the Lodestone shows it, «EXMPL»; DevBot's /config show and
  // /config validate rendered ««Souls»» until presenters stripped the stored pair.
  const stored = { ...CONFIG_FC, tag: "«EXMPL»" };
  const tagged = configReport({ fc: fcRow({ tag: stored.tag }) });

  test("show, validate, link and unlink render exactly as with a bare tag", () => {
    const officer = { now: NOW };
    const pairs = [
      [showReply(R.healthy, VIEWERS.officer, officer), showReply(tagged, VIEWERS.officer, officer)],
      [
        healthReply(R.healthy, VIEWERS.officer, officer),
        healthReply(tagged, VIEWERS.officer, officer),
      ],
      [
        changeReply(R.linked, VIEWERS.officer, officer),
        changeReply(
          configChange("fc_id", CONFIG_FC.id, { company: stored }),
          VIEWERS.officer,
          officer,
        ),
      ],
      [
        fcUnlinkReply(R.unlinked, VIEWERS.officer, { fcId: CONFIG_FC.id, now: NOW }),
        fcUnlinkReply(unlinked({ company: stored }), VIEWERS.officer, {
          fcId: CONFIG_FC.id,
          now: NOW,
        }),
      ],
    ] as const;
    for (const [bare, fromLodestone] of pairs) {
      expect(visibleText(fromLodestone)).toBe(visibleText(bare));
      expect(visibleText(fromLodestone)).toContain("«EXMPL»");
      expect(visibleText(fromLodestone)).not.toMatch(/««|»»/u);
    }
  });
});

describe("officer rank repeats (2.15.0 review)", () => {
  test("a repeat names the saved rank and what is still missing, never access it can't give", () => {
    const repeat = rankResult({ status: "unchanged", effects: "unchanged", previous: "Officer" });
    const ready = onlyEmbed(officerRankReply(repeat, VIEWERS.manager, { now: NOW }));
    expect(ready.description).toContain("is already the saved officer rank.");
    expect(ready.description).toEndWith("Members who hold it already get bot officer access.");
    expect(fieldOf(ready, "Heads-up")).toBeUndefined();
    const unbound = onlyEmbed(
      officerRankReply({ ...repeat, officerRoleId: null }, VIEWERS.manager, { now: NOW }),
    );
    expect(unbound.description).not.toContain("get bot officer access");
    expect(fieldOf(unbound, "Heads-up")).toBe(
      "No Officer role is bound; bind one with /config roles officer.",
    );
    expectHouseStyle(officerRankReply({ ...repeat, officerRoleId: null }, VIEWERS.manager), {
      tone: "info",
      title: "Officer rank already set",
    });
  });
});
