/**
 * The only way to build an interaction reply, channel post or DM. Presenters describe one embed
 * declaratively, and these builders apply Discord's limits deterministically, run the discord.js
 * validators, and return a nominal Presented. Nothing reaches Discord without passing through
 * here, so an oversized value is cut instead of failing with a 400 after the service committed.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  codeBlock,
  EmbedBuilder,
  embedLength,
} from "discord.js";
import type { APIActionRowComponent, APIButtonComponent, APIEmbed } from "discord.js";
import { Failure, json } from "../../domain/values.js";
import { isOfficer, type Viewer } from "./audience.js";
import { andMore, cut, cutMarkdown, title } from "./format.js";
import { DISCORD_LIMITS, SEPARATOR, TONE_COLOR, type Tone } from "./style.js";

/** Optional entries are written inline as `condition && value`; falsy entries are dropped. */
type Maybe<T> = T | false | null | undefined;

/** One labelled field. Short facts go inline, at most three per row. */
export interface FieldSpec {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean | undefined;
}

/** One embed, described declaratively. Text must already be escaped for where it renders. */
export interface EmbedSpec {
  readonly tone: Tone;
  readonly title: string;
  readonly url?: string | undefined;
  /** A string, or lines joined with newlines. */
  readonly description?: string | readonly Maybe<string>[] | undefined;
  readonly fields?: readonly Maybe<FieldSpec>[] | undefined;
  /** A string, or parts joined with ' · '. Footers render no markdown or mentions. */
  readonly footer?: string | readonly Maybe<string>[] | undefined;
  /** The embed timestamp: an injected now for replies, event_at for channel posts. */
  readonly timestamp?: Date | null | undefined;
}

/** A button: a link to an https page, or an action whose custom ID the codec built. */
export type ButtonSpec =
  | { readonly style: "link"; readonly label: string; readonly url: string }
  | {
      readonly style: "primary" | "secondary" | "success" | "danger";
      readonly label: string;
      readonly customId: string;
      readonly disabled?: boolean | undefined;
    };

/** An interaction reply: one embed, optional buttons, and optional copyable text above it. */
export interface ReplySpec extends EmbedSpec {
  /** Text the user must copy exactly (the /claim token), sent as a code block in content. */
  readonly copyable?: string | undefined;
  /** Buttons in order, five per row. */
  readonly buttons?: readonly Maybe<ButtonSpec>[] | undefined;
}

/** A channel post or DM: one embed and optional buttons, never content or files. */
export interface PostSpec extends EmbedSpec {
  readonly buttons?: readonly Maybe<ButtonSpec>[] | undefined;
}

/**
 * What a Presented sends. It always carries content, embeds and components, so an in-place
 * update fully replaces the previous view, and it never pings anyone. It is assignable to the
 * interaction reply, edit, channel send and message edit option types alike.
 */
export interface PresentedOptions {
  readonly content: string;
  readonly embeds: readonly APIEmbed[];
  readonly components: readonly APIActionRowComponent<APIButtonComponent>[];
  readonly files?: readonly AttachmentBuilder[];
  readonly allowedMentions: { readonly parse: readonly [] };
}

/** Module-private key: only the builders below can construct a Presented. */
const BUILDER = Symbol("presenters/reply.ts builder");

/**
 * A reply, post or DM built by this module. The class is nominal: constructing one anywhere else
 * throws, so every message the bot sends has passed the limit enforcement here.
 */
export class Presented {
  constructor(
    key: symbol,
    /** 'reply' answers an interaction; 'post' is a channel post or DM (content always ''). */
    readonly kind: "reply" | "post",
    readonly options: PresentedOptions,
    /** A Discord limit forced a cut. Tests assert maximal fixtures never set it. */
    readonly truncated: boolean,
  ) {
    if (key !== BUILDER)
      throw new Error("Presented messages are built only by presenters/reply.ts builders.");
  }
}

/** Stand-ins Discord requires for empty field names and values. */
const EMPTY_NAME = "​";
const EMPTY_VALUE = "—";
/** The shortest a field value or description is shrunk to before whole fields are dropped. */
const SHRINK_FLOOR = 64;

/** A description or footer as one string: lines join with newlines, footer parts with ' · '. */
function joined(value: string | readonly Maybe<string>[] | undefined, separator: string): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return value.filter((part): part is string => Boolean(part)).join(separator);
}

/** Mutable working copy of one field while limits are applied. */
interface DraftField {
  name: string;
  value: string;
  inline: boolean;
}

/**
 * Build one embed within Discord's limits, in a fixed order so the same spec always yields the
 * same embed:
 * 1. cut the title (256), description (4,096), field names (256), values (1,024) and footer
 *    (2,048), replacing empty names and values with Discord's accepted stand-ins;
 * 2. keep at most 25 fields: 24 plus a final 'More' field reading '…and N more';
 * 3. while the total is over 6,000: shrink the longest field value, then replace trailing fields
 *    with '…and N more sections', then shrink the description, then the footer and the title;
 * 4. build through the discord.js EmbedBuilder setters, so its validators run as well.
 * `truncated` records whether any of these cut something; presenters budget so it never does.
 */
export function embed(spec: EmbedSpec): { readonly data: APIEmbed; readonly truncated: boolean } {
  let truncated = false;
  const fit = (value: string, max: number): string => {
    const fitted = cutMarkdown(value, max);
    if (fitted !== value) truncated = true;
    return fitted;
  };
  let heading = fit(spec.title, DISCORD_LIMITS.title) || EMPTY_NAME;
  let description = fit(joined(spec.description, "\n"), DISCORD_LIMITS.description);
  let footer = cut(joined(spec.footer, SEPARATOR), DISCORD_LIMITS.footer);
  if (footer !== joined(spec.footer, SEPARATOR)) truncated = true;
  let fields: DraftField[] = (spec.fields ?? [])
    .filter((field): field is FieldSpec => Boolean(field))
    .map((field) => ({
      name: fit(field.name, DISCORD_LIMITS.fieldName) || EMPTY_NAME,
      value: fit(field.value, DISCORD_LIMITS.fieldValue) || EMPTY_VALUE,
      inline: field.inline ?? false,
    }));
  // Fields left out collapse into one final summary field that counts every one of them.
  let summary: DraftField | undefined;
  let dropped = 0;
  if (fields.length > DISCORD_LIMITS.fields) {
    dropped = fields.length - (DISCORD_LIMITS.fields - 1);
    summary = { name: "More", value: andMore(dropped), inline: false };
    fields = [...fields.slice(0, DISCORD_LIMITS.fields - 1), summary];
    truncated = true;
  }
  const length = (): number =>
    embedLength({
      title: heading,
      description,
      fields: fields.map(({ name, value }) => ({ name, value })),
      footer: { text: footer },
    });
  for (let over = length() - DISCORD_LIMITS.embedTotal; over > 0; ) {
    truncated = true;
    const longest = fields
      .filter((field) => field !== summary && field.value.length > SHRINK_FLOOR)
      .sort((a, b) => b.value.length - a.value.length)[0];
    if (longest)
      longest.value = cutMarkdown(
        longest.value,
        Math.max(SHRINK_FLOOR, longest.value.length - over),
      );
    else if (fields.some((field) => field !== summary)) {
      // Drop the last ordinary field; the summary field stays last and counts what went.
      fields = fields.filter((field) => field !== summary);
      fields.pop();
      dropped += 1;
      summary = { name: "More", value: `${andMore(dropped)} sections`, inline: false };
      fields.push(summary);
    } else if (description.length > SHRINK_FLOOR)
      description = cutMarkdown(description, Math.max(SHRINK_FLOOR, description.length - over));
    else if (footer.length > 1) footer = cut(footer, Math.max(1, footer.length - over));
    else if (description) description = "";
    else if (heading.length > 1) heading = cutMarkdown(heading, Math.max(1, heading.length - over));
    else throw new Error("An embed could not be fitted within Discord's limits.");
    over = length() - DISCORD_LIMITS.embedTotal;
  }
  const builder = new EmbedBuilder().setColor(TONE_COLOR[spec.tone]).setTitle(heading);
  if (spec.url) {
    if (!spec.url.startsWith("https://")) throw new Error("An embed URL must use https.");
    builder.setURL(spec.url);
  }
  if (description) builder.setDescription(description);
  if (fields.length)
    builder.addFields(
      fields.map(({ name, value, inline }) => (inline ? { name, value, inline } : { name, value })),
    );
  if (footer) builder.setFooter({ text: footer });
  if (spec.timestamp) builder.setTimestamp(spec.timestamp);
  return { data: builder.toJSON(), truncated };
}

/** discord.js styles for action buttons. */
const BUTTON_STYLE = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
} as const;

/**
 * Buttons in rows of five, at most five rows, labels cut to 80 characters. Custom IDs come from
 * the codec, which keeps them within 100 characters; an overlong or repeated ID is a presenter bug
 * (Discord rejects duplicates in one message), so it throws rather than being altered.
 */
function actionRows(buttons: readonly Maybe<ButtonSpec>[] | undefined): {
  readonly rows: APIActionRowComponent<APIButtonComponent>[];
  readonly truncated: boolean;
} {
  const specs = (buttons ?? []).filter((button): button is ButtonSpec => Boolean(button));
  const capacity = DISCORD_LIMITS.rows * DISCORD_LIMITS.rowButtons;
  let truncated = specs.length > capacity;
  const seen = new Set<string>();
  const built = specs.slice(0, capacity).map((spec) => {
    const label = cut(spec.label.trim(), DISCORD_LIMITS.buttonLabel);
    if (!label) throw new Error("A button needs a label.");
    if (label !== spec.label.trim()) truncated = true;
    if (spec.style === "link") {
      if (!spec.url.startsWith("https://")) throw new Error("A link button needs an https URL.");
      return new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(spec.url);
    }
    if (!spec.customId || spec.customId.length > DISCORD_LIMITS.customId || seen.has(spec.customId))
      throw new Error("Each button needs a unique custom ID of 1–100 characters from the codec.");
    seen.add(spec.customId);
    return new ButtonBuilder()
      .setStyle(BUTTON_STYLE[spec.style])
      .setLabel(label)
      .setCustomId(spec.customId)
      .setDisabled(spec.disabled ?? false);
  });
  const rows: APIActionRowComponent<APIButtonComponent>[] = [];
  for (let start = 0; start < built.length; start += DISCORD_LIMITS.rowButtons)
    rows.push(
      new ActionRowBuilder<ButtonBuilder>()
        .addComponents(built.slice(start, start + DISCORD_LIMITS.rowButtons))
        .toJSON(),
    );
  return { rows, truncated };
}

/** Freeze a Presented's options so a caller can't alter a message after its limits were applied. */
function sealed(options: PresentedOptions): PresentedOptions {
  return Object.freeze({
    ...options,
    embeds: Object.freeze([...options.embeds]),
    components: Object.freeze([...options.components]),
    allowedMentions: Object.freeze({ parse: Object.freeze([]) as readonly [] }),
  });
}

/**
 * An interaction reply. content is '' unless the spec carries copyable text, which is sent as a
 * code block above the embed so it can be copied exactly (the one-time /claim token).
 */
export function reply(spec: ReplySpec): Presented {
  const built = embed(spec);
  const controls = actionRows(spec.buttons);
  let content = "";
  if (spec.copyable !== undefined) {
    if (!spec.copyable || /`/u.test(spec.copyable) || spec.copyable.length > 1_900)
      throw new Error("Copyable text must be 1–1,900 characters without backticks.");
    content = codeBlock(spec.copyable);
  }
  return new Presented(
    BUILDER,
    "reply",
    sealed({
      content,
      embeds: [built.data],
      components: controls.rows,
      allowedMentions: { parse: [] },
    }),
    built.truncated || controls.truncated,
  );
}

/**
 * A channel post or DM (ledger posts, guest review messages, decision DMs). content is always '',
 * which also clears the legacy text when a pre-2.14.0 message is edited, and the same spec always
 * yields byte-identical JSON, so a nonce retry sends the same message.
 */
export function post(spec: PostSpec): Presented {
  const built = embed(spec);
  const controls = actionRows(spec.buttons);
  return new Presented(
    BUILDER,
    "post",
    sealed({
      content: "",
      embeds: [built.data],
      components: controls.rows,
      allowedMentions: { parse: [] },
    }),
    built.truncated || controls.truncated,
  );
}

/** Details views name their attachment: tarubot-<view>.json. */
const DETAILS_VIEW = /^[a-z][a-z0-9-]{0,39}$/u;

/**
 * Officer "Full details (JSON)": the complete authorized result, always as an attached file
 * (values.json keeps bigints exact), with a neutral 'Full details · <view>' embed. The component
 * that serves it re-runs the read under fresh authorization; this refusal of a member viewer is a
 * second guard, not the primary one. The value must never contain tokens or application answers.
 */
export function dataReply(viewer: Viewer, view: string, value: unknown, now?: Date): Presented {
  if (!isOfficer(viewer))
    throw new Failure("forbidden", "Only FC officers can open full details.", 0, {
      kind: "scope",
      scope: "officer",
    });
  if (!DETAILS_VIEW.test(view)) throw new Error("A details view needs a short lowercase name.");
  const name = `tarubot-${view}.json`;
  const built = embed({
    tone: "neutral",
    title: title("Full details", view),
    description:
      "Read just now with your current access. The attached file is a snapshot and won't update.",
    footer: ["Officer view", name],
    timestamp: now ?? null,
  });
  return new Presented(
    BUILDER,
    "reply",
    sealed({
      content: "",
      embeds: [built.data],
      components: [],
      files: [new AttachmentBuilder(Buffer.from(json(value, 2)), { name })],
      allowedMentions: { parse: [] },
    }),
    built.truncated,
  );
}
