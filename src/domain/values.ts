/** Lossless boundary values shared by application policy, persistence, and presentation. */
import { z } from "zod";

/** External IDs may exceed signed bigint; their application/storage representation is text. */
export const MAX_ID = 18_446_744_073_709_551_615n;
/** Money uses PostgreSQL's signed bigint range, with nonnegative account balances. */
export const MAX_GIL = 9_223_372_036_854_775_807n;
/** Decimal shape of an external ID: no leading zeroes, signs, or whitespace. */
const ID_PATTERN = /^[1-9][0-9]{0,19}$/;
/**
 * Reject malformed values and values outside unsigned 64-bit IDs. Zod 4 still runs a refinement
 * after a failed regex check, so the range check re-tests the shape before calling BigInt, which
 * would otherwise throw a raw SyntaxError for input such as a typed name or "@name".
 */
export const idSchema = z
  .string()
  .regex(ID_PATTERN)
  .refine((v) => ID_PATTERN.test(v) && BigInt(v) <= MAX_ID);
export type Id = string;

/** Deliberately user-safe diagnostics; raw transport/database exceptions stay out of replies. */
export class Failure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfter = 0,
  ) {
    super(message);
    this.name = "Failure";
  }
}

/** Numeric IDs are accepted only before any precision has been lost. */
export function id(value: unknown): Id {
  const candidate =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  const result = idSchema.safeParse(candidate);
  if (!result.success)
    throw new Failure("invalid_data", "Expected a lossless positive decimal ID.");
  return result.data;
}

/** Accept canonical IDs or exact regional profile URLs, preventing arbitrary URL acquisition. */
export function lodestoneId(value: string, kind: "character" | "freecompany"): Id {
  if (/^[0-9]+$/.test(value)) return id(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Failure("input", "Use an ID or canonical Lodestone URL.");
  }
  const match = new RegExp(`^/lodestone/${kind}/([1-9][0-9]*)/?$`).exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    !/^(na|eu|fr|de|jp)\.finalfantasyxiv\.com$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match?.[1]
  ) {
    throw new Failure("input", "Use a canonical HTTPS Lodestone profile URL.");
  }
  return id(match[1]);
}

/** Parse large monetary input directly into bigint rather than through JavaScript numbers. */
export function gil(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new Failure("input", "Balance must be a nonnegative decimal integer.");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_GIL) throw new Failure("input", "Balance exceeds the PostgreSQL bigint range.");
  return parsed;
}

/** Enforce accepted UTF-16 length and PostgreSQL-compatible Unicode before a mutation. */
export function note(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1_000)
    throw new Failure("input", "A note of 1–1,000 characters is required.");
  if (!trimmed.isWellFormed() || trimmed.includes("\0"))
    throw new Failure("input", "Use valid Unicode text without NUL characters.");
  return trimmed;
}

/** Comparison normalization is separate from the canonical display text stored in the DB. */
export const normalized = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
/** Jobs and replies encode exact monetary values as decimal strings. */
export const json = (value: unknown, indent = 0): string =>
  JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    indent,
  );
/** Only approved Failure messages are exposed to users; unknown exceptions get a safe fallback. */
export const message = (error: unknown): string =>
  error instanceof Failure
    ? error.message
    : "The operation failed. Inspect the operation ID in the logs.";

/** Fit Discord's UTF-16 limit without splitting emoji, combining marks, or other graphemes. */
export function nickname(name: string): string {
  let result = "";
  for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(name)) {
    if ((result + segment).length > 32) break;
    result += segment;
  }
  return result;
}
