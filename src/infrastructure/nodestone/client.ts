/** Typed HTTP adaptation and complete-crawl validation for the source-built Nodestone sidecar. */
import { decode } from "html-entities";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { Failure, id, normalized } from "../../domain/values.js";
import { responseSchema, type ParseRequest } from "./protocol.js";

const object = z.record(z.string(), z.unknown());
const limitsSchema = z
  // Request and overall crawl budgets are independent; every retry shares the crawl deadline.
  .object({
    LODESTONE_JOB_TIMEOUT_MS: z.coerce.number().int().min(35000).max(900000).default(300000),
    LODESTONE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(35000),
    LODESTONE_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(3),
    LODESTONE_MAX_PAGES: z.coerce.number().int().min(1).max(100).default(100),
    NODESTONE_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(16000000).default(8000000),
  })
  .refine(
    (value) => value.LODESTONE_JOB_TIMEOUT_MS >= value.LODESTONE_REQUEST_TIMEOUT_MS,
    "Job deadline must cover a request deadline",
  );
/** Convert schema failures to one application-owned invalid-response category. */
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Failure("invalid_response", "Nodestone returned missing or invalid required fields.");
  return result.data;
}
/** Canonical public identity; fcId is a profile hint and never roster authority. */
export interface CharacterIdentity {
  id: string;
  name: string;
  world: string;
  dc: string;
  fcId: string | null;
  biography?: string;
  /** FC roster rank facts are absent on ordinary character/search profiles. */
  fcRankName?: string;
  fcRankIcon?: string;
  isFcLeader?: boolean;
}
/** Metadata contains the affirmative count required to establish roster completeness. */
export interface CompanyIdentity {
  id: string;
  name: string;
  tag: string;
  world: string;
  dc: string;
  count: number;
}
/** A validated, time-bounded observation ready for atomic publication by the application. */
export interface Roster {
  company: CompanyIdentity;
  members: CharacterIdentity[];
  startedAt: Date;
  observedAt: Date;
  pages: number;
}

/** Strip parser-provided markup before decoding entities, preserving literal encoded brackets. */
export function display(value: unknown): string {
  if (typeof value !== "string") throw new Failure("invalid_response", "Missing display text.");
  return decode(value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/gu, "")).trim();
}
/** Missing/empty identity attributes invalidate an observation instead of creating partial records. */
function requiredText(value: unknown): string {
  const text = display(value);
  if (!text) throw new Failure("invalid_response", "Empty identity text.");
  return text;
}
/** Explicit zero is meaningful; null, malformed grouping, and unsafe/unbounded counts are not zero. */
export function count(value: unknown): number {
  if (
    typeof value === "string" &&
    /^(0|[1-9][0-9]*|[1-9][0-9]{0,2}(,[0-9]{3})+)$/.test(value.trim())
  )
    value = Number(value.replaceAll(",", "").trim());
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10000)
    throw new Failure("invalid_response", "Unknown or invalid roster count.");
  return value;
}
/** Profiles can inherit the validated requested ID; any returned ID must agree losslessly. */
export function character(raw: unknown, requested?: string): CharacterIdentity {
  const row = validate(object, raw);
  const resolved = row.ID === undefined && requested ? requested : id(row.ID);
  if (requested && requested !== resolved)
    throw new Failure("invalid_response", "Character ID mismatch.");
  if (requested && !Object.hasOwn(row, "FreeCompany"))
    throw new Failure("invalid_response", "Missing profile FC-hint field.");
  const fc = row.FreeCompany == null ? null : validate(object, row.FreeCompany);
  if (fc && fc.ID == null) throw new Failure("invalid_response", "Malformed profile FC hint.");
  const result: CharacterIdentity = {
    id: resolved,
    name: requiredText(row.Name),
    world: requiredText(row.World),
    dc: requiredText(row.DC),
    fcId: fc?.ID == null ? null : id(fc.ID),
  };
  if (typeof row.Bio === "string") result.biography = display(row.Bio);
  if (typeof row.FcRank === "string" && display(row.FcRank))
    result.fcRankName = display(row.FcRank);
  if (typeof row.FcRankIcon === "string" && row.FcRankIcon) result.fcRankIcon = row.FcRankIcon;
  return result;
}

/** Lodestone's master-rank marker is independent of the FC's customizable leader title. */
export function markRosterLeader(members: CharacterIdentity[]): void {
  const masterIcon = "https://lds-img.finalfantasyxiv.com/h/Z/W5a6yeRyN2eYiaV-AGU7mJKEhs.png";
  for (const member of members) delete member.isFcLeader;
  // An unknown/changed marker or incomplete rank data leaves leadership unknown, never guessed.
  if (!members.every((member) => member.fcRankName && member.fcRankIcon)) return;
  if (members.filter((member) => member.fcRankIcon === masterIcon).length !== 1) return;
  for (const member of members) member.isFcLeader = member.fcRankIcon === masterIcon;
}
/** Identity and advertised count are checked at both boundaries of a roster crawl. */
export function company(raw: unknown, requested: string): CompanyIdentity {
  const row = validate(object, raw);
  if (id(row.ID) !== requested) throw new Failure("invalid_response", "FC ID mismatch.");
  return {
    id: requested,
    name: requiredText(row.Name),
    tag: display(row.Tag),
    world: requiredText(row.World),
    dc: requiredText(row.DC),
    count: count(row.ActiveMemberCount),
  };
}
/** Validate page progression and every member; no malformed row is silently discarded. */
export function page(
  raw: unknown,
  expected: number,
  knownCount?: number,
): { members: CharacterIdentity[]; total: number } {
  const row = validate(object, raw);
  const list = validate(z.array(z.unknown()).max(10000), row.List);
  const pagination = validate(object, row.Pagination);
  const valid = z.number().int().min(1).max(100);
  let current = pagination.Page;
  let total = pagination.PageTotal;
  // Only affirmative FC count evidence can establish a pager-less single/empty roster.
  if (
    (current == null || !Number.isFinite(current)) &&
    (total == null || !Number.isFinite(total)) &&
    expected === 1 &&
    knownCount !== undefined &&
    knownCount <= 50 &&
    knownCount === list.length
  ) {
    current = 1;
    total = 1;
  }
  if (
    list.length === 0 &&
    typeof row.NoResultsFound === "string" &&
    row.NoResultsFound.trim() &&
    expected === 1
  )
    return { members: [], total: 1 };
  const currentPage = validate(valid, current);
  const pageTotal = validate(valid, total);
  if (currentPage !== expected || currentPage > pageTotal)
    throw new Failure("incomplete", "Invalid page progression.");
  if (pagination.PageNext != null && pagination.PageNext !== currentPage + 1)
    throw new Failure("incomplete", "Invalid next-page marker.");
  if (
    pagination.PagePrev != null &&
    pagination.PagePrev !== (currentPage === 1 ? 0 : currentPage - 1)
  )
    throw new Failure("incomplete", "Invalid previous-page marker.");
  if (currentPage < pageTotal && pagination.PageNext == null)
    throw new Failure("incomplete", "Missing next-page marker.");
  return { members: list.map((entry) => character(entry)), total: pageTotal };
}

/** Bound HTTP work and deduplicate only in-flight profiles, never cached verification proofs. */
export class Nodestone {
  private profiles = new Map<string, Promise<CharacterIdentity>>();
  private shutdown = new AbortController();
  private readonly limits: z.infer<typeof limitsSchema>;
  /** Validate limits independently of Discord credentials so acquisition tools can share the adapter. */
  constructor(private readonly endpoint: string) {
    const result = limitsSchema.safeParse(process.env);
    if (!result.success)
      throw new Failure(
        "configuration",
        `Invalid Lodestone limit configuration: ${result.error.issues.map((issue) => issue.path.join(".") || "job/request deadline").join(", ")}`,
      );
    this.limits = result.data;
  }
  /** Abort active requests and retry sleeps when the bot relinquishes work. */
  stop(): void {
    this.shutdown.abort();
  }
  /** Stream-bound responses and retry only transport/rate-limit failures with shared cancellation. */
  async request(
    input: ParseRequest,
    signal: AbortSignal = AbortSignal.timeout(this.limits.LODESTONE_JOB_TIMEOUT_MS),
  ): Promise<unknown> {
    signal = AbortSignal.any([signal, this.shutdown.signal]);
    for (let attempt = 0; attempt < this.limits.LODESTONE_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(new URL("/v1/parse", this.endpoint), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(this.limits.LODESTONE_REQUEST_TIMEOUT_MS),
          ]),
        });
        if (response.status >= 500) {
          await response.body?.cancel();
          throw new Failure("unavailable", "The Nodestone sidecar is unavailable.");
        }
        if (Number(response.headers.get("content-length")) > this.limits.NODESTONE_RESPONSE_BYTES) {
          await response.body?.cancel();
          throw new Failure("invalid_response", "Sidecar response exceeds the size limit.");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Failure("invalid_response", "Missing sidecar response body.");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > this.limits.NODESTONE_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Failure("invalid_response", "Sidecar response exceeds the size limit.");
          }
          chunks.push(chunk.value);
        }
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = responseSchema.parse(raw);
        if (result.ok) return result.data;
        throw new Failure(
          result.code,
          `Lodestone ${result.code.replaceAll("_", " ")}.`,
          result.retryAfter,
        );
      } catch (error) {
        if (signal.aborted)
          throw new Failure(
            "unavailable",
            "Lodestone work was cancelled or exceeded its job deadline.",
          );
        const failure =
          error instanceof Failure
            ? error
            : error instanceof z.ZodError || error instanceof SyntaxError
              ? new Failure("invalid_response", "Nodestone returned an invalid response.")
              : new Failure("unavailable", "Nodestone is unavailable.");
        if (
          !["unavailable", "rate_limited"].includes(failure.code) ||
          attempt === this.limits.LODESTONE_ATTEMPTS - 1
        )
          throw failure;
        await delay(
          Math.min(
            this.limits.LODESTONE_JOB_TIMEOUT_MS,
            Math.max(failure.retryAfter * 1000, 1000 * 2 ** attempt + Math.random() * 250),
          ),
          undefined,
          { signal },
        );
      }
    }
    throw new Failure("unavailable", "Nodestone is unavailable.");
  }
  /** Biography requests always reach the sidecar afresh after any in-flight request has settled. */
  async profile(characterId: string, biography = false): Promise<CharacterIdentity> {
    const key = `${characterId}:${biography}`;
    const existing = this.profiles.get(key);
    if (existing) return existing;
    if (this.profiles.size >= 1000)
      throw new Failure("rate_limited", "Too many pending profile requests. Retry shortly.", 1);
    const pending = this.request({ operation: "profile", id: id(characterId), biography }).then(
      (raw) => {
        const result = character(raw, characterId);
        if (biography && result.biography === undefined)
          throw new Failure(
            "invalid_response",
            "The biography selector was unavailable. Your challenge remains pending.",
          );
        return result;
      },
    );
    this.profiles.set(key, pending);
    try {
      return await pending;
    } finally {
      this.profiles.delete(key);
    }
  }
  /** Resolve expected FC metadata under the caller's crawl deadline. */
  async company(fcId: string, signal?: AbortSignal): Promise<CompanyIdentity> {
    return company(await this.request({ operation: "fc", id: id(fcId) }, signal), fcId);
  }
  /** Exhaust complete pages before deciding exact match, ambiguity, or an affirmative no-match. */
  async search(name: string, world: string): Promise<CharacterIdentity[]> {
    const deadline = AbortSignal.timeout(this.limits.LODESTONE_JOB_TIMEOUT_MS);
    const matches: CharacterIdentity[] = [];
    const seen = new Set<string>();
    let total = 1;
    for (let index = 1; index <= total; index++) {
      const parsed = page(
        await this.request({ operation: "search", name, world, page: index }, deadline),
        index,
      );
      if (parsed.total > this.limits.LODESTONE_MAX_PAGES)
        throw new Failure("incomplete", "Search exceeds the configured page bound.");
      if (index > 1 && total !== parsed.total)
        throw new Failure("incomplete", "Search pagination changed.");
      total = parsed.total;
      for (const entry of parsed.members) {
        if (seen.has(entry.id)) throw new Failure("incomplete", "Search pages repeated.");
        seen.add(entry.id);
        if (
          normalized(entry.name) === normalized(name) &&
          normalized(entry.world) === normalized(world)
        )
          matches.push(entry);
      }
    }
    return matches;
  }
  /** Repeated IDs, changing pagination/counts, or missing pages reject the whole candidate. */
  async roster(fcId: string): Promise<Roster> {
    const deadline = AbortSignal.timeout(this.limits.LODESTONE_JOB_TIMEOUT_MS);
    const startedAt = new Date();
    const before = await this.company(fcId, deadline);
    const members: CharacterIdentity[] = [];
    const seen = new Set<string>();
    let total = 1;
    for (let index = 1; index <= total; index++) {
      const parsed = page(
        await this.request({ operation: "members", id: fcId, page: index }, deadline),
        index,
        before.count,
      );
      if (parsed.total > this.limits.LODESTONE_MAX_PAGES)
        throw new Failure("incomplete", "Roster exceeds the configured page bound.");
      if (index > 1 && parsed.total !== total)
        throw new Failure("incomplete", "Roster pagination changed.");
      total = parsed.total;
      for (const entry of parsed.members) {
        if (seen.has(entry.id))
          throw new Failure("incomplete", "Roster pages contain duplicate IDs.");
        seen.add(entry.id);
        members.push(entry);
      }
      if (members.length > before.count)
        throw new Failure("incomplete", "Roster exceeds advertised count.");
    }
    const after = await this.company(fcId, deadline);
    if (after.count !== before.count || members.length !== before.count)
      throw new Failure("incomplete", "Roster changed during acquisition.");
    markRosterLeader(members);
    return { company: after, members, startedAt, observedAt: new Date(), pages: total };
  }
}
