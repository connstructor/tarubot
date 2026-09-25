/**
 * The officer status post (2.27.0, issue #31; owner decisions of 2026-09-25), which the gateway
 * renders for the officer.status job: one embed in the officer notifications channel naming every
 * member of one frozen batch, grouped by what changed and why, then the linked characters that left
 * the FC. Mentions only, with character names on departure lines (decision 6); officers' own
 * changes read like automatic ones, with no "by @officer" (decision 2). Pure.
 *
 * Budget: each group packs into fields of at most 1,024 characters, named 'Group (1/3)' when it
 * spans several, and a post fits when it has at most nine fields and 5,800 characters (statusFits).
 * The freeze sizes every batch with statusFits, the same layout this renders, so everyone in a post
 * is named and nothing is cut. The last "Not listed" field is only a defensive guard for one member
 * whose own lines exceed the budget (dozens of departures at once), with an exact count.
 *
 * The post renders only from the frozen entries and their freeze time, so a resend of the same
 * batch is byte-identical and Discord's nonce check returns the first message.
 */
import type { StatusPostView } from "../../application/records.js";
import { type AccessLevel, levelOf, type ReasonCode } from "../../domain/status.js";
import { andMore, characterName, count, mentionUser, splitFields, title } from "./format.js";
import { type FieldSpec, post, type Presented } from "./reply.js";
import { DISCORD_LIMITS, HOUSE_LIMITS } from "./style.js";

/**
 * Every status post kind, with whether its embed carries a timestamp: the batch's freeze time,
 * stored with it, so every resend shows the same one.
 */
const POST_TIMESTAMP = {
  "status.changes": true,
} as const satisfies Record<string, boolean>;

/** A status post state; tests catalogue one case per kind. */
export type StatusPostKind = keyof typeof POST_TIMESTAMP;

/** Every status post kind, for catalog completeness checks. */
export const STATUS_POST_KINDS = Object.keys(POST_TIMESTAMP) as readonly StatusPostKind[];

/** The post's title. */
const TITLE = "Member status changes";
/** Fields a fitting post may use: one fewer than the house limit leaves room for "Not listed". */
const FIELD_BUDGET = HOUSE_LIMITS.fields - 1;
/** Characters a fitting post may use, below Discord's 6,000, leaving room for "Not listed". */
const TOTAL_BUDGET = 5_800;
/** What the defensive "Not listed" field may add: its name and '…and N more'. */
const NOT_LISTED_RESERVE = 64;

/** Access levels as officers read them. */
const LEVEL: Readonly<Record<AccessLevel, string>> = {
  none: "No access",
  guest: "Guest",
  member: "Member",
};

/** Each reason's words (the plan's §7 table). */
export const STATUS_REASON_TEXT: Readonly<Record<ReasonCode, string>> = {
  in_fc: "a linked character is in the FC",
  not_in_fc: "no linked character is in the FC",
  no_fc: "the server has no linked FC",
  guest_grant: "guest grant",
  former_member: "former FC member",
  registered: "registered character",
  // Normally shown through the Member change it belongs to; its own words if it stands alone.
  is_member: "a linked character is in the FC",
  guest_revoked: "guest access revoked",
  no_guest_basis: "no grant, registration or FC history",
  officer_override: "officer override",
  officer_rank: "FC officer rank",
  officer_revoked: "officer access revoked",
  officer_rank_unset: "the server has no officer rank set",
  no_officer_rank: "no linked character holds the officer rank",
  fc_leader: "FC leader",
  no_fc_leader: "no linked character leads the FC",
};

/** A group heading with the reason's words, when there is a reason. */
const heading = (change: string, reason: ReasonCode | undefined): string =>
  title(change, reason && STATUS_REASON_TEXT[reason]);

/** Plain string order, the same wherever the post is rendered. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One group of lines under one heading, joined by its separator. */
interface Group {
  readonly name: string;
  readonly items: readonly string[];
  readonly separator: string;
}

/** A rank group: added or removed, and its mentions. */
interface RankGroup {
  readonly name: string;
  readonly added: boolean;
  readonly items: string[];
}

/**
 * The post's groups in their fixed order: access transitions (largest first, then by text), then
 * Officer and FC Leader added before removed (each largest first, then by text), then "Left the FC".
 * An access transition goes from the announced level to the posted one; its reason is the Member
 * flag's when Member changed, otherwise the Guest flag's.
 */
function groups(view: StatusPostView): Group[] {
  const access = new Map<string, string[]>();
  const ranks = { officer: new Map<string, RankGroup>(), leader: new Map<string, RankGroup>() };
  const left: string[] = [];
  for (const entry of view.entries) {
    const mention = mentionUser(entry.user);
    const from = levelOf(entry.from);
    const to = levelOf(entry.to);
    if (from !== to) {
      const reason =
        entry.from.member !== entry.to.member ? entry.reasons.member : entry.reasons.guest;
      const name = heading(`${LEVEL[from]} → ${LEVEL[to]}`, reason);
      access.set(name, [...(access.get(name) ?? []), mention]);
    }
    for (const [flag, label] of [
      ["officer", "Officer"],
      ["leader", "FC Leader"],
    ] as const) {
      if (entry.from[flag] === entry.to[flag]) continue;
      const added = entry.to[flag] === true;
      const name = heading(`${label} ${added ? "added" : "removed"}`, entry.reasons[flag]);
      const group = ranks[flag].get(name) ?? { name, added, items: [] };
      group.items.push(mention);
      ranks[flag].set(name, group);
    }
    for (const departure of entry.departed) left.push(`${characterName(departure)} (${mention})`);
  }
  const bySize = (a: { name: string; items: readonly string[] }, b: typeof a) =>
    b.items.length - a.items.length || byText(a.name, b.name);
  const rankOrder = (map: Map<string, RankGroup>): Group[] =>
    [...map.values()]
      .sort((a, b) => Number(b.added) - Number(a.added) || bySize(a, b))
      .map((group) => ({ name: group.name, items: group.items, separator: ", " }));
  return [
    ...[...access.entries()]
      .map(([name, items]) => ({ name, items }))
      .sort(bySize)
      .map((group) => ({ ...group, separator: ", " })),
    ...rankOrder(ranks.officer),
    ...rankOrder(ranks.leader),
    ...(left.length ? [{ name: "Left the FC", items: left, separator: "\n" }] : []),
  ];
}

/** One packed field and how many lines (mentions or departures) it holds. */
export interface StatusField {
  readonly field: FieldSpec;
  readonly items: number;
}

/** The post's fields in order, each group packed within a field value, and its footer. */
export function statusLayout(view: StatusPostView): {
  readonly fields: readonly StatusField[];
  readonly footer: string;
} {
  const fields = groups(view).flatMap((group) =>
    splitFields(group.name, group.items, DISCORD_LIMITS.fieldValue, group.separator).map(
      (field) => ({ field, items: field.value.split(group.separator).length }),
    ),
  );
  return { fields, footer: count(view.entries.length, "member") };
}

/** The characters a layout counts toward Discord's embed total: title, fields and footer. */
const size = (fields: readonly StatusField[], footer: string): number =>
  TITLE.length +
  footer.length +
  fields.reduce((sum, { field }) => sum + field.name.length + field.value.length, 0);

/**
 * Whether a batch fits one post with every member named: at most nine fields and 5,800
 * characters. The freeze adds members while this holds, up to 100.
 */
export function statusFits(view: StatusPostView): boolean {
  const { fields, footer } = statusLayout(view);
  return fields.length <= FIELD_BUDGET && size(fields, footer) <= TOTAL_BUDGET;
}

/**
 * 'Member status changes', info tone, timestamped with the batch's freeze time, footer 'N members'.
 * A batch that doesn't fit (only one member alone over the budget) keeps the fields that fit and
 * counts the lines left out in a last 'Not listed' field, so the builder never cuts anything.
 */
export function statusPost(view: StatusPostView): Presented {
  const { fields, footer } = statusLayout(view);
  let shown = fields.map(({ field }) => field);
  if (fields.length > FIELD_BUDGET || size(fields, footer) > TOTAL_BUDGET) {
    shown = [];
    let used = TITLE.length + footer.length + NOT_LISTED_RESERVE;
    let hidden = 0;
    for (const { field, items } of fields) {
      const length = field.name.length + field.value.length;
      // Once one field is left out, every later one is too, so the shown fields stay in order.
      if (!hidden && shown.length < FIELD_BUDGET && used + length <= TOTAL_BUDGET) {
        shown.push(field);
        used += length;
      } else hidden += items;
    }
    shown.push({ name: "Not listed", value: andMore(hidden) });
  }
  return post({
    tone: "info",
    title: TITLE,
    fields: shown,
    footer,
    // POST_TIMESTAMP: the batch's freeze time.
    timestamp: new Date(view.frozenAt),
  });
}
