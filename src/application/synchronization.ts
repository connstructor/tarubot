/** Acquire trustworthy shared observations, then project each guild's independent policy. */
import { z } from "zod";
import {
  authorize,
  departure,
  desiredAccess,
  type AccessFacts,
  type Actor,
} from "../domain/policy.js";
import { Failure, nickname, normalized } from "../domain/values.js";
import { desiredRankRole, rankAccess } from "./rank-policy.js";
import { ensureUser, orm } from "../infrastructure/postgres/database.js";
import {
  and,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import * as t from "../infrastructure/postgres/schema.js";
import {
  enqueue,
  layoutGuildRoles,
  reconcileUser,
  secureGuildChannels,
  type Job,
} from "../jobs/queue.js";
import type { GuildRecord, MemberView } from "./records.js";
import type { Service } from "./service.js";
import { accessFacts } from "./access-facts.js";

/** Evidence publication and Discord delivery have distinct transactions, timestamps, and failures. */
export class Synchronization {
  /** The application facade supplies persistence, external ports, and validated timing settings. */
  constructor(readonly app: Service) {}
  /** Coalesce shared acquisition or cached reconciliation and record an inspectable request run. */
  async refresh(actor: Actor, force: boolean): Promise<unknown> {
    if (force) authorize(actor, actor.guildId, "officer");
    const guild = await this.app.guild(actor);
    if (!guild.fc_id) throw new Failure("setup", "Link an FC first.");
    const [fc] = await this.app.db.orm
      .select({
        last_successful_roster_at: t.freeCompanies.last_successful_roster_at,
        last_attempt_at: t.freeCompanies.last_attempt_at,
      })
      .from(t.freeCompanies)
      .where(eq(t.freeCompanies.id, guild.fc_id));
    const fresh =
      fc?.last_successful_roster_at &&
      Date.now() - fc.last_successful_roster_at.getTime() <
        this.app.config.ROSTER_INTERVAL_SECONDS * 1000;
    const cooldown = Math.max(0, 60 - (Date.now() - (fc?.last_attempt_at?.getTime() ?? 0)) / 1000);
    return this.app.db.transaction(async (client) => {
      const job =
        force || !fresh
          ? await enqueue(
              client,
              "roster",
              `roster:${guild.fc_id}`,
              { fcId: guild.fc_id },
              null,
              null,
              cooldown,
            )
          : await enqueue(client, "reconcile.guild", `guild:${guild.id}`, {}, guild.id);
      const db = orm(client);
      const [run] = await db
        .insert(t.syncRuns)
        .values({ guild_id: guild.id, requester_id: actor.userId, job_id: job })
        .returning({ id: t.syncRuns.id });
      if (run) await db.insert(t.syncRunJobs).values({ run_id: run.id, job_id: job });
      return {
        runId: run?.id,
        status: "queued",
        cached: !force && !!fresh,
        cooldownSeconds: Math.ceil(cooldown),
        lastSuccessfulRosterAt: fc?.last_successful_roster_at ?? null,
      };
    });
  }
  /** Hold an FC session lock during acquisition; publish only after completeness and lease checks. */
  async roster(job: Job, guard: () => Promise<void>): Promise<unknown> {
    const { fcId } = z.object({ fcId: z.string() }).parse(job.payload);
    const connection = await this.app.db.pool.connect();
    let locked = false;
    try {
      locked =
        (
          await connection.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
            [`fc:${fcId}`],
          )
        ).rows[0]?.locked ?? false;
      if (!locked) throw new Failure("cooldown", "Refresh is already running.", 60);
      const session = orm(connection);
      const linked = await session
        .select({ id: t.guilds.id })
        .from(t.guilds)
        .where(and(eq(t.guilds.fc_id, fcId), eq(t.guilds.active, true)));
      if (!linked.length) return { skipped: "FC no longer linked" };
      const allowed = await session
        .update(t.freeCompanies)
        .set({ last_attempt_at: sql`now()` })
        .where(
          and(
            eq(t.freeCompanies.id, fcId),
            or(
              isNull(t.freeCompanies.last_attempt_at),
              lte(t.freeCompanies.last_attempt_at, sql`now()-interval '60 seconds'`),
            ),
          ),
        )
        .returning({ id: t.freeCompanies.id });
      if (!allowed.length) throw new Failure("cooldown", "FC refresh cooldown.", 60);
      const roster = await this.app.lodestone.roster(fcId);
      await guard();
      const result = await this.app.db.transaction(async (client) => {
        const db = orm(client);
        const lease = await db
          .select({ id: t.jobs.id })
          .from(t.jobs)
          .where(
            and(
              eq(t.jobs.id, job.id),
              eq(t.jobs.lease_token, job.lease_token),
              gt(t.jobs.lease_until, sql`now()`),
            ),
          )
          .for("update");
        if (!lease.length) throw new Failure("superseded", "Expired acquisition lease.");
        await this.app.storeCompany(client, roster.company);
        const [snapshot] = await db
          .insert(t.rosterSnapshots)
          .values({
            fc_id: fcId,
            started_at: roster.startedAt,
            observed_at: roster.observedAt,
            member_count: roster.members.length,
            evidence: {
              pages: roster.pages,
              identityRechecked: true,
              countRechecked: true,
              uniqueIds: true,
            },
          })
          .returning({ id: t.rosterSnapshots.id });
        if (!snapshot) throw new Error("Missing snapshot");
        for (const member of roster.members) {
          await this.app.storeCharacter(client, member, false);
          await db.insert(t.rosterMembers).values({
            snapshot_id: snapshot.id,
            character_id: member.id,
            fc_rank_name: member.fcRankName ?? null,
            fc_rank_key: member.fcRankName ? normalized(member.fcRankName) : null,
            is_fc_leader: member.isFcLeader ?? null,
          });
        }
        const guilds = await db
          .select()
          .from(t.guilds)
          .where(and(eq(t.guilds.fc_id, fcId), eq(t.guilds.active, true)))
          .for("share");
        const present = new Set(roster.members.map((member) => member.id));
        let confirmation = false;
        for (const guild of guilds) {
          const links = await db
            .select({
              id: t.links.id,
              user_id: t.links.user_id,
              character_id: t.links.character_id,
              state: t.membership.state,
              first_absence_at: t.membership.first_absence_at,
            })
            .from(t.links)
            .leftJoin(
              t.membership,
              and(
                eq(t.membership.guild_id, t.links.guild_id),
                eq(t.membership.character_id, t.links.character_id),
                eq(t.membership.fc_id, fcId),
              ),
            )
            .where(and(eq(t.links.guild_id, guild.id), eq(t.links.active, true)));
          let departures = 0;
          for (const link of links) {
            const transition = departure(
              link.state ?? undefined,
              present.has(link.character_id),
              link.first_absence_at,
              roster.observedAt,
            );
            if (transition.state === "missing") confirmation = true;
            if (
              transition.state === "absent" &&
              (link.state === "missing" || link.state === "present")
            )
              departures++;
            const observation = {
              state: transition.state,
              first_absence_at: transition.firstAbsence,
              snapshot_id: snapshot.id,
            };
            await db
              .insert(t.membership)
              .values({
                guild_id: guild.id,
                fc_id: fcId,
                character_id: link.character_id,
                ...observation,
                confirmed_snapshot_id: transition.state === "present" ? snapshot.id : null,
              })
              .onConflictDoUpdate({
                target: [t.membership.guild_id, t.membership.fc_id, t.membership.character_id],
                set: {
                  ...observation,
                  confirmed_snapshot_id:
                    transition.state === "present"
                      ? snapshot.id
                      : t.membership.confirmed_snapshot_id,
                },
              });
            if (present.has(link.character_id))
              await db
                .insert(t.membershipHistory)
                .values({
                  guild_id: guild.id,
                  user_id: link.user_id,
                  fc_id: fcId,
                  link_id: link.id,
                  snapshot_id: snapshot.id,
                  observed_at: roster.observedAt,
                })
                .onConflictDoNothing({
                  target: [t.membershipHistory.link_id, t.membershipHistory.fc_id],
                });
          }
          const reconciliation = await enqueue(
            client,
            "reconcile.guild",
            `guild:${guild.id}`,
            { snapshotId: snapshot.id },
            guild.id,
          );
          await db
            .insert(t.syncRunJobs)
            .select(
              db
                .select({
                  run_id: t.syncRuns.id,
                  job_id: sql<string>`${reconciliation}::uuid`.as("job_id"),
                })
                .from(t.syncRuns)
                .where(and(eq(t.syncRuns.guild_id, guild.id), eq(t.syncRuns.job_id, job.id))),
            )
            .onConflictDoNothing();
          await enqueue(
            client,
            "officer.notify",
            `officer:${guild.id}`,
            {
              message: `FC roster accepted: ${roster.members.length} members; ${departures} confirmed character departures. Snapshot ${snapshot.id}.`,
            },
            guild.id,
            null,
            5,
          );
        }
        await db
          .update(t.freeCompanies)
          .set({ last_successful_roster_at: roster.observedAt, last_error: null })
          .where(eq(t.freeCompanies.id, fcId));
        if (confirmation)
          await enqueue(client, "roster.confirm", `confirm:${fcId}`, { fcId }, null, null, 60);
        return { snapshotId: snapshot.id, count: roster.members.length, pages: roster.pages };
      });
      return result;
    } catch (error) {
      if (!(error instanceof Failure && ["cooldown", "superseded"].includes(error.code))) {
        await this.app.db.orm
          .update(t.freeCompanies)
          .set({ last_error: error instanceof Failure ? error.code : "acquisition_failed" })
          .where(eq(t.freeCompanies.id, fcId));
        const guilds = await this.app.db.orm
          .select({ id: t.guilds.id })
          .from(t.guilds)
          .where(and(eq(t.guilds.fc_id, fcId), eq(t.guilds.active, true)));
        for (const guild of guilds)
          await enqueue(
            this.app.db.pool,
            "officer.notify",
            `officer:${guild.id}`,
            {
              message:
                "Lodestone synchronization is degraded. Existing accepted membership evidence is retained; inspect /sync status.",
            },
            guild.id,
            null,
            60,
          );
      }
      throw error;
    } finally {
      if (locked)
        await connection
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`fc:${fcId}`])
          .catch(() => {});
      connection.release();
    }
  }
  /** Evaluate links not yet observed, requesting early acquisition when fresh evidence is absent. */
  async seedFreshLink(guild: GuildRecord, user: string): Promise<void> {
    const fcId = guild.fc_id;
    if (!fcId) return;
    await this.app.db.transaction(async (client) => {
      const db = orm(client);
      const current = await db
        .select({ id: t.guilds.id })
        .from(t.guilds)
        .where(
          and(
            eq(t.guilds.id, guild.id),
            eq(t.guilds.fc_id, fcId),
            eq(t.guilds.revision, guild.revision),
          ),
        )
        .for("share");
      if (!current.length)
        throw new Failure("superseded", "Configuration changed while evaluating a new link.");
      const [snapshot] = await db
        .select({ id: t.rosterSnapshots.id, observed_at: t.rosterSnapshots.observed_at })
        .from(t.rosterSnapshots)
        .where(
          and(
            eq(t.rosterSnapshots.fc_id, fcId),
            gt(
              t.rosterSnapshots.observed_at,
              sql`now()-${this.app.config.ROSTER_INTERVAL_SECONDS}*interval '1 second'`,
            ),
          ),
        )
        .orderBy(desc(t.rosterSnapshots.observed_at))
        .limit(1);
      const links = await db
        .select({ id: t.links.id, character_id: t.links.character_id })
        .from(t.links)
        .leftJoin(
          t.membership,
          and(
            eq(t.membership.guild_id, t.links.guild_id),
            eq(t.membership.character_id, t.links.character_id),
            eq(t.membership.fc_id, fcId),
          ),
        )
        .where(
          and(
            eq(t.links.guild_id, guild.id),
            eq(t.links.user_id, user),
            eq(t.links.active, true),
            isNull(t.membership.character_id),
          ),
        );
      if (!snapshot) {
        if (links.length) await enqueue(client, "roster", `roster:${fcId}`, { fcId });
        return;
      }
      for (const link of links) {
        const found = await db
          .select({ character_id: t.rosterMembers.character_id })
          .from(t.rosterMembers)
          .where(
            and(
              eq(t.rosterMembers.snapshot_id, snapshot.id),
              eq(t.rosterMembers.character_id, link.character_id),
            ),
          );
        await db
          .insert(t.membership)
          .values({
            guild_id: guild.id,
            fc_id: fcId,
            character_id: link.character_id,
            state: found.length ? "present" : "absent",
            snapshot_id: snapshot.id,
            confirmed_snapshot_id: found.length ? snapshot.id : null,
          })
          .onConflictDoNothing();
        if (found.length)
          await db
            .insert(t.membershipHistory)
            .values({
              guild_id: guild.id,
              user_id: user,
              fc_id: fcId,
              link_id: link.id,
              snapshot_id: snapshot.id,
              observed_at: snapshot.observed_at,
            })
            .onConflictDoNothing();
      }
    });
  }
  /** Assemble policy facts without granting authority to manually assigned Discord roles. */
  async facts(guild: GuildRecord, member: MemberView): Promise<AccessFacts> {
    return accessFacts(
      this.app.db.orm,
      guild,
      member.id,
      this.app.config.ROSTER_INTERVAL_SECONDS,
      member.roles,
    );
  }
  /** Complete member coverage creates per-user work and associates it with requesting runs. */
  async guild(guildId: string, parentJob: string): Promise<unknown> {
    const members = await this.app.discord.members(guildId);
    await this.app.db.transaction(async (client) => {
      const db = orm(client);
      // Each requesting run tracks all child work, including coalesced role-layout jobs.
      const attach = async (child: string) => {
        await db
          .insert(t.syncRunJobs)
          .select(
            db
              .select({ run_id: t.syncRuns.id, job_id: sql<string>`${child}::uuid`.as("job_id") })
              .from(t.syncRuns)
              .innerJoin(t.syncRunJobs, eq(t.syncRunJobs.run_id, t.syncRuns.id))
              .where(and(eq(t.syncRuns.guild_id, guildId), eq(t.syncRunJobs.job_id, parentJob))),
          )
          .onConflictDoNothing();
      };
      const layout = await layoutGuildRoles(client, guildId);
      await attach(layout);
      const secured = await db
        .select({ id: t.guilds.id })
        .from(t.guilds)
        .where(and(eq(t.guilds.id, guildId), eq(t.guilds.access_policy_enabled, true)));
      if (secured.length) {
        const access = await secureGuildChannels(client, guildId);
        await attach(access);
      }
      for (const member of members) {
        if (member.bot) continue;
        await ensureUser(client, guildId, member.id, member.joinedAt);
        const child = await reconcileUser(client, guildId, member.id);
        await attach(child);
      }
      const ids = members.filter((member) => !member.bot).map((member) => member.id);
      await db
        .update(t.guildUsers)
        .set({ present: false })
        .where(and(eq(t.guildUsers.guild_id, guildId), notInArray(t.guildUsers.user_id, ids)));
      const cancelled = await db
        .update(t.guestApplications)
        .set({ state: "cancelled", decided_at: sql`now()` })
        .where(
          and(
            eq(t.guestApplications.guild_id, guildId),
            eq(t.guestApplications.state, "pending"),
            notExists(
              db
                .select({ user_id: t.guildUsers.user_id })
                .from(t.guildUsers)
                .where(
                  and(
                    eq(t.guildUsers.guild_id, t.guestApplications.guild_id),
                    eq(t.guildUsers.user_id, t.guestApplications.user_id),
                    eq(t.guildUsers.present, true),
                    eq(t.guildUsers.joined_at, t.guestApplications.joined_at),
                  ),
                ),
            ),
          ),
        )
        .returning({ id: t.guestApplications.id, user_id: t.guestApplications.user_id });
      for (const application of cancelled)
        await enqueue(
          client,
          "guest.review",
          `review:${application.id}`,
          { applicationId: application.id },
          guildId,
          application.user_id,
        );
      await db
        .update(t.syncRuns)
        .set({ enumeration_completed_at: sql`now()`, status: "reconciling" })
        .where(
          and(
            eq(t.syncRuns.guild_id, guildId),
            exists(
              db
                .select({ run_id: t.syncRunJobs.run_id })
                .from(t.syncRunJobs)
                .where(
                  and(eq(t.syncRunJobs.run_id, t.syncRuns.id), eq(t.syncRunJobs.job_id, parentJob)),
                ),
            ),
          ),
        );
    });
    return {
      enumerationComplete: true,
      humans: members.filter((member) => !member.bot).length,
      effects: "queued",
    };
  }
  /** Serialize one user's effects; previews calculate the same desired state without mutations. */
  async user(job: Job, guard: () => Promise<void>, preview = false): Promise<unknown> {
    if (!job.guild_id || !job.user_id) throw new Failure("invalid_job", "Missing user scope.");
    const connection = await this.app.db.pool.connect();
    let locked = false;
    try {
      locked =
        (
          await connection.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
            [`user:${job.guild_id}:${job.user_id}`],
          )
        ).rows[0]?.locked ?? false;
      if (!locked) throw new Failure("busy", "User reconciliation is already running.");
      const db = this.app.db.orm;
      const [guild] = await db
        .select()
        .from(t.guilds)
        .where(and(eq(t.guilds.id, job.guild_id), eq(t.guilds.active, true)));
      if (!guild) return { skipped: "guild inactive" };
      const member = await this.app.discord.member(guild.id, job.user_id);
      if (!member || member.bot) return { skipped: "user absent or bot" };
      if (!preview) await this.seedFreshLink(guild, member.id);
      const facts = await this.facts(guild, member);
      const desired = desiredAccess(facts);
      const rank = await rankAccess(
        this.app.db,
        guild,
        member.id,
        this.app.config.ROSTER_INTERVAL_SECONDS,
      );
      const officer = desiredRankRole(
        rank.officer,
        member.roles.includes(guild.officer_role_id ?? ""),
        rank.fresh,
        rank.manualOfficer,
      );
      const leader = desiredRankRole(
        rank.leader,
        member.roles.includes(guild.leader_role_id ?? ""),
        rank.fresh,
      );
      const retired = await db
        .select({ role_id: t.retiredRoles.role_id })
        .from(t.retiredRoles)
        .where(eq(t.retiredRoles.guild_id, guild.id));
      const add: string[] = [];
      const remove = retired
        .map((row) => row.role_id)
        .filter((role) => member.roles.includes(role));
      for (const [role, wanted] of [
        [guild.member_role_id, desired.member],
        [guild.guest_role_id, desired.guest],
        [guild.officer_role_id, officer],
        [guild.leader_role_id, leader],
      ] as const) {
        if (!role) continue;
        if (wanted && !member.roles.includes(role)) add.push(role);
        if (!wanted && member.roles.includes(role)) remove.push(role);
      }
      if (preview) {
        const [preferences] = await db
          .select({ ...getTableColumns(t.guildUsers), name: t.characters.name })
          .from(t.guildUsers)
          .leftJoin(t.characters, eq(t.characters.id, t.guildUsers.primary_character_id))
          .where(and(eq(t.guildUsers.guild_id, guild.id), eq(t.guildUsers.user_id, member.id)));
        let target = member.nickname;
        if (preferences) {
          const ownPending =
            preferences.nickname_pending && member.nickname === preferences.nickname_expected;
          const expected = preferences.nickname_written
            ? preferences.nickname_last
            : preferences.nickname_before;
          const independent =
            preferences.nickname_baseline_set && member.nickname !== expected && !ownPending;
          if (
            preferences.nickname_restore &&
            preferences.nickname_baseline_set &&
            (preferences.nickname_written || ownPending) &&
            !independent
          )
            target = preferences.nickname_before;
          else if (
            !preferences.nickname_restore &&
            preferences.nickname_enabled &&
            !preferences.nickname_suspended &&
            preferences.name &&
            !independent
          )
            target = nickname(preferences.name);
        }
        return {
          user: member.id,
          add,
          remove,
          desired,
          nickname: { current: member.nickname, desired: target },
        };
      }
      if (!guild.effects_enabled || !this.app.config.ENABLE_EFFECTS)
        throw new Failure("disabled", "Effects are disabled pending activation.");
      await guard();
      const [current] = await db
        .select({ revision: t.guilds.revision })
        .from(t.guilds)
        .where(eq(t.guilds.id, guild.id));
      if (current?.revision !== guild.revision)
        throw new Failure("superseded", "Configuration changed.");
      let roleError: unknown;
      try {
        if (guild.access_policy_enabled)
          for (const role of add)
            await this.app.discord.validateRole(guild.id, role, undefined, true);
        await this.app.discord.roles(guild.id, member.id, add, remove);
      } catch (error) {
        roleError = error;
      }
      // Nicknames are an independent capability; a blocked role does not block them.
      let nicknameError: unknown;
      try {
        await this.nickname(guild, member, guard);
      } catch (error) {
        nicknameError = error;
      }
      await db
        .update(t.jobs)
        .set({
          result: {
            roles: { status: roleError ? "pending_or_blocked" : "applied", add, remove },
            nickname: { status: nicknameError ? "pending_or_blocked" : "applied" },
          },
        })
        .where(
          and(
            eq(t.jobs.id, job.id),
            eq(t.jobs.lease_token, job.lease_token),
            gt(t.jobs.lease_until, sql`now()`),
          ),
        );
      if (desired.member || (desired.guest && facts.verified)) {
        const apps = await db
          .update(t.guestApplications)
          .set({ state: "superseded", decided_at: sql`now()` })
          .where(
            and(
              eq(t.guestApplications.guild_id, guild.id),
              eq(t.guestApplications.user_id, member.id),
              eq(t.guestApplications.state, "pending"),
            ),
          )
          .returning({ id: t.guestApplications.id });
        for (const app of apps)
          await enqueue(
            this.app.db.pool,
            "guest.review",
            `review:${app.id}`,
            { applicationId: app.id },
            guild.id,
            member.id,
          );
      }
      if (roleError) throw roleError;
      if (nicknameError) throw nicknameError;
      return { user: member.id, add, remove, status: "applied" };
    } finally {
      if (locked)
        await connection
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            `user:${job.guild_id}:${job.user_id}`,
          ])
          .catch(() => {});
      connection.release();
    }
  }
  /** Preserve manual edits, distinguish baseline from successful writes, and recover ambiguous delivery. */
  private async nickname(
    guild: GuildRecord,
    member: MemberView,
    guard: () => Promise<void>,
  ): Promise<void> {
    const current = await this.app.discord.member(guild.id, member.id);
    if (!current || current.bot) return;
    const db = this.app.db.orm;
    const scope = and(eq(t.guildUsers.guild_id, guild.id), eq(t.guildUsers.user_id, member.id));
    const [user] = await db.select().from(t.guildUsers).where(scope);
    if (!user) return;
    const ownPending = user.nickname_pending && current.nickname === user.nickname_expected;
    const expected = user.nickname_written ? user.nickname_last : user.nickname_before;
    const independent = user.nickname_baseline_set && current.nickname !== expected && !ownPending;
    const suspend = async () => {
      await db
        .update(t.guildUsers)
        .set({ nickname_suspended: true, nickname_enabled: false, nickname_pending: false })
        .where(scope);
    };
    if (user.nickname_restore) {
      let restored = ownPending && current.nickname === user.nickname_before;
      let changed = independent;
      if (
        user.nickname_baseline_set &&
        (user.nickname_written || ownPending) &&
        !independent &&
        current.nickname !== user.nickname_before
      ) {
        await db
          .update(t.guildUsers)
          .set({
            nickname_pending: true,
            nickname_expected: t.guildUsers.nickname_before,
            nickname_last: current.nickname,
            nickname_written: true,
          })
          .where(scope);
        await guard();
        restored = await this.app.discord.nickname(
          guild.id,
          member.id,
          user.nickname_before,
          current.nickname,
        );
        changed = !restored;
      }
      if (changed) await suspend();
      await db
        .update(t.guildUsers)
        .set({
          nickname_restore: false,
          nickname_baseline_set: false,
          nickname_pending: false,
          nickname_written: false,
          nickname_last: restored ? t.guildUsers.nickname_before : t.guildUsers.nickname_last,
        })
        .where(scope);
      return;
    }
    if (!user.nickname_enabled || user.nickname_suspended || !user.primary_character_id) return;
    if (independent) {
      await suspend();
      return;
    }
    if (ownPending)
      await db
        .update(t.guildUsers)
        .set({ nickname_last: current.nickname, nickname_written: true, nickname_pending: false })
        .where(scope);
    const [character] = await db
      .select({ name: t.characters.name })
      .from(t.characters)
      .innerJoin(t.links, eq(t.links.character_id, t.characters.id))
      .where(
        and(
          eq(t.characters.id, user.primary_character_id),
          eq(t.links.guild_id, guild.id),
          eq(t.links.user_id, member.id),
          eq(t.links.active, true),
        ),
      );
    if (!character) return;
    const target = nickname(character.name);
    if (!user.nickname_baseline_set)
      await db
        .update(t.guildUsers)
        .set({
          nickname_before: current.nickname,
          nickname_baseline_set: true,
          nickname_written: false,
        })
        .where(scope);
    if (current.nickname !== target) {
      await db
        .update(t.guildUsers)
        .set({ nickname_pending: true, nickname_expected: target })
        .where(scope);
      await guard();
      if (!(await this.app.discord.nickname(guild.id, member.id, target, current.nickname))) {
        await suspend();
        return;
      }
      await db
        .update(t.guildUsers)
        .set({ nickname_last: target, nickname_written: true, nickname_pending: false })
        .where(scope);
    } else await db.update(t.guildUsers).set({ nickname_pending: false }).where(scope);
  }
  /** Startup catch-up and jittered scheduling fetch only actively needed FCs/profiles. */
  async schedule(): Promise<void> {
    const db = this.app.db.orm;
    const companies = await db
      .select({ id: t.freeCompanies.id })
      .from(t.freeCompanies)
      .where(
        and(
          exists(
            db
              .select({ id: t.guilds.id })
              .from(t.guilds)
              .where(and(eq(t.guilds.fc_id, t.freeCompanies.id), eq(t.guilds.active, true))),
          ),
          or(
            isNull(t.freeCompanies.last_successful_roster_at),
            lt(
              t.freeCompanies.last_successful_roster_at,
              sql`now()-${this.app.config.ROSTER_INTERVAL_SECONDS}*interval '1 second'`,
            ),
          ),
        ),
      );
    for (const fc of companies)
      await enqueue(
        this.app.db.pool,
        "roster",
        `roster:${fc.id}`,
        { fcId: fc.id },
        null,
        null,
        Math.random() * 30,
      );
    const characters = await db
      .select({ id: t.characters.id })
      .from(t.characters)
      .where(
        and(
          or(
            isNull(t.characters.profile_at),
            lt(
              t.characters.profile_at,
              sql`now()-${this.app.config.PROFILE_INTERVAL_SECONDS}*interval '1 second'`,
            ),
          ),
          exists(
            db
              .select({ id: t.links.id })
              .from(t.links)
              .innerJoin(
                t.guildUsers,
                and(
                  eq(t.guildUsers.guild_id, t.links.guild_id),
                  eq(t.guildUsers.user_id, t.links.user_id),
                ),
              )
              .innerJoin(t.guilds, eq(t.guilds.id, t.links.guild_id))
              .where(
                and(
                  eq(t.links.character_id, t.characters.id),
                  eq(t.links.active, true),
                  eq(t.guildUsers.present, true),
                  eq(t.guilds.active, true),
                ),
              ),
          ),
        ),
      )
      .limit(100);
    for (const character of characters)
      await enqueue(this.app.db.pool, "profile", `profile:${character.id}`, {
        characterId: character.id,
      });
    await db.delete(t.challenges).where(lt(t.challenges.expires_at, sql`now()-interval '7 days'`));
    await db
      .update(t.jobs)
      .set({ status: "queued", due_at: sql`now()+interval '5 minutes'`, attempts: 0 })
      .where(and(eq(t.jobs.status, "blocked"), lt(t.jobs.due_at, sql`now()-interval '5 minutes'`)));
  }
}
