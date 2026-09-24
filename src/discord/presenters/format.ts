/**
 * Text, number, time, mention, link and list helpers for presenters. Pure functions: every piece
 * of user-written text passes through plain(), quote(), titleText() or footerText(), chosen by
 * where Discord renders it, and every limit is measured in UTF-16 code units (what discord.js
 * validates) on grapheme boundaries.
 */
import { escapeMarkdown, time } from "discord.js";
import type { ApplicationCommandOptionChoiceData, TimestampStylesString } from "discord.js";
import type { CharacterRef, FcRef } from "../../application/results.js";
import { isOfficer, type Viewer } from "./audience.js";
// Type-only: reply.ts imports these helpers at runtime, and this erased import avoids a cycle.
import type { FieldSpec } from "./reply.js";
import { DISCORD_LIMITS, HOUSE_LIMITS, SEPARATOR } from "./style.js";

/** Appended wherever text was cut, so a reader can tell it continues. */
const ELLIPSIS = "…";
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

// ---------------------------------------------------------------------------------------------
// Text

/**
 * Cut to at most `max` UTF-16 units without splitting a grapheme (ZWJ emoji, flags, combining
 * marks), ending with '…' when anything was removed. The result is always well-formed Unicode.
 */
export function cut(value: string, max: number): string {
  if (!Number.isInteger(max) || max < 0)
    throw new RangeError("cut() needs a non-negative integer limit.");
  const whole = value.toWellFormed();
  if (whole.length <= max) return whole;
  if (max < ELLIPSIS.length) return "";
  const room = max - ELLIPSIS.length;
  let kept = "";
  for (const { segment } of graphemes.segment(whole)) {
    if (kept.length + segment.length > room) break;
    kept += segment;
  }
  return `${kept.trimEnd()}${ELLIPSIS}`;
}

/**
 * Cut markdown-escaped text. A cut between a backslash and the character it escapes would leave
 * the backslash escaping nothing (Discord then shows it), so a dangling one is dropped.
 */
export function cutMarkdown(value: string, max: number): string {
  if (value.length <= max) return value.toWellFormed();
  const result = cut(value, max);
  const body = result.slice(0, -ELLIPSIS.length);
  const slashes = /\\*$/u.exec(body)?.[0].length ?? 0;
  return slashes % 2 === 1 ? `${body.slice(0, -1)}${ELLIPSIS}` : result;
}

/** One line of text: every whitespace run, including newlines, becomes a single space. */
const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

/**
 * Escape one line of user text for a description or field value. discord.js escapes inline
 * markdown, and the options it leaves off by default cover headings, lists and masked links. A
 * '<' that could start a mention, channel, timestamp, command or emoji (<@, <#, <t:, </, <:) is
 * backslash-escaped so user text can never render one, and a leading quote or subtext marker is
 * escaped too.
 */
function escapeLine(line: string): string {
  return escapeMarkdown(line, {
    heading: true,
    bulletedList: true,
    numberedList: true,
    maskedLink: true,
  })
    .replace(/<(?=[@#/:]|[a-z]+:)/giu, "\\<")
    .replace(/^(\s*)(>|-#)/u, "$1\\$2");
}

/**
 * User text for descriptions and field values: collapsed to one line, escaped, and cut to `max`
 * units of rendered source (escapes included), so it always fits where it is placed.
 */
export function plain(text: string, max: number = DISCORD_LIMITS.fieldValue): string {
  return cutMarkdown(escapeLine(collapse(text)), max);
}

/** User text as a block quote: each non-empty line escaped and prefixed '> ', within `max`. */
export function quote(text: string, max: number = DISCORD_LIMITS.fieldValue): string {
  const lines = text
    .split(/\r\n|\r|\n/u)
    .map((line) => escapeLine(collapse(line)))
    .filter((line) => line !== "");
  return cutMarkdown(lines.map((line) => `> ${line}`).join("\n"), max);
}

/**
 * Text for an embed title. Titles render inline markdown but no headings, lists, links, mentions
 * or timestamps, so only inline markdown is escaped (anything more would show stray backslashes).
 */
export function titleText(text: string, max: number = DISCORD_LIMITS.title): string {
  return cutMarkdown(escapeMarkdown(collapse(text)), max);
}

/** Text for a footer, which renders no markdown at all: collapsed and cut, never escaped. */
export function footerText(text: string, max: number = DISCORD_LIMITS.footer): string {
  return cut(collapse(text), max);
}

/** Title sections joined by the house separator: title('Sync status', 'server'). */
export function title(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(SEPARATOR);
}

/** Where a name is rendered, which decides how it is escaped. */
export type TextContext = "text" | "title" | "footer";

/** Escape raw text for the place it is rendered, within `max` units. */
function forContext(raw: string, where: TextContext, max: number): string {
  if (where === "title") return titleText(raw, max);
  if (where === "footer") return footerText(raw, max);
  return plain(raw, max);
}

// ---------------------------------------------------------------------------------------------
// Numbers

/** en-US digit grouping for exact bigints and counts; never routed through Number(). */
const grouping = new Intl.NumberFormat("en-US");
/** U+2212, the approved sign for negative gil (never an ASCII hyphen). */
const MINUS = "−";

/** Exact, grouped gil with its unit: '10,005,000 gil'. */
export function gilText(value: bigint): string {
  return value < 0n ? `${MINUS}${grouping.format(-value)} gil` : `${grouping.format(value)} gil`;
}

/** A signed change: '+10,005,000 gil' or '−2,500,000 gil'; zero carries no sign. */
export function signedGilText(delta: bigint): string {
  if (delta > 0n) return `+${gilText(delta)}`;
  return gilText(delta);
}

/** A grouped count with its noun: '1 member', '1,204 members'. */
export function count(n: number | bigint, singular: string, plural = `${singular}s`): string {
  return `${grouping.format(n)} ${n === 1 || n === 1n ? singular : plural}`;
}

/**
 * A configured interval in the largest whole unit that states it exactly, for copy such as 'may
 * reapply after 24 hours' or 'roster older than 6 hours': hours, then minutes, then seconds.
 */
export function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole >= 3_600 && whole % 3_600 === 0) return count(whole / 3_600, "hour");
  if (whole >= 60 && whole % 60 === 0) return count(whole / 60, "minute");
  return count(whole, "second");
}

// ---------------------------------------------------------------------------------------------
// Times

/** A Discord timestamp, floored to whole seconds: <t:unix:style>. Record times default to f. */
export function when(date: Date, style: TimestampStylesString = "f"): string {
  return time(date, style);
}

/** A deadline shown both relative and absolute, as approved: '<t:…:R> (<t:…:t>)'. */
export function deadline(date: Date): string {
  return `${when(date, "R")} (${when(date, "t")})`;
}

/**
 * When a time-bound refusal lifts, from its retryAfter seconds and an injected now: 'shortly' at
 * zero, 'in a few seconds' under five, otherwise relative plus absolute time.
 */
export function retryWhen(seconds: number, now: Date): string {
  if (!(seconds > 0)) return "shortly";
  if (seconds < 5) return "in a few seconds";
  const at = new Date(now.getTime() + Math.ceil(seconds) * 1_000);
  return `${when(at, "R")} (${when(at, "T")})`;
}

// ---------------------------------------------------------------------------------------------
// Mentions, codes and links

/** Decimal Discord and Lodestone IDs: no leading zero, sign or whitespace. */
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;

/** Mentions and URLs are built only from IDs; anything else is a presenter bug. */
function decimalId(value: string): string {
  if (!DECIMAL_ID.test(value)) throw new Error("A mention or profile link needs a decimal ID.");
  return value;
}

/** A user mention. Embeds never ping, and replies also send allowedMentions {parse: []}. */
export const mentionUser = (id: string): string => `<@${decimalId(id)}>`;
/** A role mention; it shows the role's name. */
export const mentionRole = (id: string): string => `<@&${decimalId(id)}>`;
/** A channel mention; it shows the channel's name. */
export const mentionChannel = (id: string): string => `<#${decimalId(id)}>`;

/** A complete channel, role or user mention that plain() escaped, by its decimal ID. */
const ESCAPED_MENTION = /\\<(#|@&|@)([1-9][0-9]{16,19})>/gu;

/**
 * Restore the complete mentions plain() escaped in trusted, bot-authored text: job diagnostics
 * and Failure messages that name a role, channel or member by ID. They render as names and never
 * ping (replies send allowedMentions {parse: []}). User-written text must never pass through here.
 */
export const restoreMentions = (escaped: string): string =>
  escaped.replace(ESCAPED_MENTION, "<$1$2>");

/**
 * Inline code for a trusted token (an ID, a command, a marker). Backticks and line breaks can't
 * be represented inside a code span, so they are a presenter bug rather than something to escape.
 */
export function code(value: string): string {
  if (!value || /[`\r\n]/u.test(value))
    throw new Error("Inline code needs one line of text without backticks.");
  return `\`${value}\``;
}

/**
 * A member for this viewer. Officers also see the raw ID in code, because a departed user's
 * mention renders as unknown: '<@id> (`id`)', or stacked on two lines for narrow inline fields.
 */
export function member(id: string, viewer: Viewer, layout: "text" | "stacked" = "text"): string {
  if (!isOfficer(viewer)) return mentionUser(id);
  return layout === "stacked"
    ? `${mentionUser(id)}\n${code(id)}`
    : `${mentionUser(id)} (${code(id)})`;
}

/**
 * A command as copyable inline code: cmd('ledger adjust', {balance: 10005000n}) gives
 * '`/ledger adjust balance:10005000`'. Clickable command mentions are deferred.
 */
export function cmd(
  command: string,
  options: Readonly<Record<string, string | number | bigint | boolean>> = {},
): string {
  return code(
    [`/${command}`, ...Object.entries(options).map(([name, value]) => `${name}:${value}`)].join(
      " ",
    ),
  );
}

/** The first eight characters of a UUID, as a label only; follow-up options take the full ID. */
export const shortId = (uuid: string): string => uuid.slice(0, 8);

/** https URLs a masked link can carry without breaking its markdown. */
const LINK_URL = /^https:\/\/[^\s()<>]+$/u;

/**
 * A masked link whose text names its target ('Lodestone profile', never 'here'). The label is
 * escaped and its brackets too, so user text can't end the link early. Backslashes and brackets
 * are escaped in one pass before the markdown escaping adds its own backslashes, so a label such
 * as 'a\]' or one ending in '\' can't turn an escape into a live bracket.
 */
export function link(label: string, url: string): string {
  if (!LINK_URL.test(url)) throw new Error("A link needs an https URL without spaces.");
  const text = escapeMarkdown(collapse(label).replace(/[\\[\]]/gu, "\\$&"), {
    escape: false,
  }).replace(/<(?=[@#/:]|[a-z]+:)/giu, "\\<");
  return `[${cutMarkdown(text, DISCORD_LIMITS.fieldName)}](${url})`;
}

// ---------------------------------------------------------------------------------------------
// Lodestone

/** The one regional host every Lodestone link uses. */
export const LODESTONE_HOST = "https://na.finalfantasyxiv.com";

/** Public Lodestone pages, built from validated decimal IDs only. */
export const lodestone = {
  character: (id: string): string => `${LODESTONE_HOST}/lodestone/character/${decimalId(id)}/`,
  freeCompany: (id: string): string => `${LODESTONE_HOST}/lodestone/freecompany/${decimalId(id)}/`,
  /** Where a player edits the Character Profile that holds a claim token. */
  profileEdit: `${LODESTONE_HOST}/lodestone/my/setting/profile/`,
} as const;

/** A character as 'Example Character @ Diabolos', escaped for where it appears. */
export function characterName(
  character: Pick<CharacterRef, "name" | "world">,
  where: TextContext = "text",
): string {
  const raw = character.world ? `${character.name} @ ${character.world}` : character.name;
  return forContext(raw, where, HOUSE_LIMITS.characterName);
}

/** The FC's stored name, or its ID before the first Lodestone read filled the name in. */
const companyName = (fc: Pick<FcRef, "id" | "name">): string => fc.name.trim() || `FC ${fc.id}`;

/**
 * An FC with its tag and world, 'Example Company «EXMPL» · Diabolos', where an approved card
 * shows the tag (footers, the linked-FC field). Titles use fcTitleName().
 */
export function fcName(
  fc: Pick<FcRef, "id" | "name" | "tag" | "world">,
  where: TextContext = "text",
): string {
  const named = fc.tag ? `${companyName(fc)} «${fc.tag}»` : companyName(fc);
  return forContext(title(named, fc.world), where, HOUSE_LIMITS.characterName);
}

/** The plain FC name for titles, as approved: 'Ledger history · Example Free Company'. */
export function fcTitleName(fc: Pick<FcRef, "id" | "name">, where: TextContext = "title"): string {
  return forContext(companyName(fc), where, HOUSE_LIMITS.characterName);
}

// ---------------------------------------------------------------------------------------------
// Lists and choices

/** How a list reports what it left out. */
export const andMore = (n: number): string => `…and ${grouping.format(n)} more`;

/** Options for list(): how many items to show and the units the whole value may use. */
export interface ListOptions {
  readonly max?: number;
  readonly budget?: number;
  readonly more?: (hidden: number) => string;
}

/**
 * Newline-joined items that always fit `budget`, including the '…and N more' line. Items are
 * added in order while the remainder line would still fit, so the count is always exact.
 */
export function list(items: readonly string[], options: ListOptions = {}): string {
  const max = options.max ?? HOUSE_LIMITS.jobLines;
  const budget = options.budget ?? DISCORD_LIMITS.fieldValue;
  const more = options.more ?? andMore;
  const shown: string[] = [];
  let used = 0;
  for (const [index, raw] of items.slice(0, max).entries()) {
    const item = cutMarkdown(raw, budget);
    const hidden = items.length - index - 1;
    // The remainder line only shortens as more items are shown, so checking it now is safe.
    const tail = hidden > 0 ? 1 + more(hidden).length : 0;
    const next = used + (shown.length ? 1 : 0) + item.length;
    if (next + tail > budget) break;
    shown.push(item);
    used = next;
  }
  const hidden = items.length - shown.length;
  if (hidden > 0) shown.push(cut(more(hidden), budget));
  return shown.join("\n");
}

/**
 * Pack pre-built lines into as few fields as their budget allows, naming them 'Needs attention
 * (1/2)' when a list spans several. A line is never split across fields; one over the budget on
 * its own is cut. Used for officer job lines, whose diagnostics make ten lines exceed one field.
 */
export function splitFields(
  name: string,
  lines: readonly string[],
  budget: number = DISCORD_LIMITS.fieldValue,
): FieldSpec[] {
  const values: string[] = [];
  let current = "";
  for (const raw of lines) {
    const line = cutMarkdown(raw, budget);
    if (current && current.length + 1 + line.length > budget) {
      values.push(current);
      current = line;
    } else current = current ? `${current}\n${line}` : line;
  }
  if (current) values.push(current);
  return values.map((value, index) => ({
    name: values.length > 1 ? `${name} (${index + 1}/${values.length})` : name,
    value,
  }));
}

/**
 * An autocomplete choice: the label is plain text cut to 100 characters, and the value must
 * already fit, because a cut value would select something else.
 */
export function choice(name: string, value: string): ApplicationCommandOptionChoiceData<string> {
  if (!value || value.length > DISCORD_LIMITS.choiceValue)
    throw new Error("An autocomplete value must be 1–100 characters.");
  return { name: cut(collapse(name), DISCORD_LIMITS.choiceName) || value, value };
}
