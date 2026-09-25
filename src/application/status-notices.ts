/**
 * Officer status notices (2.27.0, issue #31; owner decisions of 2026-09-25, REQUIREMENTS.md
 * "Approved status-notice amendments"): one post in the officer notifications channel about two
 * minutes after the first change, naming the members who gained or lost Member, Guest, Officer or
 * FC Leader and the linked characters that left the FC. The per-member state is on `guild_users`
 * (migration 010); the pure rules are in src/domain/status.ts.
 *
 * Recording: a successful reconciliation pass records its decisive values (recordStatus), and the
 * accepted roster records confirmed departures in its own transaction (lockDepartingOwners, then
 * recordDepartures). Either queues the guild's one `officer.status` job, key officer:<guild>:status.
 * With no officer notifications channel nothing is saved for later (owner decision 5): a pass takes
 * its change as announced at once, the roster records no departure, and neither queues the job.
 *
 * Delivery (deliverStatus): a batch frozen earlier is resent first, unchanged and with no waits
 * (or only marked, when its `delivered` attempt shows Discord already took it); then the job waits
 * (`ordered`) until the oldest waiting change is two minutes old; then it drains everything waiting
 * at that moment in budget-sized batches while the guild's settings stay as the run found them.
 * Each batch is frozen on its members' rows under the job's lease, sent under the nonce key
 * status:<batch>, recorded as delivered, and marked right after, before any lease check, so a lost
 * lease never leaves a posted batch unmarked.
 *
 * Lock order: every transaction here takes the guild row FOR SHARE first (recordStatus, freeze,
 * mark, the no-channel drop), then guild_users rows in (guild_id, user_id) order compared as plain
 * strings (COLLATE "C"), then (recordStatus and the roster only, through enqueue) the guild's status
 * job row last. /config, /setup and activation lock the guild row FOR UPDATE before any member row,
 * so they queue behind these on the guild row rather than deadlocking with them; the guild-first
 * lock matters for recordStatus too, since its job insert takes FOR KEY SHARE on the guild row
 * through the foreign key. Member rows are locked FOR NO KEY UPDATE: like FOR UPDATE it serializes
 * with every other member-row lock (the FOR UPDATE of /unclaim, /verify and the two-404 unlink
 * included), but it doesn't block the FOR KEY SHARE that foreign-key checks take, so an insert that
 * references a member (the roster's membership_history, links, grants) never waits on these. The
 * roster and sync.guild take the same locks in the same order (see Synchronization).
 */
import { randomUUID } from "node:crypto";
import { and, eq, gt, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { statusFits } from "../discord/presenters/officer.js";
import {
  addDeparture,
  applyPosted,
  type Departure,
  dropPending,
  entryFor,
  entryVisible,
  isPending,
  type Observation,
  observe,
  readPosting,
  readState,
  STATUS_POST_MEMBERS,
  STATUS_WINDOW_SECONDS,
  type StatusEntry,
  type StatusPosting,
  type StatusState,
} from "../domain/status.js";
import { Failure } from "../domain/values.js";
import { type Connection, type Orm, orm } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import { enqueue, type Job } from "../jobs/queue.js";
import type { GuildRecord, StatusPostView } from "./records.js";
import type { Service } from "./service.js";

/** The guild's one status job: every recorded change merges into it (enqueue bumps its generation). */
export const statusNoticeKey = (guild: string): string => `officer:${guild}:status`;

/**
 * Queue the guild's status post, due one window from now; an active one keeps its earlier due time
 * (enqueue's least(due_at)), and a running one is requeued for the new change when it finishes.
 */
export const queueStatus = (client: Connection, guild: string): Promise<string> =>
  enqueue(client, "officer.status", statusNoticeKey(guild), {}, guild, null, STATUS_WINDOW_SECONDS);

/** guild_users rows compared as plain strings, whatever the database's collation (the lock order). */
const byUser = sql`${t.guildUsers.user_id} COLLATE "C"`;

/** Plain string order, matching COLLATE "C" for decimal IDs. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The guild settings a status transaction reads under its share lock, and the database clock. */
interface LockedGuild {
  readonly at: Date;
  readonly active: boolean;
  readonly effects: boolean;
  readonly channel: string | null;
}

/**
 * Share-lock the guild row before any of its guild_users rows (the header's lock order), so these
 * transactions queue behind /config adoption, /setup and activation, which lock it FOR UPDATE
 * before theirs, instead of deadlocking with them. Returns the settings the caller acts on, read
 * under that lock, with the database clock; null when the guild has no row.
 */
async function lockGuild(db: Orm, guildId: string): Promise<LockedGuild | null> {
  const [row] = await db
    .select({
      at: sql<Date>`now()`,
      active: t.guilds.active,
      effects: t.guilds.effects_enabled,
      channel: t.guilds.officer_notifications_channel_id,
    })
    .from(t.guilds)
    .where(eq(t.guilds.id, guildId))
    .for("share");
  return row ? { ...row, at: new Date(row.at) } : null;
}

/**
 * Record one successful reconciliation pass (§4). Called by Synchronization.user after the role
 * write succeeded and the job result was stored, never from a preview. One transaction: the guild
 * row (shared), the member's row, then (only when a decisive value moved) the guild's status job.
 * With no guild_users row yet (a gateway event queued the pass before any enumeration), nothing is
 * written, and no log line either: the next reconcile.guild creates the row, and its pass takes the
 * baseline silently, as nickname() waits too. An unchanged pass writes nothing. With no officer
 * notifications channel the change is taken as announced at once and nothing is queued (owner
 * decision 5: changes made while it is unset aren't saved for later); what waited from before the
 * unset is dropped by the job its change queued. Returns whether a post was queued.
 */
export async function recordStatus(
  app: Service,
  guildId: string,
  userId: string,
  joinedAt: Date,
  observation: Observation,
): Promise<boolean> {
  return app.db.transaction(async (client) => {
    const db = orm(client);
    const guild = await lockGuild(db, guildId);
    if (!guild) return false;
    const scope = and(eq(t.guildUsers.guild_id, guildId), eq(t.guildUsers.user_id, userId));
    const [row] = await db
      .select({ state: t.guildUsers.status_state })
      .from(t.guildUsers)
      .where(scope)
      .for("no key update");
    if (!row) return false;
    const recorded = observe(readState(row.state), observation, joinedAt.toISOString());
    if (!recorded.changed) return false;
    if (!guild.channel) {
      await db
        .update(t.guildUsers)
        .set({ status_state: dropPending(recorded.next), status_since: null })
        .where(scope);
      return false;
    }
    await db
      .update(t.guildUsers)
      .set({
        status_state: recorded.next,
        status_since: recorded.pending ? sql`coalesce(${t.guildUsers.status_since},now())` : null,
      })
      .where(scope);
    // Every recorded move queues, not only the first: a change during a running post bumps the
    // job's generation, so the queue runs it again (after the window) when this run finishes.
    if (recorded.moved) await queueStatus(client, guildId);
    return recorded.moved;
  });
}

/** One departing link's owner, as the roster found it. */
export interface DepartingOwner {
  readonly guild: string;
  readonly user: string;
}
/** A departing owner's map key. */
const ownerKey = (owner: DepartingOwner): string => `${owner.guild}:${owner.user}`;

/**
 * The roster's step 3 (§5): lock the owners of every departing link in one statement, in (guild_id,
 * user_id) order, before the roster touches any characters row, the order /unclaim, /assign and the
 * two-404 unlink use. The roster passes only owners in guilds with an officer notifications channel,
 * since no other departure is recorded. Returns each owner's stored state (null when there is none
 * or it is unreadable). Usually matches no rows. Every link has its guild_users row (a foreign key).
 */
export async function lockDepartingOwners(
  client: Connection,
  owners: readonly DepartingOwner[],
): Promise<Map<string, StatusState | null>> {
  const states = new Map<string, StatusState | null>();
  if (!owners.length) return states;
  const rows = await orm(client)
    .select({
      guild_id: t.guildUsers.guild_id,
      user_id: t.guildUsers.user_id,
      state: t.guildUsers.status_state,
    })
    .from(t.guildUsers)
    .where(
      or(
        ...owners.map((owner) =>
          and(eq(t.guildUsers.guild_id, owner.guild), eq(t.guildUsers.user_id, owner.user)),
        ),
      ),
    )
    .orderBy(sql`${t.guildUsers.guild_id} COLLATE "C"`, byUser)
    .for("no key update");
  for (const row of rows)
    states.set(ownerKey({ guild: row.guild_id, user: row.user_id }), readState(row.state));
  return states;
}

/**
 * The roster's step 5 (§5): fold one guild's confirmed departures into their owners' states, locked
 * earlier by lockDepartingOwners, and queue the guild's status post once. It shares the snapshot
 * transaction with the membership change, so a departure is recorded exactly once: a failed
 * transaction records nothing and the retry evaluates again. `channel` is the guild's officer
 * notifications channel, read under the roster's share lock on the guild row: with none, nothing
 * is recorded or queued (owner decision 5). Returns how many were recorded.
 */
export async function recordDepartures(
  client: Connection,
  guildId: string,
  channel: string | null,
  departures: readonly { readonly user: string; readonly departure: Departure }[],
  states: Map<string, StatusState | null>,
): Promise<number> {
  if (!channel || !departures.length) return 0;
  const db = orm(client);
  const users = [...new Set(departures.map((item) => item.user))].sort(byText);
  for (const user of users) {
    const key = ownerKey({ guild: guildId, user });
    let state = states.get(key) ?? null;
    for (const item of departures)
      if (item.user === user) state = addDeparture(state, item.departure);
    states.set(key, state);
    await db
      .update(t.guildUsers)
      .set({ status_state: state, status_since: sql`coalesce(${t.guildUsers.status_since},now())` })
      .where(and(eq(t.guildUsers.guild_id, guildId), eq(t.guildUsers.user_id, user)));
  }
  await queueStatus(client, guildId);
  return departures.length;
}

/** The guild's rows that wait for a post or sit in one, locked in user order. */
function lockWaiting(db: Orm, guildId: string, due: SQL<boolean>) {
  return db
    .select({
      user_id: t.guildUsers.user_id,
      state: t.guildUsers.status_state,
      posting: t.guildUsers.status_posting,
      since: t.guildUsers.status_since,
      due,
    })
    .from(t.guildUsers)
    .where(
      and(
        eq(t.guildUsers.guild_id, guildId),
        or(isNotNull(t.guildUsers.status_since), isNotNull(t.guildUsers.status_posting)),
      ),
    )
    .orderBy(byUser)
    .for("no key update");
}

/**
 * No officer notifications channel (checked before the effects gate, like `layout disabled`):
 * nothing is saved for later (owner decision 5). One transaction announces what waits as it is,
 * drops unposted departures and any frozen batch, so no job parks just because the channel is unset.
 */
export async function dropStatus(app: Service, guildId: string): Promise<{ skipped: string }> {
  await app.db.transaction(async (client) => {
    const db = orm(client);
    await lockGuild(db, guildId);
    const rows = await lockWaiting(db, guildId, sql<boolean>`true`);
    for (const row of rows) {
      const state = readState(row.state);
      await db
        .update(t.guildUsers)
        .set({
          ...(state ? { status_state: dropPending(state) } : {}),
          status_since: null,
          status_posting: null,
        })
        .where(and(eq(t.guildUsers.guild_id, guildId), eq(t.guildUsers.user_id, row.user_id)));
    }
  });
  return { skipped: "officer notifications unconfigured" };
}

/**
 * A frozen batch: its ID (the nonce key's), the view every send of it renders, and whether it was
 * frozen before this call found it (so Discord may already hold it; see postBatch).
 */
interface FrozenBatch {
  readonly id: string;
  readonly view: StatusPostView;
  readonly resumed: boolean;
}

/** The nonce key a batch is sent under, also stored on its `delivered` attempt. */
const statusNonce = (batch: string): string => `status:${batch}`;

/**
 * The frozen batch among these rows, if any: the lowest frozenAt, entries in seq order. At most one
 * exists per guild (only the lease holder freezes, and freezing resumes one first); taking the
 * oldest covers anything else.
 */
function frozenIn(rows: readonly { posting: unknown }[]): FrozenBatch | null {
  const postings = rows
    .map((row) => readPosting(row.posting))
    .filter((posting): posting is StatusPosting => posting !== null)
    .sort((a, b) => byText(a.frozenAt, b.frozenAt) || byText(a.batch, b.batch));
  const first = postings[0];
  if (!first) return null;
  const entries = postings
    .filter((posting) => posting.batch === first.batch)
    .sort((a, b) => a.seq - b.seq)
    .map((posting) => posting.entry);
  return { id: first.batch, view: { frozenAt: first.frozenAt, entries }, resumed: true };
}

/** A batch frozen earlier, read without locks: its rows stay frozen until a mark clears them. */
async function frozenBatch(app: Service, guildId: string): Promise<FrozenBatch | null> {
  return frozenIn(
    await app.db.orm
      .select({ posting: t.guildUsers.status_posting })
      .from(t.guildUsers)
      .where(and(eq(t.guildUsers.guild_id, guildId), isNotNull(t.guildUsers.status_posting))),
  );
}

/**
 * Freeze the next batch (§6 step 3a) from the rows waiting at `cutoff`, oldest first, in one
 * transaction: the guild row, the waiting rows in user order (the global lock order, not the age
 * order), and a lease check, so only the lease holder starts a post. A batch already frozen is
 * returned instead, to be resent unchanged. Members are added while the post still fits
 * (statusFits, the layout the send renders) up to 100; the first that doesn't fit leads the next
 * batch, and one that doesn't fit even alone is frozen alone. A row found not waiting is cleared;
 * a change with no line of its own is announced silently. Returns null when nothing is left.
 *
 * Under the guild's share lock it first checks that the run may still post to `channel`, the one
 * the run started with (owner decision 5: posts go out only while the channel is set, and wait while
 * Discord changes are paused). Otherwise it throws `superseded`, a wait: the rerun, about a second
 * later, drops what waits (no channel), parks (paused) or posts to the new channel, resending a
 * batch already frozen first, as usual.
 */
async function freeze(
  app: Service,
  guildId: string,
  channel: string,
  job: Job,
  cutoff: string,
): Promise<FrozenBatch | null> {
  return app.db.transaction(async (client) => {
    const db = orm(client);
    const guild = await lockGuild(db, guildId);
    if (!guild?.active || !guild.effects || guild.channel !== channel)
      throw new Failure("superseded", "Status post settings changed during the run.");
    const now = guild.at;
    const rows = await lockWaiting(
      db,
      guildId,
      sql<boolean>`coalesce(${t.guildUsers.status_since}<=${cutoff}::timestamptz,false)`,
    );
    const frozen = frozenIn(rows);
    if (frozen) return frozen;
    const [lease] = await db
      .select({ id: t.jobs.id })
      .from(t.jobs)
      .where(
        and(
          eq(t.jobs.id, job.id),
          eq(t.jobs.lease_token, job.lease_token),
          gt(t.jobs.lease_until, sql`now()`),
        ),
      );
    if (!lease)
      throw new Failure(
        "lease_lost",
        "Worker lease expired or was reclaimed; another worker owns this job.",
      );
    const write = (user: string, values: Partial<typeof t.guildUsers.$inferInsert>) =>
      db
        .update(t.guildUsers)
        .set(values)
        .where(and(eq(t.guildUsers.guild_id, guildId), eq(t.guildUsers.user_id, user)));
    // An unreadable posting (none survives a mark) is dropped, so it can't hold a row forever.
    for (const row of rows)
      if (row.posting !== null && !readPosting(row.posting))
        await write(row.user_id, { status_posting: null });
    const candidates = rows
      .filter((row) => row.due && row.since)
      .sort(
        (a, b) =>
          (a.since?.getTime() ?? 0) - (b.since?.getTime() ?? 0) || byText(a.user_id, b.user_id),
      );
    const frozenAt = now.toISOString();
    const entries: StatusEntry[] = [];
    for (const row of candidates) {
      const state = readState(row.state);
      const entry = state ? entryFor(row.user_id, state) : null;
      if (!state || !entry) {
        await write(row.user_id, { status_since: null });
        continue;
      }
      if (!entryVisible(entry)) {
        const next = applyPosted(state, entry);
        await write(row.user_id, {
          status_state: next,
          ...(isPending(next) ? {} : { status_since: null }),
        });
        continue;
      }
      if (entries.length >= STATUS_POST_MEMBERS) break;
      const fits = statusFits({ frozenAt, entries: [...entries, entry] });
      if (!fits && entries.length) break;
      entries.push(entry);
      if (!fits) break;
    }
    if (!entries.length) return null;
    const batch = randomUUID();
    for (const [seq, entry] of entries.entries())
      await write(entry.user, { status_posting: { batch, seq, frozenAt, entry } });
    return { id: batch, view: { frozenAt, entries }, resumed: false };
  });
}

/**
 * The mark (§6 step 3c), right after the send and before any lease check: apply each posted entry
 * to its member's current state, keep what changed since the freeze waiting from now, and clear the
 * batch. Matched on the exact batch, so it is idempotent: a stale and a current worker may both
 * resend the same batch under the same nonce, and whichever marks second finds no rows.
 */
async function markPosted(app: Service, guildId: string, batch: string): Promise<void> {
  await app.db.transaction(async (client) => {
    const db = orm(client);
    await lockGuild(db, guildId);
    const rows = await db
      .select({
        user_id: t.guildUsers.user_id,
        state: t.guildUsers.status_state,
        posting: t.guildUsers.status_posting,
      })
      .from(t.guildUsers)
      .where(
        and(
          eq(t.guildUsers.guild_id, guildId),
          sql`${t.guildUsers.status_posting}->>'batch'=${batch}`,
        ),
      )
      .orderBy(byUser)
      .for("no key update");
    for (const row of rows) {
      const state = readState(row.state);
      const posting = readPosting(row.posting);
      const next = state && posting ? applyPosted(state, posting.entry) : state;
      await db
        .update(t.guildUsers)
        .set({
          ...(next ? { status_state: next } : {}),
          status_since: next && isPending(next) ? sql`now()` : null,
          status_posting: null,
        })
        .where(and(eq(t.guildUsers.guild_id, guildId), eq(t.guildUsers.user_id, row.user_id)));
    }
  });
}

/**
 * Send one frozen batch and mark it (§6 steps 3b and 3c), recording a `started` attempt, then a
 * `failed` one with the Failure code when the send fails (as the dispatcher's shared tail does),
 * leaving the batch frozen for the retry to resend. Once Discord has taken the post, nothing that
 * follows is a failed delivery: the `delivered` attempt, with the message ID and the batch's nonce
 * key, is written before the mark, so if the mark then fails (the database, say), the job's retry
 * finds it and only marks the batch (postBatch) rather than posting it twice after Discord's nonce
 * window has passed. No in-process retry: the job's own retry does that, with backoff.
 */
async function sendBatch(
  app: Service,
  guildId: string,
  channel: string,
  job: Job,
  batch: FrozenBatch,
): Promise<{ messageId: string; members: number }> {
  await app.db.orm.insert(t.deliveryAttempts).values({ job_id: job.id, status: "started" });
  let messageId: string;
  try {
    messageId = await app.discord.send(
      guildId,
      channel,
      { kind: "status", view: batch.view },
      statusNonce(batch.id),
    );
  } catch (error) {
    await app.db.orm.insert(t.deliveryAttempts).values({
      job_id: job.id,
      status: "failed",
      diagnostic: error instanceof Failure ? error.code : "delivery_failed",
    });
    throw error;
  }
  await app.db.orm.insert(t.deliveryAttempts).values({
    job_id: job.id,
    status: "delivered",
    message_id: messageId,
    diagnostic: statusNonce(batch.id),
  });
  await markPosted(app, guildId, batch.id);
  return { messageId, members: batch.view.entries.length };
}

/** The message ID Discord gave a batch, from its `delivered` attempt; null when none is recorded. */
async function deliveredMessage(app: Service, batch: string): Promise<string | null> {
  const [row] = await app.db.orm
    .select({ messageId: t.deliveryAttempts.message_id })
    .from(t.deliveryAttempts)
    .where(
      and(
        eq(t.deliveryAttempts.status, "delivered"),
        eq(t.deliveryAttempts.diagnostic, statusNonce(batch)),
      ),
    )
    .limit(1);
  return row?.messageId ?? null;
}

/**
 * Post one batch: a batch frozen before this run found it may already be in the channel, when an
 * earlier run's mark failed after the send; then it is only marked. Anything else is sent. The check
 * reads delivery_attempts only for such a resumed batch, which is rare.
 */
async function postBatch(
  app: Service,
  guildId: string,
  channel: string,
  job: Job,
  batch: FrozenBatch,
): Promise<{ messageId: string; members: number }> {
  const posted = batch.resumed ? await deliveredMessage(app, batch.id) : null;
  if (posted === null) return sendBatch(app, guildId, channel, job, batch);
  await markPosted(app, guildId, batch.id);
  return { messageId: posted, members: batch.view.entries.length };
}

/**
 * Seconds until the oldest waiting change is one window old (0 or less: post now), or null when
 * nothing waits. All window arithmetic uses the database clock.
 */
async function windowRemaining(app: Service, guildId: string): Promise<number | null> {
  const [row] = await app.db.orm
    .select({
      remaining: sql<
        number | null
      >`extract(epoch from min(${t.guildUsers.status_since})+${STATUS_WINDOW_SECONDS}*interval '1 second'-now())::float8`,
    })
    .from(t.guildUsers)
    .where(and(eq(t.guildUsers.guild_id, guildId), isNotNull(t.guildUsers.status_since)));
  return row?.remaining ?? null;
}

/** The job result for posts this run completed. */
function delivered(posts: readonly { messageId: string; members: number }[]) {
  return {
    status: "delivered",
    posts: posts.length,
    members: posts.reduce((sum, item) => sum + item.members, 0),
    messageIds: posts.map((item) => item.messageId),
  };
}

/**
 * The officer.status job (§6), after the dispatcher's no-channel check and effects gate:
 * 1. resend a frozen batch first, with no waits, so a retry lands inside Discord's nonce window
 *    (or only mark it, when its `delivered` attempt shows Discord already took it);
 * 2. wait (`ordered`, which refunds the attempt) until the oldest waiting change is two minutes
 *    old, or finish when nothing waits;
 * 3. drain everything waiting at the cutoff, one frozen batch at a time, each sent, marked, then
 *    lease-checked; each freeze first checks that the guild's settings still allow this post.
 * The result lists the posts this run completed. A batch resent by a run that then waited is in
 * its `delivered` attempt row instead, which holds the message ID.
 */
export async function deliverStatus(
  app: Service,
  guild: GuildRecord,
  job: Job,
  guard: () => Promise<void>,
): Promise<unknown> {
  const channel = guild.officer_notifications_channel_id;
  if (!channel) return dropStatus(app, guild.id);
  const posts: { messageId: string; members: number }[] = [];
  const resume = await frozenBatch(app, guild.id);
  if (resume) {
    await guard();
    posts.push(await postBatch(app, guild.id, channel, job, resume));
  }
  const remaining = await windowRemaining(app, guild.id);
  if (remaining === null) return posts.length ? delivered(posts) : { skipped: "nothing to post" };
  if (remaining > 0)
    throw new Failure("ordered", "Collecting status changes for one post.", Math.ceil(remaining));
  // Only rows waiting now: a change during the drain waits for the next run, after its window, so
  // the drain always ends and never skips the window for newer changes.
  const [clock] = await app.db.orm
    .select({ cutoff: sql<string>`now()::text` })
    .from(t.guilds)
    .where(eq(t.guilds.id, guild.id));
  if (!clock) return posts.length ? delivered(posts) : { skipped: "nothing to post" };
  for (;;) {
    const batch = await freeze(app, guild.id, channel, job, clock.cutoff);
    if (!batch) break;
    posts.push(await postBatch(app, guild.id, channel, job, batch));
    await guard();
  }
  return posts.length ? delivered(posts) : { skipped: "nothing to post" };
}
