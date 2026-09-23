/**
 * Cross-catalog consistency: one title and tone per (concept, audience) however a concept is
 * reached, the approved titles pinned per concept, the ' · ' section separator, and footer
 * vocabulary. Group workstreams add their catalogs to CATALOGS and their pins here.
 */
import { describe, expect, test } from "bun:test";
import type { Tone } from "../../src/discord/presenters/style.js";
import { onlyEmbed } from "../fixtures/replies.js";
import { CATALOGS, type ReplyCase } from "../fixtures/replies/index.js";

/** Every case of every catalog, with its catalog and kind for failure messages. */
const CASES: readonly (ReplyCase & { readonly key: string })[] = Object.entries(CATALOGS).flatMap(
  ([group, catalog]) =>
    Object.entries<ReplyCase>(catalog).map(([kind, reply]) => ({
      ...reply,
      key: `${group}/${kind}`,
    })),
);

/** An approved title and tone per audience group: members (and no viewer) or officers. */
interface Pin {
  readonly member: readonly [Tone, string];
  readonly officer?: readonly [Tone, string];
}

/**
 * The approved presentation of each failure concept (errors-and-style board and the resolved
 * inconsistencies). Officers and managers share the officer pin; replies before the actor is
 * known share the member pin.
 */
const FAILURE_PINS: Readonly<Record<string, Pin>> = {
  input: { member: ["warning", "Check your input"] },
  "forbidden.officer": { member: ["error", "Officers only"] },
  "forbidden.owner": { member: ["error", "Only your own records"] },
  "forbidden.manager": { member: ["error", "Server managers only"] },
  "forbidden.membership": { member: ["warning", "FC membership needed"] },
  "forbidden.context": { member: ["error", "Not available here"] },
  "setup.guild": {
    member: ["info", "TaruBot isn't set up here yet"],
    officer: ["warning", "Finish setup first"],
  },
  "setup.fc": {
    member: ["info", "No Free Company linked"],
    officer: ["warning", "Finish setup first"],
  },
  "setup.ledger": {
    member: ["info", "Ledger isn't set up"],
    officer: ["warning", "Finish setup first"],
  },
  "setup.guest_applications": { member: ["info", "Guest applications are closed"] },
  "not_found.character": { member: ["warning", "Character not found"] },
  "not_found.freecompany": { member: ["warning", "Free Company not found"] },
  "ambiguous.character": { member: ["warning", "Several characters match"] },
  ownership_conflict: { member: ["error", "Linked to another member"] },
  insufficient_funds: { member: ["warning", "Not enough recorded gil"] },
  initialized: { member: ["warning", "Opening balance already set"] },
  uninitialized: { member: ["warning", "Opening balance not set"] },
  "stale.settings": { member: ["warning", "Settings changed — try again"] },
  "stale.control": { member: ["warning", "This control is out of date"] },
  "stale.form": { member: ["warning", "Please reopen /apply"] },
  // The guest failures WS7 pins: an obsolete review message, a missing application and the
  // reapply cooldown keep one presentation from the command, the buttons and the form.
  "stale.review": { member: ["warning", "This review message is out of date"] },
  "not_found.application": { member: ["warning", "Application not found"] },
  "wait.apply": { member: ["pending", "You can apply again later"] },
  pending_proof: { member: ["pending", "Token not on the Lodestone yet"] },
  "wait.claims_own": { member: ["pending", "Too many unfinished claims"] },
  "wait.retry": { member: ["pending", "Please wait a moment"] },
  eligible: { member: ["info", "No application needed"] },
  "upstream.lodestone": { member: ["warning", "The Lodestone isn't responding"] },
  blocked: {
    member: ["warning", "Server setup issue"],
    officer: ["warning", "Discord permissions need attention"],
  },
  // C4 tone table: a paused refusal is pending like every paused state. The rows for change
  // results, the officer sync overview and no-op results are pinned below.
  paused: { member: ["pending", "Discord changes paused"] },
  unexpected: { member: ["error", "Something went wrong"] },
};

/**
 * The C4 tone table's rows for results, pinned as groups migrate:
 * - a change saved while Discord effects are paused is the approved errors-and-style#26 card in
 *   every group;
 * - the officer sync overview is pending while work is in progress, even with a failed job
 *   (approved guests#44), warning only when focused on blocked or failed work with nothing in
 *   progress (#45), and pending when only paused work remains (#46).
 */
const RESULT_PINS: Readonly<Record<string, readonly [Tone, string]>> = {
  paused_save: ["pending", "Saved, Discord changes paused"],
  sync_overview_active: ["pending", "Sync status · server"],
  sync_overview_focused: ["warning", "Sync status · server"],
  sync_overview_paused: ["pending", "Sync status · server"],
};

/** No-op results are info (C4), except these approved neutral cards. */
const NEUTRAL_NO_OPS: ReadonlySet<string> = new Set([
  "No correction needed",
  "Nickname sync already off",
]);

/** Officers and managers read the officer pin; members and pre-actor replies the member pin. */
const officerAudience = (reply: ReplyCase): boolean =>
  reply.audience === "officer" || reply.audience === "manager";

describe("one presentation per concept", () => {
  test("each (concept, audience) has one title and one tone across every command", () => {
    const seen = new Map<string, { title: string; tone: Tone; key: string }>();
    for (const reply of CASES) {
      if (!reply.concept) continue;
      const id = `${reply.concept} · ${reply.audience}`;
      const first = seen.get(id);
      if (!first) seen.set(id, { title: reply.title, tone: reply.tone, key: reply.key });
      else
        expect({ id, title: reply.title, tone: reply.tone }).toEqual({
          id,
          title: first.title,
          tone: first.tone,
        });
    }
  });

  test("the approved failure concepts keep their pinned titles and tones", () => {
    for (const reply of CASES) {
      const pin = reply.concept ? FAILURE_PINS[reply.concept] : undefined;
      if (!pin) continue;
      const [tone, title] = officerAudience(reply) ? (pin.officer ?? pin.member) : pin.member;
      const embed = onlyEmbed(reply.render());
      expect({ key: reply.key, title: embed.title, tone: reply.tone }).toEqual({
        key: reply.key,
        title,
        tone,
      });
    }
  });

  test("'Discord permissions need attention' is only the officer view of code blocked", () => {
    for (const reply of CASES) {
      const embed = onlyEmbed(reply.render());
      if (embed.title !== "Discord permissions need attention") continue;
      expect({ key: reply.key, officer: officerAudience(reply) }).toEqual({
        key: reply.key,
        officer: true,
      });
      expect(embed.footer?.text).toStartWith("Code blocked · ");
    }
  });

  test("change results keep the C4 tone table's pinned title and tone", () => {
    for (const reply of CASES) {
      const pin = reply.concept ? RESULT_PINS[reply.concept] : undefined;
      if (!pin) continue;
      const embed = onlyEmbed(reply.render());
      expect({ key: reply.key, title: embed.title, tone: reply.tone }).toEqual({
        key: reply.key,
        title: pin[1],
        tone: pin[0],
      });
    }
    // Every pinned row is exercised by at least one catalog case.
    const concepts = new Set(CASES.map((reply) => reply.concept));
    for (const concept of Object.keys(RESULT_PINS)) expect(concepts).toContain(concept);
  });

  test("no-op results are info, except the approved neutral cards", () => {
    const noOps = CASES.filter((reply) => reply.noOp);
    expect(noOps.length).toBeGreaterThan(0);
    for (const reply of noOps)
      expect({ key: reply.key, tone: reply.tone }).toEqual({
        key: reply.key,
        tone: NEUTRAL_NO_OPS.has(reply.title) ? "neutral" : "info",
      });
  });

  test("every pinned failure concept is present in the catalogs", () => {
    const concepts = new Set(CASES.map((reply) => reply.concept));
    for (const concept of Object.keys(FAILURE_PINS)) expect(concepts).toContain(concept);
  });
});

describe("titles and footers", () => {
  test("titles are sentence-like, use ' · ' between sections and never ': '", () => {
    for (const reply of CASES) {
      const title = onlyEmbed(reply.render()).title ?? "";
      expect({ key: reply.key, colon: title.includes(": "), period: /\.$/u.test(title) }).toEqual({
        key: reply.key,
        colon: false,
        period: false,
      });
      expect(title.length).toBeLessThanOrEqual(60);
    }
  });

  test("failure footers are exactly 'Code <code> · Ref <interaction ID>'", () => {
    for (const reply of CASES) {
      const footer = onlyEmbed(reply.render()).footer?.text ?? "";
      expect(footer).not.toMatch(/\b(?:Operation|Reference)\b/u);
      if (reply.key.startsWith("failures/"))
        expect(footer).toMatch(/^Code [a-z_]+ · Ref \d{17,20}$/u);
    }
  });

  test("success replies never say nothing changed, except read-only health checks", () => {
    for (const reply of CASES) {
      if (reply.tone !== "success") continue;
      // /config validate and Re-check are read-only, so their approved cards say so (C2).
      if (reply.spec && /^configuration#[789]$/u.test(reply.spec)) continue;
      expect({
        key: reply.key,
        said: onlyEmbed(reply.render()).description?.includes("Nothing was changed.") ?? false,
      }).toEqual({
        key: reply.key,
        said: false,
      });
    }
  });
});
