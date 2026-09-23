/** PostgreSQL-backed work leases: deduplicate decisions and recover abandoned delivery. */
import { randomUUID } from "node:crypto";
import { DiscordAPIError } from "discord.js";
import { Failure } from "../domain/values.js";
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

/** A small worker pool uses leases rather than keeping database transactions open during I/O. */
export class Queue {
  private stopping = false;
  private running: Promise<void>[] = [];
  /** Dispatch is injected so ownership/recovery behavior can be tested independently. */
  constructor(
    private readonly db: Database,
    private readonly dispatch: (job: Job, guard: () => Promise<void>) => Promise<unknown>,
    private readonly report: (error: unknown, job?: Job) => void,
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
    const guard = async (): Promise<void> => {
      // Reconciliation also checks generation because its desired state can change mid-flight.
      const rows = await this.db.orm
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .where(
          and(
            eq(t.jobs.id, job.id),
            eq(t.jobs.lease_token, job.lease_token),
            gt(t.jobs.lease_until, sql`now()`),
            eq(t.jobs.status, "running"),
            job.kind.startsWith("reconcile.") ? eq(t.jobs.generation, job.generation) : undefined,
          ),
        );
      if (!rows.length) throw new Failure("superseded", "Worker lease expired.");
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
        .catch((e: unknown) => this.report(e, job));
    }, 10000);
    try {
      const result = await this.dispatch(job, guard);
      await guard();
      await this.db.orm
        .update(t.jobs)
        .set({
          status: sql`CASE WHEN ${t.jobs.generation}=${job.generation} THEN 'succeeded' ELSE 'queued' END`,
          completed_at: sql`now()`,
          lease_until: null,
          result: result ?? {},
          last_error: null,
        })
        .where(and(eq(t.jobs.id, job.id), eq(t.jobs.lease_token, job.lease_token)));
    } catch (error) {
      this.report(error, job);
      const code =
        error instanceof Failure
          ? error.code
          : error instanceof DiscordAPIError &&
              [50001, 50013, 10003, 10011].includes(Number(error.code))
            ? "blocked"
            : error instanceof DiscordAPIError && [10004, 10007, 10013].includes(Number(error.code))
              ? "gone"
              : "transient";
      const waiting = ["ordered", "busy", "cooldown", "superseded"].includes(code);
      // Waiting for ordering/locks is not a failed delivery and must not exhaust attempts.
      const status = waiting
        ? "queued"
        : code === "blocked"
          ? "blocked"
          : code === "disabled"
            ? "disabled"
            : code === "gone"
              ? "succeeded"
              : code === "dm_blocked" || code === "invalid_job" || job.attempts >= 8
                ? "failed"
                : "queued";
      const delay = Math.max(
        error instanceof Failure ? error.retryAfter : 0,
        waiting ? 1 : Math.min(3600, 2 ** job.attempts + Math.random() * 5),
      );
      const diagnostic =
        // Store actionable approved messages, never raw credential-bearing SDK error objects.
        error instanceof Failure
          ? `${code}: ${error.message}`
          : code === "blocked"
            ? "blocked: Recheck Discord roles, channel permissions, and bot hierarchy with /config validate."
            : code;
      await this.db.orm
        .update(t.jobs)
        .set({
          status,
          due_at: sql`now()+${delay}*interval '1 second'`,
          lease_until: null,
          last_error: diagnostic,
          attempts: waiting ? sql`greatest(0,${t.jobs.attempts}-1)` : t.jobs.attempts,
        })
        .where(and(eq(t.jobs.id, job.id), eq(t.jobs.lease_token, job.lease_token)))
        .catch((e: unknown) => this.report(e, job));
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
          this.report(error);
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
