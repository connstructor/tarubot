/**
 * Issue-report helpers (2.18.0), pure so they can be unit-tested: secret redaction, stable
 * fingerprints, bounded Markdown, and the caps. Reports go to a private GitHub repository the owner
 * controls, so they carry more than the logs do (error messages and first-party stack frames), but
 * every text still passes redact() first: nothing credential-shaped leaves the process.
 */
import { createHash } from "node:crypto";

/** A user may send one /issue per this many seconds (owner decision, 2026-09-24). */
export const USER_REPORT_INTERVAL_SECONDS = 600;
/** A server may send at most this many /issue reports in any 24 hours (owner decision). */
export const GUILD_REPORTS_PER_DAY = 20;
/** Automatic reports open at most this many new issues per day, across every fingerprint. */
export const AUTO_ISSUES_PER_DAY = 10;
/** Automatic reports post at most this many repeat comments per day, across every fingerprint. */
export const AUTO_COMMENTS_PER_DAY = 50;
/** One fingerprint gets at most one repeat comment per this many seconds; the rest are counted. */
export const REPEAT_COMMENT_SECONDS = 3600;
/** Repeated trouble is reported once it has lasted this long: a roster not accepted for 12 hours. */
export const ROSTER_STALE_SECONDS = 12 * 3600;
/** ...and the Lodestone unreachable, throttling or refusing for an hour. */
export const LODESTONE_DOWN_SECONDS = 3600;
/** An outage counts only while requests keep failing: the last attempt within this long. */
export const LODESTONE_RECENT_ATTEMPT_SECONDS = 1800;
/** GitHub rejects bodies over 65,536 characters; stay well below with room for the header. */
export const BODY_LIMIT = 60_000;

/** Where a report came from; also the label it carries. */
export type ReportSource = "user" | "error" | "job" | "trouble";

/**
 * Patterns for credentials that must never reach a report, whatever text carried them: Discord bot
 * tokens, GitHub tokens, Authorization values, passwords in connection URLs, PEM blocks, and
 * healthchecks.io ping URLs (anyone holding one can ping the check and hide an outage). Exported
 * since 2.28.0: public suggestions (src/domain/suggestions.ts) apply the same shapes, but never
 * the deployment's exact secret values, so a member can't use /suggest to test a guess.
 */
export const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, "[pem redacted]"],
  [
    /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/gu,
    "[discord token redacted]",
  ],
  [/\bgithub_pat_[A-Za-z\d_]{20,}\b/gu, "[github token redacted]"],
  [/\bgh[pousr]_[A-Za-z\d]{20,}\b/gu, "[github token redacted]"],
  [/\b(Bot|Bearer|token)\s+[A-Za-z\d._~+/=-]{16,}/giu, "$1 [redacted]"],
  [/([a-z][a-z\d+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/giu, "$1[credentials redacted]@"],
  [/\bhc-ping\.com\/[^\s"'<>)]+/giu, "hc-ping.com/[ping URL redacted]"],
];

/**
 * Remove credentials from text bound for a report: the known secret shapes above, and the exact
 * values of the deployment's own secrets (tokens, the database password), which may be passed in.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets)
    if (secret.length >= 8) result = result.split(secret).join("[secret redacted]");
  for (const [pattern, replacement] of SECRET_PATTERNS)
    result = result.replace(pattern, replacement);
  return result;
}

/**
 * Whole seconds from now until `seconds` after `from`, at least one: a limit's Failure.retryAfter.
 * Shared by /issue's and /suggest's limits (moved here from issue-reports.ts in 2.28.0).
 */
export function secondsUntil(from: Date, seconds: number): number {
  return Math.max(1, Math.ceil((from.getTime() + seconds * 1000 - Date.now()) / 1000));
}

/** `seconds` after `from`: when a limit that started at `from` lifts. */
export function after(from: Date, seconds: number): Date {
  return new Date(from.getTime() + seconds * 1000);
}

/** A short, stable fingerprint of the parts that identify one kind of trouble. */
export function fingerprint(...parts: readonly (string | number | null | undefined)[]): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * The first-party frames of a stack, which identify where an error came from without the noise of
 * dependency internals: frames under src/ or scripts/, with any absolute directory before
 * the repository-relative path removed.
 */
export function firstPartyFrames(stack: string | undefined, limit = 8): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /\/(src|dist\/src|scripts|dist\/scripts)\//u.test(line))
    .filter((line) => !line.includes("node_modules"))
    .map(relative)
    .slice(0, limit);
}

/** Repository-relative markers, compiled output first; the last occurrence wins. */
const FRAME_ROOTS = ["/dist/src/", "/dist/scripts/", "/src/", "/scripts/"];

/** A stack frame with everything before its repository-relative path removed. */
function relative(line: string): string {
  for (const marker of FRAME_ROOTS) {
    const index = line.lastIndexOf(marker);
    if (index < 0) continue;
    const start = Math.max(line.lastIndexOf("(", index), line.lastIndexOf(" ", index));
    return `${line.slice(0, start + 1)}${line.slice(index + 1)}`;
  }
  return line;
}

/** Trim text to `limit` characters, saying how much was cut. */
export function bounded(text: string, limit = BODY_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n… ${text.length - limit} more characters cut to fit GitHub's limit.`;
}

/** Text safe inside a Markdown fenced block: a stray fence would end the block early. */
export function fenced(text: string, language = ""): string {
  return `\`\`\`${language}\n${text.replaceAll("```", "ʼʼʼ")}\n\`\`\``;
}

/** A collapsed Markdown section, so long context doesn't bury the summary. */
export function details(summary: string, body: string): string {
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

/** A Markdown table from rows of cells; pipes and newlines inside cells are escaped. */
export function table(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const cell = (value: unknown) =>
    String(value ?? "—")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ");
  return [
    `| ${header.map(cell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

/**
 * A two-column table for one record's fields: easier to read than one wide row, and it never
 * scrolls sideways on GitHub. Pairs whose value is undefined are left out.
 */
export function fields(
  pairs: readonly (readonly [string, unknown])[],
  header: readonly [string, string] = ["Field", "Value"],
): string {
  return table(
    header,
    pairs.filter(([, value]) => value !== undefined),
  );
}

/** A time as `2026-09-25 03:07:37 UTC`, or a dash. */
export function when(value: Date | null | undefined): string {
  return value ? `${value.toISOString().slice(0, 19).replace("T", " ")} UTC` : "—";
}

/** A boolean as yes or no, or a dash when unknown. */
export function yesNo(value: boolean | null | undefined): string {
  return value === null || value === undefined ? "—" : value ? "yes" : "no";
}

/**
 * A duration in the largest sensible unit: 45 s, 12 min, 3.7 h, 2.1 d. Anything that isn't a
 * finite number (null for "no roster yet", a missing field) is a dash, never "0 s".
 */
export function duration(seconds: unknown): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

/** pino's numeric levels, by name. */
const LEVELS: Readonly<Record<number, string>> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};
/** Fields every record carries that say nothing about what happened. */
const LOG_NOISE = new Set(["level", "time", "pid", "hostname", "msg"]);
/** Periodic records that repeat every 30 seconds; readiness already shows their numbers. */
const LOG_ROUTINE = new Set(["Capability status"]);

/**
 * Whether a serialized record is routine and worth no space in the recent-log buffer. The buffer
 * skips these as they are written, so on an idle bot its slots still hold the useful records
 * instead of half an hour of the same periodic line.
 */
export function routineLog(line: string): boolean {
  try {
    const entry = JSON.parse(line) as { msg?: unknown };
    return typeof entry.msg === "string" && LOG_ROUTINE.has(entry.msg);
  } catch {
    return false;
  }
}

/**
 * pino JSON records as readable lines: `03:07:37 INFO Modules loaded · commands=20 events=15`.
 * Routine periodic records are dropped; a line that isn't JSON is kept as it is.
 */
export function logLines(records: readonly string[]): string[] {
  const lines: string[] = [];
  for (const record of records) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(record) as Record<string, unknown>;
    } catch {
      lines.push(record);
      continue;
    }
    const message = typeof entry.msg === "string" ? entry.msg : "";
    if (LOG_ROUTINE.has(message)) continue;
    const time =
      typeof entry.time === "number"
        ? new Date(entry.time).toISOString().slice(11, 19)
        : "--:--:--";
    const level = LEVELS[Number(entry.level)] ?? String(entry.level ?? "?");
    const extra = Object.entries(entry)
      .filter(([key]) => !LOG_NOISE.has(key))
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    lines.push(`${time} ${level} ${message}${extra.length ? ` · ${extra.join(" ")}` : ""}`);
  }
  return lines;
}
