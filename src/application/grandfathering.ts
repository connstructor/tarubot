/**
 * First-activation Guest grandfathering shared by the read-only preview and activation (owner
 * decision 3, 2026-09-23). Planning classifies every currently enumerated human with the same
 * accessFacts/desiredAccess inputs a reconcile.user pass uses, so the previewed plan is exactly the
 * set activation writes; the plan checksum ties the two together. Writing happens only inside
 * activation's transaction, through the caller's client, together with the effects flip.
 */
import { and, desc, eq, gt, notExists, sql } from "drizzle-orm";
import {
  assemblePlan,
  compareIds,
  type GrandfatherCandidate,
  type GrandfatherPlan,
  grandfatherBasis,
  type Subset,
  subset,
} from "../domain/grandfathering.js";
import { desiredAccess } from "../domain/policy.js";
import { Failure } from "../domain/values.js";
import {
  audit,
  type Connection,
  ensureUser,
  type Orm,
  orm,
} from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import { accessFacts } from "./access-facts.js";
import type { GuildRecord, MemberView } from "./records.js";

/** The accepted evidence a plan is built from; its IDs become part of the plan checksum. */
export interface GrandfatherEvidence {
  /** The latest `migration.import` audit's target (the legacy source fingerprint), if any. */
  importFingerprint: string | null;
  importedAt: Date | null;
  /** The latest accepted roster snapshot for the guild's FC, if it has one. */
  rosterSnapshotId: string | null;
  rosterObservedAt: Date | null;
}

/**
 * Users with an active trusted link whose FC character awaits departure confirmation: their
 * membership row for this guild and its FC is `missing` after one absent accepted roster. Such
 * rows still count as membership, so a plan built now would change once the next roster confirms
 * the departure (amendment C2). Rows of deactivated links are left out: no roster ever revisits
 * them and they no longer affect access.
 */
export async function pendingDepartures(db: Orm, guild: GuildRecord): Promise<Subset> {
  if (!guild.fc_id) return subset([]);
  const rows = await db
    .selectDistinct({ user: t.links.user_id })
    .from(t.membership)
    .innerJoin(
      t.links,
      and(
        eq(t.links.guild_id, t.membership.guild_id),
        eq(t.links.character_id, t.membership.character_id),
        eq(t.links.active, true),
      ),
    )
    .where(
      and(
        eq(t.membership.guild_id, guild.id),
        eq(t.membership.fc_id, guild.fc_id),
        eq(t.membership.state, "missing"),
      ),
    );
  return subset(rows.map((row) => row.user));
}

/** The refusal shared by preview, planning and activation while departures await confirmation. */
export function pendingDepartureFailure(pending: Subset): Failure {
  return new Failure(
    "stale",
    `${pending.count} linked FC character(s) await departure confirmation. Run roster:acquire again at least 60 seconds after the previous acquisition, then preview again.`,
  );
}

/**
 * Read and check the evidence a plan needs: a fresh accepted roster (the activation predicate,
 * last_successful_roster_at within freshnessSeconds) whose snapshot is newer than the import, so
 * roster publication has evaluated every imported link. Guilds without an FC have no roster
 * evidence and classify everyone as ineligible.
 */
export async function grandfatherEvidence(
  db: Orm,
  guild: GuildRecord,
  freshnessSeconds: number,
): Promise<GrandfatherEvidence> {
  const [imported] = await db
    .select({ fingerprint: t.auditEvents.target, at: t.auditEvents.event_at })
    .from(t.auditEvents)
    .where(and(eq(t.auditEvents.guild_id, guild.id), eq(t.auditEvents.action, "migration.import")))
    .orderBy(desc(t.auditEvents.event_at), desc(t.auditEvents.id))
    .limit(1);
  const evidence: GrandfatherEvidence = {
    importFingerprint: imported?.fingerprint ?? null,
    importedAt: imported?.at ?? null,
    rosterSnapshotId: null,
    rosterObservedAt: null,
  };
  if (!guild.fc_id) return evidence;
  const fresh = await db
    .select({ id: t.freeCompanies.id })
    .from(t.freeCompanies)
    .where(
      and(
        eq(t.freeCompanies.id, guild.fc_id),
        gt(
          t.freeCompanies.last_successful_roster_at,
          sql`now()-${freshnessSeconds}*interval '1 second'`,
        ),
      ),
    );
  const [snapshot] = await db
    .select({ id: t.rosterSnapshots.id, observed_at: t.rosterSnapshots.observed_at })
    .from(t.rosterSnapshots)
    .where(eq(t.rosterSnapshots.fc_id, guild.fc_id))
    .orderBy(desc(t.rosterSnapshots.observed_at), desc(t.rosterSnapshots.id))
    .limit(1);
  if (!fresh.length || !snapshot)
    throw new Failure(
      "stale",
      "Acquire a fresh complete roster with roster:acquire before grandfathering.",
    );
  if (evidence.importedAt && snapshot.observed_at <= evidence.importedAt)
    throw new Failure(
      "stale",
      "The latest accepted roster predates the import. Run roster:acquire after importing.",
    );
  return { ...evidence, rosterSnapshotId: snapshot.id, rosterObservedAt: snapshot.observed_at };
}

/**
 * Build the grandfathering plan for one complete Discord enumeration. Read-only: preview calls it
 * on the pool, activation on its transaction client (after locking the guild row), so both see
 * the same classification. Refuses stale evidence and pending departures with Failure('stale').
 */
export async function planGrandfathering(
  db: Orm,
  guild: GuildRecord,
  members: readonly MemberView[],
  freshnessSeconds: number,
  enumeratedAt: Date,
): Promise<GrandfatherPlan> {
  const evidence = await grandfatherEvidence(db, guild, freshnessSeconds);
  const pending = await pendingDepartures(db, guild);
  if (pending.count) throw pendingDepartureFailure(pending);
  if (new Set(members.map((member) => member.id)).size !== members.length)
    throw new Failure("incomplete", "Discord enumeration returned a member twice. Retry it.");
  // Two guild-wide reads replace per-user lookups. Active grants give the report's provenance;
  // grants /guest reset ended confer nothing, but still count as an existing grant below, so a
  // reset before first activation is not undone by a fresh grandfathered grant (2.15.0).
  const grants = new Map<string, Set<string>>();
  const ended = new Set<string>();
  for (const row of await db
    .select({
      user: t.guestGrants.user_id,
      provenance: t.guestGrants.provenance,
      endedAt: t.guestGrants.ended_at,
    })
    .from(t.guestGrants)
    .where(eq(t.guestGrants.guild_id, guild.id)))
    if (row.endedAt) ended.add(row.user);
    else grants.set(row.user, (grants.get(row.user) ?? new Set()).add(row.provenance));
  const imported = new Set(
    (
      await db
        .select({ user: t.guildUsers.user_id })
        .from(t.guildUsers)
        .where(and(eq(t.guildUsers.guild_id, guild.id), eq(t.guildUsers.imported, true)))
    ).map((row) => row.user),
  );
  const candidates: GrandfatherCandidate[] = [];
  let bots = 0;
  for (const member of members) {
    if (member.bot) {
      bots++;
      continue;
    }
    // The exact inputs of a reconcile.user pass (Synchronization.facts): stored evidence plus the
    // member's current roles.
    const facts = await accessFacts(db, guild, member.id, freshnessSeconds, member.roles);
    const basis = grandfatherBasis({ ...facts, grant: facts.grant || ended.has(member.id) });
    candidates.push({
      userId: member.id,
      basis,
      membership: facts.membership,
      former: facts.former,
      registered: facts.verified === true,
      heldMember: facts.hasMember,
      heldGuest: facts.hasGuest,
      newSinceImport: !imported.has(member.id),
      joinedAt: member.joinedAt,
      existingProvenance: [...(grants.get(member.id) ?? [])].sort(),
      projected: desiredAccess({ ...facts, grant: facts.grant || basis === "grant" }),
    });
  }
  return assemblePlan({
    guildId: guild.id,
    importFingerprint: evidence.importFingerprint,
    rosterSnapshotId: evidence.rosterSnapshotId,
    guestRoleId: guild.guest_role_id,
    enumeratedAt,
    rosterObservedAt: evidence.rosterObservedAt,
    bots,
    candidates,
  });
}

/**
 * Write a confirmed plan inside the caller's activation transaction: one durable `grandfathered`
 * grant per planned user (idempotent by source key), an audit per inserted grant, one completion
 * audit that keeps enumeratedAt for the late-joiner report (amendment C9), and the guild marker.
 * It never reads or writes guest_state (a revocation always stands) and queues no per-user work:
 * activation's reconcile.guild covers every present human.
 */
export async function applyGrandfathering(
  client: Connection,
  plan: GrandfatherPlan,
): Promise<{ granted: number }> {
  const store = orm(client);
  let granted = 0;
  for (const candidate of plan.candidates) {
    if (candidate.basis !== "grant") continue;
    // Users who joined after the cutover snapshot have no guild_users row yet (the grant's FK).
    await ensureUser(client, plan.guildId, candidate.userId, candidate.joinedAt);
    const [grant] = await store
      .insert(t.guestGrants)
      .values({
        guild_id: plan.guildId,
        user_id: candidate.userId,
        provenance: "grandfathered",
        source_key: `grandfather:${plan.guildId}:${candidate.userId}`,
        actor_id: null,
        reason: "Grandfathered Guest at first activation",
        source: {
          planChecksum: plan.checksum,
          enumeratedAt: plan.enumeratedAt,
          rosterObservedAt: plan.rosterObservedAt,
          rosterSnapshotId: plan.rosterSnapshotId,
          membership: candidate.membership,
          former: candidate.former,
          registered: candidate.registered,
          heldMember: candidate.heldMember,
          heldGuest: candidate.heldGuest,
          newSinceImport: candidate.newSinceImport,
          joinedAt: candidate.joinedAt,
        },
      })
      .onConflictDoNothing({ target: t.guestGrants.source_key })
      .returning({ id: t.guestGrants.id });
    if (!grant) continue;
    granted++;
    await audit(client, plan.guildId, null, "guest.grandfather", candidate.userId, {
      grantId: grant.id,
      planChecksum: plan.checksum,
    });
  }
  const count = (basis: GrandfatherCandidate["basis"]) =>
    plan.candidates.filter((candidate) => candidate.basis === basis).length;
  await audit(client, plan.guildId, null, "guest.grandfather.completed", plan.guildId, {
    planChecksum: plan.checksum,
    granted,
    enumeratedAt: plan.enumeratedAt,
    rosterObservedAt: plan.rosterObservedAt,
    rosterSnapshotId: plan.rosterSnapshotId,
    importFingerprint: plan.importFingerprint,
    counts: {
      humans: plan.humans,
      bots: plan.bots,
      memberEligible: count("member"),
      planned: plan.grants.length,
      existingGrant: count("existing_grant"),
      revoked: count("revoked"),
    },
  });
  // Consuming the marker is the exactly-once guard: a concurrent or repeated run finds nothing.
  const [marked] = await store
    .update(t.guilds)
    .set({ guest_grandfather: "completed", guest_grandfathered_at: sql`now()` })
    .where(and(eq(t.guilds.id, plan.guildId), eq(t.guilds.guest_grandfather, "pending")))
    .returning({ id: t.guilds.id });
  if (!marked)
    throw new Failure(
      "conflict",
      "Grandfathering already ran for this guild; nothing was written.",
    );
  return { granted };
}

/** Humans who joined after activation's enumeration and hold neither a grant nor a link. */
export interface LateJoinerReport {
  guildId: string;
  state: "pending" | "completed" | "not_applicable";
  enumeratedAt: string | null;
  count: number;
  users: { userId: string; joinedAt: Date | null }[];
}

/**
 * Read-only report for after the worker is live (amendment C9): present humans whose join is later
 * than the completed run's enumeration and who have no guest grant and no active link, so nothing
 * gives them access automatically. Officers decide `/guest grant` for each. Presence comes from
 * the running worker's member events and guild reconciliation.
 */
export async function lateJoiners(db: Orm, guildId: string): Promise<LateJoinerReport> {
  const [guild] = await db
    .select({ state: t.guilds.guest_grandfather })
    .from(t.guilds)
    .where(eq(t.guilds.id, guildId));
  if (!guild) throw new Failure("input", "Unknown guild.");
  const [completed] = await db
    .select({ details: t.auditEvents.details })
    .from(t.auditEvents)
    .where(
      and(
        eq(t.auditEvents.guild_id, guildId),
        eq(t.auditEvents.action, "guest.grandfather.completed"),
      ),
    )
    .orderBy(desc(t.auditEvents.event_at), desc(t.auditEvents.id))
    .limit(1);
  const details = completed?.details as { enumeratedAt?: unknown } | undefined;
  const enumeratedAt = typeof details?.enumeratedAt === "string" ? details.enumeratedAt : null;
  const state = guild.state ?? "not_applicable";
  if (state !== "completed" || enumeratedAt === null)
    return { guildId, state, enumeratedAt: null, count: 0, users: [] };
  const rows = await db
    .select({ userId: t.guildUsers.user_id, joinedAt: t.guildUsers.joined_at })
    .from(t.guildUsers)
    .where(
      and(
        eq(t.guildUsers.guild_id, guildId),
        eq(t.guildUsers.present, true),
        gt(t.guildUsers.joined_at, sql`${enumeratedAt}::timestamptz`),
        notExists(
          db
            .select({ id: t.guestGrants.id })
            .from(t.guestGrants)
            .where(
              and(
                eq(t.guestGrants.guild_id, t.guildUsers.guild_id),
                eq(t.guestGrants.user_id, t.guildUsers.user_id),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: t.links.id })
            .from(t.links)
            .where(
              and(
                eq(t.links.guild_id, t.guildUsers.guild_id),
                eq(t.links.user_id, t.guildUsers.user_id),
                eq(t.links.active, true),
              ),
            ),
        ),
      ),
    );
  // Earliest join first, ties in numeric user order.
  const users = [...rows].sort(
    (left, right) =>
      (left.joinedAt?.getTime() ?? 0) - (right.joinedAt?.getTime() ?? 0) ||
      compareIds(left.userId, right.userId),
  );
  return { guildId, state, enumeratedAt, count: users.length, users };
}
