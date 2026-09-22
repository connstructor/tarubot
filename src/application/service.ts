/** Authorized application decisions. Commit state and its outbox together; perform remote I/O outside transactions. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as t from "../infrastructure/postgres/schema.js";
import type { PoolClient } from "pg";
import type { Configuration } from "../config/env.js";
import { authorize, authorizeRoleManager, type Actor } from "../domain/policy.js";
import { rankAccess } from "./rank-policy.js";
import { Failure, gil, MAX_GIL, note, normalized } from "../domain/values.js";
import {
  audit,
  ensureUser,
  orm,
  type Connection,
  type Database,
} from "../infrastructure/postgres/database.js";
import type {
  CharacterIdentity,
  CompanyIdentity,
  Nodestone,
} from "../infrastructure/nodestone/client.js";
import { enqueue, layoutGuildRoles, reconcileUser } from "../jobs/queue.js";
import type { DiscordPort, GuildRecord } from "./records.js";

/** Guild-scoped operations reused by slash commands, components, and operational workflows. */
export class Service {
  /** Dependencies are injected so persistence tests can control Discord/Lodestone outcomes. */
  constructor(
    readonly db: Database,
    readonly discord: DiscordPort,
    readonly lodestone: Nodestone,
    readonly config: Configuration,
  ) {}
  /** Delegate bot-only officer authority without granting Discord server permissions. */
  async enrichActor(actor: Actor): Promise<Actor> {
    if (actor.serverManager ?? actor.officer) return actor;
    const [guild] = await this.db.orm
      .select()
      .from(t.guilds)
      .where(and(eq(t.guilds.id, actor.guildId), eq(t.guilds.active, true)));
    if (!guild?.officer_role_id || !actor.roleIds?.includes(guild.officer_role_id)) return actor;
    const access = await rankAccess(
      this.db,
      guild,
      actor.userId,
      this.config.ROSTER_INTERVAL_SECONDS,
    );
    return { ...actor, officer: !access.revoked && access.officer !== "no" };
  }
  /** Read configured state without silently creating a guild for an ordinary/read-only command. */
  async guild(actor: Actor): Promise<GuildRecord> {
    authorize(actor, actor.guildId, "user");
    const [row] = await this.db.orm
      .select()
      .from(t.guilds)
      .where(and(eq(t.guilds.id, actor.guildId), eq(t.guilds.active, true)));
    if (!row)
      throw new Failure(
        "setup",
        "This guild is unconfigured. An officer can begin with /config fc link.",
      );
    return row;
  }
  /** Return only self-owned links unless the caller is an officer in this same guild. */
  async characters(actor: Actor, owner: string): Promise<unknown> {
    authorize(actor, actor.guildId, "user", owner);
    await this.guild(actor);
    return {
      characters: await this.db.orm
        .select({
          id: t.links.id,
          character_id: t.links.character_id,
          active: t.links.active,
          provenance: t.links.provenance,
          created_at: t.links.created_at,
          name: t.characters.name,
          world: t.characters.world,
          fc_hint: t.characters.fc_hint,
          fc_name: t.freeCompanies.name,
          primary_character_id: t.guildUsers.primary_character_id,
          nickname_enabled: t.guildUsers.nickname_enabled,
          nickname_suspended: t.guildUsers.nickname_suspended,
        })
        .from(t.links)
        .innerJoin(t.characters, eq(t.characters.id, t.links.character_id))
        .leftJoin(t.freeCompanies, eq(t.freeCompanies.id, t.characters.fc_hint))
        .innerJoin(
          t.guildUsers,
          and(
            eq(t.guildUsers.guild_id, t.links.guild_id),
            eq(t.guildUsers.user_id, t.links.user_id),
          ),
        )
        .where(and(eq(t.links.guild_id, actor.guildId), eq(t.links.user_id, owner)))
        .orderBy(asc(t.links.created_at)),
    };
  }
  /** Keep application outcomes, grants, revocation, history, and delivery visibly separate. */
  async guestStatus(actor: Actor, owner: string): Promise<unknown> {
    authorize(actor, actor.guildId, "user", owner);
    const guild = await this.guild(actor);
    return {
      applications: await this.db.orm
        .select()
        .from(t.guestApplications)
        .where(
          and(
            eq(t.guestApplications.guild_id, actor.guildId),
            eq(t.guestApplications.user_id, owner),
          ),
        )
        .orderBy(desc(t.guestApplications.created_at))
        .limit(10),
      grants: await this.db.orm
        .select({
          provenance: t.guestGrants.provenance,
          created_at: t.guestGrants.created_at,
          reason: t.guestGrants.reason,
        })
        .from(t.guestGrants)
        .where(and(eq(t.guestGrants.guild_id, actor.guildId), eq(t.guestGrants.user_id, owner))),
      revocation: await this.db.orm
        .select({
          revoked: t.guestState.revoked,
          changed_at: t.guestState.changed_at,
          reason: t.guestState.reason,
        })
        .from(t.guestState)
        .where(and(eq(t.guestState.guild_id, actor.guildId), eq(t.guestState.user_id, owner))),
      formerMember: [
        {
          eligible:
            guild.fc_id !== null &&
            (
              await this.db.orm
                .select({ id: t.membershipHistory.id })
                .from(t.membershipHistory)
                .where(
                  and(
                    eq(t.membershipHistory.guild_id, actor.guildId),
                    eq(t.membershipHistory.user_id, owner),
                    eq(t.membershipHistory.fc_id, guild.fc_id),
                  ),
                )
                .limit(1)
            ).length > 0,
        },
      ],
      delivery: await this.db.orm
        .select({
          id: t.jobs.id,
          kind: t.jobs.kind,
          status: t.jobs.status,
          last_error: t.jobs.last_error,
          result: t.jobs.result,
        })
        .from(t.jobs)
        .where(and(eq(t.jobs.guild_id, actor.guildId), eq(t.jobs.user_id, owner)))
        .orderBy(desc(t.jobs.created_at))
        .limit(10),
    };
  }
  /** Aggregate child work without exposing another requester's private run or user effects. */
  async syncStatus(actor: Actor, run: string | null): Promise<unknown> {
    const guild = await this.guild(actor);
    const db = this.db.orm,
      child = alias(t.jobs, "child");
    const totals = db
      .select({
        total: sql<number>`count(*)::int`.as("total"),
        completed: sql<number>`count(*) FILTER(WHERE ${child.status}='succeeded')::int`.as(
          "completed",
        ),
        pending:
          sql<number>`count(*) FILTER(WHERE ${child.status} IN ('queued','running'))::int`.as(
            "pending",
          ),
        blocked:
          sql<number>`count(*) FILTER(WHERE ${child.status} IN ('blocked','disabled'))::int`.as(
            "blocked",
          ),
        failed: sql<number>`count(*) FILTER(WHERE ${child.status}='failed')::int`.as("failed"),
      })
      .from(t.syncRunJobs)
      .innerJoin(child, eq(child.id, t.syncRunJobs.job_id))
      .where(eq(t.syncRunJobs.run_id, t.syncRuns.id))
      .as("totals");
    const runs = await db
      .select({
        id: t.syncRuns.id,
        created_at: t.syncRuns.created_at,
        enumeration_completed_at: t.syncRuns.enumeration_completed_at,
        acquisition_kind: t.jobs.kind,
        acquisition_status: t.jobs.status,
        last_error: t.jobs.last_error,
        result: t.jobs.result,
        status: sql<string>`CASE WHEN ${totals.failed}>0 THEN 'failed' WHEN ${totals.blocked}>0 THEN 'blocked' WHEN ${totals.pending}>0 THEN 'queued' ELSE 'completed' END`,
        work_total: totals.total,
        work_completed: totals.completed,
        work_blocked: totals.blocked,
        work_failed: totals.failed,
      })
      .from(t.syncRuns)
      .leftJoin(t.jobs, eq(t.jobs.id, t.syncRuns.job_id))
      .leftJoinLateral(totals, sql`true`)
      .where(
        and(
          eq(t.syncRuns.guild_id, actor.guildId),
          actor.officer ? undefined : eq(t.syncRuns.requester_id, actor.userId),
          run ? eq(t.syncRuns.id, run) : undefined,
        ),
      )
      .orderBy(desc(t.syncRuns.created_at))
      .limit(10);
    const ownProfile = db
      .select({ id: t.links.id })
      .from(t.links)
      .where(
        and(
          eq(t.links.guild_id, actor.guildId),
          eq(t.links.active, true),
          eq(t.links.character_id, sql`${t.jobs.payload}->>'characterId'`),
          actor.officer ? undefined : eq(t.links.user_id, actor.userId),
        ),
      );
    const work = await db
      .select({
        id: t.jobs.id,
        kind: t.jobs.kind,
        status: t.jobs.status,
        attempts: t.jobs.attempts,
        due_at: t.jobs.due_at,
        last_error: t.jobs.last_error,
        result: t.jobs.result,
      })
      .from(t.jobs)
      .where(
        and(
          or(
            and(
              eq(t.jobs.guild_id, actor.guildId),
              actor.officer ? undefined : eq(t.jobs.user_id, actor.userId),
            ),
            and(
              isNull(t.jobs.guild_id),
              or(
                actor.officer && guild.fc_id
                  ? eq(sql`${t.jobs.payload}->>'fcId'`, guild.fc_id)
                  : sql`false`,
                exists(ownProfile),
              ),
            ),
          ),
          inArray(t.jobs.status, ["queued", "running", "blocked", "failed", "disabled"]),
        ),
      )
      .orderBy(desc(t.jobs.created_at))
      .limit(25);
    return { runs, work };
  }
  /** Diagnose independent capabilities; validation never mutates configuration or access. */
  async validate(actor: Actor): Promise<unknown> {
    authorize(actor, actor.guildId, "officer");
    const guild = await this.guild(actor);
    const capabilities: Record<string, string> = {};
    for (const [field, value] of Object.entries(guild)) {
      if (!field.endsWith("role_id") && !field.endsWith("channel_id")) continue;
      if (typeof value !== "string") {
        capabilities[field] = "unconfigured";
        continue;
      }
      try {
        if (field.endsWith("role_id")) await this.discord.validateRole(guild.id, value);
        else await this.discord.validateChannel(guild.id, value);
        capabilities[field] = "available";
      } catch (error) {
        capabilities[field] =
          error instanceof Failure
            ? error.message
            : "Resource check failed; inspect bot permissions and hierarchy.";
      }
    }
    return {
      configuration: guild,
      effectsGloballyEnabled: this.config.ENABLE_EFFECTS,
      capabilities,
      fc: guild.fc_id
        ? await this.db.orm
            .select({
              id: t.freeCompanies.id,
              last_successful_roster_at: t.freeCompanies.last_successful_roster_at,
              last_attempt_at: t.freeCompanies.last_attempt_at,
              last_error: t.freeCompanies.last_error,
            })
            .from(t.freeCompanies)
            .where(eq(t.freeCompanies.id, guild.fc_id))
        : null,
    };
  }
  /** Completion is a private read and repeats owner/officer authorization inside the service. */
  async autocomplete(
    actor: Actor,
    kind: "application" | "verify" | "character",
    owner: string,
    query: string,
  ): Promise<{ name: string; value: string }[]> {
    authorize(actor, actor.guildId, kind === "application" ? "officer" : "user", owner);
    query = query.replaceAll("%", "\\%").replaceAll("_", "\\_");
    if (kind === "application") {
      const rows = await this.db.orm
        .select({ id: t.guestApplications.id, user_id: t.guestApplications.user_id })
        .from(t.guestApplications)
        .where(
          and(
            eq(t.guestApplications.guild_id, actor.guildId),
            eq(t.guestApplications.state, "pending"),
            or(
              ilike(sql`${t.guestApplications.id}::text`, `%${query}%`),
              ilike(t.guestApplications.user_id, `%${query}%`),
            ),
          ),
        )
        .limit(25);
      return rows.map((row) => ({
        name: `${row.user_id} — ${row.id}`.slice(0, 100),
        value: row.id,
      }));
    }
    const rows =
      kind === "verify"
        ? await this.db.orm
            .selectDistinct({
              id: t.characters.id,
              name: t.characters.name,
              world: t.characters.world,
            })
            .from(t.challenges)
            .innerJoin(t.characters, eq(t.characters.id, t.challenges.character_id))
            .where(
              and(
                eq(t.challenges.guild_id, actor.guildId),
                eq(t.challenges.user_id, owner),
                gt(t.challenges.expires_at, sql`now()`),
                isNull(t.challenges.consumed_at),
                isNull(t.challenges.replaced_at),
                or(ilike(t.characters.name, `%${query}%`), ilike(t.characters.id, `%${query}%`)),
              ),
            )
            .limit(25)
        : await this.db.orm
            .select({ id: t.characters.id, name: t.characters.name, world: t.characters.world })
            .from(t.links)
            .innerJoin(t.characters, eq(t.characters.id, t.links.character_id))
            .where(
              and(
                eq(t.links.guild_id, actor.guildId),
                eq(t.links.user_id, owner),
                eq(t.links.active, true),
                or(ilike(t.characters.name, `%${query}%`), ilike(t.characters.id, `%${query}%`)),
              ),
            )
            .limit(25);
    return rows.map((row) => ({
      name: `${row.name} @ ${row.world} (${row.id})`.slice(0, 100),
      value: row.id,
    }));
  }
  /** Refresh public display metadata without treating a profile fetch as an accepted roster. */
  async storeCompany(client: Connection, value: CompanyIdentity): Promise<void> {
    const data = {
      name: value.name,
      tag: value.tag,
      world: value.world,
      dc: value.dc,
      profile_at: sql`now()`,
    };
    await orm(client)
      .insert(t.freeCompanies)
      .values({ id: value.id, ...data })
      .onConflictDoUpdate({ target: t.freeCompanies.id, set: data });
  }
  /** Roster display updates must not advance profile freshness or overwrite independent FC hints. */
  async storeCharacter(
    client: Connection,
    value: CharacterIdentity,
    profile = true,
  ): Promise<void> {
    // Profile FC hints are deliberately independent from roster authority.
    const display = { name: value.name, world: value.world, dc: value.dc };
    await orm(client)
      .insert(t.characters)
      .values({
        id: value.id,
        ...display,
        fc_hint: value.fcId,
        profile_at: profile ? sql`now()` : null,
      })
      .onConflictDoUpdate({
        target: t.characters.id,
        set: {
          ...display,
          fc_hint: profile ? value.fcId : t.characters.fc_hint,
          profile_at: profile ? sql`now()` : t.characters.profile_at,
        },
      });
  }
  /** Validate external resources first, then atomically revise config and queue cleanup/projection. */
  async configure(actor: Actor, field: string, value: string | null): Promise<unknown> {
    authorize(actor, actor.guildId, "officer");
    const fields = [
      "fc_id",
      "member_role_id",
      "guest_role_id",
      "officer_role_id",
      "leader_role_id",
      "ledger_channel_id",
      "officer_notifications_channel_id",
      "guest_application_channel_id",
    ] as const;
    const column = fields.find((candidate) => candidate === field);
    if (!column) throw new Failure("input", "Invalid configuration field.");
    if (field === "officer_role_id" || field === "leader_role_id") authorizeRoleManager(actor);
    if (field === "fc_id" && value === null)
      throw new Failure("input", "Use FC unlink with the currently linked ID.");
    const [existing] = await this.db.orm
      .select()
      .from(t.guilds)
      .where(eq(t.guilds.id, actor.guildId));
    if (field === "fc_id" && existing?.officer_rank_key) authorizeRoleManager(actor);
    let fc: CompanyIdentity | undefined;
    if (field === "fc_id" && value) {
      if (existing?.fc_id === value) return { status: "unchanged" };
      if (existing?.fc_id) throw new Failure("input", "Explicitly unlink the current FC first.");
      fc = await this.lodestone.company(value);
    }
    if (field.endsWith("role_id")) {
      if (!actor.manageRoles) throw new Failure("forbidden", "Manage Roles is required.");
      if (value) await this.discord.validateRole(actor.guildId, value, actor.userId);
    } else if (field.endsWith("channel_id") && value)
      await this.discord.validateChannel(actor.guildId, value);
    const adopted =
      field === "officer_role_id" && value && existing?.officer_role_id !== value
        ? (await this.discord.members(actor.guildId)).filter(
            (member) => !member.bot && member.roles.includes(value),
          )
        : [];
    return this.db.transaction(async (client) => {
      const db = orm(client);
      await db
        .insert(t.guilds)
        .values({ id: actor.guildId, effects_enabled: true })
        .onConflictDoNothing();
      const [saved] = await db
        .select()
        .from(t.guilds)
        .where(eq(t.guilds.id, actor.guildId))
        .for("update");
      if (!saved) throw new Error("Missing guild");
      if (field === "fc_id" && value && saved.fc_id && saved.fc_id !== value)
        throw new Failure("conflict", "Another FC was linked; unlink it explicitly first.");
      if (fc) await this.storeCompany(client, fc);
      if (
        field === "member_role_id" ||
        field === "guest_role_id" ||
        field === "officer_role_id" ||
        field === "leader_role_id"
      ) {
        const old = saved[field];
        const other = [
          "member_role_id",
          "guest_role_id",
          "officer_role_id",
          "leader_role_id",
        ] as const;
        if (value && other.some((key) => key !== field && saved[key] === value))
          throw new Failure("input", "Managed roles must be distinct.");
        if (old && old !== value)
          await db
            .insert(t.retiredRoles)
            .values({ guild_id: actor.guildId, role_id: old, revision: saved.revision })
            .onConflictDoNothing();
        if (value)
          await db
            .delete(t.retiredRoles)
            .where(
              and(eq(t.retiredRoles.guild_id, actor.guildId), eq(t.retiredRoles.role_id, value)),
            );
      }
      // The computed field is a schema-key union from the allowlist, never a SQL identifier string.
      await db
        .update(t.guilds)
        .set({ [column]: value, revision: sql`${t.guilds.revision}+1`, active: true })
        .where(eq(t.guilds.id, actor.guildId));
      if (field === "fc_id" && value) {
        await db
          .insert(t.ledgerAccounts)
          .values({ guild_id: actor.guildId, fc_id: value })
          .onConflictDoNothing();
        await enqueue(client, "roster", `roster:${value}`, { fcId: value });
      }
      await audit(client, actor.guildId, actor.userId, "config", field, { value });
      if (field.endsWith("role_id")) await layoutGuildRoles(client, actor.guildId);
      for (const member of adopted) {
        await ensureUser(client, actor.guildId, member.id, member.joinedAt);
        await db
          .insert(t.officerOverrides)
          .values({
            guild_id: actor.guildId,
            user_id: member.id,
            state: "granted",
            actor_id: actor.userId,
            reason: "Existing Officer role adopted by configuration",
          })
          .onConflictDoNothing();
        await audit(client, actor.guildId, actor.userId, "officer.adopt", member.id, {
          roleId: value,
        });
      }
      await enqueue(client, "reconcile.guild", `guild:${actor.guildId}`, {}, actor.guildId);
      await db
        .update(t.jobs)
        .set({ status: "queued", attempts: 0, due_at: sql`now()` })
        .where(
          and(eq(t.jobs.guild_id, actor.guildId), inArray(t.jobs.status, ["blocked", "disabled"])),
        );
      return { status: "saved", effects: "queued" };
    });
  }
  /** Selecting an automatic authority source is reserved for actual server role managers. */
  async configureOfficerRank(actor: Actor, rank: string | null): Promise<unknown> {
    authorizeRoleManager(actor);
    await this.guild(actor);
    if (rank !== null) rank = note(rank);
    return this.db.transaction(async (client) => {
      await orm(client)
        .update(t.guilds)
        .set({
          officer_rank_name: rank,
          officer_rank_key: rank ? normalized(rank) : null,
          revision: sql`${t.guilds.revision}+1`,
        })
        .where(eq(t.guilds.id, actor.guildId));
      await audit(client, actor.guildId, actor.userId, "config.officer_rank", actor.guildId, {
        rank,
      });
      await enqueue(client, "reconcile.guild", `guild:${actor.guildId}`, {}, actor.guildId);
      return {
        status: "saved",
        officerRank: rank,
        mode: rank ? "rank_and_manual_overrides" : "manual_only",
        effects: "queued",
      };
    });
  }
  /** Matching the stored ID prevents stale unlink requests; all historical/account data survives. */
  async unlinkCompany(actor: Actor, fcId: string): Promise<unknown> {
    authorize(actor, actor.guildId, "officer");
    if ((await this.guild(actor)).officer_rank_key) authorizeRoleManager(actor);
    return this.db.transaction(async (client) => {
      const result = await orm(client)
        .update(t.guilds)
        .set({ fc_id: null, revision: sql`${t.guilds.revision}+1` })
        .where(and(eq(t.guilds.id, actor.guildId), eq(t.guilds.fc_id, fcId)))
        .returning({ id: t.guilds.id });
      if (!result.length)
        throw new Failure("input", "The supplied FC ID does not match the linked FC.");
      await audit(client, actor.guildId, actor.userId, "fc.unlink", fcId);
      await enqueue(client, "reconcile.guild", `guild:${actor.guildId}`, {}, actor.guildId);
      return { status: "unlinked", effects: "queued" };
    });
  }
  /** Serialize ownership by character; an active link and any fresh positive evidence commit together. */
  private async trust(
    client: PoolClient,
    actor: Actor,
    owner: string,
    character: string,
    provenance: string,
    reason: string | null,
    source: unknown,
  ): Promise<string> {
    const db = orm(client);
    await db
      .select({ id: t.characters.id })
      .from(t.characters)
      .where(eq(t.characters.id, character))
      .for("update");
    const [linked] = await db
      .select({ id: t.links.id, user_id: t.links.user_id })
      .from(t.links)
      .where(
        and(
          eq(t.links.guild_id, actor.guildId),
          eq(t.links.character_id, character),
          eq(t.links.active, true),
        ),
      );
    if (linked) {
      if (linked.user_id !== owner)
        throw new Failure(
          "ownership_conflict",
          "This character is already linked to another user.",
        );
      await reconcileUser(client, actor.guildId, owner);
      return linked.id;
    }
    const previous =
      (
        await db
          .select({ id: t.links.id })
          .from(t.links)
          .where(and(eq(t.links.guild_id, actor.guildId), eq(t.links.user_id, owner)))
          .limit(1)
      ).length > 0 ||
      (
        await db
          .select({ user_id: t.guildUsers.user_id })
          .from(t.guildUsers)
          .where(
            and(
              eq(t.guildUsers.guild_id, actor.guildId),
              eq(t.guildUsers.user_id, owner),
              eq(t.guildUsers.imported, true),
            ),
          )
          .limit(1)
      ).length > 0;
    await db
      .delete(t.membership)
      .where(
        and(eq(t.membership.guild_id, actor.guildId), eq(t.membership.character_id, character)),
      );
    const [link] = await db
      .insert(t.links)
      .values({
        guild_id: actor.guildId,
        user_id: owner,
        character_id: character,
        provenance,
        actor_id: actor.userId,
        reason,
        source,
      })
      .returning({ id: t.links.id });
    if (!link) throw new Error("Missing link");
    const latest = db
      .select({
        id: t.rosterSnapshots.id,
        fc_id: t.rosterSnapshots.fc_id,
        observed_at: t.rosterSnapshots.observed_at,
      })
      .from(t.rosterSnapshots)
      .where(eq(t.rosterSnapshots.fc_id, t.guilds.fc_id))
      .orderBy(desc(t.rosterSnapshots.observed_at))
      .limit(1)
      .as("latest");
    const [evidence] = await db
      .select({ id: latest.id, fc_id: latest.fc_id, observed_at: latest.observed_at })
      .from(t.guilds)
      .innerJoinLateral(latest, sql`true`)
      .innerJoin(
        t.rosterMembers,
        and(
          eq(t.rosterMembers.snapshot_id, latest.id),
          eq(t.rosterMembers.character_id, character),
        ),
      )
      .where(
        and(
          eq(t.guilds.id, actor.guildId),
          gt(
            latest.observed_at,
            sql`now()-${this.config.ROSTER_INTERVAL_SECONDS}*interval '1 second'`,
          ),
        ),
      );
    if (evidence) {
      await db
        .insert(t.membership)
        .values({
          guild_id: actor.guildId,
          fc_id: evidence.fc_id,
          character_id: character,
          state: "present",
          snapshot_id: evidence.id,
          confirmed_snapshot_id: evidence.id,
        })
        .onConflictDoUpdate({
          target: [t.membership.guild_id, t.membership.fc_id, t.membership.character_id],
          set: {
            state: "present",
            first_absence_at: null,
            snapshot_id: evidence.id,
            confirmed_snapshot_id: evidence.id,
          },
        });
      await db
        .insert(t.membershipHistory)
        .values({
          guild_id: actor.guildId,
          user_id: owner,
          fc_id: evidence.fc_id,
          link_id: link.id,
          snapshot_id: evidence.id,
          observed_at: evidence.observed_at,
        })
        .onConflictDoNothing();
    }
    if (!previous)
      await db
        .update(t.guildUsers)
        .set({ primary_character_id: character, nickname_enabled: true, nickname_suspended: false })
        .where(and(eq(t.guildUsers.guild_id, actor.guildId), eq(t.guildUsers.user_id, owner)));
    await audit(client, actor.guildId, actor.userId, "character.link", link.id, {
      character,
      owner,
      provenance,
      reason,
    });
    await reconcileUser(client, actor.guildId, owner);
    return link.id;
  }
  /** Issue a bounded, replaceable challenge; plaintext is returned once and never persisted. */
  async claim(actor: Actor, identity: CharacterIdentity): Promise<unknown> {
    await this.guild(actor);
    const member = await this.discord.member(actor.guildId, actor.userId);
    if (!member || member.bot)
      throw new Failure("forbidden", "Only current human guild members may claim characters.");
    const token = `tarubot_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256")
      .update(`${actor.guildId}:${actor.userId}:${identity.id}:${token}`)
      .digest("hex");
    return this.db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(714882491)");
      const db = orm(client);
      await ensureUser(client, actor.guildId, actor.userId, member.joinedAt);
      await this.storeCharacter(client, identity);
      const [existing] = await db
        .select({ user_id: t.links.user_id })
        .from(t.links)
        .where(
          and(
            eq(t.links.guild_id, actor.guildId),
            eq(t.links.character_id, identity.id),
            eq(t.links.active, true),
          ),
        );
      if (existing) {
        if (existing.user_id === actor.userId) {
          await reconcileUser(client, actor.guildId, actor.userId);
          return { status: "already_linked", effects: "queued" };
        }
        throw new Failure(
          "ownership_conflict",
          "This character is already linked to another user.",
        );
      }
      await db
        .update(t.challenges)
        .set({ replaced_at: sql`now()` })
        .where(
          and(
            eq(t.challenges.guild_id, actor.guildId),
            eq(t.challenges.user_id, actor.userId),
            eq(t.challenges.character_id, identity.id),
            isNull(t.challenges.consumed_at),
            isNull(t.challenges.replaced_at),
          ),
        );
      const [counts] = await db
        .select({
          own: sql<bigint>`count(*) FILTER(WHERE ${t.challenges.guild_id}=${actor.guildId} AND ${t.challenges.user_id}=${actor.userId})`.mapWith(
            BigInt,
          ),
          total: sql<bigint>`count(*)`.mapWith(BigInt),
        })
        .from(t.challenges)
        .where(
          and(
            gt(t.challenges.expires_at, sql`now()`),
            isNull(t.challenges.consumed_at),
            isNull(t.challenges.replaced_at),
          ),
        );
      if (!counts || counts.own >= 5n || counts.total >= 1000n)
        throw new Failure(
          "cooldown",
          "Too many pending verification challenges. Try again after one expires.",
        );
      const [row] = await db
        .insert(t.challenges)
        .values({
          guild_id: actor.guildId,
          user_id: actor.userId,
          character_id: identity.id,
          token_hash: hash,
          expires_at: sql`now()+${this.config.VERIFICATION_SECONDS}*interval '1 second'`,
        })
        .returning({ id: t.challenges.id, expires_at: t.challenges.expires_at });
      return {
        status: "pending",
        character: identity.id,
        name: identity.name,
        world: identity.world,
        token,
        challenge: row?.id,
        expiresAt: row?.expires_at,
        instructions: `Place the exact token in your public Lodestone biography, then use /verify character:${identity.id}. Publication may take several minutes.`,
      };
    });
  }
  /** Fresh biography proof is checked against a locked, still-valid tuple-bound challenge. */
  async verify(actor: Actor, characterId: string): Promise<unknown> {
    await this.guild(actor);
    const identity = await this.lodestone.profile(characterId, true);
    const tokens = identity.biography?.match(/tarubot_[A-Za-z0-9_-]{43}/g) ?? [];
    return this.db.transaction(async (client) => {
      const db = orm(client);
      await db
        .select({ user_id: t.guildUsers.user_id })
        .from(t.guildUsers)
        .where(
          and(eq(t.guildUsers.guild_id, actor.guildId), eq(t.guildUsers.user_id, actor.userId)),
        )
        .for("update");
      const [challenge] = await db
        .select()
        .from(t.challenges)
        .where(
          and(
            eq(t.challenges.guild_id, actor.guildId),
            eq(t.challenges.user_id, actor.userId),
            eq(t.challenges.character_id, characterId),
            isNull(t.challenges.replaced_at),
          ),
        )
        .orderBy(desc(t.challenges.issued_at))
        .limit(1)
        .for("update");
      if (!challenge || challenge.expires_at.getTime() <= Date.now())
        throw new Failure("expired", "No unexpired challenge. Use /claim to obtain a new token.");
      if (challenge.consumed_at) return { status: "already_verified" };
      const expected = Buffer.from(challenge.token_hash, "hex");
      if (
        !tokens.some((token) =>
          timingSafeEqual(
            createHash("sha256")
              .update(`${actor.guildId}:${actor.userId}:${characterId}:${token}`)
              .digest(),
            expected,
          ),
        )
      )
        throw new Failure(
          "pending",
          "Your proof token is not visible yet. Retry before the challenge expires.",
        );
      await this.storeCharacter(client, identity);
      const link = await this.trust(
        client,
        actor,
        actor.userId,
        characterId,
        "profile_token",
        null,
        { challengeId: challenge.id },
      );
      const consumed = await db
        .update(t.challenges)
        .set({ consumed_at: sql`clock_timestamp()` })
        .where(
          and(
            eq(t.challenges.id, challenge.id),
            gt(t.challenges.expires_at, sql`clock_timestamp()`),
            isNull(t.challenges.consumed_at),
            isNull(t.challenges.replaced_at),
          ),
        )
        .returning({ id: t.challenges.id });
      if (!consumed.length)
        throw new Failure(
          "expired",
          "The challenge expired before completion. Request a new challenge.",
        );
      await audit(client, actor.guildId, actor.userId, "verification.complete", link, {
        challengeId: challenge.id,
      });
      return { status: "verified", link, effects: "queued" };
    });
  }
  /** Manual trust requires an officer reason and a currently present human recipient. */
  async assign(
    actor: Actor,
    owner: string,
    identity: CharacterIdentity,
    reason: string,
  ): Promise<unknown> {
    authorize(actor, actor.guildId, "officer");
    await this.guild(actor);
    reason = note(reason);
    const member = await this.discord.member(actor.guildId, owner);
    if (!member || member.bot)
      throw new Failure("input", "Assignments require a current human guild member.");
    return this.db.transaction(async (client) => {
      await ensureUser(client, actor.guildId, owner, member.joinedAt);
      await this.storeCharacter(client, identity);
      const link = await this.trust(
        client,
        actor,
        owner,
        identity.id,
        "officer_assignment",
        reason,
        // Delegated officers may vouch for membership, but cannot indirectly appoint officers.
        { officerAuthority: (actor.serverManager ?? actor.officer) && actor.manageRoles },
      );
      await audit(client, actor.guildId, actor.userId, "character.assign", link, {
        owner,
        character: identity.id,
        reason,
      });
      return { status: "assigned", link, effects: "queued" };
    });
  }
  /** Resolve stored ownership locally and retain history even when the character is unavailable. */
  async unclaim(actor: Actor, owner: string, character: string, reason?: string): Promise<unknown> {
    authorize(actor, actor.guildId, owner === actor.userId ? "user" : "officer");
    await this.guild(actor);
    if (owner !== actor.userId || reason !== undefined) reason = note(reason ?? "");
    return this.db.transaction(async (client) => {
      const db = orm(client);
      await db
        .select({ user_id: t.guildUsers.user_id })
        .from(t.guildUsers)
        .where(and(eq(t.guildUsers.guild_id, actor.guildId), eq(t.guildUsers.user_id, owner)))
        .for("update");
      await db
        .select({ id: t.characters.id })
        .from(t.characters)
        .where(eq(t.characters.id, character))
        .for("update");
      const [link] = await db
        .select({ id: t.links.id, user_id: t.links.user_id })
        .from(t.links)
        .where(
          and(
            eq(t.links.guild_id, actor.guildId),
            eq(t.links.character_id, character),
            eq(t.links.active, true),
          ),
        )
        .for("update");
      if (!link || link.user_id !== owner)
        throw new Failure("input", "That character is not actively linked to the specified owner.");
      await db
        .update(t.links)
        .set({ active: false, ended_at: sql`now()` })
        .where(eq(t.links.id, link.id));
      const remaining = db
        .select({ id: t.links.id })
        .from(t.links)
        .innerJoin(
          t.membership,
          and(
            eq(t.membership.guild_id, t.links.guild_id),
            eq(t.membership.character_id, t.links.character_id),
          ),
        )
        .innerJoin(
          t.guilds,
          and(eq(t.guilds.id, t.links.guild_id), eq(t.guilds.fc_id, t.membership.fc_id)),
        )
        .where(
          and(
            eq(t.links.guild_id, actor.guildId),
            eq(t.links.user_id, owner),
            eq(t.links.active, true),
            inArray(t.membership.state, ["present", "missing"]),
          ),
        );
      await db
        .update(t.guildUsers)
        .set({ local_member_loss: true })
        .where(
          and(
            eq(t.guildUsers.guild_id, actor.guildId),
            eq(t.guildUsers.user_id, owner),
            not(exists(remaining)),
          ),
        );
      await db
        .update(t.guildUsers)
        .set({ primary_character_id: null, nickname_restore: true })
        .where(
          and(
            eq(t.guildUsers.guild_id, actor.guildId),
            eq(t.guildUsers.user_id, owner),
            eq(t.guildUsers.primary_character_id, character),
          ),
        );
      await audit(client, actor.guildId, actor.userId, "character.unlink", link.id, {
        reason: reason ?? null,
      });
      await reconcileUser(client, actor.guildId, owner);
      return {
        status: "unlinked",
        effects: "queued",
        instructions: "If this was your primary character, select another with /main.",
      };
    });
  }
  /** Persist explicit primary/nickname intent and let the worker safely project or restore it. */
  async preferences(
    actor: Actor,
    character: string | null,
    enabled: boolean | null,
  ): Promise<unknown> {
    await this.guild(actor);
    return this.db.transaction(async (client) => {
      const db = orm(client);
      const scope = and(
        eq(t.guildUsers.guild_id, actor.guildId),
        eq(t.guildUsers.user_id, actor.userId),
      );
      await db
        .select({ user_id: t.guildUsers.user_id })
        .from(t.guildUsers)
        .where(scope)
        .for("update");
      if (character) {
        const owned = await db
          .select({ id: t.links.id })
          .from(t.links)
          .where(
            and(
              eq(t.links.guild_id, actor.guildId),
              eq(t.links.user_id, actor.userId),
              eq(t.links.character_id, character),
              eq(t.links.active, true),
            ),
          )
          .for("update");
        if (!owned.length)
          throw new Failure("input", "Choose one of your active linked characters.");
        await db
          .update(t.guildUsers)
          .set({ primary_character_id: character, nickname_restore: false })
          .where(scope);
      }
      if (enabled !== null) {
        const updated = await db
          .update(t.guildUsers)
          .set({
            nickname_enabled: enabled,
            nickname_suspended: false,
            nickname_restore: !enabled,
            nickname_baseline_set: enabled ? false : t.guildUsers.nickname_baseline_set,
          })
          .where(and(scope, enabled ? isNotNull(t.guildUsers.primary_character_id) : undefined))
          .returning({ user_id: t.guildUsers.user_id });
        if (!updated.length)
          throw new Failure("input", "Select a primary character with /main first.");
      }
      await reconcileUser(client, actor.guildId, actor.userId);
      return { status: "saved", effects: "queued" };
    });
  }
  /** Ledger authority requires actual accepted positive evidence, not just imported role protection. */
  async memberEligible(client: Connection, guild: GuildRecord, user: string): Promise<boolean> {
    if (!guild.fc_id) return false;
    const rows = await orm(client)
      .select({ id: t.links.id })
      .from(t.links)
      .innerJoin(
        t.membership,
        and(
          eq(t.membership.guild_id, t.links.guild_id),
          eq(t.membership.character_id, t.links.character_id),
        ),
      )
      .where(
        and(
          eq(t.links.guild_id, guild.id),
          eq(t.links.user_id, user),
          eq(t.links.active, true),
          eq(t.membership.fc_id, guild.fc_id),
          inArray(t.membership.state, ["present", "missing"]),
          isNotNull(t.membership.confirmed_snapshot_id),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
  /** Account locking orders exact-once financial mutations independently of notification delivery. */
  async ledger(
    actor: Actor,
    operation: string,
    input: string | number,
    noteText: string,
    key: string,
    correction: string | null = null,
  ): Promise<unknown> {
    const guild = await this.guild(actor);
    noteText = note(noteText);
    if (operation !== "deposit") authorize(actor, actor.guildId, "officer");
    if (!guild.fc_id || !guild.ledger_channel_id)
      throw new Failure("setup", "Configure an FC and ledger channel first.");
    const linkedFc = guild.fc_id;
    await this.discord.validateChannel(actor.guildId, guild.ledger_channel_id);
    let amount: bigint;
    if (operation === "deposit" || operation === "withdraw") {
      if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 999999999)
        throw new Failure("input", "Amount must be 1–999,999,999 gil.");
      amount = BigInt(input);
    } else amount = gil(input);
    return this.db.transaction(async (client) => {
      const db = orm(client);
      const [current] = await db
        .select()
        .from(t.guilds)
        .where(eq(t.guilds.id, actor.guildId))
        .for("share");
      if (!current || current.revision !== guild.revision)
        throw new Failure("conflict", "Configuration changed. Retry the operation.");
      if (!actor.officer && !(await this.memberEligible(client, current, actor.userId)))
        throw new Failure("forbidden", "Confirmed FC membership is required to deposit.");
      const [account] = await db
        .select()
        .from(t.ledgerAccounts)
        .where(
          and(eq(t.ledgerAccounts.guild_id, actor.guildId), eq(t.ledgerAccounts.fc_id, linkedFc)),
        )
        .for("update");
      if (!account) throw new Failure("setup", "The ledger account is unavailable.");
      const [duplicate] = await db
        .select()
        .from(t.ledgerEntries)
        .where(eq(t.ledgerEntries.idempotency_key, key));
      if (duplicate) {
        if (duplicate.guild_id !== actor.guildId || duplicate.account_id !== account.id)
          throw new Failure("conflict", "Idempotency key belongs to another account.");
        return { entry: duplicate, status: "already_recorded" };
      }
      if (operation === "initialize" && account.balance !== null)
        throw new Failure("initialized", "This account is already initialized.");
      if (operation !== "initialize" && account.balance === null)
        throw new Failure(
          "uninitialized",
          "An officer must initialize the recorded balance first.",
        );
      if (correction) {
        const referenced = await db
          .select({ id: t.ledgerEntries.id })
          .from(t.ledgerEntries)
          .where(
            and(eq(t.ledgerEntries.id, correction), eq(t.ledgerEntries.account_id, account.id)),
          );
        if (!referenced.length)
          throw new Failure("input", "Correction entry must belong to this account.");
      }
      const before = account.balance ?? 0n;
      const balance =
        operation === "deposit"
          ? before + amount
          : operation === "withdraw"
            ? before - amount
            : amount;
      if (balance < 0n || balance > MAX_GIL)
        throw new Failure("funds", "Insufficient funds or balance range exceeded.");
      if (operation === "adjust" && balance === before) return { status: "unchanged", balance };
      const [entry] = await db
        .insert(t.ledgerEntries)
        .values({
          account_id: account.id,
          sequence: account.sequence + 1n,
          operation,
          delta: balance - before,
          balance,
          actor_id: actor.userId,
          guild_id: actor.guildId,
          note: noteText,
          idempotency_key: key,
          correction_id: correction,
        })
        .returning();
      if (!entry) throw new Error("Missing entry");
      await db
        .update(t.ledgerAccounts)
        .set({ balance, sequence: entry.sequence })
        .where(eq(t.ledgerAccounts.id, account.id));
      await enqueue(
        client,
        "ledger.notify",
        `ledger:${entry.id}`,
        { entryId: entry.id },
        actor.guildId,
        actor.userId,
      );
      await audit(client, actor.guildId, actor.userId, `ledger.${operation}`, entry.id, {
        balance,
        delta: balance - before,
      });
      return {
        entry,
        status: "recorded",
        delivery: "queued",
        inspect: "/ledger history or /sync status",
      };
    });
  }
  /** Historical accounts remain guild-owned and officer-only even while the current FC is unlinked. */
  async ledgerRead(
    actor: Actor,
    fcId: string | null,
    before: string | null,
    history: boolean,
  ): Promise<unknown> {
    const guild = await this.guild(actor);
    const target = fcId ?? guild.fc_id;
    if (!target) throw new Failure("setup", "Supply a historical FC ID or link an FC.");
    if (target !== guild.fc_id) authorize(actor, actor.guildId, "officer");
    if (!actor.officer && !(await this.memberEligible(this.db.pool, guild, actor.userId)))
      throw new Failure("forbidden", "Confirmed FC membership is required.");
    const [account] = await this.db.orm
      .select()
      .from(t.ledgerAccounts)
      .where(and(eq(t.ledgerAccounts.guild_id, actor.guildId), eq(t.ledgerAccounts.fc_id, target)));
    if (!account) throw new Failure("input", "No ledger account exists for that FC in this guild.");
    const delivery = await this.db.orm
      .select({
        id: t.jobs.id,
        status: t.jobs.status,
        last_error: t.jobs.last_error,
        message_id: t.jobs.message_id,
        entry_id: sql<string>`${t.jobs.payload}->>'entryId'`,
      })
      .from(t.jobs)
      .innerJoin(t.ledgerEntries, sql`${t.ledgerEntries.id}::text=${t.jobs.payload}->>'entryId'`)
      .where(and(eq(t.jobs.kind, "ledger.notify"), eq(t.ledgerEntries.account_id, account.id)))
      .orderBy(desc(t.ledgerEntries.sequence))
      .limit(10);
    if (!history)
      return {
        account,
        balanceState: account.balance === null ? "uninitialized" : "known",
        delivery,
      };
    const cursor = before === null ? account.sequence + 1n : gil(before);
    const entries = await this.db.orm
      .select()
      .from(t.ledgerEntries)
      .where(and(eq(t.ledgerEntries.account_id, account.id), lt(t.ledgerEntries.sequence, cursor)))
      .orderBy(desc(t.ledgerEntries.sequence))
      .limit(10);
    return {
      entries,
      delivery,
      next: entries.length === 10 ? entries.at(-1)?.sequence.toString() : null,
    };
  }
  /** One pending application per join context; duplicate submissions reuse the persisted request. */
  async apply(actor: Actor): Promise<unknown> {
    const guild = await this.guild(actor);
    if (!guild.guest_role_id || !guild.guest_application_channel_id)
      throw new Failure("setup", "Configure a guest role and application review channel first.");
    const reviewChannel = guild.guest_application_channel_id;
    await this.discord.validateRole(actor.guildId, guild.guest_role_id);
    await this.discord.validateChannel(actor.guildId, guild.guest_application_channel_id);
    const member = await this.discord.member(actor.guildId, actor.userId);
    if (!member || member.bot)
      throw new Failure("forbidden", "Only current human guild members may apply.");
    return this.db.transaction(async (client) => {
      const db = orm(client);
      const [current] = await db
        .select()
        .from(t.guilds)
        .where(eq(t.guilds.id, actor.guildId))
        .for("share");
      if (!current || current.revision !== guild.revision)
        throw new Failure("conflict", "Configuration changed. Retry your application.");
      await ensureUser(client, actor.guildId, actor.userId, member.joinedAt);
      await db
        .select({ user_id: t.guildUsers.user_id })
        .from(t.guildUsers)
        .where(
          and(eq(t.guildUsers.guild_id, actor.guildId), eq(t.guildUsers.user_id, actor.userId)),
        )
        .for("update");
      const [pending] = await db
        .select()
        .from(t.guestApplications)
        .where(
          and(
            eq(t.guestApplications.guild_id, actor.guildId),
            eq(t.guestApplications.user_id, actor.userId),
            eq(t.guestApplications.state, "pending"),
          ),
        );
      if (pending && pending.joined_at.getTime() === member.joinedAt.getTime()) return pending;
      if (pending) {
        await db
          .update(t.guestApplications)
          .set({ state: "cancelled", decided_at: sql`now()` })
          .where(eq(t.guestApplications.id, pending.id));
        await enqueue(
          client,
          "guest.review",
          `review:${pending.id}`,
          { applicationId: pending.id },
          actor.guildId,
          actor.userId,
        );
      }
      const granted = db
        .select({ id: t.guestGrants.id })
        .from(t.guestGrants)
        .where(
          and(eq(t.guestGrants.guild_id, actor.guildId), eq(t.guestGrants.user_id, actor.userId)),
        );
      const former = guild.fc_id
        ? exists(
            db
              .select({ id: t.membershipHistory.id })
              .from(t.membershipHistory)
              .where(
                and(
                  eq(t.membershipHistory.guild_id, actor.guildId),
                  eq(t.membershipHistory.user_id, actor.userId),
                  eq(t.membershipHistory.fc_id, guild.fc_id),
                ),
              ),
          )
        : sql`false`;
      const revoked = db
        .select({ user_id: t.guestState.user_id })
        .from(t.guestState)
        .where(
          and(
            eq(t.guestState.guild_id, actor.guildId),
            eq(t.guestState.user_id, actor.userId),
            eq(t.guestState.revoked, true),
          ),
        );
      const [guest] = await db
        .select({
          eligible: sql<boolean>`(${exists(granted)} OR ${former}) AND NOT ${exists(revoked)}`,
        })
        .from(t.guilds)
        .where(eq(t.guilds.id, actor.guildId));
      if (
        guest?.eligible ||
        (await this.memberEligible(client, guild, actor.userId)) ||
        member.roles.includes(guild.guest_role_id ?? "") ||
        member.roles.includes(guild.member_role_id ?? "")
      )
        throw new Failure(
          "eligible",
          "You already have member or guest access; reconciliation can repair a missing role.",
        );
      const denied = await db
        .select({ id: t.guestApplications.id })
        .from(t.guestApplications)
        .where(
          and(
            eq(t.guestApplications.guild_id, actor.guildId),
            eq(t.guestApplications.user_id, actor.userId),
            eq(t.guestApplications.state, "denied"),
            gt(
              t.guestApplications.decided_at,
              sql`now()-${this.config.GUEST_COOLDOWN_SECONDS}*interval '1 second'`,
            ),
          ),
        );
      if (denied.length) throw new Failure("cooldown", "Your denial cooldown has not expired.");
      const [application] = await db
        .insert(t.guestApplications)
        .values({
          guild_id: actor.guildId,
          user_id: actor.userId,
          joined_at: member.joinedAt,
          channel_id: reviewChannel,
        })
        .returning();
      if (!application) throw new Error("Missing application");
      await enqueue(
        client,
        "guest.review",
        `review:${application.id}`,
        { applicationId: application.id },
        actor.guildId,
        actor.userId,
      );
      return application;
    });
  }
  /** Lock user then application consistently so approval, denial, and revocation serialize. */
  async decide(
    actor: Actor,
    applicationId: string,
    approve: boolean,
    reason: string | null = null,
    messageId?: string,
  ): Promise<unknown> {
    authorize(actor, actor.guildId, "officer");
    await this.guild(actor);
    const [preliminary] = await this.db.orm
      .select()
      .from(t.guestApplications)
      .where(
        and(
          eq(t.guestApplications.id, applicationId),
          eq(t.guestApplications.guild_id, actor.guildId),
        ),
      );
    if (!preliminary) throw new Failure("input", "Unknown application in this guild.");
    const member = await this.discord.member(actor.guildId, preliminary.user_id);
    return this.db.transaction(async (client) => {
      const db = orm(client);
      const [guild] = await db
        .select()
        .from(t.guilds)
        .where(eq(t.guilds.id, actor.guildId))
        .for("share");
      if (!guild) throw new Failure("setup", "Guild configuration unavailable.");
      const [presence] = await db
        .select({ present: t.guildUsers.present, joined_at: t.guildUsers.joined_at })
        .from(t.guildUsers)
        .where(
          and(
            eq(t.guildUsers.guild_id, actor.guildId),
            eq(t.guildUsers.user_id, preliminary.user_id),
          ),
        )
        .for("update");
      const [application] = await db
        .select()
        .from(t.guestApplications)
        .where(
          and(
            eq(t.guestApplications.id, applicationId),
            eq(t.guestApplications.guild_id, actor.guildId),
          ),
        )
        .for("update");
      if (!application) throw new Failure("input", "Unknown application.");
      if (messageId && application.message_id !== messageId)
        throw new Failure("forbidden", "This review message is obsolete.");
      if (application.state !== "pending") return application;
      let state = approve ? "approved" : "denied";
      if (
        !member ||
        member.bot ||
        member.joinedAt.getTime() !== application.joined_at.getTime() ||
        !presence?.present ||
        presence.joined_at?.getTime() !== application.joined_at.getTime()
      )
        state = "cancelled";
      else if (await this.memberEligible(client, guild, application.user_id)) state = "superseded";
      await db
        .update(t.guestApplications)
        .set({ state, reviewer_id: actor.userId, decided_at: sql`now()`, reason })
        .where(eq(t.guestApplications.id, application.id));
      if (state === "approved")
        await this.grantWithin(
          client,
          actor,
          application.user_id,
          "approved",
          `application:${application.id}`,
          reason,
        );
      await audit(client, actor.guildId, actor.userId, `guest.${state}`, application.id, {
        reason,
      });
      await enqueue(
        client,
        "guest.review",
        `review:${application.id}`,
        { applicationId: application.id },
        actor.guildId,
        application.user_id,
      );
      if (state === "approved" || state === "denied")
        await enqueue(
          client,
          "guest.dm",
          `dm:${application.id}`,
          { applicationId: application.id },
          actor.guildId,
          application.user_id,
        );
      return { id: application.id, status: state, effects: "queued" };
    });
  }
  /** A new explicit grant can restore revoked access; replaying an old grant cannot undo a later revocation. */
  private async grantWithin(
    client: Connection,
    actor: Actor,
    user: string,
    provenance: string,
    key: string,
    reason: string | null,
  ): Promise<void> {
    const db = orm(client);
    const [previous] = await db
      .select({ revoked: t.guestState.revoked })
      .from(t.guestState)
      .where(and(eq(t.guestState.guild_id, actor.guildId), eq(t.guestState.user_id, user)))
      .for("update");
    const inserted = await db
      .insert(t.guestGrants)
      .values({
        guild_id: actor.guildId,
        user_id: user,
        provenance,
        source_key: key,
        actor_id: actor.userId,
        reason,
      })
      .onConflictDoNothing({ target: t.guestGrants.source_key })
      .returning({ id: t.guestGrants.id });
    if (!inserted.length) {
      const existing = await db
        .select({ id: t.guestGrants.id })
        .from(t.guestGrants)
        .where(
          and(
            eq(t.guestGrants.source_key, key),
            eq(t.guestGrants.guild_id, actor.guildId),
            eq(t.guestGrants.user_id, user),
          ),
        );
      if (!existing.length)
        throw new Failure("conflict", "Grant idempotency key belongs to a different target.");
      return;
    }
    await db
      .insert(t.guestState)
      .values({
        guild_id: actor.guildId,
        user_id: user,
        revoked: false,
        actor_id: actor.userId,
        reason,
      })
      .onConflictDoUpdate({
        target: [t.guestState.guild_id, t.guestState.user_id],
        set: { revoked: false, actor_id: actor.userId, reason, changed_at: sql`now()` },
      });
    if (previous?.revoked)
      await audit(client, actor.guildId, actor.userId, "guest.restore", user, {
        provenance,
        key,
        reason,
      });
    await reconcileUser(client, actor.guildId, user);
  }
  /** Officer grants/revocations are durable policy decisions, with reconciliation queued separately. */
  async guestAction(
    actor: Actor,
    user: string,
    revoke: boolean,
    reason: string,
    key: string,
  ): Promise<unknown> {
    authorize(actor, actor.guildId, "officer");
    await this.guild(actor);
    reason = note(reason);
    if ((await this.discord.member(actor.guildId, user))?.bot)
      throw new Failure("input", "Guest access applies to human guild members.");
    return this.db.transaction(async (client) => {
      await ensureUser(client, actor.guildId, user);
      const db = orm(client);
      await db
        .select({ user_id: t.guildUsers.user_id })
        .from(t.guildUsers)
        .where(and(eq(t.guildUsers.guild_id, actor.guildId), eq(t.guildUsers.user_id, user)))
        .for("update");
      if (revoke) {
        await db
          .insert(t.guestState)
          .values({
            guild_id: actor.guildId,
            user_id: user,
            revoked: true,
            actor_id: actor.userId,
            reason,
          })
          .onConflictDoUpdate({
            target: [t.guestState.guild_id, t.guestState.user_id],
            set: { revoked: true, actor_id: actor.userId, reason, changed_at: sql`now()` },
          });
        const cancelled = await db
          .update(t.guestApplications)
          .set({ state: "cancelled", decided_at: sql`now()`, reviewer_id: actor.userId, reason })
          .where(
            and(
              eq(t.guestApplications.guild_id, actor.guildId),
              eq(t.guestApplications.user_id, user),
              eq(t.guestApplications.state, "pending"),
            ),
          )
          .returning({ id: t.guestApplications.id });
        for (const row of cancelled)
          await enqueue(
            client,
            "guest.review",
            `review:${row.id}`,
            { applicationId: row.id },
            actor.guildId,
            user,
          );
      } else await this.grantWithin(client, actor, user, "manual", key, reason);
      await audit(
        client,
        actor.guildId,
        actor.userId,
        revoke ? "guest.revoke" : "guest.grant",
        user,
        { reason },
      );
      await reconcileUser(client, actor.guildId, user);
      const [state] = await db
        .select({ revoked: t.guestState.revoked })
        .from(t.guestState)
        .where(and(eq(t.guestState.guild_id, actor.guildId), eq(t.guestState.user_id, user)));
      return { status: state?.revoked ? "revoked" : "granted", effects: "queued" };
    });
  }
}
