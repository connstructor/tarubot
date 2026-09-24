/**
 * The approved reply house style as data: tones and their colors, the status-marker and
 * health-check vocabularies, separators, and the Discord and house limits every presenter and the
 * reply builder share. Pure constants; no discovered-module suffix, so discovery ignores it.
 */
import { Colors } from "discord.js";

/**
 * The six reply tones. Color only reinforces the title and markers, which carry the meaning in
 * words. The approved tone table (docs/REPLIES.md, pinned by reply-consistency.test):
 *
 * - success: saved and confirmed, or nothing left to do. Every committed change is success,
 *   removals included (unlink, revoke, clear, layout off, deny).
 * - pending: saved with Discord work queued, or try again later (a user action, the requested run
 *   or activation is still outstanding, or a time-bound refusal). A paused save is always pending,
 *   titled "Saved, Discord changes paused", unless something is also blocked or failed.
 * - info: read-only results and harmless refusals. No-op results are info, except the approved
 *   neutral cards ("No correction needed", "Nickname sync already off").
 * - warning: refused or degraded in a way the user or an officer can fix (input, setup, blocked).
 * - error: refused for permissions, or failed unexpectedly.
 * - neutral: utilities (/ping, /channel), reference lists and the officer JSON details.
 *
 * The officer /sync status overview stays pending while runs are active or anything is queued,
 * even with a failed job (approved #44); it is warning only when focused on blocked or failed
 * work (#45).
 */
export type Tone = "success" | "pending" | "info" | "warning" | "error" | "neutral";

/** Tone colors are discord.js palette entries, as the approved swatches show. */
export const TONE_COLOR: Readonly<Record<Tone, number>> = {
  success: Colors.Green,
  pending: Colors.Yellow,
  info: Colors.Blurple,
  warning: Colors.Orange,
  error: Colors.Red,
  neutral: Colors.Greyple,
};

/**
 * Status markers for saved, queued and delivered work, rendered in inline code. Each glyph is
 * plain Unicode that Discord does not turn into an emoji, and the word after it carries the
 * meaning. Completion words (applied, posted, sent, secured) belong only to ✓ DONE.
 */
export const MARKER = {
  /** Discord confirmed it: the job succeeded. */
  done: "✓ DONE",
  /** Committed to the database. */
  saved: "• SAVED",
  /** Waiting for the worker. */
  queued: "… QUEUED",
  /** A worker is running it. */
  running: "… IN PROGRESS",
  /** A retry is scheduled (cooldown, lock, ordering or a temporary error). */
  waiting: "↻ WAITING",
  /** An officer must fix a permission or setting. */
  blocked: "! BLOCKED",
  /** Discord changes are off until activation, or for the whole deployment. */
  paused: "‖ PAUSED",
  /** Stopped and will not retry. */
  failed: "✗ FAILED",
  /** It was already that way. */
  unchanged: "= NO CHANGE",
  /** There was nothing to do. */
  skipped: "– SKIPPED",
} as const;

/** A status marker's name. */
export type Marker = keyof typeof MARKER;

/** Render a status marker the approved way: inside inline code, followed by the caller's words. */
export const marker = (name: Marker): string => `\`${MARKER[name]}\``;

/**
 * The separate health-check vocabulary of /config validate (approved configuration#7–#9). It is
 * used only inside health checklists; status views use MARKER. Awaiting activation is [WAIT]
 * where configuration#9 shows it, and [WARN] marks the warnings configuration#8 shows.
 */
export const CHECK = {
  ok: "[OK]",
  warn: "[WARN]",
  fail: "[FAIL]",
  off: "[OFF]",
  wait: "[WAIT]",
} as const;

/** A health-check token's name. */
export type Check = keyof typeof CHECK;

/** Text marker for a GitHub-verified commit signature in /version (replaces the ✅ emoji). */
export const VERIFIED = "✓ verified";

/** Joins title sections, footer parts and inline facts: 'Ledger history · Example Company'. */
export const SEPARATOR = " · ";

/**
 * Discord's hard limits in UTF-16 code units, which is what discord.js validates and never less
 * than Discord's own count. reply.ts enforces these deterministically; nothing else truncates.
 */
export const DISCORD_LIMITS = {
  title: 256,
  description: 4_096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1_024,
  footer: 2_048,
  /** Title, description, field names and values, and footer across one message's embeds. */
  embedTotal: 6_000,
  content: 2_000,
  rows: 5,
  rowButtons: 5,
  buttonLabel: 80,
  customId: 100,
  choiceName: 100,
  choiceValue: 100,
  choices: 25,
} as const;

/**
 * The approved house limits. Tests check them (expectHouseStyle); presenters budget within them,
 * so the runtime builder never needs to truncate. Exemptions are documented in docs/REPLIES.md.
 */
export const HOUSE_LIMITS = {
  /** Sentence-case titles, outcome first. */
  title: 60,
  /** At most two sentences of description; channel posts are exempt (a full ledger note). */
  description: 1_000,
  /** Labelled fields per embed. */
  fields: 10,
  /** /config show keeps the approved 12-field layout (13 with grandfathering), tested to 15. */
  configShowFields: 15,
  /** User-written notes and reasons shown in fields. */
  userText: 300,
  /** A character written as 'Example Character @ Diabolos'. */
  characterName: 100,
  /** An officer job line's quoted last_error. */
  diagnostic: 150,
  /** Job lines shown before '…and N more'. */
  jobLines: 10,
} as const;
