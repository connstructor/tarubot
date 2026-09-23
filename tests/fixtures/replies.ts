/**
 * Assertions and stress data shared by every presenter test. expectHouseStyle checks a Presented
 * against Discord's limits (through the real discord.js validators) and the approved house style;
 * expectFailure adds the 'Code <code> · Ref <ref>' footer every failure carries. The stress
 * builders produce maximal inputs, so tests can show that presenters budget within the limits
 * and never reach the builder's truncation fallback.
 */
import { expect } from "bun:test";
import { EmbedBuilder, embedLength } from "discord.js";
import type { APIButtonComponent, APIEmbed } from "discord.js";
import type { JobView } from "../../src/application/results.js";
import { parseControl } from "../../src/discord/custom-ids.js";
import { Presented } from "../../src/discord/presenters/reply.js";
import {
  DISCORD_LIMITS,
  HOUSE_LIMITS,
  TONE_COLOR,
  type Tone,
} from "../../src/discord/presenters/style.js";
import type { FailureCode } from "../../src/domain/failures.js";
import { MAX_GIL, MAX_ID } from "../../src/domain/values.js";
import { at, job } from "./results.js";

export { NOW } from "./results.js";

/** Every tone, in the approved swatch order. */
const TONES: readonly Tone[] = ["success", "pending", "info", "warning", "error", "neutral"];

/** Embed color to tone, for asserting a reply's tone from its color. */
export const TONE_COLORS: ReadonlyMap<number, Tone> = new Map(
  TONES.map((tone) => [TONE_COLOR[tone], tone]),
);

/** The single embed every reply, post and DM carries. */
export function onlyEmbed(presented: Presented): APIEmbed {
  expect(presented.options.embeds).toHaveLength(1);
  const [embed] = presented.options.embeds;
  if (!embed) throw new Error("Missing embed");
  return embed;
}

/** Every button, row by row. */
export function buttonsOf(presented: Presented): APIButtonComponent[] {
  return presented.options.components.flatMap((row) => row.components);
}

/**
 * Everything a recipient can read: content, embed text, button labels and attachment names. Tests
 * assert what a member never sees against this.
 */
export function visibleText(presented: Presented): string {
  const embed = onlyEmbed(presented);
  return [
    presented.options.content,
    embed.title,
    embed.description,
    ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
    embed.footer?.text,
    ...buttonsOf(presented).map((button) => ("label" in button ? button.label : "")),
    ...(presented.options.files ?? []).map((file) => file.name),
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

/** What a catalog case expects beyond the house style itself. */
export interface HouseStyle {
  readonly tone?: Tone;
  readonly title?: string;
  /** Whether the approved card carries an embed timestamp (its `timestamp` value). */
  readonly timestamp?: boolean;
  /** A documented exemption from the ten-field house limit; /config show allows 15. */
  readonly maxFields?: number;
}

/** Mentions, timestamps and masked links render nowhere in titles, field names or footers. */
const RENDERED_ONLY_IN_BODY = /<@|<#|<t:|\]\(/u;

/**
 * Assert a Presented follows Discord's limits and the house style, and return its embed:
 * - content, embeds and components are always present, allowedMentions is {parse: []}, content
 *   never holds a JSON dump, and a post's content is '';
 * - exactly one embed, which the discord.js validators accept, within 6,000 characters, with
 *   non-empty field names and values within their limits, and no truncation fallback;
 * - title ≤ 60, description ≤ 1,000 (posts may use Discord's 4,096 for a full ledger note), and
 *   ≤ 10 fields unless a documented exemption says otherwise;
 * - the color is one of the six tones; titles, field names and footers carry no mentions,
 *   timestamps or links;
 * - buttons stay within 5×5, labels within 80, and every custom ID parses with the codec.
 */
export function expectHouseStyle(presented: Presented, expected: HouseStyle = {}): APIEmbed {
  expect(presented).toBeInstanceOf(Presented);
  const { options } = presented;
  expect(typeof options.content).toBe("string");
  expect(Array.isArray(options.components)).toBe(true);
  expect(options.allowedMentions).toEqual({ parse: [] });
  expect(options.content).not.toContain("```json");
  if (presented.kind === "post") expect(options.content).toBe("");
  expect(presented.truncated).toBe(false);

  const embed = onlyEmbed(presented);
  // Rebuild through the setters: the EmbedBuilder constructor itself validates nothing.
  expect(() => {
    const builder = new EmbedBuilder()
      .setColor(embed.color ?? null)
      .setTitle(embed.title ?? null)
      .setURL(embed.url ?? null)
      .setDescription(embed.description ?? null)
      .setFooter(embed.footer ? { text: embed.footer.text } : null)
      .setTimestamp(embed.timestamp ? new Date(embed.timestamp) : null);
    if (embed.fields?.length) builder.addFields(embed.fields);
  }).not.toThrow();
  expect(embedLength(embed)).toBeLessThanOrEqual(DISCORD_LIMITS.embedTotal);

  const fields = embed.fields ?? [];
  expect(fields.length).toBeLessThanOrEqual(expected.maxFields ?? HOUSE_LIMITS.fields);
  for (const field of fields) {
    expect(field.name.length).toBeGreaterThan(0);
    expect(field.name.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldName);
    expect(field.value.length).toBeGreaterThan(0);
    expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue);
    expect(field.name).not.toMatch(RENDERED_ONLY_IN_BODY);
  }
  expect(embed.title?.length ?? 0).toBeGreaterThan(0);
  expect(embed.title?.length ?? 0).toBeLessThanOrEqual(HOUSE_LIMITS.title);
  expect(embed.title ?? "").not.toMatch(RENDERED_ONLY_IN_BODY);
  expect(embed.footer?.text ?? "").not.toMatch(RENDERED_ONLY_IN_BODY);
  expect(embed.description?.length ?? 0).toBeLessThanOrEqual(
    presented.kind === "post" ? DISCORD_LIMITS.description : HOUSE_LIMITS.description,
  );
  expect(TONE_COLORS.has(embed.color ?? -1)).toBe(true);
  if (expected.tone) expect(TONE_COLORS.get(embed.color ?? -1)).toBe(expected.tone);
  if (expected.title !== undefined) expect(embed.title).toBe(expected.title);
  if (expected.timestamp !== undefined) expect(Boolean(embed.timestamp)).toBe(expected.timestamp);

  expect(options.components.length).toBeLessThanOrEqual(DISCORD_LIMITS.rows);
  for (const row of options.components)
    expect(row.components.length).toBeLessThanOrEqual(DISCORD_LIMITS.rowButtons);
  for (const button of buttonsOf(presented)) {
    const label = "label" in button ? (button.label ?? "") : "";
    expect(label.length).toBeGreaterThan(0);
    expect(label.length).toBeLessThanOrEqual(DISCORD_LIMITS.buttonLabel);
    if ("url" in button) expect(button.url).toStartWith("https://");
    if ("custom_id" in button) {
      expect(button.custom_id.length).toBeLessThanOrEqual(DISCORD_LIMITS.customId);
      expect(() => parseControl(button.custom_id)).not.toThrow();
    }
  }
  return embed;
}

/** What a failure reply must show: its catalog code, the interaction Ref, and its concept. */
export interface ExpectedFailure {
  readonly code: FailureCode;
  readonly ref: string;
  readonly tone?: Tone;
  readonly title?: string;
}

/** Assert a failure reply's house style and its 'Code <code> · Ref <ref>' footer. */
export function expectFailure(presented: Presented, expected: ExpectedFailure): APIEmbed {
  const embed = expectHouseStyle(presented, {
    ...(expected.tone && { tone: expected.tone }),
    ...(expected.title !== undefined && { title: expected.title }),
  });
  expect(embed.footer?.text).toBe(`Code ${expected.code} · Ref ${expected.ref}`);
  return embed;
}

/**
 * Markdown, mention, timestamp, command and emoji syntax plus multi-unit graphemes (a ZWJ family,
 * a flag, stacked combining marks), everything a presenter must escape or cut safely.
 */
const HOSTILE =
  "# **bold** _it_ `code` [link](https://example.com) <@123456789012345678> <#223456789012345678> " +
  "<@&323456789012345678> <t:1790169000:R> </ping:1> ||spoiler|| ~~strike~~ \\ > quote\n- item\n" +
  "1. item -# small 👩‍👩‍👧‍👦 🇯🇵 é̂̂ @everyone ";

/** Maximal inputs: the longest IDs, cursors and texts the bot can store or receive. */
export const stress = {
  /** A 20-digit ID, the largest unsigned 64-bit value. */
  id: MAX_ID.toString(),
  /** The largest entry number, 19 digits. */
  cursor: MAX_GIL,
  /** A canonical UUID with every hex digit at its maximum. */
  uuid: "ffffffff-ffff-4fff-bfff-ffffffffffff",
  /** Hostile user text of exactly `length` UTF-16 units, cut on a grapheme boundary. */
  text(length: number): string {
    let text = "";
    const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
    while (text.length < length) {
      for (const { segment } of graphemes.segment(HOSTILE)) {
        if (text.length + segment.length > length) return text.padEnd(length, "x");
        text += segment;
      }
    }
    return text;
  },
  /**
   * `count` jobs in the states that show officer diagnostics, each attempt-heavy with a stored
   * last_error far longer than the 150-character quote.
   */
  jobs(count: number): JobView[] {
    const states = ["failed", "blocked", "queued", "disabled"] as const;
    return Array.from({ length: count }, (_, index) =>
      job({
        id: `${index.toString(16).padStart(8, "0")}-ffff-4fff-bfff-ffffffffffff`,
        kind: "channels.access",
        status: states[index % states.length] ?? "failed",
        attempts: 8,
        due_at: at(-index * 60),
        last_error: `transient: ${stress.text(900)}`,
      }),
    );
  },
};
