/** PostgreSQL-backed work leases: deduplicate decisions and recover abandoned delivery. */
import { randomUUID } from "node:crypto";
import { DiscordAPIError } from "discord.js";
import { DISCORD_BLOCKED_CODES, WAITING_CODES } from "../domain/failures.js";
import { Failure, json } from "../domain/values.js";
import { orm, type Connection, type Database } from "../infrastructure/postgres/database.js";
import { and, asc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import * as t from "../infrastructure/postgres/schema.js";

/** Payload version describes its schema; generation describes superseding work for the same key. */
export type Job = Pick<
  typeof t.jobs.$inferSelect,
  | "id"
  | "kind"
  | "guild_id"
  | "user_id"
  | "payload"
  | "payload_version"
  | "generation"
  | "attempts"
  | "message_id"
  // Row timestamps let log events distinguish queue latency from a wait that never clears.
  | "created_at"
  | "due_at"
> & { lease_token: string };
/** Enqueue in the decision transaction; updating active work increments its generation fence. */
export async function enqueue(
  client: Connection,
  kind: string,
  key: string,
  payload: unknown,
  guild: string | null = null,
  user: string | null = null,
  delay = 0,
): Promise<string> {
  const [row] = await orm(client)
    .insert(t.jobs)
    .values({
      kind,
      dedupe_key: key,
      payload: payload === null ? sql`'null'::jsonb` : payload,
      guild_id: guild,
      user_id: user,
      due_at: sql`now()+${delay}*interval '1 second'`,
    })
    .onConflictDoUpdate({
      target: t.jobs.dedupe_key,
      // Literal states match the existing partial unique index, including generic prepared plans.
      targetWhere: sql`${t.jobs.status} IN ('queued','running','blocked')`,
      set: {
        payload: sql`excluded.payload`,
        generation: sql`${t.jobs.generation}+1`,
        due_at: sql`least(${t.jobs.due_at},excluded.due_at)`,
        status: sql`CASE WHEN ${t.jobs.status}='blocked' THEN 'queued' ELSE ${t.jobs.status} END`,
      },
    })
    .returning({ id: t.jobs.id });
  if (!row) throw new Error("Missing queued job");
  return row.id;
}
/** One active reconciliation per guild/user coalesces command changes and gateway echoes. */
export const reconcileUser = (client: Connection, guild: string, user: string): Promise<string> =>
  enqueue(client, "reconcile.user", `user:${guild}:${user}`, {}, guild, user);

/** Coalesce role appearance/order changes independently of per-user access delivery. */
export const layoutGuildRoles = (client: Connection, guild: string): Promise<string> =>
  enqueue(client, "roles.layout", `role-layout:${guild}`, {}, guild);

/** Channel edits coalesce independently from member enumeration and role-layout effects. */
export const secureGuildChannels = (client: Connection, guild: string): Promise<string> =>
  enqueue(client, "channels.access", `channel-access:${guild}`, {}, guild);

/** Attempts at or beyond this count end an ordinary retry as a failed delivery. */
const MAX_ATTEMPTS = 8;
/**
 * Waits are logged at debug, so a lock or ordering head that never clears would otherwise be
 * invisible: each wait re-queues the row one second (or its retryAfter) later forever. Once a row
 * has waited continuously for longer than this, its waits escalate to warn so the stall appears in
 * normal logs. Row age alone is no stall signal: re-queued disabled/blocked rows keep created_at.
 */
export const STALE_WAIT_MS = 10 * 60 * 1000;

/** Severity names match the pino methods used by the composition root. */
export type JobLevel = "debug" | "info" | "warn" | "error";
/** One classified failed/waiting attempt: persisted state, retry timing, and log severity. */
export type JobOutcome = {
  /** Failure code, or the Discord/transport classification for other errors. */
  code: string;
  /** Stored status, or "unchanged" when the worker lost its lease and wrote nothing. */
  status: "queued" | "blocked" | "disabled" | "succeeded" | "failed" | "unchanged";
  /**
   * Written waiting outcomes return their attempt, so contention never exhausts the retry budget.
   * A lost lease writes nothing; claim() reclaims (and counts) the expired row on its own.
   */
  waiting: boolean;
  delaySeconds: number;
  /** Stored as last_error; approved Failure messages or fixed guidance, never raw SDK errors. */
  diagnostic: string;
  category: "wait" | "lease" | "gone" | "blocked" | "disabled" | "retry" | "failed";
  /** Error class (plus Discord's numeric code) for logs; never the error's message or body. */
  source: string;
  level: JobLevel;
};

/** Classify a caught job error once; waitingMs (the continuous wait streak) escalates stalls. */
export function jobOutcome(error: unknown, attempts: number, waitingMs = 0): JobOutcome {
  const discord = error instanceof DiscordAPIError ? Number(error.code) : undefined;
  const code =
    error instanceof Failure
      ? error.code
      : discord !== undefined && DISCORD_BLOCKED_CODES.has(discord)
        ? "blocked"
        : discord !== undefined && [10004, 10007, 10013].includes(discord)
          ? "gone"
          : "transient";
  // The catalog's waiting codes (ordering, locks, cooldowns, new inputs, a lost lease) are shared
  // with reply presentation, so a job line and its logged outcome agree on what is waiting.
  const waiting = WAITING_CODES.has(code);
  // Waiting for ordering/locks is not a failed delivery and must not exhaust attempts.
  const status =
    code === "lease_lost"
      ? "unchanged"
      : waiting
        ? "queued"
        : code === "blocked"
          ? "blocked"
          : code === "disabled"
            ? "disabled"
            : code === "gone"
              ? "succeeded"
              : code === "dm_blocked" || code === "invalid_job" || attempts >= MAX_ATTEMPTS
                ? "failed"
                : "queued";
  const delaySeconds =
    code === "lease_lost"
      ? 0
      : Math.max(
          error instanceof Failure ? error.retryAfter : 0,
          waiting ? 1 : Math.min(3600, 2 ** attempts + Math.random() * 5),
        );
  const diagnostic =
    // Store actionable approved messages, never raw credential-bearing SDK error objects.
    error instanceof Failure
      ? `${code}: ${error.message}`
      : code === "blocked"
        ? "blocked: Recheck Discord roles, channel permissions, and bot hierarchy with /config validate."
        : code;
  const category =
    code === "lease_lost"
      ? "lease"
      : waiting
        ? "wait"
        : status === "succeeded"
          ? "gone"
          : status === "blocked" || status === "disabled"
            ? status
            : status === "failed"
              ? "failed"
              : "retry";
  // Expected waits stay quiet; stalls, retries and blocks warn; only terminal failures are errors.
  const level =
    category === "lease"
      ? "warn"
      : category === "wait"
        ? waitingMs > STALE_WAIT_MS
          ? "warn"
          : "debug"
        : category === "gone" || code === "dm_blocked"
          ? "info"
          : category === "failed"
            ? "error"
            : "warn";
  const source =
    error instanceof Failure
      ? "Failure"
      : discord !== undefined
        ? `DiscordAPIError[${discord}]`
        : error instanceof Error
          ? error.name
          : "unknown";
  return { code, status, waiting, delaySeconds, diagnostic, category, source, level };
}

/** Classified attempt outcomes are observed separately from worker-level infrastructure errors. */
export type QueueEvent =
  | {
      type: "job";
      job: Job;
      outcome: JobOutcome;
      /** Time spent in this attempt, from perform start to the recorded outcome. */
      durationMs: number;
      /** Queue latency: how long the row was due before this attempt started. */
      waitMs: number;
      /** Time since the row was created, spanning every retry and superseding generation. */
      ageMs: number;
    }
  | { type: "worker"; error: unknown; job?: Job };

/** Non-negative elapsed milliseconds; application and database clocks both use UTC. */
const since = (instant: Date, now: number): number =>
  // Re-wrapping tolerates hand-built jobs whose timestamps arrive as ISO strings.
  Math.max(0, now - new Date(instant).getTime());

/** A small worker pool uses leases rather than keeping database transactions open during I/O. */
export class Queue {
  private stopping = false;
  private running: Promise<void>[] = [];
  /**
   * When each row's current run of consecutive waits began. In-memory is enough for the single
   * writer; after a restart a streak simply starts again from the next wait.
   */
  private readonly waitingSince = new Map<string, number>();
  /** Dispatch and the clock are injected so ownership/recovery behavior can be tested independently. */
  constructor(
    private readonly db: Database,
    private readonly dispatch: (job: Job, guard: () => Promise<void>) => Promise<unknown>,
    private readonly observe: (event: QueueEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}
  /** SKIP LOCKED lets workers claim distinct rows and reclaim expired leases atomically. */
  async claim(): Promise<Job | undefined> {
    const token = randomUUID();
    const db = this.db.orm;
    const candidate = db.$with("candidate").as(
      db
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .leftJoin(t.guilds, eq(t.guilds.id, t.jobs.guild_id))
        .where(
          and(
            or(
              and(eq(t.jobs.status, "queued"), lte(t.jobs.due_at, sql`now()`)),
              and(eq(t.jobs.status, "running"), lt(t.jobs.lease_until, sql`now()`)),
            ),
            or(isNull(t.jobs.guild_id), eq(t.guilds.active, true)),
          ),
        )
        .orderBy(asc(t.jobs.due_at))
        .limit(1)
        .for("update", { of: t.jobs, skipLocked: true }),
    );
    const [row] = await db
      .with(candidate)
      .update(t.jobs)
      .set({
        status: "running",
        lease_token: token,
        lease_until: sql`now()+interval '45 seconds'`,
        attempts: sql`${t.jobs.attempts}+1`,
      })
      .from(candidate)
      .where(eq(t.jobs.id, candidate.id))
      .returning();
    if (!row) return undefined;
    if (!row.lease_token) throw new Error("Claimed job has no lease token");
    return { ...row, lease_token: row.lease_token };
  }
  /** Extend ownership while work runs, then publish only through the current lease token. */
  async perform(job: Job): Promise<void> {
    const started = this.now();
    const waitMs = since(job.due_at, started);
    const guard = async (): Promise<void> => {
      // One primary-key read distinguishes lost ownership from superseding inputs for diagnostics.
      const [row] = await this.db.orm
        .select({
          lease_token: t.jobs.lease_token,
          status: t.jobs.status,
          generation: t.jobs.generation,
          live: sql<boolean>`coalesce(${t.jobs.lease_until}>now(),false)`,
        })
        .from(t.jobs)
        .where(eq(t.jobs.id, job.id));
      if (!row || row.lease_token !== job.lease_token || !row.live || row.status !== "running")
        throw new Failure(
          "lease_lost",
          "Worker lease expired or was reclaimed; another worker owns this job.",
        );
      // Reconciliation also checks generation because its desired state can change mid-flight.
      if (job.kind.startsWith("reconcile.") && row.generation !== job.generation)
        throw new Failure(
          "superseded",
          `Reconciliation inputs changed (generation ${job.generation}→${row.generation}); recomputing current desired state.`,
        );
    };
    const heartbeat = setInterval(() => {
      void this.db.orm
        .update(t.jobs)
        .set({ lease_until: sql`now()+interval '45 seconds'` })
        .where(
          and(
            eq(t.jobs.id, job.id),
            eq(t.jobs.lease_token, job.lease_token),
            gt(t.jobs.lease_until, sql`now()`),
          ),
        )
        .catch((e: unknown) => this.observe({ type: "worker", error: e, job }));
    }, 10000);
    try {
      const result = await this.dispatch(job, guard);
      await guard();
      // Carry over only the append-only `applied` evidence written by earlier superseded passes;
      // every other key comes from this attempt so stale fields such as `skipped` never survive.
      const value = json(result ?? {});
      await this.db.orm
        .update(t.jobs)
        .set({
          status: sql`CASE WHEN ${t.jobs.generation}=${job.generation} THEN 'succeeded' ELSE 'queued' END`,
          completed_at: sql`now()`,
          lease_until: null,
          result: sql`CASE WHEN jsonb_typeof(${value}::jsonb)='object' THEN ${value}::jsonb || jsonb_strip_nulls(jsonb_build_object('applied',${t.jobs.result}->'applied')) ELSE ${value}::jsonb END`,
          last_error: null,
        })
        .where(and(eq(t.jobs.id, job.id), eq(t.jobs.lease_token, job.lease_token)));
      this.waitingSince.delete(job.id);
    } catch (error) {
      const now = this.now();
      const ageMs = since(job.created_at, now);
      // Escalate only when this row has kept waiting since its streak began; a first wait (for
      // example an activation-time gateway echo on an old re-queued row) stays at debug.
      const first = this.waitingSince.get(job.id) ?? started;
      const outcome = jobOutcome(error, job.attempts, now - first);
      if (outcome.category === "wait") this.waitingSince.set(job.id, first);
      else this.waitingSince.delete(job.id);
      // A worker that lost its lease no longer owns the row, even if its token still matches an
      // expired or operator-changed lease; claim() reclaims expired running rows on its own.
      if (outcome.status !== "unchanged")
        await this.db.orm
          .update(t.jobs)
          .set({
            status: outcome.status,
            due_at: sql`now()+${outcome.delaySeconds}*interval '1 second'`,
            lease_until: null,
            last_error: outcome.diagnostic,
            attempts: outcome.waiting ? sql`greatest(0,${t.jobs.attempts}-1)` : t.jobs.attempts,
          })
          .where(and(eq(t.jobs.id, job.id), eq(t.jobs.lease_token, job.lease_token)))
          .catch((e: unknown) => this.observe({ type: "worker", error: e, job }));
      // Observe after the write attempt, so the log line follows (never precedes) the stored status.
      this.observe({ type: "job", job, outcome, durationMs: now - started, waitMs, ageMs });
    } finally {
      clearInterval(heartbeat);
    }
  }
  /** Poll with bounded concurrency; a worker-level failure does not stop unrelated work. */
  start(concurrency = 3): void {
    this.running = Array.from({ length: concurrency }, async () => {
      while (!this.stopping) {
        try {
          const job = await this.claim();
          if (job) await this.perform(job);
          else await Bun.sleep(500);
        } catch (error) {
          this.observe({ type: "worker", error });
          await Bun.sleep(2000);
        }
      }
    });
  }
  /** Stop new claims and allow current jobs to finish or be abandoned by the lifecycle deadline. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.running);
  }
}
