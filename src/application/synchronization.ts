/** Acquire trustworthy shared observations, then project each guild's independent policy. */
import { z } from "zod";
import {
  authorize,
  departure,
  desiredAccess,
  type AccessFacts,
  type Actor,
} from "../domain/policy.js";
import { Failure, json, nickname, normalized } from "../domain/values.js";
import { desiredRankRole, rankAccess } from "./rank-policy.js";
import { ensureUser } from "../infrastructure/postgres/database.js";
import { enqueue, layoutGuildRoles, reconcileUser, type Job } from "../jobs/queue.js";
import type { GuildRecord, MemberView, UserRecord } from "./records.js";
import type { Service } from "./service.js";

/** Evidence publication and Discord delivery have distinct transactions, timestamps, and failures. */
export class Synchronization {
  /** The application facade supplies persistence, external ports, and validated timing settings. */
  constructor(readonly app: Service) {}
  /** Coalesce shared acquisition or cached reconciliation and record an inspectable request run. */
  async refresh(actor: Actor, force: boolean): Promise<unknown> {
    if (force) authorize(actor, actor.guildId, "officer");
    const guild = await this.app.guild(actor);
    if (!guild.fc_id) throw new Failure("setup", "Link an FC first.");
    const fc = (
      await this.app.db.query<{
        last_successful_roster_at: Date | null;
        last_attempt_at: Date | null;
      }>("SELECT last_successful_roster_at,last_attempt_at FROM free_companies WHERE id=$1", [
        guild.fc_id,
      ])
    )[0];
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
      const run = (
        await client.query<{ id: string }>(
          "INSERT INTO sync_runs(guild_id,requester_id,job_id) VALUES($1,$2,$3) RETURNING id",
          [guild.id, actor.userId, job],
        )
      ).rows[0];
      if (run)
        await client.query("INSERT INTO sync_run_jobs(run_id,job_id) VALUES($1,$2)", [run.id, job]);
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
      const linked = await connection.query("SELECT id FROM guilds WHERE fc_id=$1 AND active", [
        fcId,
      ]);
      if (!linked.rowCount) return { skipped: "FC no longer linked" };
      const allowed = await connection.query(
        "UPDATE free_companies SET last_attempt_at=now() WHERE id=$1 AND (last_attempt_at IS NULL OR last_attempt_at<=now()-interval '60 seconds') RETURNING id",
        [fcId],
      );
      if (!allowed.rowCount) throw new Failure("cooldown", "FC refresh cooldown.", 60);
      const roster = await this.app.lodestone.roster(fcId);
      await guard();
      const result = await this.app.db.transaction(async (client) => {
        const lease = await client.query(
          "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND lease_until>now() FOR UPDATE",
          [job.id, job.lease_token],
        );
        if (!lease.rowCount) throw new Failure("superseded", "Expired acquisition lease.");
        await this.app.storeCompany(client, roster.company);
        const snapshot = (
          await client.query<{ id: string }>(
            "INSERT INTO roster_snapshots(fc_id,started_at,observed_at,member_count,evidence) VALUES($1,$2,$3,$4,$5) RETURNING id",
            [
              fcId,
              roster.startedAt,
              roster.observedAt,
              roster.members.length,
              json({
                pages: roster.pages,
                identityRechecked: true,
                countRechecked: true,
                uniqueIds: true,
              }),
            ],
          )
        ).rows[0];
        if (!snapshot) throw new Error("Missing snapshot");
        for (const member of roster.members) {
          await this.app.storeCharacter(client, member, false);
          await client.query(
            "INSERT INTO roster_members(snapshot_id,character_id,fc_rank_name,fc_rank_key,is_fc_leader) VALUES($1,$2,$3,$4,$5)",
            [
              snapshot.id,
              member.id,
              member.fcRankName ?? null,
              member.fcRankName ? normalized(member.fcRankName) : null,
              member.isFcLeader ?? null,
            ],
          );
        }
        const guilds = (
          await client.query<GuildRecord>(
            "SELECT * FROM guilds WHERE fc_id=$1 AND active FOR SHARE",
            [fcId],
          )
        ).rows;
        const present = new Set(roster.members.map((member) => member.id));
        let confirmation = false;
        for (const guild of guilds) {
          const links = (
            await client.query<{
              id: string;
              user_id: string;
              character_id: string;
              state: "present" | "missing" | "absent" | null;
              first_absence_at: Date | null;
            }>(
              "SELECT l.id,l.user_id,l.character_id,m.state,m.first_absence_at FROM links l LEFT JOIN membership m ON m.guild_id=l.guild_id AND m.character_id=l.character_id AND m.fc_id=$2 WHERE l.guild_id=$1 AND l.active",
              [guild.id, fcId],
            )
          ).rows;
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
            await client.query(
              "INSERT INTO membership(guild_id,fc_id,character_id,state,first_absence_at,snapshot_id,confirmed_snapshot_id) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $4='present' THEN $6::uuid ELSE NULL END) ON CONFLICT(guild_id,fc_id,character_id) DO UPDATE SET state=$4,first_absence_at=$5,snapshot_id=$6,confirmed_snapshot_id=CASE WHEN $4='present' THEN $6::uuid ELSE membership.confirmed_snapshot_id END",
              [
                guild.id,
                fcId,
                link.character_id,
                transition.state,
                transition.firstAbsence,
                snapshot.id,
              ],
            );
            if (present.has(link.character_id))
              await client.query(
                "INSERT INTO membership_history(guild_id,user_id,fc_id,link_id,snapshot_id,observed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(link_id,fc_id) DO NOTHING",
                [guild.id, link.user_id, fcId, link.id, snapshot.id, roster.observedAt],
              );
          }
          const reconciliation = await enqueue(
            client,
            "reconcile.guild",
            `guild:${guild.id}`,
            { snapshotId: snapshot.id },
            guild.id,
          );
          await client.query(
            "INSERT INTO sync_run_jobs(run_id,job_id) SELECT id,$3 FROM sync_runs WHERE guild_id=$1 AND job_id=$2 ON CONFLICT DO NOTHING",
            [guild.id, job.id, reconciliation],
          );
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
        await client.query(
          "UPDATE free_companies SET last_successful_roster_at=$2,last_error=NULL WHERE id=$1",
          [fcId, roster.observedAt],
        );
        if (confirmation)
          await enqueue(client, "roster.confirm", `confirm:${fcId}`, { fcId }, null, null, 60);
        return { snapshotId: snapshot.id, count: roster.members.length, pages: roster.pages };
      });
      return result;
    } catch (error) {
      if (!(error instanceof Failure && ["cooldown", "superseded"].includes(error.code))) {
        await this.app.db.query("UPDATE free_companies SET last_error=$2 WHERE id=$1", [
          fcId,
          error instanceof Failure ? error.code : "acquisition_failed",
        ]);
        const guilds = await this.app.db.query<{ id: string }>(
          "SELECT id FROM guilds WHERE fc_id=$1 AND active",
          [fcId],
        );
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
    if (!guild.fc_id) return;
    await this.app.db.transaction(async (client) => {
      const current = await client.query(
        "SELECT id FROM guilds WHERE id=$1 AND fc_id=$2 AND revision=$3 FOR SHARE",
        [guild.id, guild.fc_id, guild.revision],
      );
      if (!current.rowCount)
        throw new Failure("superseded", "Configuration changed while evaluating a new link.");
      const snapshot = (
        await client.query<{ id: string; observed_at: Date }>(
          "SELECT id,observed_at FROM roster_snapshots WHERE fc_id=$1 AND observed_at>now()-$2*interval '1 second' ORDER BY observed_at DESC LIMIT 1",
          [guild.fc_id, this.app.config.ROSTER_INTERVAL_SECONDS],
        )
      ).rows[0];
      const links = (
        await client.query<{ id: string; character_id: string }>(
          "SELECT l.id,l.character_id FROM links l LEFT JOIN membership m ON m.guild_id=l.guild_id AND m.character_id=l.character_id AND m.fc_id=$3 WHERE l.guild_id=$1 AND l.user_id=$2 AND l.active AND m.character_id IS NULL",
          [guild.id, user, guild.fc_id],
        )
      ).rows;
      if (!snapshot) {
        if (links.length)
          await enqueue(client, "roster", `roster:${guild.fc_id}`, { fcId: guild.fc_id });
        return;
      }
      for (const link of links) {
        const found = await client.query(
          "SELECT character_id FROM roster_members WHERE snapshot_id=$1 AND character_id=$2",
          [snapshot.id, link.character_id],
        );
        await client.query(
          "INSERT INTO membership(guild_id,fc_id,character_id,state,snapshot_id,confirmed_snapshot_id) VALUES($1,$2,$3,$4,$5,CASE WHEN $4='present' THEN $5::uuid ELSE NULL END) ON CONFLICT DO NOTHING",
          [
            guild.id,
            guild.fc_id,
            link.character_id,
            found.rowCount ? "present" : "absent",
            snapshot.id,
          ],
        );
        if (found.rowCount)
          await client.query(
            "INSERT INTO membership_history(guild_id,user_id,fc_id,link_id,snapshot_id,observed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
            [guild.id, user, guild.fc_id, link.id, snapshot.id, snapshot.observed_at],
          );
      }
    });
  }
  /** Assemble policy facts without granting authority to manually assigned Discord roles. */
  async facts(guild: GuildRecord, member: MemberView): Promise<AccessFacts> {
    const row = (
      await this.app.db.query<{ links: bigint; confirmed: bigint; unknown: bigint }>(
        "SELECT count(*) AS links,count(*) FILTER(WHERE m.state IN ('present','missing')) AS confirmed,count(*) FILTER(WHERE m.state IS NULL) AS unknown FROM links l LEFT JOIN membership m ON m.guild_id=l.guild_id AND m.character_id=l.character_id AND m.fc_id=$3 WHERE l.guild_id=$1 AND l.user_id=$2 AND l.active",
        [guild.id, member.id, guild.fc_id],
      )
    )[0];
    const state = (
      await this.app.db.query<{
        former: boolean;
        grant: boolean;
        revoked: boolean;
        fresh: boolean;
        local_loss: boolean;
      }>(
        `SELECT
      EXISTS(SELECT 1 FROM guild_users WHERE guild_id=$1 AND user_id=$2 AND local_member_loss) AS local_loss,
      EXISTS(SELECT 1 FROM membership_history WHERE guild_id=$1 AND user_id=$2 AND fc_id=$3) AS former,
      EXISTS(SELECT 1 FROM guest_grants WHERE guild_id=$1 AND user_id=$2) AS grant,
      EXISTS(SELECT 1 FROM guest_state WHERE guild_id=$1 AND user_id=$2 AND revoked) AS revoked,
      EXISTS(SELECT 1 FROM free_companies WHERE id=$3 AND last_successful_roster_at>now()-$4*interval '1 second') AS fresh`,
        [guild.id, member.id, guild.fc_id, this.app.config.ROSTER_INTERVAL_SECONDS],
      )
    )[0];
    if (!state || !row) throw new Error("Missing access facts");
    return {
      ...state,
      membership: !guild.fc_id
        ? "ineligible"
        : row.confirmed > 0n
          ? "member"
          : row.unknown > 0n && !state.local_loss
            ? "uncertain"
            : "ineligible",
      hasMember: member.roles.includes(guild.member_role_id ?? ""),
      hasGuest: member.roles.includes(guild.guest_role_id ?? ""),
    };
  }
  /** Complete member coverage creates per-user work and associates it with requesting runs. */
  async guild(guildId: string, parentJob: string): Promise<unknown> {
    const members = await this.app.discord.members(guildId);
    await this.app.db.transaction(async (client) => {
      const layout = await layoutGuildRoles(client, guildId);
      await client.query(
        "INSERT INTO sync_run_jobs(run_id,job_id) SELECT r.id,$3 FROM sync_runs r JOIN sync_run_jobs p ON p.run_id=r.id WHERE r.guild_id=$1 AND p.job_id=$2 ON CONFLICT DO NOTHING",
        [guildId, parentJob, layout],
      );
      for (const member of members) {
        if (member.bot) continue;
        await ensureUser(client, guildId, member.id, member.joinedAt);
        const child = await reconcileUser(client, guildId, member.id);
        await client.query(
          "INSERT INTO sync_run_jobs(run_id,job_id) SELECT r.id,$3 FROM sync_runs r JOIN sync_run_jobs p ON p.run_id=r.id WHERE r.guild_id=$1 AND p.job_id=$2 ON CONFLICT DO NOTHING",
          [guildId, parentJob, child],
        );
      }
      const ids = members.filter((member) => !member.bot).map((member) => member.id);
      await client.query(
        "UPDATE guild_users SET present=false WHERE guild_id=$1 AND NOT(user_id::text=ANY($2::text[]))",
        [guildId, ids],
      );
      const cancelled = (
        await client.query<{ id: string; user_id: string }>(
          "UPDATE guest_applications a SET state='cancelled',decided_at=now() WHERE guild_id=$1 AND state='pending' AND NOT EXISTS(SELECT 1 FROM guild_users u WHERE u.guild_id=a.guild_id AND u.user_id=a.user_id AND u.present AND u.joined_at=a.joined_at) RETURNING id,user_id",
          [guildId],
        )
      ).rows;
      for (const application of cancelled)
        await enqueue(
          client,
          "guest.review",
          `review:${application.id}`,
          { applicationId: application.id },
          guildId,
          application.user_id,
        );
      await client.query(
        "UPDATE sync_runs r SET enumeration_completed_at=now(),status='reconciling' WHERE guild_id=$1 AND EXISTS(SELECT 1 FROM sync_run_jobs p WHERE p.run_id=r.id AND p.job_id=$2)",
        [guildId, parentJob],
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
      const guild = (
        await this.app.db.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1 AND active", [
          job.guild_id,
        ])
      )[0];
      if (!guild) return { skipped: "guild inactive" };
      const member = await this.app.discord.member(guild.id, job.user_id);
      if (!member || member.bot) return { skipped: "user absent or bot" };
      if (!preview) await this.seedFreshLink(guild, member.id);
      const desired = desiredAccess(await this.facts(guild, member));
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
      const retired = await this.app.db.query<{ role_id: string }>(
        "SELECT role_id FROM retired_roles WHERE guild_id=$1",
        [guild.id],
      );
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
        const preferences = (
          await this.app.db.query<UserRecord & { name: string | null }>(
            "SELECT u.*,c.name FROM guild_users u LEFT JOIN characters c ON c.id=u.primary_character_id WHERE u.guild_id=$1 AND u.user_id=$2",
            [guild.id, member.id],
          )
        )[0];
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
      const current = (
        await this.app.db.query<{ revision: bigint }>("SELECT revision FROM guilds WHERE id=$1", [
          guild.id,
        ])
      )[0];
      if (current?.revision !== guild.revision)
        throw new Failure("superseded", "Configuration changed.");
      let roleError: unknown;
      try {
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
      await this.app.db.query(
        "UPDATE jobs SET result=$3 WHERE id=$1 AND lease_token=$2 AND lease_until>now()",
        [
          job.id,
          job.lease_token,
          json({
            roles: { status: roleError ? "pending_or_blocked" : "applied", add, remove },
            nickname: { status: nicknameError ? "pending_or_blocked" : "applied" },
          }),
        ],
      );
      if (desired.member) {
        const apps = await this.app.db.query<{ id: string }>(
          "UPDATE guest_applications SET state='superseded',decided_at=now() WHERE guild_id=$1 AND user_id=$2 AND state='pending' RETURNING id",
          [guild.id, member.id],
        );
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
    const user = (
      await this.app.db.query<UserRecord>(
        "SELECT * FROM guild_users WHERE guild_id=$1 AND user_id=$2",
        [guild.id, member.id],
      )
    )[0];
    if (!user) return;
    const ownPending = user.nickname_pending && current.nickname === user.nickname_expected;
    const expected = user.nickname_written ? user.nickname_last : user.nickname_before;
    const independent = user.nickname_baseline_set && current.nickname !== expected && !ownPending;
    const suspend = async () => {
      await this.app.db.query(
        "UPDATE guild_users SET nickname_suspended=true,nickname_enabled=false,nickname_pending=false WHERE guild_id=$1 AND user_id=$2",
        [guild.id, member.id],
      );
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
        await this.app.db.query(
          "UPDATE guild_users SET nickname_pending=true,nickname_expected=nickname_before,nickname_last=$3,nickname_written=true WHERE guild_id=$1 AND user_id=$2",
          [guild.id, member.id, current.nickname],
        );
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
      await this.app.db.query(
        "UPDATE guild_users SET nickname_restore=false,nickname_baseline_set=false,nickname_pending=false,nickname_written=false,nickname_last=CASE WHEN $3 THEN nickname_before ELSE nickname_last END WHERE guild_id=$1 AND user_id=$2",
        [guild.id, member.id, restored],
      );
      return;
    }
    if (!user.nickname_enabled || user.nickname_suspended || !user.primary_character_id) return;
    if (independent) {
      await suspend();
      return;
    }
    if (ownPending)
      await this.app.db.query(
        "UPDATE guild_users SET nickname_last=$3,nickname_written=true,nickname_pending=false WHERE guild_id=$1 AND user_id=$2",
        [guild.id, member.id, current.nickname],
      );
    const character = (
      await this.app.db.query<{ name: string }>(
        "SELECT c.name FROM characters c JOIN links l ON l.character_id=c.id WHERE c.id=$1 AND l.guild_id=$2 AND l.user_id=$3 AND l.active",
        [user.primary_character_id, guild.id, member.id],
      )
    )[0];
    if (!character) return;
    const target = nickname(character.name);
    if (!user.nickname_baseline_set)
      await this.app.db.query(
        "UPDATE guild_users SET nickname_before=$3,nickname_baseline_set=true,nickname_written=false WHERE guild_id=$1 AND user_id=$2",
        [guild.id, member.id, current.nickname],
      );
    if (current.nickname !== target) {
      await this.app.db.query(
        "UPDATE guild_users SET nickname_pending=true,nickname_expected=$3 WHERE guild_id=$1 AND user_id=$2",
        [guild.id, member.id, target],
      );
      await guard();
      if (!(await this.app.discord.nickname(guild.id, member.id, target, current.nickname))) {
        await suspend();
        return;
      }
      await this.app.db.query(
        "UPDATE guild_users SET nickname_last=$3,nickname_written=true,nickname_pending=false WHERE guild_id=$1 AND user_id=$2",
        [guild.id, member.id, target],
      );
    } else
      await this.app.db.query(
        "UPDATE guild_users SET nickname_pending=false WHERE guild_id=$1 AND user_id=$2",
        [guild.id, member.id],
      );
  }
  /** Startup catch-up and jittered scheduling fetch only actively needed FCs/profiles. */
  async schedule(): Promise<void> {
    const companies = await this.app.db.query<{ id: string }>(
      "SELECT f.id FROM free_companies f WHERE EXISTS(SELECT 1 FROM guilds g WHERE g.fc_id=f.id AND g.active) AND (f.last_successful_roster_at IS NULL OR f.last_successful_roster_at<now()-$1*interval '1 second')",
      [this.app.config.ROSTER_INTERVAL_SECONDS],
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
    const characters = await this.app.db.query<{ id: string }>(
      "SELECT c.id FROM characters c WHERE (c.profile_at IS NULL OR c.profile_at<now()-$1*interval '1 second') AND EXISTS(SELECT 1 FROM links l JOIN guild_users u ON u.guild_id=l.guild_id AND u.user_id=l.user_id JOIN guilds g ON g.id=l.guild_id WHERE l.character_id=c.id AND l.active AND u.present AND g.active) LIMIT 100",
      [this.app.config.PROFILE_INTERVAL_SECONDS],
    );
    for (const character of characters)
      await enqueue(this.app.db.pool, "profile", `profile:${character.id}`, {
        characterId: character.id,
      });
    await this.app.db.query("DELETE FROM challenges WHERE expires_at<now()-interval '7 days'");
    await this.app.db.query(
      "UPDATE jobs SET status='queued',due_at=now()+interval '5 minutes',attempts=0 WHERE status='blocked' AND due_at<now()-interval '5 minutes'",
    );
  }
}
