/**
 * Configuration presenters: /config show and /config validate (and the buttons that re-run the
 * health check), every /config change, /setup, and /officer grant and revoke. Each renders a typed
 * service result for its viewer, reproducing the approved mockups (configuration#4, #7, #8, #9,
 * #18, #34, #37 and #41, with the gen.py title overrides) and the reply specs for the other states.
 * Failures are never caught here: the router's failure presenter renders them. Pure; the clock is
 * injected for embed timestamps.
 *
 * Change receipts branch on effectsMode (C5). A change whose own effect is Discord work (roles,
 * the FC link, the officer rank, the role layout, /setup, an officer override) saved while Discord
 * changes are paused is the approved paused-save card (errors-and-style#26, owner decision O2):
 * pending, titled 'Saved, Discord changes paused', keeping the receipt's facts. Channel settings
 * take effect at once, so their cards stay as they are and say in words when posts resume. Live
 * Discord work reads '… QUEUED' as the style guide says, except where an approved card words it
 * (#37's Channel access line, #41's 'Assignment queued'). Every committed change is success,
 * removals included; repeats that change nothing are the info '= NO CHANGE' cards (C4).
 *
 * The health checklist uses the approved bracket tokens ([OK] [WARN] [FAIL] [OFF] [WAIT]), which
 * belong to health checks only. /config show keeps the approved field-per-setting layout, which
 * needs up to 14 fields: its documented exemption from the ten-field house limit (C3).
 */
import type { GuildRecord } from "../../application/records.js";
import type {
  ConfigChange,
  ConfigurationReport,
  EffectsMode,
  FcHealthRow,
  FcRef,
  FcUnlinkResult,
  OfficerOverrideResult,
  OfficerRankResult,
  RoleLayoutResult,
  SetupResult,
} from "../../application/results.js";
import { GUEST_APPLICATIONS_CLOSED } from "../../domain/guest-application.js";
import type { Viewer } from "./audience.js";
import { recheckButton, syncStatusButton } from "./controls.js";
import {
  code,
  count,
  fcTitleName,
  link,
  lodestone,
  mentionChannel,
  mentionRole,
  mentionUser,
  plain,
  restoreMentions,
  shortId,
  title,
  when,
} from "./format.js";
import { effectsField, pausedSave, whenApplied } from "./jobs.js";
import { reply, type FieldSpec, type Presented, type ReplySpec } from "./reply.js";
import { CHECK, HOUSE_LIMITS, marker, type Check, type Tone } from "./style.js";

/**
 * Every configuration reply kind, with whether its embed carries a timestamp: the approved card's
 * `timestamp` value, or the reply spec's for states without a drawn card (C11). Repeats that
 * change nothing and paused saves (errors-and-style#26) have none. The reply catalog must cover
 * every kind.
 */
const TIMESTAMP = {
  "show.configured": true,
  "show.partial": true,
  "show.paused": true,
  "validate.healthy": true,
  "validate.problems": true,
  "validate.warnings": true,
  "validate.ready": true,
  "fc.linked": true,
  "fc.unchanged": false,
  "fc.paused": false,
  "fc.unlinked": true,
  "fc.unlink_paused": false,
  "role.set": true,
  "role.leader": true,
  "role.leader_no_fc": true,
  "role.officer_adopted": true,
  "role.officer_not_adopted": true,
  "role.officer_no_rank": true,
  "role.cleared": true,
  "role.unchanged": false,
  "role.paused": false,
  "channel.ledger": true,
  "channel.ledger_no_fc": true,
  "channel.ledger_cleared": true,
  "channel.notifications": true,
  "channel.notifications_cleared": true,
  "channel.applications_open": true,
  "channel.applications_no_role": true,
  "channel.applications_closed": true,
  "channel.unchanged": false,
  "rank.set": true,
  "rank.heads_up": true,
  "rank.cleared": true,
  "rank.paused": false,
  "layout.on": true,
  "layout.off": true,
  "layout.unchanged": false,
  "layout.paused": false,
  "setup.created": true,
  "setup.reused": true,
  "setup.paused": false,
  "officer.granted": true,
  "officer.revoked": true,
  "officer.repeated": true,
  "officer.absent": true,
  "officer.recorded": true,
  "officer.paused": false,
} as const satisfies Record<string, boolean>;

/** A configuration reply state; tests catalogue one case per kind. */
export type ConfigReplyKind = keyof typeof TIMESTAMP;

/** Every configuration reply kind, for catalog completeness checks. */
export const CONFIG_REPLY_KINDS = Object.keys(TIMESTAMP) as readonly ConfigReplyKind[];

/** Options every configuration presenter takes. */
export interface ConfigReplyOptions {
  /** The current time for embed timestamps; commands omit it, tests inject the mockups' clock. */
  readonly now?: Date | undefined;
}

/** Build a configuration reply of `kind`, stamping it only when its approved card does. */
function card(
  kind: ConfigReplyKind,
  spec: Omit<ReplySpec, "timestamp">,
  options: ConfigReplyOptions,
): Presented {
  return reply({ ...spec, timestamp: TIMESTAMP[kind] ? (options.now ?? new Date()) : null });
}

/** Whether Discord changes are held, which turns a Discord-work receipt into the paused card. */
const paused = (mode: EffectsMode): mode is Exclude<EffectsMode, "live"> => mode !== "live";

/**
 * The approved paused-save card (errors-and-style#26) around a receipt: its sentence follows what
 * was saved, and its Saved and Discord changes fields come before the receipt's own facts.
 */
function heldCard(
  kind: ConfigReplyKind,
  mode: Exclude<EffectsMode, "live">,
  viewer: Viewer,
  saved: string,
  fields: readonly (FieldSpec | false | null | undefined)[],
  options: ConfigReplyOptions,
): Presented {
  const held = pausedSave(mode, viewer);
  return card(
    kind,
    {
      tone: held.tone,
      title: held.title,
      description: `${saved} ${held.sentence}`,
      fields: [...held.fields, ...fields],
      footer: held.footer,
    },
    options,
  );
}

/** The audit footer of a configuration change, naming the revision it produced (a bigint). */
const revisionFooter = (guild: Pick<GuildRecord, "revision">): string =>
  `Audited · configuration revision ${guild.revision}`;

/** User-written rank names and reasons in fields, capped like all user text (C10). */
const userText = (text: string): string => plain(text, HOUSE_LIMITS.userText);

/** A rank name inside a sentence, in bold, cut like a character name. */
const rankText = (rank: string): string => `**${plain(rank, HOUSE_LIMITS.characterName)}**`;

// ---------------------------------------------------------------------------------------------
// Shared vocabulary

/** The four managed roles in layout order (FC Leader > Officer > Member > Guest). */
const ROLES = [
  { column: "leader_role_id", label: "FC Leader" },
  { column: "officer_role_id", label: "Officer" },
  { column: "member_role_id", label: "Member" },
  { column: "guest_role_id", label: "Guest" },
] as const;

/** The FC's stored name for links, or its ID before the first Lodestone read filled it in. */
const rawName = (fc: Pick<FcRef, "id" | "name">): string => fc.name.trim() || `FC ${fc.id}`;

/** The FC as the checklist and receipts name it: 'Example Company «EXMPL»' (no world). */
function fcLabel(fc: Pick<FcRef, "id" | "name" | "tag">): string {
  const name = fcTitleName(fc, "text");
  return fc.tag ? `${name} «${plain(fc.tag, 20)}»` : name;
}

/**
 * The FC as a Lodestone link plus its world: '[Example Company «EXMPL»](…) · Diabolos', or with
 * ' on ' between them inside a sentence.
 */
function fcLink(fc: FcRef, joiner: " · " | " on " = " · "): string {
  const label = fc.tag ? `${rawName(fc)} «${fc.tag}»` : rawName(fc);
  const world = fc.world ? `${joiner}${plain(fc.world, HOUSE_LIMITS.characterName)}` : "";
  return `${link(label, lodestone.freeCompany(fc.id))}${world}`;
}

/**
 * The linked FC's health row. A linked FC whose row is missing (never expected: linking stores it)
 * still shows as linked by its ID, with no roster read.
 */
function linkedFc(report: ConfigurationReport): FcHealthRow | null {
  const id = report.configuration.fc_id;
  if (id === null) return null;
  return (
    report.fc?.find((row) => row.id === id) ?? {
      id,
      name: "",
      tag: "",
      world: "",
      last_successful_roster_at: null,
      last_attempt_at: null,
      last_error: null,
      fresh: false,
      attemptFailed: false,
    }
  );
}

/** What 'Discord changes' reads in /config show, and its one-word form in the description. */
const DISCORD_STATE: Readonly<
  Record<EffectsMode, { readonly field: string; readonly word: string }>
> = {
  live: { field: "Live", word: "Live" },
  awaiting_activation: { field: "Paused · pending activation", word: "Paused" },
  deployment_disabled: {
    field: "Disabled for this deployment",
    word: "Disabled for this deployment",
  },
};

/** Why Discord changes are held, as /config show's description states it. */
const PAUSED_NOTE: Readonly<Record<Exclude<EffectsMode, "live">, string>> = {
  awaiting_activation:
    "**Not activated yet.** TaruBot's role, nickname and channel changes are paused until the activation step runs.",
  deployment_disabled:
    "**Discord changes are off for this deployment.** TaruBot won't change roles, nicknames or channels until they're turned back on.",
};

/**
 * Held work a change queued again (blocked or paused jobs): '… QUEUED' while Discord changes are
 * live, otherwise when the pause ends, because the requeued jobs are held again until then.
 */
function heldWork(requeued: number, mode: EffectsMode): FieldSpec | null {
  if (requeued <= 0) return null;
  const jobs = count(requeued, "held job");
  return {
    name: "Held work",
    value:
      mode === "live"
        ? `${marker("queued")} ${jobs} queued again`
        : `${jobs} will retry ${whenApplied(mode)}`,
  };
}

// ---------------------------------------------------------------------------------------------
// /config validate: the health checklist

/** A checklist section: one field each, in the approved order. */
export type HealthSection =
  | "Free Company"
  | "Access roles"
  | "Channels"
  | "Onboarding"
  | "Discord changes"
  | "Role layout"
  | "Guest grandfathering";

/** One checklist line: its bracket token, text, and whether it reports a configured resource. */
export interface HealthCheck {
  readonly section: HealthSection;
  readonly check: Check;
  readonly text: string;
  /** A role or channel check the service ran (available or failed); /config show counts these. */
  readonly resource: boolean;
}

/** Sections that sit side by side, as the approved checklists draw them. */
const INLINE_SECTIONS: ReadonlySet<HealthSection> = new Set([
  "Discord changes",
  "Role layout",
  "Guest grandfathering",
]);

/** Roster-acquisition failure codes as the failed-attempt clause names them (configuration#8). */
const ROSTER_ERROR: Readonly<Record<string, string>> = {
  unavailable: "Lodestone unavailable",
  rate_limited: "Lodestone rate limited",
  not_found: "FC not found on the Lodestone",
  incomplete: "roster read was incomplete",
  invalid_response: "unexpected Lodestone data",
  acquisition_failed: "roster read failed",
};

/**
 * The room a failed check's message gets. Messages are approved Failure text that may name the
 * resource as a mention; at this length four failing roles still fit one 1,024-character field.
 */
const CHECK_MESSAGE = 200;

/** A resource check's stored state: available, unconfigured, or the check's failure message. */
function capability(report: ConfigurationReport, column: string, value: string | null): string {
  if (value === null) return "unconfigured";
  // A configured column the service did not report can't be called healthy.
  return (
    report.capabilities[column] ?? "Resource check failed; inspect bot permissions and hierarchy."
  );
}

/**
 * A configured role or channel's line: '[OK] <label> <mention>', or '[FAIL] <label> <mention>:
 * <message>' with the message's own mentions kept (the gateway names the resource in it).
 */
function resourceCheck(
  section: HealthSection,
  label: string,
  mention: string,
  state: string,
): HealthCheck {
  if (state === "available")
    return { section, check: "ok", text: `${label} ${mention}`, resource: true };
  return {
    section,
    check: "fail",
    text: `${label} ${mention}: ${restoreMentions(plain(state, CHECK_MESSAGE))}`,
    resource: true,
  };
}

/** The failed-attempt clause, only when the latest roster attempt came after the last success. */
function attemptClause(fc: FcHealthRow): string {
  const last = fc.last_successful_roster_at;
  const attempt = fc.last_attempt_at;
  if (!fc.attemptFailed || !attempt || (last && attempt <= last)) return "";
  // Stored codes are catalog codes; anything else (or a prototype key) gets the generic words.
  const stored = fc.last_error;
  const reason =
    (stored && Object.hasOwn(ROSTER_ERROR, stored) ? ROSTER_ERROR[stored] : undefined) ??
    "roster read failed";
  return `; the attempt ${when(attempt, "R")} failed (${reason})`;
}

/**
 * The /config validate checklist as rows, one bracket token each (approved configuration#7–#9):
 * - Free Company: linked or not, then the roster: fresh [OK], stale or never read [WARN], with
 *   the failed-attempt clause when the latest attempt came after the last success.
 * - Access roles in layout order: [OK], [FAIL] with the check's message, [WARN] for an unset
 *   Member or Guest role, [OFF] 'not managed' for an unset Officer or FC Leader role.
 * - Channels: [OK], [FAIL], [OFF] when unset; a review channel without a Guest role is [WARN].
 * - Onboarding: the lobby and officer room, or [OFF] when onboarding is off.
 * - Discord changes: [OK] Live; [WARN] when disabled for the deployment; awaiting activation is
 *   [WAIT] 'Paused until activation' (configuration#9), except beside problems, where the approved
 *   configuration#8 counts it as the warning 'Paused: this server has not been activated'.
 * - Role layout: [OK] On or [OFF] Off; Guest grandfathering: [WAIT] only while it is pending.
 * The unset-guest-channel line likewise follows each approved card's wording (#8 with problems,
 * #9 otherwise). Pure: the service already ran every check.
 */
export function configurationChecks(report: ConfigurationReport): HealthCheck[] {
  const guild = report.configuration;
  const rows: HealthCheck[] = [];
  const add = (section: HealthSection, check: Check, text: string, resource = false): void => {
    rows.push({ section, check, text, resource });
  };

  const fc = linkedFc(report);
  if (!fc) add("Free Company", "warn", "No FC linked, so no one can receive Member");
  else {
    add("Free Company", "ok", `${fcLabel(fc)} linked`);
    const last = fc.last_successful_roster_at;
    const failed = attemptClause(fc);
    if (last && fc.fresh) add("Free Company", "ok", `Roster read ${when(last, "R")}`);
    else if (!last) add("Free Company", "warn", `No successful roster read yet${failed}`);
    else add("Free Company", "warn", `Roster is stale: last good read ${when(last, "R")}${failed}`);
  }

  for (const { column, label } of ROLES) {
    const id = guild[column];
    if (id !== null)
      rows.push(
        resourceCheck("Access roles", label, mentionRole(id), capability(report, column, id)),
      );
    else if (column === "member_role_id" || column === "guest_role_id")
      add("Access roles", "warn", `${label}: not set, so no one receives ${label} access`);
    else add("Access roles", "off", `${label}: not managed`);
  }

  const ledger = guild.ledger_channel_id;
  if (ledger !== null)
    rows.push(
      resourceCheck(
        "Channels",
        "Ledger",
        mentionChannel(ledger),
        capability(report, "ledger_channel_id", ledger),
      ),
    );
  else add("Channels", "off", "Ledger: not set, so ledger commands are unavailable");
  const notices = guild.officer_notifications_channel_id;
  if (notices !== null)
    rows.push(
      resourceCheck(
        "Channels",
        "Officer notifications",
        mentionChannel(notices),
        capability(report, "officer_notifications_channel_id", notices),
      ),
    );
  else add("Channels", "off", "Officer notifications: not set, so officer alerts are skipped");
  const reviews = guild.guest_application_channel_id;
  if (reviews !== null) {
    const review = resourceCheck(
      "Channels",
      "Guest applications",
      mentionChannel(reviews),
      capability(report, "guest_application_channel_id", reviews),
    );
    // A usable review channel without a Guest role still leaves /apply closed.
    rows.push(
      review.check === "ok" && guild.guest_role_id === null
        ? {
            ...review,
            check: "warn",
            text: `${review.text}: open, but no Guest role is set, so /apply stays closed`,
          }
        : review,
    );
  }

  if (guild.access_policy_enabled)
    for (const [column, label] of [
      ["lobby_channel_id", "Lobby"],
      ["officer_channel_id", "Officer room"],
    ] as const) {
      const id = guild[column];
      if (id !== null)
        rows.push(
          resourceCheck("Onboarding", label, mentionChannel(id), capability(report, column, id)),
        );
      else add("Onboarding", "warn", `${label}: not set; run /setup again to create it`);
    }
  else add("Onboarding", "off", "Onboarding is off");

  // Wording that differs between the approved problem (#8) and ready (#9) checklists follows the
  // verdict. Fields group rows by section, so this line still lists last among the channels.
  const problems = rows.some((row) => row.check === "fail");
  if (reviews === null)
    add(
      "Channels",
      "off",
      problems
        ? "Guest applications: not set, so /apply is closed"
        : "Guest applications: closed, so /apply refuses",
    );

  if (report.effectsMode === "deployment_disabled")
    add("Discord changes", "warn", "Disabled for this deployment");
  else if (report.effectsMode === "awaiting_activation")
    if (problems) add("Discord changes", "warn", "Paused: this server has not been activated");
    else add("Discord changes", "wait", "Paused until activation");
  else add("Discord changes", "ok", "Live");

  if (guild.role_layout_enabled) add("Role layout", "ok", "On");
  else add("Role layout", "off", "Off: display and order untouched");

  if (guild.guest_grandfather === "pending")
    add("Guest grandfathering", "wait", "Pending: runs once at activation");
  return rows;
}

/** The checklist's verdict: its counts, and which state (and so tone and title) it is in. */
interface Verdict {
  readonly kind: "validate.healthy" | "validate.problems" | "validate.warnings" | "validate.ready";
  readonly tone: Tone;
  readonly title: string;
  readonly description: string;
}

/** Tone, title and description from the checklist's token counts (approved #7, #8 and #9). */
function verdict(checks: readonly HealthCheck[], mode: EffectsMode): Verdict {
  const tally = (check: Check) => checks.filter((row) => row.check === check).length;
  const [ok, fail, warn, wait] = [tally("ok"), tally("fail"), tally("warn"), tally("wait")];
  const warnings = warn > 0 ? count(warn, "warning") : null;
  if (fail > 0)
    return {
      kind: "validate.problems",
      tone: "error",
      title: title(
        "Configuration health",
        [count(fail, "problem"), warnings].filter(Boolean).join(", "),
      ),
      description: `Fix the items marked ${CHECK.fail}, then run /config validate again. Nothing was changed.`,
    };
  if (warnings)
    return {
      kind: "validate.warnings",
      tone: "warning",
      title: title("Configuration health", warnings),
      description: `No problems found, but review the items marked ${CHECK.warn}. Nothing was changed.`,
    };
  if (wait > 0)
    return {
      kind: "validate.ready",
      tone: "pending",
      title: title("Configuration health", "ready for activation"),
      description:
        mode === "awaiting_activation"
          ? "All configured resources passed. Discord changes stay paused until activation. Nothing was changed."
          : `All configured resources passed. Items marked ${CHECK.wait} run at activation. Nothing was changed.`,
    };
  return {
    kind: "validate.healthy",
    tone: "success",
    title: title("Configuration health", "all checks passed"),
    description: `${count(ok, "check")} passed. Nothing was changed.`,
  };
}

/** One field per checklist section, in order, each line '<token> <text>'. */
function checklistFields(checks: readonly HealthCheck[]): FieldSpec[] {
  const sections: HealthSection[] = [];
  for (const row of checks) if (!sections.includes(row.section)) sections.push(row.section);
  return sections.map((section) => ({
    name: section,
    value: checks
      .filter((row) => row.section === section)
      .map((row) => `${CHECK[row.check]} ${row.text}`)
      .join("\n"),
    inline: INLINE_SECTIONS.has(section),
  }));
}

/**
 * /config validate and its Re-check, and /config show's Run health check (approved
 * configuration#7–#9, titled 'Configuration health · …'). Read-only, so every verdict says
 * "Nothing was changed." (C2). Any [FAIL] is error with the problem and warning counts; warnings
 * alone are warning; waits alone (an imported guild before activation) are pending 'ready for
 * activation'; otherwise success with the passed count. Re-check edits this view in place.
 */
export function healthReply(
  report: ConfigurationReport,
  _viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const checks = configurationChecks(report);
  const result = verdict(checks, report.effectsMode);
  return card(
    result.kind,
    {
      tone: result.tone,
      title: result.title,
      description: result.description,
      fields: checklistFields(checks),
      footer: ["Read-only check", `configuration revision ${report.configuration.revision}`],
      buttons: [recheckButton("Re-check")],
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /config show

/** /config show's health line, from the same resource checks /config validate lists. */
function healthLine(checks: readonly HealthCheck[]): string {
  const resources = checks.filter((row) => row.resource);
  const failed = resources.filter((row) => row.check === "fail").length;
  if (resources.length === 0) return "Health: no roles or channels to check yet.";
  if (failed > 0) return `Health: ${count(failed, "problem")}. Run /config validate.`;
  return `Health: all ${count(resources.length, "resource check")} passed.`;
}

/** What 'Guest applications' reads: open only when both the channel and the Guest role are set. */
function guestApplications(guild: GuildRecord): string {
  const channel = guild.guest_application_channel_id;
  if (channel === null) return "Closed";
  if (guild.guest_role_id === null) return "Closed · no Guest role";
  return `Open · ${mentionChannel(channel)}`;
}

/** Numbered next steps for what is still unset, in the order setup needs them (spec #5). */
function nextSteps(guild: GuildRecord): string | null {
  const steps = [
    (guild.member_role_id === null || guild.guest_role_id === null) &&
      "Create or bind the access roles.",
    guild.fc_id === null && "Link the Free Company with /config fc link.",
    guild.ledger_channel_id === null && "Choose a ledger channel with /config ledger.",
  ].filter((step): step is string => Boolean(step));
  if (steps.length === 0) return null;
  return [...steps, "Run /config validate."]
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");
}

/**
 * /config show (approved configuration#4; spec #5 partially configured and #6 not activated). The
 * description gives the FC, a pause note while Discord changes are held, the three switches and
 * the health line. Fields show each setting: the four roles inline in layout order (one 'Access
 * roles' field when none is set), Officer access, the three channels (one 'Channels' field when
 * none is set), Onboarding, Discord changes, Role layout, Guest grandfathering while it applies,
 * and Next steps when something required is unset: up to 14 fields, the documented /config show
 * exemption (C3). Info, or pending while Discord changes are held (C4). Run health check replaces
 * this view with the checklist.
 */
export function showReply(
  report: ConfigurationReport,
  _viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const guild = report.configuration;
  const mode = report.effectsMode;
  const checks = configurationChecks(report);
  const fc = linkedFc(report);
  const onboarding = guild.access_policy_enabled;

  const fcLine = fc
    ? [
        `**${fcTitleName(fc, "text")}**`,
        fc.tag ? ` «${plain(fc.tag, 20)}»` : "",
        fc.world ? ` · ${plain(fc.world, HOUSE_LIMITS.characterName)}` : "",
      ].join("")
    : "No Free Company linked";
  const switches = [
    `Discord changes **${DISCORD_STATE[mode].word}**`,
    `Onboarding **${onboarding ? "On" : "Off"}**`,
    `Role layout **${guild.role_layout_enabled ? "On" : "Off"}**`,
  ].join(" · ");

  const company: FieldSpec = {
    name: "Free Company",
    value: fc
      ? [
          fcLink(fc),
          fc.last_successful_roster_at
            ? `Roster read ${when(fc.last_successful_roster_at, "R")}`
            : "No successful roster read yet",
          `FC ID ${fc.id}`,
        ].join("\n")
      : "Not linked. /config fc link fc_id:<ID or Lodestone URL>",
  };
  const rolesUnset = ROLES.every(({ column }) => guild[column] === null);
  const roles: FieldSpec[] = rolesUnset
    ? [
        {
          name: "Access roles",
          value:
            "Not set. Server managers can run /setup, or bind existing roles with /config roles member, guest, officer and leader.",
        },
      ]
    : ROLES.map(({ column, label }) => {
        const id = guild[column];
        return { name: `${label} role`, value: id ? mentionRole(id) : "Not set", inline: true };
      });
  const officerAccess: FieldSpec = {
    name: "Officer access",
    value:
      guild.officer_role_id === null
        ? "Server managers only. Set an Officer role with /config roles officer to delegate."
        : guild.officer_rank_name
          ? `In-game rank ${rankText(guild.officer_rank_name)} + manual grants (/officer grant)`
          : "Manual grants only (/officer grant)",
  };
  const channelsUnset =
    guild.ledger_channel_id === null &&
    guild.officer_notifications_channel_id === null &&
    guild.guest_application_channel_id === null;
  const channels: FieldSpec[] = channelsUnset
    ? [
        {
          name: "Channels",
          value: "Ledger: not set\nOfficer notifications: not set\nGuest applications: closed",
        },
      ]
    : [
        {
          name: "Ledger channel",
          value: guild.ledger_channel_id ? mentionChannel(guild.ledger_channel_id) : "Not set",
          inline: true,
        },
        {
          name: "Officer notifications",
          value: guild.officer_notifications_channel_id
            ? mentionChannel(guild.officer_notifications_channel_id)
            : "Not set",
          inline: true,
        },
        { name: "Guest applications", value: guestApplications(guild), inline: true },
      ];
  const rooms = [
    guild.lobby_channel_id ? `lobby ${mentionChannel(guild.lobby_channel_id)}` : "lobby not set",
    guild.officer_channel_id
      ? `officer room ${mentionChannel(guild.officer_channel_id)}`
      : "officer room not set",
  ];
  const steps = nextSteps(guild);
  const grandfather = guild.guest_grandfather;

  const kind: ConfigReplyKind = paused(mode)
    ? "show.paused"
    : steps
      ? "show.partial"
      : "show.configured";
  return card(
    kind,
    {
      tone: paused(mode) ? "pending" : "info",
      title: "Server configuration",
      description: [fcLine, paused(mode) && PAUSED_NOTE[mode], switches, healthLine(checks)],
      fields: [
        company,
        ...roles,
        officerAccess,
        ...channels,
        onboarding
          ? { name: "Onboarding", value: `On · ${rooms.join(" · ")}` }
          : { name: "Onboarding", value: "Off", inline: true },
        { name: "Discord changes", value: DISCORD_STATE[mode].field, inline: true },
        {
          name: "Role layout",
          value: guild.role_layout_enabled ? "On" : "Off · display and order untouched",
          inline: true,
        },
        grandfather === "pending" && {
          name: "Guest grandfathering",
          value: "Pending · runs once at activation",
          inline: true,
        },
        grandfather === "completed" && {
          name: "Guest grandfathering",
          value: guild.guest_grandfathered_at
            ? `Completed ${when(guild.guest_grandfathered_at, "R")}`
            : "Completed",
          inline: true,
        },
        steps !== null && { name: "Next steps", value: steps },
      ],
      footer: [`Configuration revision ${guild.revision}`, "/config validate tests each resource"],
      buttons: [recheckButton("Run health check")],
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /config fc link and unlink

/**
 * /config fc link (spec #10, #11). A new link is success, 'Free Company linked', with the roster
 * read (which runs even while Discord changes are paused), the ledger account and the role check
 * it queued; paused, it is the paused-save card. Linking the FC that is already linked is the
 * info no-op 'Free Company already linked'.
 */
function companyLinkReply(
  result: Extract<ConfigChange, { readonly status: "saved" }>,
  viewer: Viewer,
  options: ConfigReplyOptions,
): Presented {
  const id = result.value ?? result.guild.fc_id ?? "";
  const company = result.company;
  const linked = company
    ? `${fcLink(company, " on ")} is now linked to this server.`
    : `FC ${code(id)} is now linked to this server.`;
  const facts: FieldSpec[] = [
    { name: "FC ID", value: code(id), inline: true },
    { name: "Roster", value: `${marker("queued")} Lodestone read`, inline: true },
    { name: "Ledger account", value: `${marker("saved")} Ready`, inline: true },
  ];
  if (paused(result.effectsMode))
    return heldCard(
      "fc.paused",
      result.effectsMode,
      viewer,
      `${linked} Its roster is still read now.`,
      [...facts, heldWork(result.requeued, result.effectsMode)],
      options,
    );
  return card(
    "fc.linked",
    {
      tone: "success",
      title: "Free Company linked",
      description: `${linked} A roster read is queued; member access updates when it finishes.`,
      fields: [
        ...facts,
        effectsField(result.effectsMode, "Server-wide role check", viewer),
        heldWork(result.requeued, result.effectsMode),
      ],
      footer: ["Audited", "check progress with /sync status"],
    },
    options,
  );
}

/** Options for the unlink receipt: the FC ID the officer typed, which the result may not name. */
export interface UnlinkReplyOptions extends ConfigReplyOptions {
  readonly fcId: string;
}

/**
 * /config fc unlink (spec #14): success, 'Free Company unlinked', naming the FC, what the next
 * role check removes (manual grants and registered Guest stay) and that ledger commands pause;
 * paused, it is the paused-save card.
 */
export function fcUnlinkReply(
  result: FcUnlinkResult,
  viewer: Viewer,
  options: UnlinkReplyOptions,
): Presented {
  const name = result.company
    ? `**${fcTitleName(result.company, "text")}**${result.company.tag ? ` «${plain(result.company.tag, 20)}»` : ""}`
    : `FC ${code(options.fcId)}`;
  const unlinked = `${name} is no longer linked. Characters, ledger history and audit records are kept.`;
  const facts: FieldSpec[] = [
    {
      name: "What changes",
      value:
        "At the next role check, TaruBot removes the Member and FC Leader roles and rank-based Officer access. Manual officer grants stay, and members with a verified character keep Guest.",
    },
    { name: "Ledger", value: "Ledger commands are unavailable until an FC is linked again." },
  ];
  if (paused(result.effectsMode))
    return heldCard("fc.unlink_paused", result.effectsMode, viewer, unlinked, facts, options);
  return card(
    "fc.unlinked",
    {
      tone: "success",
      title: "Free Company unlinked",
      description: unlinked,
      fields: [...facts, effectsField(result.effectsMode, "Server-wide role check", viewer)],
      footer: ["Audited as fc.unlink", "link again with /config fc link"],
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /config roles and the channel settings

/** A saved configuration change (not the FC-link no-op). */
type SavedChange = Extract<ConfigChange, { readonly status: "saved" }>;

/**
 * Each role binding: its label with the article a sentence needs, what binding a role means
 * (spec #16 and #19; the Officer role has its own receipt), and the Effect a clear has (#20).
 */
const ROLE_FIELDS = {
  member_role_id: {
    label: "Member",
    article: "a",
    saved: (role: string) =>
      `${role} is now the Member role. TaruBot gives it to people whose linked character is in the linked FC and removes it from everyone else.`,
    cleared: "No one receives Member access from TaruBot until a role is set again.",
  },
  guest_role_id: {
    label: "Guest",
    article: "a",
    saved: (role: string) =>
      `${role} is now the Guest role. TaruBot gives it to approved guests, members with a verified character who aren't in the FC, and former members.`,
    cleared: "Approved guests and verified visitors get no Guest role until one is set again.",
  },
  officer_role_id: {
    label: "Officer",
    article: "an",
    saved: (role: string) => `${role} is now the bot-managed Officer role.`,
    cleared: "Delegated officer access ends: only people with Manage Server count as officers.",
  },
  leader_role_id: {
    label: "FC Leader",
    article: "an",
    saved: (role: string) =>
      `${role} now follows the Free Company leader: TaruBot gives it to the member whose linked character leads the linked FC on the Lodestone roster.`,
    cleared: "No one receives an FC Leader role.",
  },
} as const;

/** Each channel setting's name, for titles and inside sentences (its no-op receipt). */
const CHANNEL_FIELDS = {
  ledger_channel_id: { label: "Ledger channel", noun: "ledger channel" },
  officer_notifications_channel_id: {
    label: "Officer notifications channel",
    noun: "officer notifications channel",
  },
  guest_application_channel_id: {
    label: "Guest applications channel",
    noun: "guest applications channel",
  },
} as const;

/** Whether a saved field is one of the role bindings. */
const isRole = (field: string): field is keyof typeof ROLE_FIELDS =>
  Object.hasOwn(ROLE_FIELDS, field);
/** Whether a saved field is one of the channel settings. */
const isChannel = (field: string): field is keyof typeof CHANNEL_FIELDS =>
  Object.hasOwn(CHANNEL_FIELDS, field);

/**
 * The Discord work a role binding queued beyond the role check: the layout pass when the role
 * layout is on, and channel access when onboarding is on. Live only; a paused receipt's Discord
 * changes field covers them.
 */
function roleWork(change: SavedChange, viewer: Viewer): FieldSpec[] {
  const guild = change.guild;
  return [
    guild.role_layout_enabled &&
      effectsField(change.effectsMode, "Layout pass", viewer, "Role layout"),
    guild.access_policy_enabled &&
      effectsField(change.effectsMode, "Re-securing channels", viewer, "Channel access"),
  ].filter((field): field is FieldSpec => Boolean(field));
}

/** Officer access in the words of the approved cards: rank plus grants, or grants only. */
const officerAccess = (rank: string | null): string =>
  rank ? `Manual grants + in-game rank ${rankText(rank)}` : "Manual grants only";

/**
 * A repeated setting that changed nothing (C4 no-op, info): the same role or channel chosen again,
 * or a clear of something already unset. Rebinding the Officer role adopts nobody. It still
 * re-queues held work, which it reports.
 */
function unchangedReply(
  change: SavedChange,
  label: string,
  noun: string,
  options: ConfigReplyOptions,
): Presented {
  const role = isRole(change.field);
  const target = change.value
    ? role
      ? mentionRole(change.value)
      : mentionChannel(change.value)
    : null;
  const officer =
    change.field === "officer_role_id" && change.value ? " No holders were adopted." : "";
  return card(
    role ? "role.unchanged" : "channel.unchanged",
    {
      tone: "info",
      title: `${label} already ${change.value ? "set" : "cleared"}`,
      description: target
        ? `${marker("unchanged")} ${target} was already the ${noun}.${officer}`
        : `${marker("unchanged")} No ${noun} was set.`,
      fields: [heldWork(change.requeued, change.effectsMode)],
      footer: revisionFooter(change.guild),
    },
    options,
  );
}

/**
 * /config roles officer (spec #17, approved #18). adopt_holders (the default) adopts the role's
 * current holders as manual grants, listing up to twenty; adopt_holders:false (the production
 * runbook) says who keeps the role, and turns warning when no officer rank is set, since then
 * only manual grants keep it.
 */
function officerRoleReply(
  change: SavedChange,
  viewer: Viewer,
  options: ConfigReplyOptions,
): Presented {
  const role = mentionRole(change.value ?? "");
  const intro = ROLE_FIELDS.officer_role_id.saved(role);
  const holders = change.officerHolders;
  const rank = change.guild.officer_rank_name;
  const replaced = replacedField(change);
  const mode = change.effectsMode;
  if (holders && !holders.adopt) {
    const saved = `${intro} No manual grants were created for its current holders.`;
    const facts: (FieldSpec | null)[] = [
      {
        name: "Who keeps the role",
        value: rank
          ? `Members whose linked character holds in-game rank ${rankText(rank)}, plus anyone given /officer grant. Other holders lose the role once the roster confirms they don't hold that rank.`
          : "Only people given /officer grant, because no officer rank is set. Other holders lose the role at the next role check.",
      },
      rank
        ? { name: "Officer rank", value: userText(rank), inline: true }
        : {
            name: "Officer rank",
            value:
              "Not set. Run /config officer_rank rank:<name>, or only /officer grant confers Officer.",
          },
    ];
    if (paused(mode))
      return heldCard("role.paused", mode, viewer, saved, [...facts, replaced], options);
    return card(
      rank ? "role.officer_not_adopted" : "role.officer_no_rank",
      {
        tone: rank ? "success" : "warning",
        title: "Officer role set without adopting holders",
        description: saved,
        fields: [
          ...facts,
          effectsField(mode, "Server-wide role check", viewer),
          replaced,
          ...roleWork(change, viewer),
          heldWork(change.requeued, mode),
        ],
        footer: ["Audited", "adopt_holders:false"],
      },
      options,
    );
  }
  const adopted = holders?.adopted ?? 0;
  const sample = holders?.sample ?? [];
  const saved = `${intro} ${
    adopted > 0
      ? `${count(adopted, "current holder was", "current holders were")} adopted as manual officer grants and keep it until a server manager runs /officer revoke.`
      : "No one holds this role yet."
  }`;
  const facts: (FieldSpec | null)[] = [
    adopted > 0
      ? {
          name: "Adopted holders",
          value: `${sample.map(mentionUser).join(", ")}${
            adopted > sample.length ? ` +${adopted - sample.length} more` : ""
          }`,
        }
      : null,
    { name: "Officer access", value: officerAccess(rank), inline: true },
  ];
  if (paused(mode))
    return heldCard("role.paused", mode, viewer, saved, [...facts, replaced], options);
  return card(
    "role.officer_adopted",
    {
      tone: "success",
      title: "Officer role set",
      description: saved,
      fields: [
        ...facts,
        effectsField(mode, "Server-wide role check", viewer),
        replaced,
        ...roleWork(change, viewer),
        heldWork(change.requeued, mode),
      ],
      footer:
        adopted > 0
          ? ["Audited", "officer.adopt recorded for each holder"]
          : revisionFooter(change.guild),
    },
    options,
  );
}

/** The role a new binding retired, which TaruBot removes from its holders. */
function replacedField(change: SavedChange): FieldSpec | null {
  if (!change.previous || change.previous === change.value) return null;
  return {
    name: "Replaced",
    value: `${mentionRole(change.previous)} is retired: TaruBot removes it from its current holders.`,
  };
}

/**
 * /config roles member, guest, officer and leader (spec #16, #17, approved #18, #19 and #20).
 * Binding shows the retired role, the queued role check, the layout pass and channel access when
 * those switches are on, and held work; a leader without a linked FC turns warning. Clearing is
 * success like every committed removal, and officer and leader bindings render to the manager
 * audience that alone may make them.
 */
function roleChangeReply(
  change: SavedChange,
  field: keyof typeof ROLE_FIELDS,
  viewer: Viewer,
  options: ConfigReplyOptions,
): Presented {
  const { label, article, saved: sentence, cleared } = ROLE_FIELDS[field];
  const mode = change.effectsMode;
  if (change.value === null) {
    const saved = `TaruBot no longer manages ${article} ${label} role.${
      change.previous
        ? ` ${mentionRole(change.previous)} is retired and TaruBot removes it from its current holders.`
        : ""
    }`;
    const effect: FieldSpec = { name: "Effect", value: cleared };
    if (paused(mode))
      return heldCard(
        "role.paused",
        mode,
        viewer,
        saved,
        [effect, heldWork(change.requeued, mode)],
        options,
      );
    return card(
      "role.cleared",
      {
        tone: "success",
        title: `${label} role cleared`,
        description: saved,
        fields: [
          effect,
          effectsField(mode, "Role removal", viewer),
          ...roleWork(change, viewer),
          heldWork(change.requeued, mode),
        ],
        footer: revisionFooter(change.guild),
      },
      options,
    );
  }
  if (field === "officer_role_id") return officerRoleReply(change, viewer, options);
  const role = mentionRole(change.value);
  const leaderless = field === "leader_role_id" && change.guild.fc_id === null;
  const saved = sentence(role);
  const noFc: FieldSpec | null = leaderless
    ? {
        name: "Free Company",
        value: "Not linked, so no one can receive this role yet. Link one with /config fc link.",
      }
    : null;
  if (paused(mode))
    return heldCard(
      "role.paused",
      mode,
      viewer,
      saved,
      [replacedField(change), noFc, heldWork(change.requeued, mode)],
      options,
    );
  return card(
    field === "leader_role_id" ? (leaderless ? "role.leader_no_fc" : "role.leader") : "role.set",
    {
      tone: leaderless ? "warning" : "success",
      title: `${label} role set`,
      description: saved,
      fields: [
        noFc,
        replacedField(change),
        effectsField(mode, "Server-wide role check", viewer),
        ...roleWork(change, viewer),
        heldWork(change.requeued, mode),
      ],
      footer: revisionFooter(change.guild),
    },
    options,
  );
}

/**
 * /config ledger, officer_notifications and guest_applications (spec #23–#28). A channel setting
 * takes effect at once, so it is never the paused-save card; while Discord changes are held, the
 * description says when posts resume and held work says when it retries. Warning variants: a
 * ledger channel with no linked FC, and a review channel with no Guest role ('Review channel set;
 * Guest role still needed', since /apply stays closed). Closing applications quotes the exact
 * refusal /apply now shows.
 */
function channelChangeReply(
  change: SavedChange,
  field: keyof typeof CHANNEL_FIELDS,
  options: ConfigReplyOptions,
): Presented {
  const mode = change.effectsMode;
  const guild = change.guild;
  const held = heldWork(change.requeued, mode);
  const footer = revisionFooter(guild);
  const resumes = (what: string): string => (paused(mode) ? ` ${what} ${whenApplied(mode)}.` : "");
  const channel = change.value ? mentionChannel(change.value) : null;
  if (field === "ledger_channel_id") {
    if (!channel)
      return card(
        "channel.ledger_cleared",
        {
          tone: "success",
          title: "Ledger channel cleared",
          description: "Ledger commands are unavailable until a ledger channel is set again.",
          fields: [
            {
              name: "Queued posts",
              value: "Ledger posts already queued wait, and are sent once a channel is set.",
            },
            held,
          ],
          footer,
        },
        options,
      );
    const noFc = guild.fc_id === null;
    return card(
      noFc ? "channel.ledger_no_fc" : "channel.ledger",
      {
        tone: noFc ? "warning" : "success",
        title: "Ledger channel set",
        description: `Ledger deposits, withdrawals, adjustments and initializations will be posted in ${channel}.${resumes("Posts start")}`,
        fields: [
          noFc && {
            name: "Free Company",
            value:
              "Not linked, so ledger commands stay unavailable. Link one with /config fc link.",
          },
          held,
        ],
        footer,
      },
      options,
    );
  }
  if (field === "officer_notifications_channel_id")
    return card(
      channel ? "channel.notifications" : "channel.notifications_cleared",
      channel
        ? {
            tone: "success",
            title: "Officer notifications channel set",
            description: `Officer alerts will be posted in ${channel}.${resumes("Alerts start")}`,
            fields: [held],
            footer,
          }
        : {
            tone: "success",
            title: "Officer notifications turned off",
            description:
              "Officer alerts raised while no channel is set are skipped, not held. Set a channel again to resume them.",
            fields: [held],
            footer,
          },
      options,
    );
  if (!channel)
    return card(
      "channel.applications_closed",
      {
        tone: "success",
        title: "Guest applications closed",
        description: `/apply now refuses before the form opens: “${GUEST_APPLICATIONS_CLOSED}”`,
        fields: [
          {
            name: "Pending applications",
            value: "Applications already posted stay reviewable in their original channel.",
          },
          {
            name: "Other Guest access",
            value:
              "/guest grant still works, and people with a verified character still receive Guest.",
          },
          held,
        ],
        footer,
      },
      options,
    );
  const privacy: FieldSpec = {
    name: "Keep it private",
    value:
      "Applicants' answers are visible to anyone who can read this channel. Use a staff-only channel.",
  };
  if (guild.guest_role_id === null)
    return card(
      "channel.applications_no_role",
      {
        tone: "warning",
        title: "Review channel set; Guest role still needed",
        description: `${channel} will receive applications, but /apply stays closed until a Guest role is set.`,
        fields: [
          privacy,
          { name: "Next step", value: "Set the Guest role with /config roles guest role:@Guest." },
          held,
        ],
        footer,
      },
      options,
    );
  return card(
    "channel.applications_open",
    {
      tone: "success",
      title: "Guest applications open",
      description: `/apply is open. Each application is posted in ${channel} with Approve and Deny buttons.${resumes("New applications are posted")}`,
      fields: [
        privacy,
        { name: "Guest role", value: mentionRole(guild.guest_role_id), inline: true },
        held,
      ],
      footer,
    },
    options,
  );
}

/**
 * Every /config change that configure() saves: fc link (and its already-linked no-op), the four
 * role bindings and the three channel settings. Repeats that change nothing are the info
 * '= NO CHANGE' card; the rest are routed by field.
 */
export function changeReply(
  result: ConfigChange,
  viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  if (result.status === "unchanged")
    return card(
      "fc.unchanged",
      {
        tone: "info",
        title: "Free Company already linked",
        description: `${marker("unchanged")} FC ${code(result.value)} is already linked to this server.`,
      },
      options,
    );
  const field = result.field;
  if (field === "fc_id") return companyLinkReply(result, viewer, options);
  if (isRole(field)) {
    if (result.rebound) {
      const name = `${ROLE_FIELDS[field].label} role`;
      return unchangedReply(result, name, name, options);
    }
    return roleChangeReply(result, field, viewer, options);
  }
  if (isChannel(field)) {
    if (result.rebound)
      return unchangedReply(
        result,
        CHANNEL_FIELDS[field].label,
        CHANNEL_FIELDS[field].noun,
        options,
      );
    return channelChangeReply(result, field, options);
  }
  // configure() saves only allowlisted fields, so anything else is a presenter/service mismatch.
  throw new Error(`No configuration receipt for field ${field}.`);
}

// ---------------------------------------------------------------------------------------------
// /config officer_rank and role_layout

/**
 * /config officer_rank (spec #30, #31). Setting a rank is success, with a Heads-up (warning tone)
 * when no FC is linked or no Officer role is bound, since the rank can't confer anything until
 * both exist. Clearing is success: officer access comes from manual grants only. Paused, it is the
 * paused-save card.
 */
export function officerRankReply(
  result: OfficerRankResult,
  viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const rank = result.officerRank;
  const mode = result.effectsMode;
  const headsUp = rank
    ? [
        !result.fcLinked && "No FC is linked, so this rank can't match anyone yet.",
        !result.officerRoleId && "No Officer role is bound; bind one with /config roles officer.",
      ].filter((line): line is string => Boolean(line))
    : [];
  const saved = rank
    ? `Members whose linked character holds the in-game rank ${rankText(rank)} get bot officer access and the Officer role, alongside manual grants. /officer revoke still overrides the rank.`
    : "Officer access now comes only from manual grants (/officer grant). People who had the Officer role only through their in-game rank lose it at the next role check.";
  const facts: (FieldSpec | null)[] = rank
    ? [
        { name: "Mode", value: "Rank + manual grants", inline: true },
        { name: "Matching", value: "Exact rank name, ignoring case and spacing", inline: true },
      ]
    : [{ name: "Mode", value: "Manual grants only", inline: true }];
  const warning: FieldSpec | null = headsUp.length
    ? { name: "Heads-up", value: headsUp.join("\n") }
    : null;
  if (paused(mode))
    return heldCard("rank.paused", mode, viewer, saved, [...facts, warning], options);
  return card(
    rank ? (warning ? "rank.heads_up" : "rank.set") : "rank.cleared",
    {
      tone: warning ? "warning" : "success",
      title: rank ? "Officer rank set" : "Officer rank cleared",
      description: saved,
      fields: [...facts, effectsField(mode, "Officer role check", viewer), warning],
      footer: "Audited as config.officer_rank",
    },
    options,
  );
}

/**
 * /config role_layout (spec #33, approved #34, spec #35). Turning it on shows the order and the
 * queued layout pass by its short job ID; paused, it is the paused-save card. Turning it off
 * queues nothing and never reverts earlier changes (approved #34, in every mode). Choosing the
 * current setting is the info no-op.
 */
export function roleLayoutReply(
  result: RoleLayoutResult,
  viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const on = result.roleLayout === "enabled";
  if (result.status === "unchanged")
    return card(
      "layout.unchanged",
      {
        tone: "info",
        title: `Role layout is already ${on ? "on" : "off"}`,
        description: on
          ? `${marker("unchanged")} TaruBot already keeps the managed roles displayed separately, in order.`
          : `${marker("unchanged")} TaruBot already leaves role display and order alone.`,
      },
      options,
    );
  if (!on)
    return card(
      "layout.off",
      {
        tone: "success",
        title: "Role layout turned off",
        description:
          "Current role display and order are left as they are; the bot will no longer change them.",
        fields: [{ name: "Access roles", value: "Still assigned and removed as usual" }],
        footer: "Audited as config.role_layout",
      },
      options,
    );
  const saved =
    "FC Leader > Officer > Member > Guest will be displayed separately in the member list, as one consecutive block.";
  const order: FieldSpec = {
    name: "Order",
    value: result.order.length
      ? result.order.map(mentionRole).join(" > ")
      : "No managed roles are set yet.",
  };
  if (paused(result.effectsMode))
    return heldCard("layout.paused", result.effectsMode, viewer, saved, [order], options);
  return card(
    "layout.on",
    {
      tone: "success",
      title: "Role layout turned on",
      description: saved,
      fields: [
        order,
        effectsField(
          result.effectsMode,
          result.layoutJob ? `job ${code(shortId(result.layoutJob))}` : "",
          viewer,
          "Layout pass",
        ),
      ],
      footer: ["Audited as config.role_layout", "check progress with /sync status"],
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /setup

/** /setup's roles in the service's order, re-sorted into layout order with their labels. */
const SETUP_ROLES = [
  { field: "leader_role_id", label: "FC Leader" },
  { field: "officer_role_id", label: "Officer" },
  { field: "member_role_id", label: "Member" },
  { field: "guest_role_id", label: "Guest" },
] as const;

/** 'created' or 'reused', as the approved card marks each resource. */
const provenance = (created: boolean): string => (created ? "created" : "reused");

/** A list in prose: 'a', 'a and b', 'a, b and c'. */
function prose(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * /setup (approved configuration#37; spec #38). 'Server setup complete' when anything was
 * created, 'Server setup refreshed' when everything was reused. Access roles in layout order with
 * created or reused (and the holders adopted onto the Officer role), the rooms, the FC and its
 * queued roster read, the officer rank, where applications and officer alerts go, the role
 * layout, channel access as approved ('[WAIT] Securing channels · job …'), and next steps (the
 * ledger step only without a ledger channel). Paused, it is the paused-save card, with the rooms
 * in one field so it stays within ten. Check sync status opens /sync status in a new reply.
 */
export function setupReply(
  result: SetupResult,
  viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const roles = SETUP_ROLES.map(({ field, label }) => {
    const role = result.roles.find((candidate) => candidate.field === field);
    if (!role) return null;
    const adopted =
      field === "officer_role_id" && result.adopted > 0
        ? `, ${count(result.adopted, "holder")} adopted as manual grants`
        : "";
    return `${label} ${mentionRole(role.id)} · ${provenance(role.created)}${adopted}`;
  }).filter((line): line is string => line !== null);
  const createdRoles = result.roles.filter((role) => role.created).length;
  const created = [
    createdRoles > 0 && count(createdRoles, "access role"),
    result.lobby.created && "a lobby",
    result.officerChannel.created && "an officer room",
  ].filter((item): item is string => Boolean(item));
  const everything = createdRoles === result.roles.length && created.length === 3;
  const built =
    created.length === 0
      ? "Existing roles and rooms were reused; nothing was duplicated."
      : `TaruBot created ${prose(created)}${everything ? "" : ", and reused the rest"}.`;
  const mode = result.effectsMode;
  const lobby = `${mentionChannel(result.lobby.id)} · ${provenance(result.lobby.created)}`;
  const officerRoom = `${mentionChannel(result.officerChannel.id)} · ${provenance(result.officerChannel.created)}`;
  const steps = [
    "Run /sync status until channel access shows as completed.",
    result.ledgerChannelId === null &&
      "If you use the gil ledger, set a channel with /config ledger.",
    "Run /config validate.",
  ]
    .filter((step): step is string => Boolean(step))
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");
  const settings: FieldSpec[] = [
    {
      name: "Free Company",
      value: result.fcId
        ? `FC ${result.fcId} · roster read queued`
        : "Not linked · /config fc link",
      inline: true,
    },
    {
      name: "Officer rank",
      value: result.officerRank ? userText(result.officerRank) : "Not set · manual grants only",
      inline: true,
    },
    {
      name: "Guest applications",
      value: `Open · reviews in ${mentionChannel(result.guestApplications.id)}`,
      inline: true,
    },
    {
      name: "Officer notifications",
      value: mentionChannel(result.officerNotifications.id),
      inline: true,
    },
    {
      name: "Role layout",
      value: result.roleLayoutEnabled
        ? "On · FC Leader > Officer > Member > Guest, displayed separately"
        : "Off · role display and order are left unchanged. Enable with /config role_layout enabled:true",
    },
  ];
  const nextSteps: FieldSpec = { name: "Next steps", value: steps };
  const accessRoles: FieldSpec = { name: "Access roles", value: roles.join("\n") };
  const buttons = [syncStatusButton()];
  const footer = "Setup is safe to rerun: existing roles and rooms are reused";
  if (paused(mode)) {
    const held = pausedSave(mode, viewer);
    return card(
      "setup.paused",
      {
        tone: held.tone,
        title: held.title,
        description: `${built} ${held.sentence}`,
        fields: [
          ...held.fields,
          accessRoles,
          { name: "Rooms", value: `Lobby ${lobby}\nOfficer room ${officerRoom}` },
          ...settings,
          nextSteps,
        ],
        footer,
        buttons,
      },
      options,
    );
  }
  return card(
    created.length ? "setup.created" : "setup.reused",
    {
      tone: "success",
      title: created.length ? "Server setup complete" : "Server setup refreshed",
      description: `${built} ${
        created.length
          ? "Channel permissions are being secured in the background."
          : "Channel permissions are being re-checked in the background."
      }`,
      fields: [
        accessRoles,
        { name: "Lobby", value: lobby, inline: true },
        { name: "Officer room", value: officerRoom, inline: true },
        ...settings,
        {
          name: "Channel access",
          value: `${CHECK.wait} Securing channels · job ${shortId(result.accessJob)}`,
        },
        nextSteps,
      ],
      footer,
      buttons,
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// /officer grant and revoke

/**
 * /officer grant and revoke (approved configuration#41; spec #42). Both are success. The Discord
 * role line says what is queued, 'Applies if they rejoin' for someone who left, and that nothing
 * applies until an Officer role is bound when none is. Repeating the current state says only the
 * reason was updated. Paused, a queued change is the paused-save card. The reason is the manager's
 * own text, capped at 300 characters.
 */
export function officerOverrideReply(
  result: OfficerOverrideResult,
  viewer: Viewer,
  options: ConfigReplyOptions = {},
): Presented {
  const grant = result.status === "granted";
  const who = mentionUser(result.user);
  const mode = result.effectsMode;
  const recorded = result.effects === "recorded";
  const repeated = result.previous === result.status;
  const memberField: FieldSpec = { name: "Member", value: who, inline: true };
  const reasonField: FieldSpec = { name: "Reason", value: userText(result.reason) };
  const footer = `Audited as officer.${grant ? "grant" : "revoke"}`;
  const work = grant ? "Assignment" : "Removal";
  const lead = grant
    ? `${who} now has bot officer access and will receive the Officer role. This grant doesn't depend on in-game rank and lasts until a server manager runs /officer revoke.`
    : `${who} no longer has bot officer access, and the Officer role will be removed. This revoke also overrides the in-game rank until a server manager runs /officer grant again.`;
  const discordRole = (value: string): FieldSpec => ({ name: "Discord role", value, inline: true });
  if (!recorded && result.present && !repeated && paused(mode))
    return heldCard("officer.paused", mode, viewer, lead, [memberField, reasonField], options);
  let kind: ConfigReplyKind;
  let description: string;
  let role: string;
  if (recorded) {
    // Officer authority needs the bound Officer role, so a recorded override confers nothing yet.
    kind = "officer.recorded";
    description = `The officer ${grant ? "grant" : "revoke"} for ${who} is recorded. No Officer role is set yet, so it takes effect once /config roles officer binds one.`;
    role = "Applies once an Officer role is set";
  } else if (!result.present) {
    kind = "officer.absent";
    description = `${who} isn't in the server now, so this applies if they rejoin. ${
      grant
        ? "This grant doesn't depend on in-game rank."
        : "This revoke also overrides the in-game rank until a server manager runs /officer grant again."
    }`;
    role = "Applies if they rejoin";
  } else if (repeated) {
    kind = "officer.repeated";
    description = grant
      ? `${marker("unchanged")} ${who} already had bot officer access, so only the reason was updated.`
      : `${marker("unchanged")} ${who}'s officer access was already revoked, so only the reason was updated.`;
    role = paused(mode) ? `${work} applies ${whenApplied(mode)}` : `${work} queued`;
  } else {
    kind = grant ? "officer.granted" : "officer.revoked";
    description = lead;
    role = `${work} queued`;
  }
  return card(
    kind,
    {
      tone: "success",
      title: grant ? "Officer access granted" : "Officer access revoked",
      description,
      fields: [memberField, discordRole(role), reasonField],
      footer,
    },
    options,
  );
}
