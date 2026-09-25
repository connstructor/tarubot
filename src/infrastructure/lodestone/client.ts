/**
 * TaruBot's Lodestone adapter (2.21.0: in process; the sidecar is gone). It runs each operation
 * through the runner (fetch under the gate, parse in a fresh worker) with the live selector set,
 * bounds concurrency, retries transient outages, and validates every parsed field before it becomes
 * an application fact. It also follows the selector repository's HEAD (selectors.ts, upstreams.ts).
 */
import { decode } from "html-entities";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { FailureCode, FailureDetail } from "../../domain/failures.js";
import { Failure, id, normalized } from "../../domain/values.js";
import { LodestoneGate } from "./gate.js";
import { pagePlan } from "./pages.js";
import type { ParseRequest, ParseResponse } from "./protocol.js";
import { REGIONS, run, type RunnerOptions } from "./runner.js";
import { type SelectorStatus, SelectorStore } from "./selectors.js";
import { UpstreamMonitor, type UpstreamState } from "./upstreams.js";

/**
 * Which Lodestone page an operation reads, so a failure's reply can say "Character not found"
 * rather than "Free Company not found". Searches look for characters; members pages belong to an FC.
 */
function resourceOf(input: ParseRequest): FailureDetail {
  return {
    kind: "resource",
    resource:
      input.operation === "profile" || input.operation === "search" ? "character" : "freecompany",
    ...(input.operation === "search" ? { name: input.name, world: input.world } : { id: input.id }),
  };
}
/** Codes that describe the requested Lodestone page and so carry its resource detail. */
const RESOURCE_CODES: ReadonlySet<string> = new Set([
  "not_found",
  "unavailable",
  "incomplete",
  "invalid_response",
  "private_profile",
]);
/** Parse failure codes as catalog codes: only a private profile is renamed. */
export const WIRE_CODES = {
  not_found: "not_found",
  unavailable: "unavailable",
  rate_limited: "rate_limited",
  private: "private_profile",
  invalid_response: "invalid_response",
  incomplete: "incomplete",
} as const satisfies Record<string, FailureCode>;
/**
 * Failures worth another attempt inside one request: the Lodestone unreachable or timing out. Its
 * rate limit is not retried here (2.17.0): the gate refuses every start for the cooldown it returns,
 * so an immediate retry only spends the deadline. The job queue waits that retryAfter without
 * spending an attempt, and a command tells the user when to retry.
 */
const RETRYABLE: ReadonlySet<string> = new Set(["unavailable"]);
/**
 * Outcomes that mean TaruBot couldn't get an answer from the Lodestone: down, unreachable or
 * throttling. A not-found, private or unreadable page is still an answer.
 */
const UNREACHABLE: ReadonlySet<string> = new Set(["unavailable", "rate_limited"]);

/** Whether the Lodestone has been answering, for the "unreachable for an hour" report (2.18.0). */
export interface LodestoneReachability {
  /** The last request the Lodestone answered, in this process; null before the first. */
  readonly lastAnswerAt: Date | null;
  /** When unanswered requests began, if every request since the last answer went unanswered. */
  readonly failingSince: Date | null;
  /**
   * The last request started, answered or not. A failure followed by quiet says nothing about
   * now, so an outage is only "still failing" while attempts keep being made.
   */
  readonly lastAttemptAt: Date | null;
  /** The code of the most recent unanswered request. */
  readonly lastFailure: string | null;
}
/**
 * The approved not-found wording per page. It names only public Lodestone IDs, never a typed
 * search name, because the message also reaches logs and job diagnostics.
 */
function notFoundMessage(input: ParseRequest): string {
  if (input.operation === "search")
    return "The Lodestone has no character with that exact name on that world.";
  return input.operation === "profile"
    ? `The Lodestone has no character with ID ${input.id}.`
    : `The Lodestone has no Free Company with ID ${input.id}.`;
}
/**
 * Attach the operation's resource to a detail-less failure; retry timing is unchanged. The
 * runner's generic not-found text becomes the page-specific wording; other messages are kept,
 * because officers see them as the diagnostic.
 */
function withResource(failure: Failure, input: ParseRequest): Failure {
  if (failure.detail || !RESOURCE_CODES.has(failure.code)) return failure;
  const message =
    failure.code === "not_found"
      ? notFoundMessage(input)
      : failure.code === "private_profile" && input.operation === "profile"
        ? `The Lodestone profile for character ID ${input.id} is private.`
        : failure.message;
  return new Failure(failure.code, message, failure.retryAfter, resourceOf(input));
}

const object = z.record(z.string(), z.unknown());
/** Every Lodestone setting (2.21.0: the sidecar's own settings joined the bot's). */
const limitsSchema = z
  .object({
    // Which regional Lodestone to read (formerly the sidecar's PAGE_REGION).
    LODESTONE_REGION: z.enum(REGIONS).default("na"),
    // Parses at once; more wait for a free slot within their deadline.
    LODESTONE_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
    // The least time between two Lodestone request starts, process-wide.
    LODESTONE_START_MS: z.coerce.number().int().min(1000).max(60000).default(1000),
    // One Lodestone fetch, and the most page bytes read.
    LODESTONE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
    LODESTONE_BODY_BYTES: z.coerce.number().int().min(1024).max(8000000).default(2000000),
    // Request and overall crawl budgets are independent; every retry shares the crawl deadline.
    LODESTONE_JOB_TIMEOUT_MS: z.coerce.number().int().min(35000).max(900000).default(300000),
    LODESTONE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(35000),
    LODESTONE_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(3),
    LODESTONE_MAX_PAGES: z.coerce.number().int().min(1).max(100).default(100),
    // How often to check the selector repository's HEAD; 0 keeps the bundled set (offline use).
    LODESTONE_SELECTOR_CHECK_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .refine((value) => value === 0 || value >= 300)
      .default(900),
  })
  .refine(
    (value) => value.LODESTONE_JOB_TIMEOUT_MS >= value.LODESTONE_REQUEST_TIMEOUT_MS,
    "Job deadline must cover a request deadline",
  );
export type LodestoneLimits = z.infer<typeof limitsSchema>;
/** Convert schema failures to one application-owned invalid-response category. */
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Failure("invalid_response", "The Lodestone page lacked required fields.");
  return result.data;
}
/**
 * A malformed ID in parsed output is unexpected Lodestone data, never the user's input: id()'s own
 * failure is the input card that advises the user, so parse sites reclassify it as an unreadable
 * upstream response (warn level, 'Unexpected Lodestone page', a neutral job diagnostic).
 */
function upstreamId(value: unknown): string {
  try {
    return id(value);
  } catch {
    throw new Failure("invalid_response", "The Lodestone page had an invalid Lodestone ID.");
  }
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

/**
 * Remove parser-provided tags until a pass changes nothing. One pass is already stable, because no
 * tag can reassemble from the remainder; the fixed-point loop is the shape CodeQL's
 * js/incomplete-multi-character-sanitization accepts (the result flows back into the receiver),
 * so do not collapse it into a single replace.
 */
function stripTags(markup: string): string {
  let text = markup;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/gu, "");
  } while (text !== previous);
  return text;
}
/**
 * Convert parser-provided markup to plain text. Encoded brackets decode to literal `<`/`>`, so the
 * result is display text, not HTML-safe output: every HTML sink must encode it when rendering.
 */
export function display(value: unknown): string {
  if (typeof value !== "string") throw new Failure("invalid_response", "Missing display text.");
  return decode(stripTags(value.replace(/<br\s*\/?\s*>/gi, "\n"))).trim();
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
  const resolved = row.ID === undefined && requested ? requested : upstreamId(row.ID);
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
    fcId: fc?.ID == null ? null : upstreamId(fc.ID),
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
  if (upstreamId(row.ID) !== requested) throw new Failure("invalid_response", "FC ID mismatch.");
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

/** The selector package, as bun.lock and upstream-revisions.json name it. */
const BUNDLED_SELECTORS_PACKAGE = "lodestone-css-selectors";

/** A structured log line from the adapter; the composition root routes it to the bot's logger. */
export type LodestoneLog = (
  level: "info" | "warn",
  fields: Record<string, unknown>,
  message: string,
) => void;

/** Runs one operation: the runner by default; tests script parse results instead. */
export type ParseRunner = (input: ParseRequest, signal: AbortSignal) => Promise<ParseResponse>;

export interface LodestoneOptions {
  readonly log?: LodestoneLog;
  /** Replaces the runner (and so the network and workers) with scripted parse results. */
  readonly run?: ParseRunner;
  /** Runner overrides: a Lodestone transport, a worker script or a gate of the test's own. */
  readonly runner?: Partial<Pick<RunnerOptions, "transport" | "workerURL" | "gate">>;
  readonly selectors?: SelectorStore;
  /** The selector repository's HEAD, for the monitor; tests supply their own. */
  readonly resolveHead?: ConstructorParameters<typeof UpstreamMonitor>[1];
}

/** What issue reports and /health/ready show about the Lodestone. */
export interface LodestoneStatus {
  /** Parses running, and requests waiting for a parse slot. */
  readonly parsing: number;
  readonly waiting: number;
  /** The gate: the remaining 429 cooldown and the Lodestone 429s in a row. */
  readonly cooldownSeconds: number;
  readonly strikes: number;
  readonly selectors: SelectorStatus;
  readonly upstream: UpstreamState;
}

/**
 * Bound Lodestone work and deduplicate only in-flight profiles, never cached verification proofs.
 * One instance per process: the gate's spacing and 429 cooldown cover every request it makes.
 */
export class Lodestone {
  private profiles = new Map<string, Promise<CharacterIdentity>>();
  private lastAnswerAt: Date | null = null;
  private failingSince: Date | null = null;
  private lastFailure: string | null = null;
  private lastAttemptAt: Date | null = null;
  private shutdown = new AbortController();
  private readonly limits: LodestoneLimits;
  private readonly gate: LodestoneGate;
  private readonly selectors: SelectorStore;
  private readonly monitor: UpstreamMonitor;
  private readonly runner: ParseRunner;
  private readonly log: LodestoneLog;
  /** Parse slots in use, and requests waiting for one, woken in arrival order. */
  private active = 0;
  private waiting: (() => void)[] = [];

  /** Validate limits independently of Discord credentials so acquisition tools can share the adapter. */
  constructor(options: LodestoneOptions = {}) {
    const result = limitsSchema.safeParse(process.env);
    if (!result.success)
      throw new Failure(
        "configuration",
        `Invalid Lodestone limit configuration: ${result.error.issues.map((issue) => issue.path.join(".") || "job/request deadline").join(", ")}`,
      );
    this.limits = result.data;
    this.log = options.log ?? (() => {});
    this.gate = options.runner?.gate ?? new LodestoneGate(this.limits.LODESTONE_START_MS);
    this.selectors = options.selectors ?? new SelectorStore();
    const runner: RunnerOptions = {
      region: this.limits.LODESTONE_REGION,
      gate: this.gate,
      fetchTimeoutMs: this.limits.LODESTONE_TIMEOUT_MS,
      bodyBytes: this.limits.LODESTONE_BODY_BYTES,
      // Throttled jobs wait quietly (debug), so one line per 429 says the gate closed.
      throttled: (state) =>
        this.log(
          "info",
          state,
          "The Lodestone throttled TaruBot; new requests wait for the cooldown",
        ),
      ...options.runner,
    };
    this.runner =
      options.run ??
      ((input, signal) =>
        run(input, this.selectors.selectorFiles(pagePlan(input).files), signal, runner));
    // Each new selector HEAD is activated live; a rejected one is logged once, then retried quietly.
    let rejected: string | undefined;
    const store = this.selectors;
    this.monitor = new UpstreamMonitor(
      {
        [BUNDLED_SELECTORS_PACKAGE]: {
          repository: store.repository,
          revision: store.status().bundled,
        },
      },
      options.resolveHead,
      (state) => this.log("info", { ...state }, "Lodestone selector upstream status changed"),
      {
        package: BUNDLED_SELECTORS_PACKAGE,
        activate: async (latest, signal) => {
          const before = store.status().revision;
          try {
            const after = await store.activate(latest, signal);
            if (after !== before)
              this.log("info", { from: before, to: after }, "Lodestone selectors updated");
            rejected = undefined;
            return after;
          } catch (error) {
            if (rejected !== latest)
              this.log(
                "warn",
                {
                  revision: latest,
                  active: before,
                  reason: error instanceof Error ? error.message : "unknown",
                },
                "Lodestone selector revision rejected; the active set stays",
              );
            rejected = latest;
            return store.status().revision;
          }
        },
      },
    );
  }

  /**
   * Follow the selector repository: check HEAD now, then every LODESTONE_SELECTOR_CHECK_SECONDS.
   * The first check runs in the background, so startup never waits for GitHub.
   */
  start(): void {
    this.monitor.start(this.limits.LODESTONE_SELECTOR_CHECK_SECONDS);
  }

  /** One selector check now, for maintenance tools that parse right away. */
  async refresh(): Promise<void> {
    if (this.limits.LODESTONE_SELECTOR_CHECK_SECONDS > 0) await this.monitor.check();
  }

  /** Whether the Lodestone has been answering this process's requests. */
  reachability(): LodestoneReachability {
    return {
      lastAnswerAt: this.lastAnswerAt,
      failingSince: this.failingSince,
      lastFailure: this.lastFailure,
      lastAttemptAt: this.lastAttemptAt,
    };
  }

  /** Parse slots, the gate and the selectors, for issue reports and /health/ready. */
  status(): LodestoneStatus {
    return {
      parsing: this.active,
      waiting: this.waiting.length,
      ...this.gate.status(),
      selectors: this.selectors.status(),
      upstream: this.monitor.status(),
    };
  }

  /** Abort active requests, slot waits and retry sleeps, and stop following upstream. */
  stop(): void {
    this.shutdown.abort();
    this.monitor.stop();
  }

  /**
   * Retry only transient outages, with shared cancellation. A not-found, private, outage,
   * incomplete or invalid failure names the page the operation read.
   */
  async request(
    input: ParseRequest,
    signal: AbortSignal = AbortSignal.timeout(this.limits.LODESTONE_JOB_TIMEOUT_MS),
  ): Promise<unknown> {
    this.lastAttemptAt = new Date();
    try {
      const result = await this.attempts(input, signal);
      this.answered();
      return result;
    } catch (error) {
      // Only a page that says something about the request is an answer; an unreachable code or
      // any other error (a cancelled request) is not.
      if (!(error instanceof Failure) || UNREACHABLE.has(error.code)) {
        this.failingSince ??= new Date();
        this.lastFailure = error instanceof Failure ? error.code : "unavailable";
      } else this.answered();
      throw error instanceof Failure ? withResource(error, input) : error;
    }
  }
  /** The Lodestone gave an answer: success, or a page that says something about the request. */
  private answered(): void {
    this.lastAnswerAt = new Date();
    this.failingSince = null;
    this.lastFailure = null;
  }
  /**
   * Take one of LODESTONE_CONCURRENCY parse slots, waiting in arrival order for one to free. Returns
   * the release; rejects with the signal's reason if it aborts while waiting.
   */
  private async slot(signal: AbortSignal): Promise<() => void> {
    while (this.active >= this.limits.LODESTONE_CONCURRENCY) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = (): void => {
          this.waiting = this.waiting.filter((waiter) => waiter !== wake);
          reject(signal.reason);
        };
        this.waiting.push(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
  /** The retry loop behind request(); its failures gain their resource detail there. */
  private async attempts(input: ParseRequest, signal: AbortSignal): Promise<unknown> {
    signal = AbortSignal.any([signal, this.shutdown.signal]);
    for (let attempt = 0; attempt < this.limits.LODESTONE_ATTEMPTS; attempt++) {
      try {
        const deadline = AbortSignal.any([
          signal,
          AbortSignal.timeout(this.limits.LODESTONE_REQUEST_TIMEOUT_MS),
        ]);
        const release = await this.slot(deadline);
        let result: ParseResponse;
        try {
          result = await this.runner(input, deadline);
        } finally {
          release();
        }
        if (result.ok) return result.data;
        throw new Failure(
          WIRE_CODES[result.code],
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
            : new Failure("unavailable", "The Lodestone request timed out or failed.");
        if (!RETRYABLE.has(failure.code) || attempt === this.limits.LODESTONE_ATTEMPTS - 1)
          throw failure;
        try {
          await delay(
            Math.min(
              this.limits.LODESTONE_JOB_TIMEOUT_MS,
              Math.max(failure.retryAfter * 1000, 1000 * 2 ** attempt + Math.random() * 250),
            ),
            undefined,
            { signal },
          );
        } catch {
          // The deadline or shutdown during the backoff ends the request as the check above does,
          // never as a raw AbortError: that would read as unexpected, and as a Lodestone answer.
          throw new Failure(
            "unavailable",
            "Lodestone work was cancelled or exceeded its job deadline.",
          );
        }
      }
    }
    throw new Failure("unavailable", "The Lodestone is unavailable.");
  }
  /** Biography requests always reach the Lodestone afresh after any in-flight request has settled. */
  async profile(characterId: string, biography = false): Promise<CharacterIdentity> {
    const key = `${characterId}:${biography}`;
    const existing = this.profiles.get(key);
    if (existing) return existing;
    if (this.profiles.size >= 1000)
      throw new Failure(
        "rate_limited",
        "TaruBot is handling many Lodestone lookups. Try again in a few seconds.",
        1,
      );
    const pending = this.request({ operation: "profile", id: id(characterId), biography }).then(
      (raw) => {
        const result = character(raw, characterId);
        if (biography && result.biography === undefined)
          throw new Failure(
            "invalid_response",
            "TaruBot couldn't read the biography section of the Lodestone page. Your token is still valid; try again in a few minutes.",
            0,
            { kind: "resource", resource: "biography", id: characterId },
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
