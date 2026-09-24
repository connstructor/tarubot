/**
 * The database writer lease (amendment C3) against real PostgreSQL session advisory locks. Each
 * lifecycle gets its own Database (its own pool and sessions, like a separate process) confined to
 * a private schema, so startup writes never touch persistence.test.ts's public schema. Advisory
 * locks are database-wide, so the lifecycles contend exactly as two deployments would. The same
 * harness pins the periodic lease check's SQL against real pg_locks and startup's per-guild enqueue
 * gates (AC-26: no layout work for layout-off guilds, no channel work for onboarding-off guilds).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type LifecycleOptions, WRITER_LEASE_LOCK } from "../../src/application/lifecycle.js";
import type { Configuration } from "../../src/config/env.js";
import { Database, SESSION_OPTIONS } from "../../src/infrastructure/postgres/database.js";
import {
  eventually,
  type LifecycleHarness,
  lifecycleHarness,
  observe,
} from "../fixtures/lifecycle.js";

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = "writer_lease";
/** The runbook gate's probe (docs/OPERATIONS.md): backends holding the writer lease. */
const HOLDERS = `SELECT pid FROM pg_locks
  WHERE locktype = 'advisory' AND granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND classid = 0 AND objid = $1::bigint::oid AND objsubid = 1`;

describe.skipIf(!url)("database writer lease", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  /** Observer connection: sets up the schema and reads pg_locks independently of the lifecycles. */
  const admin = new Database(url);
  // Connection-string options replace the pool's own, so UTC and the statement timeout are restated.
  const confined = new URL(url);
  confined.searchParams.set("options", `${SESSION_OPTIONS} -c search_path=${SCHEMA}`);
  const running: LifecycleHarness[] = [];
  /**
   * A lifecycle with its own pool, as a separately deployed writer would have; `guilds` are the
   * guilds its gateway reports present at startup.
   */
  function writer(
    options: Partial<LifecycleOptions> = {},
    guilds: readonly string[] = [],
    config: Partial<Configuration> = {},
  ): LifecycleHarness {
    const created = lifecycleHarness(new Database(confined.toString()), options, guilds, config);
    running.push(created);
    return created;
  }
  const holders = async () =>
    (await admin.query<{ pid: number }>(HOLDERS, [WRITER_LEASE_LOCK])).map((row) => row.pid);

  beforeAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    // prepare() checks the migrated head, and start() writes guild presence, inside the schema.
    const migrator = new Database(confined.toString());
    try {
      await migrator.migrate();
    } finally {
      await migrator.close();
    }
  });
  afterEach(async () => {
    // stop() is idempotent; a failed assertion must not leave a lease held for the next test.
    await Promise.all(running.splice(0).map(({ lifecycle }) => lifecycle.stop()));
    expect(await holders()).toEqual([]);
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.close();
  });

  test("pooled sessions ask PostgreSQL to end sessions whose client vanished", async () => {
    // Without server-side keepalive an orphaned lease survives a host loss for about two hours.
    const settings = await admin.query<{ name: string; setting: string }>(
      "SELECT name, setting FROM pg_settings WHERE name IN ('tcp_keepalives_idle','tcp_keepalives_interval','tcp_keepalives_count') ORDER BY name",
    );
    expect(settings).toEqual([
      { name: "tcp_keepalives_count", setting: "3" },
      { name: "tcp_keepalives_idle", setting: "30" },
      { name: "tcp_keepalives_interval", setting: "10" },
    ]);
  });

  test("a second writer waits unready while the first holds the lease, and acquires it once the first stops", async () => {
    const first = writer();
    await first.lifecycle.prepare();
    const [firstPid] = await holders();
    expect(firstPid).toBeNumber();
    await first.lifecycle.start();
    expect(first.queueStarts()).toBe(1);
    expect(await first.probe("/health/ready")).toMatchObject({
      status: 200,
      body: { ready: true, writerLease: true },
    });

    const second = writer();
    const prepared = observe(second.lifecycle.prepare());
    // Several retry intervals pass with the lock still held by the first writer's session.
    await eventually(
      "three contended attempts",
      () =>
        second.logs.filter((line) => line.msg.startsWith("Waiting for the database writer"))
          .length >= 3,
    );
    expect(prepared.settled()).toBe(false);
    expect(second.logs.at(-1)).toMatchObject({ lock: WRITER_LEASE_LOCK, holderPid: firstPid });
    expect(await holders()).toEqual([firstPid as number]);
    expect(await second.probe("/health/live")).toMatchObject({ status: 200 });
    expect(await second.probe("/health/ready")).toMatchObject({
      status: 503,
      body: { ready: false, database: true, writerLease: false },
    });
    // Neither startup writes nor queue workers run for the waiting writer.
    const ready = observe(second.lifecycle.whenReady());
    await expect(second.lifecycle.start()).rejects.toMatchObject({ code: "writer_lease" });
    await expect(ready.result).rejects.toMatchObject({ code: "writer_lease" });
    expect(second.queueStarts()).toBe(0);

    // A graceful stop unlocks before the pool closes, so the waiting writer takes over promptly.
    await first.lifecycle.stop();
    await prepared.result;
    const [secondPid] = await holders();
    expect(secondPid).toBeNumber();
    expect(secondPid).not.toBe(firstPid);
    await second.lifecycle.start();
    expect(await second.probe("/health/ready")).toMatchObject({ status: 200 });
  });

  test("stopping a waiting writer leaves the holder's lease intact", async () => {
    const holder = writer();
    await holder.lifecycle.prepare();
    const [holderPid] = await holders();
    const waiting = writer();
    const prepared = observe(waiting.lifecycle.prepare());
    await eventually("a contended attempt", () =>
      waiting.logs.some((line) => line.msg.startsWith("Waiting for the database writer")),
    );
    await waiting.lifecycle.stop();
    await expect(prepared.result).rejects.toMatchObject({ code: "stopping" });
    // Its pool closed (the session was returned), and the holder was never disturbed.
    expect(await holders()).toEqual([holderPid as number]);
    expect(waiting.lifecycle.isStopping()).toBe(true);
  });

  test("a writer whose lease session is terminated stops and exits non-zero, freeing the lease", async () => {
    const lost = writer();
    await lost.lifecycle.prepare();
    await lost.lifecycle.start();
    const [pid] = await holders();
    // A database restart or failover ends the session; PostgreSQL frees the lock with it.
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await eventually("the lost-lease exit", () => lost.exits.length > 0);
    expect(lost.exits).toEqual([1]);
    expect(lost.reports).toContain("writer-lease");
    expect(lost.lifecycle.isStopping()).toBe(true);
    // A replacement writer can now take the lease.
    const replacement = writer();
    await replacement.lifecycle.prepare();
    expect(await holders()).toHaveLength(1);
  });

  test("the periodic lease check confirms a held lease against real pg_locks", async () => {
    const checked = writer({ leaseCheckMs: 20 });
    await checked.lifecycle.prepare();
    await checked.lifecycle.start();
    const [pid] = await holders();
    // The lease backend's latest statement becomes the check once the first one has run.
    const latest = async () =>
      (
        await admin.query<{ query: string }>("SELECT query FROM pg_stat_activity WHERE pid = $1", [
          pid,
        ])
      )[0]?.query ?? "";
    await eventually("a lease check on the lease session", async () =>
      (await latest()).includes("pg_backend_pid"),
    );
    // Several more intervals: the check finds this session's lock every time.
    await Bun.sleep(150);
    expect(checked.exits).toEqual([]);
    expect(checked.reports).toEqual([]);
    expect(await holders()).toEqual([pid as number]);
    expect(await checked.probe("/health/ready")).toMatchObject({
      status: 200,
      body: { ready: true, writerLease: true },
    });
  });

  test("startup schedules layout and channel work only for guilds whose switches are on", async () => {
    // IDs used by no other test in this schema. `on` has both switches on, `off` neither.
    const on = "7310000000000000001";
    const off = "7310000000000000002";
    // Onboarding on requires the managed roles and both rooms (access_setup_complete).
    await admin.query(
      `INSERT INTO ${SCHEMA}.guilds (id, role_layout_enabled, access_policy_enabled, member_role_id,
         guest_role_id, officer_role_id, leader_role_id, lobby_channel_id, officer_channel_id)
       VALUES ($1, true, true, '7310000000000000011', '7310000000000000012',
         '7310000000000000013', '7310000000000000014', '7310000000000000015', '7310000000000000016'),
       ($2, false, false, NULL, NULL, NULL, NULL, NULL, NULL)`,
      [on, off],
    );
    const started = writer({}, [on, off]);
    await started.lifecycle.prepare();
    await started.lifecycle.start();
    const jobs = await admin.query<{ guild_id: string; kind: string; dedupe_key: string }>(
      `SELECT guild_id::text, kind, dedupe_key FROM ${SCHEMA}.jobs
       WHERE guild_id IN ($1, $2) ORDER BY guild_id, kind`,
      [on, off],
    );
    // Both get the repair pass; only the layout-on guild gets roles.layout (AC-26), and only the
    // onboarding-on guild gets channels.access.
    expect(jobs).toEqual([
      { guild_id: on, kind: "channels.access", dedupe_key: `channel-access:${on}` },
      { guild_id: on, kind: "reconcile.guild", dedupe_key: `guild:${on}` },
      { guild_id: on, kind: "roles.layout", dedupe_key: `role-layout:${on}` },
      { guild_id: off, kind: "reconcile.guild", dedupe_key: `guild:${off}` },
    ]);
  });

  test("a restart with effects on requeues work parked while they were off, once per dedupe key", async () => {
    // `live` is activated (its own effects flag on); `waiting` is an imported guild awaiting
    // activation, whose parked work must keep waiting.
    const live = "7310000000000000021";
    const waiting = "7310000000000000022";
    await admin.query(
      `INSERT INTO ${SCHEMA}.guilds (id, effects_enabled, role_layout_enabled, access_policy_enabled)
       VALUES ($1, true, false, false), ($2, false, false, false)`,
      [live, waiting],
    );
    /** Park a job as the dispatcher does while effects are off, created `age` minutes ago. */
    const park = async (
      guild: string,
      kind: string,
      key: string,
      age: number,
      status = "disabled",
    ) =>
      (
        await admin.query<{ id: string }>(
          `INSERT INTO ${SCHEMA}.jobs (kind, dedupe_key, payload, guild_id, status, attempts,
             last_error, created_at)
           VALUES ($1, $2, '{}'::jsonb, $3, $4, 2, 'disabled: Discord effects are disabled pending activation.',
             now() - $5 * interval '1 minute')
           RETURNING id::text`,
          [kind, key, guild, status, age],
        )
      )[0]?.id ?? "";
    // Two parked rows share a key (a repeated /refresh while paused); the newer one survives.
    const older = await park(live, "reconcile.user", `user:${live}:1`, 30);
    const newer = await park(live, "reconcile.user", `user:${live}:1`, 10);
    // The older pass had already applied roles before it was parked (for example, its nickname was
    // blocked): that `applied` evidence is the only record of what Discord received.
    const applied = [
      {
        generation: 1,
        add: ["7310000000000000031"],
        remove: [],
        status: "applied",
        at: "2026-09-20T00:00:00.000Z",
      },
    ];
    await admin.query(`UPDATE ${SCHEMA}.jobs SET result = $2::jsonb WHERE id = $1`, [
      older,
      JSON.stringify({ applied }),
    ]);
    const post = await park(live, "ledger.notify", `ledger:${live}:1`, 20);
    // Startup's own repair pass replaces a parked one instead of colliding with it.
    const repair = await park(live, "reconcile.guild", `guild:${live}`, 40);
    // Blocked work still needs its fix first; the unactivated guild keeps waiting.
    const blocked = await park(live, "roles.layout", `role-layout:${live}`, 5, "blocked");
    const held = await park(waiting, "reconcile.user", `user:${waiting}:1`, 5);
    const state = async () =>
      new Map(
        (
          await admin.query<{
            id: string;
            status: string;
            attempts: number;
            last_error: string | null;
            result: unknown;
          }>(
            `SELECT id::text, status, attempts, last_error, result FROM ${SCHEMA}.jobs
             WHERE guild_id IN ($1, $2)`,
            [live, waiting],
          )
        ).map((row) => [row.id, row]),
      );

    // With effects still off, a restart leaves every parked row alone.
    const paused = writer({}, [live, waiting]);
    await paused.lifecycle.prepare();
    await paused.lifecycle.start();
    await paused.lifecycle.stop();
    for (const id of [older, newer, post, repair, held])
      expect((await state()).get(id)?.status).toBe("disabled");

    const resumed = writer({}, [live, waiting], { ENABLE_EFFECTS: true });
    await resumed.lifecycle.prepare();
    await resumed.lifecycle.start();
    const after = await state();
    // The newest row per key runs now with a fresh attempt budget and without the stale paused
    // diagnostic, so it reads `… QUEUED` rather than a retry after a Discord error.
    for (const id of [newer, post])
      expect(after.get(id)).toMatchObject({ status: "queued", attempts: 0, last_error: null });
    // The rows it replaces close as superseded, never as delivered work; a closed reconcile.user
    // keeps its `applied` list (OPERATIONS.md), and a row without one gains nothing else.
    expect(after.get(older)).toMatchObject({ status: "succeeded", last_error: null });
    expect(after.get(older)?.result).toEqual({ skipped: "superseded", applied });
    expect(after.get(repair)).toMatchObject({ status: "succeeded", last_error: null });
    expect(after.get(repair)?.result).toEqual({ skipped: "superseded" });
    expect(after.get(blocked)?.status).toBe("blocked");
    expect(after.get(held)?.status).toBe("disabled");
    // Exactly one active repair pass for the guild, and the count (not payloads) is logged.
    expect(
      await admin.query(
        `SELECT status FROM ${SCHEMA}.jobs WHERE dedupe_key = $1 AND status = 'queued'`,
        [`guild:${live}`],
      ),
    ).toEqual([{ status: "queued" }]);
    expect(resumed.logs).toContainEqual(
      expect.objectContaining({
        msg: "Requeued work held while Discord changes were off",
        requeued: 2,
      }),
    );
  });
});
