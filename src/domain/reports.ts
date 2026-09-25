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
 * tokens, GitHub tokens, Authorization values, passwords in connection URLs, and PEM blocks.
 */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, "[pem redacted]"],
  [
    /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/gu,
    "[discord token redacted]",
  ],
  [/\bgithub_pat_[A-Za-z\d_]{20,}\b/gu, "[github token redacted]"],
  [/\bgh[pousr]_[A-Za-z\d]{20,}\b/gu, "[github token redacted]"],
  [/\b(Bot|Bearer|token)\s+[A-Za-z\d._~+/=-]{16,}/giu, "$1 [redacted]"],
  [/([a-z][a-z\d+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/giu, "$1[credentials redacted]@"],
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

/** A short, stable fingerprint of the parts that identify one kind of trouble. */
export function fingerprint(...parts: readonly (string | number | null | undefined)[]): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * The first-party frames of a stack, which identify where an error came from without the noise of
 * dependency internals: frames under src/, scripts/ or sidecar/, with any absolute directory before
 * the repository-relative path removed.
 */
export function firstPartyFrames(stack: string | undefined, limit = 8): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /\/(src|dist\/src|scripts|dist\/scripts|sidecar)\//u.test(line))
    .filter((line) => !line.includes("node_modules"))
    .map(relative)
    .slice(0, limit);
}

/** Repository-relative markers, compiled output first; the last occurrence wins. */
const FRAME_ROOTS = [
  "/dist/src/",
  "/dist/scripts/",
  "/dist/sidecar/",
  "/src/",
  "/scripts/",
  "/sidecar/",
];

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
