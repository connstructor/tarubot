/**
 * Synchronization and utility replies: every catalog state follows the house style; the approved
 * cards (guests#36, #43, #44 and #54, with the gen.py overrides and the approved job-line
 * component) are reproduced exactly; /refresh shows officers the mode, cooldown and force hint and
 * everyone the full run ID only where it must be pasted; /sync status keeps job IDs and diagnostics
 * from members, follows the C4 tone table, and splits long officer job lists across fields (C7);
 * /ping and /channel are neutral; and the refresh and sync refusals render as their concepts.
 */
import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import type { EffectsMode, JobView, SyncStatusView } from "../../src/application/results.js";
import { Service } from "../../src/application/service.js";
import { Synchronization } from "../../src/application/synchronization.js";
import { failureReply } from "../../src/discord/presenters/failure.js";
import {
  refreshReply,
  SYNC_REPLY_KINDS,
  syncStatusReply,
} from "../../src/discord/presenters/synchronization.js";
import {
  channelReply,
  pingReply,
  UTILITY_REPLY_KINDS,
} from "../../src/discord/presenters/utility.js";
import { VERSION_REPLY_KINDS } from "../../src/discord/presenters/version.js";
import { DISCORD_LIMITS } from "../../src/discord/presenters/style.js";
import { Failure } from "../../src/domain/values.js";
import {
  buttonsOf,
  expectFailure,
  expectHouseStyle,
  onlyEmbed,
  stress,
  visibleText,
} from "../fixtures/replies.js";
import { catalogTests } from "../fixtures/replies/index.js";
import {
  refreshed,
  RUN_ID,
  SYNC_CASES,
  SYNC_RESULTS as S,
  syncRun,
  UTILITY_CASES,
  VERSION_CASES,
} from "../fixtures/replies/sync-utility.js";
import { ACTORS, at, job, NOW, OFFICER_ID, REF, VIEWERS } from "../fixtures/results.js";

catalogTests("sync", SYNC_CASES);
catalogTests("utility", UTILITY_CASES);
catalogTests("version", VERSION_CASES);

/** The embed a sync case renders. */
const embedOf = (kind: keyof typeof SYNC_CASES) => onlyEmbed(SYNC_CASES[kind].render());
/** A field's value by name, or undefined. */
const fieldOf = (embed: ReturnType<typeof onlyEmbed>, name: string) =>
  embed.fields?.find((field) => field.name === name)?.value;
/** The overview for a viewer. */
const overview = (view: SyncStatusView, audience: "member" | "officer") =>
  syncStatusReply(view, VIEWERS[audience], { run: null, now: NOW });
/** Outstanding work rows as /sync status reads them. */
const work = (overrides: Partial<JobView> = {}) => ({ ...job(overrides), user_id: null });

test("the catalogs cover every sync, utility and version reply kind", () => {
  expect(Object.keys(SYNC_CASES).sort()).toEqual([...SYNC_REPLY_KINDS].sort());
  expect(Object.keys(UTILITY_CASES).sort()).toEqual([...UTILITY_REPLY_KINDS].sort());
  expect(Object.keys(VERSION_CASES).sort()).toEqual([...VERSION_REPLY_KINDS].sort());
});

describe("approved cards are reproduced exactly", () => {
  test("guests#36: a member's refresh from the fresh cached roster", () => {
    expect(embedOf("refresh.cached")).toEqual({
      color: 0xfee75c,
      title: "Refresh requested",
      description: "The FC roster is already fresh, so TaruBot is re-checking roles from it now.",
      fields: [
        { name: "Roster updated", value: "<t:1790161200:R>", inline: true },
        { name: "Track progress", value: `/sync status run_id:${RUN_ID}` },
      ],
      footer: { text: `Run ${RUN_ID}` },
    });
    expect(buttonsOf(SYNC_CASES["refresh.cached"].render())).toEqual([]);
  });

  test("guests#43: a member's refresh waiting on a blocked role update", () => {
    expect(embedOf("status.member_attention")).toEqual({
      color: 0xe67e22,
      title: "Your sync status",
      description:
        "**Your recent refreshes**\n`9d8c7b6a` · <t:1790164800:R> · Waiting on the server: 38 of 40 done",
      fields: [
        {
          // The approved errors-and-style#28 member job line replaces the draft's plain words.
          name: "Your pending work",
          value: "`! BLOCKED` Role update: an officer needs to fix permissions",
        },
      ],
      footer: { text: "Ask an officer if this doesn't clear." },
    });
  });

  test("guests#44: the officer overview, pending with a failed job while a run is in progress", () => {
    const presented = SYNC_CASES["status.officer"].render();
    expect(onlyEmbed(presented)).toEqual({
      color: 0xfee75c,
      title: "Sync status · server",
      description:
        "**Recent runs**\n`9d8c7b6a` · <t:1790164800:R> · Lodestone fetch · In progress · 38/40 done\n`1c2d3e4f` · <t:1790078400:R> · Cached roster · Completed · 212/212 done",
      fields: [
        {
          name: "Outstanding work (5)",
          value: "Queued 3 · Running 1 · Blocked 0 · Paused 0 · Failed 1",
        },
        {
          name: "Next up",
          value: "Role update ×3 · next <t:1790164830:R>\nServer-wide role check ×1 · running",
        },
        {
          // The approved errors-and-style#28 officer job line: raw kind, short ID, attempt.
          name: "Needs attention",
          value: "`✗ FAILED` officer.notify `b2c3d4e5` · attempt 8\n> transient",
        },
      ],
      footer: { text: "Officer view · Up to 10 runs and 25 outstanding jobs" },
      timestamp: NOW.toISOString(),
    });
    expect(buttonsOf(presented)).toEqual([
      {
        type: 2,
        style: 2,
        label: "Full details (JSON)",
        custom_id: "details:sync",
        disabled: false,
      },
    ]);
  });

  test("guests#54: /version with '· ✓ verified' and the marker legend", () => {
    const embed = onlyEmbed(VERSION_CASES["version.commits"].render());
    expect(embed).toMatchObject({
      color: 0x5865f2,
      title: "TaruBot v2.13.0",
      description:
        "Latest 5 commits on [deconfined/tarubot](https://github.com/deconfined/tarubot) · `main`\n\n[Source code](https://github.com/deconfined/tarubot) · [AGPL-3.0-only](https://github.com/deconfined/tarubot/blob/main/LICENSE)",
      footer: { text: "✓ verified = GitHub-verified signature · History cached up to 5 minutes" },
      timestamp: NOW.toISOString(),
    });
    expect(embed.fields?.slice(0, 2)).toEqual([
      {
        name: "Add launch access policy and cutover tooling",
        value:
          "[a1b2c3d](https://github.com/deconfined/tarubot/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678) · ✓ verified",
      },
      {
        name: "Log queue outcomes by severity",
        value:
          "[2dc82b5](https://github.com/deconfined/tarubot/commit/2dc82b5000000000000000000000000000000000) · ✓ verified",
      },
    ]);
  });
});

describe("/refresh", () => {
  test("members see when it starts and the last roster; officers add mode, cooldown and force", () => {
    const acquisition = refreshed({
      cached: false,
      cooldownSeconds: 42,
      lastSuccessfulRosterAt: at(-29_400),
    });
    const member = embedOf("refresh.acquisition");
    expect(member.fields?.map((field) => [field.name, field.value])).toEqual([
      ["Starts", "<t:1790169042:R>"],
      ["Last roster", "<t:1790139600:R>"],
      ["Track progress", `/sync status run_id:${RUN_ID}`],
    ]);
    expect(member.footer?.text).toBe(`Run ${RUN_ID}`);
    const officer = onlyEmbed(refreshReply(acquisition, VIEWERS.officer, { now: NOW }));
    expect(fieldOf(officer, "Mode")).toBe("Lodestone fetch (roster older than 6 hours)");
    expect(fieldOf(officer, "Starts")).toBe("<t:1790169042:R> (cooldown 42 seconds)");
    expect(fieldOf(officer, "Last roster")).toBe("<t:1790139600:f>");
    expect(officer.footer?.text).toBe(`Run ${RUN_ID} · Use force:true to bypass freshness`);
    const cached = onlyEmbed(refreshReply(refreshed(), VIEWERS.officer, { now: NOW }));
    expect(fieldOf(cached, "Mode")).toBe("Cached roster (fresh within 6 hours): reconcile only");
    // A roster never read before is fetched now.
    const first = onlyEmbed(
      refreshReply(refreshed({ cached: false, lastSuccessfulRosterAt: null }), VIEWERS.officer, {
        now: NOW,
      }),
    );
    expect(fieldOf(first, "Mode")).toBe("Lodestone fetch (no roster read yet)");
    expect(fieldOf(first, "Last roster")).toBe("Never");
    expect(fieldOf(first, "Starts")).toBe("Now");
  });

  test("the full run ID appears only in the Track progress line and the footer", () => {
    for (const kind of Object.keys(SYNC_CASES) as (keyof typeof SYNC_CASES)[]) {
      if (!kind.startsWith("refresh.")) continue;
      const embed = embedOf(kind);
      expect(embed.title).not.toContain(RUN_ID);
      expect(embed.description).not.toContain(RUN_ID);
      const carrying = (embed.fields ?? []).filter((field) => field.value.includes(RUN_ID));
      expect(carrying.map((field) => field.name)).toEqual(["Track progress"]);
      expect(embed.footer?.text).toStartWith(`Run ${RUN_ID}`);
    }
  });

  test("while Discord changes are paused, a Role changes field says so", () => {
    const cases: [EffectsMode, string, string][] = [
      ["awaiting_activation", "`‖ PAUSED` until activation", "once this server is activated"],
      [
        "deployment_disabled",
        "`‖ PAUSED` Discord changes are off for this deployment",
        "once Discord changes are turned back on",
      ],
    ];
    for (const [effectsMode, field, when] of cases) {
      const embed = expectHouseStyle(
        refreshReply(refreshed({ effectsMode, forced: true, cached: false }), VIEWERS.member, {
          now: NOW,
        }),
        { tone: "pending" },
      );
      expect(fieldOf(embed, "Role changes")).toBe(field);
      expect(embed.description).toEndWith(`Role changes are applied ${when}.`);
    }
    expect(fieldOf(embedOf("refresh.cached"), "Role changes")).toBeUndefined();
  });
});

describe("/sync status, member views", () => {
  test("the tone follows the member's work: nothing, done, active, paused and attention", () => {
    expect(embedOf("status.member_empty").description).toBe(
      "Nothing is pending for you.\nYou haven't requested a refresh recently.",
    );
    expect(embedOf("status.member_done").description).toStartWith("Everything is up to date.\n\n");
    expect(fieldOf(embedOf("status.member_active"), "Your pending work")).toBe(
      "`… IN PROGRESS` Role update\n`… QUEUED` Character profile refresh",
    );
    expect(embedOf("status.member_paused").description).toContain("· Paused: 38 of 40 done");
    // A failed job is warning for members too.
    const failed = overview(
      {
        runs: [],
        work: [work({ status: "failed", last_error: "invalid_data: Bad" })],
        effectsMode: "live",
      },
      "member",
    );
    expectHouseStyle(failed, { tone: "warning" });
  });

  test("members never see job IDs, diagnostics or a run's full ID", () => {
    for (const kind of Object.keys(SYNC_CASES) as (keyof typeof SYNC_CASES)[]) {
      if (!kind.startsWith("status.member")) continue;
      const text = visibleText(SYNC_CASES[kind].render());
      for (const secret of [
        "1a2b3c4d",
        "Missing Permissions",
        "blocked:",
        RUN_ID,
        "reconcile.user",
      ])
        expect({ kind, secret, shown: text.includes(secret) }).toEqual({
          kind,
          secret,
          shown: false,
        });
    }
  });
});

describe("/sync status, officer views (C4 and C7)", () => {
  test("the overview is pending while work is in progress, warning only when focused on problems", () => {
    const blocked = work({ status: "blocked", last_error: "blocked: Missing Permissions" });
    const failed = work({ id: stress.uuid, status: "failed", last_error: "transient" });
    const cases: [SyncStatusView, string][] = [
      // #44: a failed job while a run is in progress stays pending.
      [S.officer, "pending"],
      // Blocked work while a job is running is still pending.
      [{ runs: [], work: [blocked, work({ status: "running" })], effectsMode: "live" }, "pending"],
      // #45: blocked or failed work with nothing in progress is warning.
      [{ runs: [], work: [blocked, work()], effectsMode: "live" }, "warning"],
      [{ runs: [syncRun({ status: "failed" })], work: [failed], effectsMode: "live" }, "warning"],
      // A DM the recipient refused is no officer problem: nothing to fix or wait for.
      [
        {
          runs: [],
          work: [work({ kind: "guest.dm", status: "failed", last_error: "dm_blocked: Closed" })],
          effectsMode: "live",
        },
        "info",
      ],
      // Paused work alone is pending (#46), and finished runs with nothing left are success.
      [S.officerPaused, "pending"],
      [{ runs: [syncRun({ status: "completed" })], work: [], effectsMode: "live" }, "success"],
      [{ runs: [], work: [], effectsMode: "live" }, "neutral"],
    ];
    for (const [view, tone] of cases)
      expectHouseStyle(overview(view, "officer"), { tone: tone as never });
    expect(fieldOf(embedOf("status.officer_attention"), "Next step")).toBe(
      "Run /config validate, fix what it reports, then /refresh.",
    );
    expect(fieldOf(embedOf("status.officer"), "Next step")).toBeUndefined();
  });

  test("a paused-only server says nothing needs fixing, and counts 25+ when the cap is reached", () => {
    const embed = embedOf("status.officer_paused");
    expect(embed.description).toStartWith("**Role changes are paused.**");
    expect(fieldOf(embed, "Outstanding work (25+)")).toBe(
      "Queued 0 · Running 0 · Blocked 0 · Paused 25 · Failed 0",
    );
    expect(fieldOf(embed, "Next step")).toBe(
      "Nothing to fix. Held work resumes when the server is activated.",
    );
    expect(fieldOf(embed, "Needs attention")).toBeUndefined();
    const deployment = onlyEmbed(
      overview({ ...S.officerPaused, effectsMode: "deployment_disabled" }, "officer"),
    );
    expect(fieldOf(deployment, "Next step")).toBe(
      "Nothing to fix here. Held work resumes when Discord changes are turned back on.",
    );
  });

  test("with effects live, work left paused by an earlier pause is never promised a resume", () => {
    // A restart with effects on requeues held work, so a `disabled` row that is still there while
    // live has nothing coming to resume it: officers see it under Needs attention with the
    // /config step that re-queues it (never "Nothing to fix"), and members aren't told to wait
    // for an activation.
    const leftover = S.officerPaused.work.slice(0, 2);
    const officer = overview({ runs: [], work: leftover, effectsMode: "live" }, "officer");
    const embed = expectHouseStyle(officer, { tone: "pending" });
    const requeue =
      "Paused work is left from an earlier pause; saving any setting with /config re-queues it.";
    expect(fieldOf(embed, "Next step")).toBe(requeue);
    // Other work in progress doesn't hide the step: nothing else will resume these rows.
    const busy = overview(
      { runs: [], work: [...leftover, work({ status: "running" })], effectsMode: "live" },
      "officer",
    );
    expect(fieldOf(onlyEmbed(busy), "Next step")).toBe(requeue);
    expect(fieldOf(embed, "Needs attention")).toStartWith("`‖ PAUSED` reconcile.user");
    expect(visibleText(officer)).not.toContain("Held work resumes");
    const member = overview(
      {
        runs: [],
        work: [work({ status: "disabled" })],
        effectsMode: "live",
      },
      "member",
    );
    expect(fieldOf(onlyEmbed(member), "Your pending work")).toBe(
      "`‖ PAUSED` Role update: held from an earlier pause, so ask an officer",
    );
    expect(visibleText(member)).not.toMatch(/activat/u);
  });

  test("25 jobs with maximal diagnostics split Needs attention across fields within limits", () => {
    const view: SyncStatusView = {
      runs: Array.from({ length: 10 }, (_, index) =>
        syncRun({
          id: `${index.toString(16)}${stress.uuid.slice(1)}`,
          status: "failed",
          work_total: 2_147_483_647,
          work_completed: 2_147_483_646,
          work_blocked: 1_000_000,
          work_failed: 1_000_000,
        }),
      ),
      work: stress.jobs(25).map((row) => ({ ...row, user_id: stress.id })),
      effectsMode: "live",
    };
    const presented = overview(view, "officer");
    const embed = expectHouseStyle(presented, { tone: "warning" });
    const parts = (embed.fields ?? []).filter((field) => field.name.startsWith("Needs attention"));
    expect(parts.length).toBeGreaterThan(1);
    for (const [index, field] of parts.entries())
      expect(field.name).toBe(`Needs attention (${index + 1}/${parts.length})`);
    const lines = parts
      .flatMap((field) => field.value.split("\n"))
      .filter((line) => line.startsWith("`"));
    // All 25 rows need attention: ten officer lines, then how many more there are.
    expect(lines).toHaveLength(10);
    expect(parts.at(-1)?.value).toEndWith("…and 15 more");
    for (const field of parts)
      expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue);
    // The member view of the same work stays within limits too.
    expectHouseStyle(overview(view, "member"), { tone: "warning" });
  });

  test("run detail names no ID in its title; officers add the requester, acquisition and details", () => {
    const member = embedOf("run.detail");
    expect(member.title).toBe("Sync run · completed");
    expect(member.footer?.text).toBe(`Run ${RUN_ID}`);
    expect(fieldOf(member, "Roster")).toBe("187 members read (4 pages)");
    expect(fieldOf(member, "Acquisition")).toBeUndefined();
    const officerView = syncStatusReply(
      {
        ...S.run,
        runs: [
          syncRun({
            status: "failed",
            acquisition_status: "failed",
            last_error: "incomplete: Roster pages contain duplicate IDs.",
          }),
        ],
      },
      VIEWERS.officer,
      { run: RUN_ID.toUpperCase(), now: NOW },
    );
    const officer = expectHouseStyle(officerView, {
      tone: "warning",
      title: "Sync run · did not finish",
    });
    expect(fieldOf(officer, "Requested")).toBe(`<t:1790164800:R> by <@${OFFICER_ID}>`);
    expect(fieldOf(officer, "Acquisition")).toBe(
      "`✗ FAILED` roster\n> incomplete: Roster pages contain duplicate IDs.",
    );
    expect(buttonsOf(officerView)).toMatchObject([
      { label: "Full details (JSON)", custom_id: `details:sync:${RUN_ID}` },
    ]);
    const states: [SyncStatusView["runs"][number]["status"], EffectsMode, string, string][] = [
      ["queued", "live", "pending", "Sync run · in progress"],
      ["blocked", "live", "warning", "Sync run · waiting on the server"],
      ["blocked", "awaiting_activation", "pending", "Sync run · paused"],
    ];
    for (const [status, effectsMode, tone, title] of states)
      expectHouseStyle(
        syncStatusReply({ runs: [syncRun({ status })], work: [], effectsMode }, VIEWERS.member, {
          run: RUN_ID,
          now: NOW,
        }),
        { tone: tone as never, title },
      );
  });

  test("a missing run reads the same as someone else's", () => {
    expect(embedOf("run.missing").footer?.text).toBe("Members can see only runs they requested");
    const officer = onlyEmbed(
      syncStatusReply(S.memberEmpty, VIEWERS.officer, { run: RUN_ID, now: NOW }),
    );
    expect(officer.title).toBe("No matching run");
    expect(officer.footer).toBeUndefined();
  });

  test("details custom IDs stay within Discord's 100 characters at maximum inputs", () => {
    const presented = syncStatusReply(
      { runs: [syncRun({ id: stress.uuid })], work: [], effectsMode: "live" },
      VIEWERS.officer,
      { run: stress.uuid, now: NOW },
    );
    for (const button of buttonsOf(presented))
      if ("custom_id" in button)
        expect(button.custom_id.length).toBeLessThanOrEqual(DISCORD_LIMITS.customId);
  });
});

describe("/ping and /channel", () => {
  test("/ping is neutral whether or not the latency is measured", () => {
    expect(onlyEmbed(pingReply(1_204)).description).toBe("Discord gateway latency: **1,204 ms**");
    expectHouseStyle(pingReply(null), { tone: "neutral", title: "Pong" });
  });

  test("/channel humanizes channel types and escapes and caps names", () => {
    const cases: [ChannelType, string][] = [
      [ChannelType.GuildText, "Text channel"],
      [ChannelType.GuildAnnouncement, "Announcement channel"],
      [ChannelType.GuildVoice, "Voice channel (text chat)"],
      [ChannelType.GuildStageVoice, "Stage channel"],
      [ChannelType.PublicThread, "Public thread"],
      [ChannelType.PrivateThread, "Private thread"],
      [ChannelType.AnnouncementThread, "Announcement thread"],
      [ChannelType.GuildForum, "Forum"],
      [ChannelType.GuildMedia, "Media channel"],
      [ChannelType.GuildCategory, "GuildCategory"],
    ];
    for (const [type, words] of cases) {
      const embed = onlyEmbed(channelReply({ id: "678901234567890123", name: "general", type }));
      expect(fieldOf(embed, "Type")).toBe(words);
    }
    const hostile = expectHouseStyle(
      channelReply({ id: stress.id, name: stress.text(200), type: ChannelType.PublicThread }),
      { tone: "neutral" },
    );
    expect(fieldOf(hostile, "Name")?.length).toBeLessThanOrEqual(100);
    expect(fieldOf(hostile, "Name")).not.toMatch(/(?<!\\)<@/u);
    expect(fieldOf(hostile, "ID")).toBe(`\`${stress.id}\``);
  });
});

describe("refresh and sync failures render as their approved concepts", () => {
  test("/refresh force:true by a member is 'Officers only', before any read", async () => {
    const app: unknown = Object.create(Service.prototype);
    if (!(app instanceof Service)) throw new Error("Invalid application fixture");
    const error = await new Synchronization(app)
      .refresh(ACTORS.member, true)
      .catch((caught: unknown) => caught);
    expectFailure(failureReply(error, { ref: REF, viewer: VIEWERS.member, scope: "/refresh" }), {
      code: "forbidden",
      ref: REF,
      tone: "error",
      title: "Officers only",
    });
  });

  test("/refresh with no FC is the setup family for each audience", () => {
    const noFc = new Failure(
      "setup",
      "There's no FC roster to refresh until an officer links the Free Company.",
      0,
      { kind: "setup", missing: "fc" },
    );
    expectFailure(failureReply(noFc, { ref: REF, viewer: VIEWERS.member, scope: "/refresh" }), {
      code: "setup",
      ref: REF,
      tone: "info",
      title: "No Free Company linked",
    });
    expectFailure(failureReply(noFc, { ref: REF, viewer: VIEWERS.officer, scope: "/refresh" }), {
      code: "setup",
      ref: REF,
      tone: "warning",
      title: "Finish setup first",
    });
  });
});
