/** PostgreSQL-backed work leases: deduplicate decisions and recover abandoned delivery. */
import { randomUUID } from "node:crypto";
import { DiscordAPIError } from "discord.js";
import { Failure, json } from "../domain/values.js";
import type { Connection, Database } from "../infrastructure/postgres/database.js";

/** Payload version describes its schema; generation describes superseding work for the same key. */
export interface Job {
  id: string;
  kind: string;
  guild_id: string | null;
  user_id: string | null;
  payload: unknown;
  payload_version: number;
  generation: number;
  attempts: number;
  lease_token: string;
  message_id: string | null;
}
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
  const result = await client.query<{ id: string }>(
    `INSERT INTO jobs(kind,dedupe_key,payload,guild_id,user_id,due_at)
    VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 second') ON CONFLICT(dedupe_key) WHERE status IN ('queued','running','blocked')
    DO UPDATE SET payload=EXCLUDED.payload,generation=jobs.generation+1,due_at=LEAST(jobs.due_at,EXCLUDED.due_at),
    status=CASE WHEN jobs.status='blocked' THEN 'queued' ELSE jobs.status END RETURNING id`,
    [kind, key, json(payload), guild, user, delay],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Missing queued job");
  return row.id;
}
/** One active reconciliation per guild/user coalesces command changes and gateway echoes. */
export const reconcileUser = (client: Connection, guild: string, user: string): Promise<string> =>
  enqueue(client, "reconcile.user", `user:${guild}:${user}`, {}, guild, user);

/** Coalesce role appearance/order changes independently of per-user access delivery. */
export const layoutGuildRoles = (client: Connection, guild: string): Promise<string> =>
  enqueue(client, "roles.layout", `role-layout:${guild}`, {}, guild);

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
    const rows = await this.db.query<Job>(
      `WITH candidate AS (
      SELECT j.id FROM jobs j LEFT JOIN guilds g ON g.id=j.guild_id
      WHERE ((j.status='queued' AND due_at<=now()) OR (j.status='running' AND lease_until<now()))
        AND (j.guild_id IS NULL OR g.active) ORDER BY due_at FOR UPDATE OF j SKIP LOCKED LIMIT 1)
      UPDATE jobs SET status='running',lease_token=$1,lease_until=now()+interval '45 seconds',attempts=attempts+1
      FROM candidate WHERE jobs.id=candidate.id RETURNING jobs.*`,
      [token],
    );
    return rows[0];
  }
  /** Extend ownership while work runs, then publish only through the current lease token. */
  async perform(job: Job): Promise<void> {
    const guard = async (): Promise<void> => {
      // Reconciliation also checks generation because its desired state can change mid-flight.
      const rows = await this.db.query<{ id: string }>(
        "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND status='running' AND ($3::boolean OR generation=$4)",
        [job.id, job.lease_token, !job.kind.startsWith("reconcile."), job.generation],
      );
      if (!rows.length) throw new Failure("superseded", "Worker lease expired.");
    };
    const heartbeat = setInterval(() => {
      void this.db
        .query(
          "UPDATE jobs SET lease_until=now()+interval '45 seconds' WHERE id=$1 AND lease_token=$2 AND lease_until>now()",
          [job.id, job.lease_token],
        )
        .catch((e: unknown) => this.report(e, job));
    }, 10000);
    try {
      const result = await this.dispatch(job, guard);
      await guard();
      await this.db.query(
        "UPDATE jobs SET status=CASE WHEN generation=$3 THEN 'succeeded' ELSE 'queued' END,completed_at=now(),lease_until=NULL,result=$4,last_error=NULL WHERE id=$1 AND lease_token=$2",
        [job.id, job.lease_token, job.generation, json(result ?? {})],
      );
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
      await this.db
        .query(
          "UPDATE jobs SET status=$3,due_at=now()+$4*interval '1 second',lease_until=NULL,last_error=$5,attempts=CASE WHEN $6 THEN GREATEST(0,attempts-1) ELSE attempts END WHERE id=$1 AND lease_token=$2",
          [job.id, job.lease_token, status, delay, diagnostic, waiting],
        )
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
