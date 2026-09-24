/** Authorized application decisions. Commit state and its outbox together; perform remote I/O outside transactions. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
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
import { authorize, authorizeRoleManager, type AccessFacts, type Actor } from "../domain/policy.js";
import { rankAccess } from "./rank-policy.js";
import { accessFacts } from "./access-facts.js";
import { Failure, gil, MAX_GIL, note, normalized, sequenceCursor } from "../domain/values.js";
import {
  GUEST_APPLICATIONS_CLOSED,
  guestApplicationInput,
  guestApplicationsOpen,
  type GuestApplicationInput,
} from "../domain/guest-application.js";
import {
  audit,
  ensureUser,
  orm,
  type Connection,
  type Database,
  type Orm,
} from "../infrastructure/postgres/database.js";
import type {
  CharacterIdentity,
  CompanyIdentity,
  Nodestone,
} from "../infrastructure/nodestone/client.js";
import {
  enqueue,
  layoutGuildRoles,
  reconcileUser,
  requeueParked,
  secureGuildChannels,
} from "../jobs/queue.js";
import { managedRoleOrder } from "../domain/role-layout.js";
import type { DiscordPort, GuildRecord } from "./records.js";
import type {
  ApplicationChoiceRow,
  ApplicationState,
  ApplyResult,
  AssignResult,
  CharacterRef,
  CharactersResult,
  ClaimResult,
  ConfigChange,
  ConfigurationReport,
  CorrectionRef,
  DecisionResult,
  EffectsMode,
  FcRef,
  FcUnlinkResult,
  GuestActionResult,
  GuestStatusView,
  LedgerBalanceView,
  LedgerHistoryView,
  LedgerReceipt,
  OfficerRankResult,
  PreferencesResult,
  RoleLayoutResult,
  RosterEvidence,
  SyncStatusView,
  UnlinkResult,
  VerifyResult,
} from "./results.js";

/** The approved wording for a revision fence: settings changed while the request ran. */
const SETTINGS_CHANGED =
  "Server settings changed while this was running, so nothing was saved. Run the command again.";

/** Approved wording shared by the role-binding and /setup input checks. */
const ONBOARDING_ROLES =
  "Onboarding is on, so all four roles are required. Choose a replacement role instead of clearing it, or run /setup again.";
const DISTINCT_ROLES = "Member, Guest, Officer and FC Leader must be four different roles.";

/**
 * Linking a second FC needs an explicit unlink first; the detail names the linked FC so the reply
 * can show the exact unlink command. History and ledgers survive the unlink.
 */
export const fcLinked = (linked: string): Failure =>
  new Failure(
    "fc_linked",
    `This server is linked to FC ${linked}. Unlink it with /config fc unlink fc_id:${linked}, then link the new one. History and ledgers are kept.`,
    0,
    { kind: "resource", resource: "freecompany", id: linked },
  );

/**
 * A character linked to someone else. The message never names the owner (it reaches logs and job
 * diagnostics); the detail carries both so an officer's reply can show the owner and a member's
 * never does.
 */
const ownershipConflict = (character: CharacterRef, owner: string): Failure =>
  new Failure(
    "ownership_conflict",
    "This character is already linked to a different member of this server.",
    0,
    { kind: "ownership", character, owner },
  );

/** The actor left the server (or is a bot) between the command and the service call. */
const notCurrentMember = (): Failure =>
  new Failure("forbidden", "You need to be a current member of this server to do that.", 0, {
    kind: "scope",
    scope: "current_member",
  });

/** A target user who is not a current human member; the detail carries the ID for the reply. */
const memberNotFound = (user: string): Failure =>
  new Failure("not_found", "That user isn't a current member of this server, or is a bot.", 0, {
    kind: "resource",
    resource: "member",
    id: user,
  });

/** Ledger access for a member who has no confirmed character in the linked FC. */
const membershipNeeded = (): Failure =>
  new Failure(
    "forbidden",
    "The FC ledger is for confirmed members of this server's Free Company.",
    0,
    { kind: "scope", scope: "membership" },
  );

/** The applicant's join changed while the form was open, so the form's join context is stale. */
const joinChanged = (): Failure =>
  new Failure(
    "stale",
    "Your server membership changed while the form was open. Run /apply again.",
    0,
    { kind: "stale", what: "join" },
  );

/** An application ID that is not in this server (officer-facing; the ID is in the detail). */
const applicationNotFound = (id: string): Failure =>
  new Failure(
    "not_found",
    "There's no guest application with that ID in this server. Pick one from the suggestions.",
    0,
    { kind: "resource", resource: "application", id },
  );

/** Guest decisions, grants and revocations are officer-only, with the approved wording. */
function authorizeGuestDecision(actor: Actor): void {
  if (!actor.officer)
    throw new Failure("forbidden", "Only officers can decide guest access.", 0, {
      kind: "scope",
      scope: "officer",
    });
  authorize(actor, actor.guildId, "officer");
}

/** Whole seconds until a limit lifts, for Failure.retryAfter; zero when unknown or already past. */
const secondsUntil = (moment: Date | null): number =>
  moment ? Math.max(0, Math.ceil((moment.getTime() - Date.now()) / 1000)) : 0;

/** Registration grants Guest only with fresh evidence, no FC membership and no revocation. */
const registrationEligible = (facts: AccessFacts): boolean =>
  facts.verified === true && facts.membership === "ineligible" && facts.fresh && !facts.revoked;

/** What trust() committed: the link, whether it is new, and the evidence it recorded. */
interface TrustResult {
  readonly id: string;
  /** False when the same owner already held this link (an idempotent repeat). */
  readonly created: boolean;
  /** The owner's first link in this guild, which therefore became their main character. */
  readonly firstLink: boolean;
  /** Fresh roster evidence listed the character, so FC membership was recorded now. */
  readonly listed: boolean;
  readonly character: CharacterRef;
}

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
        "This server has no TaruBot configuration yet. Start with /setup, or link the Free Company with /config fc link.",
        0,
        { kind: "setup", missing: "guild" },
      );
    return row;
  }
  /**
   * Whether Discord work queued by a change runs now. Callers pass the guild row they already read,
   * inside their transaction where they have one; a concurrent activation can make it momentarily
   * stale, which only affects wording, never what is queued.
   */
  effectsMode(guild: Pick<GuildRecord, "effects_enabled">): EffectsMode {
    if (!this.config.ENABLE_EFFECTS) return "deployment_disabled";
    return guild.effects_enabled ? "live" : "awaiting_activation";
  }
  /** One primary-key read of an FC's stored identity; null before its first Lodestone read. */
  async company(db: Orm, fcId: string | null): Promise<FcRef | null> {
    if (!fcId) return null;
    const [row] = await db
      .select({
        id: t.freeCompanies.id,
        name: t.freeCompanies.name,
        tag: t.freeCompanies.tag,
        world: t.freeCompanies.world,
      })
      .from(t.freeCompanies)
      .where(eq(t.freeCompanies.id, fcId));
    return row ?? null;
  }
  /**
   * Roster evidence behind a link: one primary-key read of the linked FC's last successful roster,
   * judged fresh against the same interval and database clock as reconciliation.
   */
  private async rosterEvidence(
    db: Orm,
    guild: Pick<GuildRecord, "fc_id">,
    listed: boolean,
  ): Promise<RosterEvidence> {
    if (!guild.fc_id) return { fcLinked: false, fresh: false, checkedAt: null, listed };
    const [row] = await db
      .select({
        checkedAt: t.freeCompanies.last_successful_roster_at,
        fresh: sql<boolean>`coalesce(${t.freeCompanies.last_successful_roster_at}>now()-${this.config.ROSTER_INTERVAL_SECONDS}*interval '1 second',false)`,
      })
      .from(t.freeCompanies)
      .where(eq(t.freeCompanies.id, guild.fc_id));
    return {
      fcLinked: true,
      fresh: row?.fresh ?? false,
      checkedAt: row?.checkedAt ?? null,
      listed,
    };
  }
  /** Return only self-owned links unless the caller is an officer in this same guild. */
  async characters(actor: Actor, owner: string): Promise<CharactersResult> {
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
          ended_at: t.links.ended_at,
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
  /**
   * Keep application outcomes, grants, revocation, history, and delivery visibly separate. The
   * membership, freshness and registration facts come from the same database-only read that
   * reconciliation uses; no Discord call is made.
   */
  async guestStatus(actor: Actor, owner: string): Promise<GuestStatusView> {
    authorize(actor, actor.guildId, "user", owner);
    const guild = await this.guild(actor);
    const facts = await accessFacts(this.db.orm, guild, owner, this.config.ROSTER_INTERVAL_SECONDS);
    return {
      applications: await this.db.orm
        // Answers belong in the configured review room, not potentially public status replies.
        .select({
          id: t.guestApplications.id,
          guild_id: t.guestApplications.guild_id,
          user_id: t.guestApplications.user_id,
          joined_at: t.guestApplications.joined_at,
          created_at: t.guestApplications.created_at,
          state: t.guestApplications.state,
          channel_id: t.guestApplications.channel_id,
          message_id: t.guestApplications.message_id,
          reviewer_id: t.guestApplications.reviewer_id,
          decided_at: t.guestApplications.decided_at,
          reason: t.guestApplications.reason,
        })
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
        .where(and(eq(t.guestGrants.guild_id, actor.guildId), eq(t.guestGrants.user_id, owner)))
        .orderBy(desc(t.guestGrants.created_at)),
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
          attempts: t.jobs.attempts,
          due_at: t.jobs.due_at,
          created_at: t.jobs.created_at,
          completed_at: t.jobs.completed_at,
          last_error: t.jobs.last_error,
          result: t.jobs.result,
        })
        .from(t.jobs)
        .where(and(eq(t.jobs.guild_id, actor.guildId), eq(t.jobs.user_id, owner)))
        .orderBy(desc(t.jobs.created_at))
        .limit(10),
      verifiedGuestEligible: registrationEligible(facts),
      membership: facts.membership,
      rosterFresh: facts.fresh,
      registered: facts.verified === true,
      cooldownSeconds: this.config.GUEST_COOLDOWN_SECONDS,
      effectsMode: this.effectsMode(guild),
    };
  }
  /**
   * Aggregate child work without exposing another requester's private run or user effects. A run
   * that has completed reports when its last child job finished.
   */
  async syncStatus(actor: Actor, run: string | null): Promise<SyncStatusView> {
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
        // The column's own decoder turns the aggregate's timestamp text into a Date.
        finished: sql<Date | null>`max(${child.completed_at})`
          .mapWith(child.completed_at)
          .as("finished"),
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
        requester_id: t.syncRuns.requester_id,
        acquisition_kind: t.jobs.kind,
        acquisition_status: t.jobs.status,
        last_error: t.jobs.last_error,
        result: t.jobs.result,
        status: sql<
          "failed" | "blocked" | "queued" | "completed"
        >`CASE WHEN ${totals.failed}>0 THEN 'failed' WHEN ${totals.blocked}>0 THEN 'blocked' WHEN ${totals.pending}>0 THEN 'queued' ELSE 'completed' END`,
        work_total: totals.total,
        work_completed: totals.completed,
        work_blocked: totals.blocked,
        work_failed: totals.failed,
        finished: totals.finished,
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
        created_at: t.jobs.created_at,
        completed_at: t.jobs.completed_at,
        user_id: t.jobs.user_id,
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
    return {
      // Only a completed run has a completion time; an unfinished run's last child is not its end.
      runs: runs.map(({ finished, ...row }) => ({
        ...row,
        completed_at: row.status === "completed" ? finished : null,
      })),
      work,
      effectsMode: this.effectsMode(guild),
    };
  }
  /** Diagnose independent capabilities; validation never mutates configuration or access. */
  async validate(actor: Actor): Promise<ConfigurationReport> {
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
        if (field.endsWith("role_id"))
          await this.discord.validateRole(guild.id, value, undefined, guild.access_policy_enabled);
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
      effectsMode: this.effectsMode(guild),
      // The raw row also carries role_layout_enabled; this states what the switch means.
      roleLayout: guild.role_layout_enabled
        ? "enabled"
        : "disabled (role display and order are not changed by the bot)",
      capabilities,
      guestApplicationsOpen: guestApplicationsOpen(guild),
      fc: guild.fc_id
        ? await this.db.orm
            .select({
              id: t.freeCompanies.id,
              name: t.freeCompanies.name,
              tag: t.freeCompanies.tag,
              world: t.freeCompanies.world,
              last_successful_roster_at: t.freeCompanies.last_successful_roster_at,
              last_attempt_at: t.freeCompanies.last_attempt_at,
              // Roster acquisition stores the failed attempt's code here, never a message.
              last_error: t.freeCompanies.last_error,
              fresh: sql<boolean>`coalesce(${t.freeCompanies.last_successful_roster_at}>now()-${this.config.ROSTER_INTERVAL_SECONDS}*interval '1 second',false)`,
              // A success clears last_error, so a stored code means the latest attempt failed.
              attemptFailed: sql<boolean>`${t.freeCompanies.last_error} IS NOT NULL`,
            })
            .from(t.freeCompanies)
            .where(eq(t.freeCompanies.id, guild.fc_id))
        : null,
    };
  }
  /**
   * The newest pending applications (at most 25, Discord's choice limit) for officer
   * autocomplete. The command filters them in-process on cached display names, user IDs and short
   * IDs, which SQL cannot see, and builds the labels; this is an officer-only private read.
   */
  async applicationChoices(actor: Actor): Promise<ApplicationChoiceRow[]> {
    authorize(actor, actor.guildId, "officer");
    return this.db.orm
      .select({
        id: t.guestApplications.id,
        user_id: t.guestApplications.user_id,
        created_at: t.guestApplications.created_at,
      })
      .from(t.guestApplications)
      .where(
        and(
          eq(t.guestApplications.guild_id, actor.guildId),
          eq(t.guestApplications.state, "pending"),
        ),
      )
      .orderBy(desc(t.guestApplications.created_at))
      .limit(25);
  }
  /** Completion is a private read and repeats owner/officer authorization inside the service. */
  async autocomplete(
    actor: Actor,
    kind: "verify" | "character",
    owner: string,
    query: string,
  ): Promise<{ name: string; value: string }[]> {
    authorize(actor, actor.guildId, "user", owner);
    query = query.replaceAll("%", "\\%").replaceAll("_", "\\_");
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
  /**
   * Validate external resources first, then atomically revise config and queue cleanup/projection.
   * `adoptHolders` applies only when binding an Officer role (owner decision O1, 2026-09-23):
   * true (the default, the long-standing behavior) grants every current human holder a manual
   * officer override; false grants nobody, so officer authority comes only from the mapped
   * in-game rank and explicit /officer grant. Either choice is recorded in the config audit.
   */
  async configure(
    actor: Actor,
    field: string,
    value: string | null,
    options: { adoptHolders?: boolean } = {},
  ): Promise<ConfigChange> {
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
    // Unreachable from /config, whose subcommands name only allowlisted fields.
    if (!column) throw new Failure("input", "Invalid configuration field.");
    if (field === "officer_role_id" || field === "leader_role_id") authorizeRoleManager(actor);
    const bindsOfficer = field === "officer_role_id" && value !== null;
    if (options.adoptHolders !== undefined && !bindsOfficer)
      throw new Failure(
        "input",
        "Use adopt_holders only when choosing an Officer role, not with clear:true.",
        0,
        { kind: "option", option: "adopt_holders" },
      );
    const adoptHolders = options.adoptHolders ?? true;
    // Unreachable from /config: unlinking has its own subcommand, which needs the linked ID.
    if (field === "fc_id" && value === null)
      throw new Failure("input", "Use /config fc unlink with the linked FC's ID.");
    const [existing] = await this.db.orm
      .select()
      .from(t.guilds)
      .where(eq(t.guilds.id, actor.guildId));
    if (existing?.access_policy_enabled && field.endsWith("role_id") && value === null)
      throw new Failure("input", ONBOARDING_ROLES, 0, { kind: "option", option: "role" });
    if (existing?.access_policy_enabled && field.endsWith("role_id")) authorizeRoleManager(actor);
    if (field === "fc_id" && existing?.officer_rank_key) authorizeRoleManager(actor);
    let fc: CompanyIdentity | undefined;
    if (field === "fc_id" && value) {
      if (existing?.fc_id === value) return { status: "unchanged", field: "fc_id", value };
      if (existing?.fc_id) throw fcLinked(existing.fc_id);
      fc = await this.lodestone.company(value);
    }
    if (field.endsWith("role_id")) {
      if (!actor.manageRoles)
        throw new Failure(
          "forbidden",
          "Choosing access roles needs Discord's Manage Roles permission.",
          0,
          { kind: "scope", scope: "manage_roles" },
        );
      if (value)
        await this.discord.validateRole(
          actor.guildId,
          value,
          actor.userId,
          existing?.access_policy_enabled ?? false,
        );
    } else if (field.endsWith("channel_id") && value)
      await this.discord.validateChannel(actor.guildId, value);
    // With adopt_holders:false the holders are not even enumerated; nobody gains an override.
    const adopted =
      bindsOfficer && adoptHolders && value && existing?.officer_role_id !== value
        ? (await this.discord.members(actor.guildId)).filter(
            (member) => !member.bot && member.roles.includes(value),
          )
        : [];
    return this.db.transaction(async (client) => {
      const db = orm(client);
      // A guild first created here takes the column defaults, so its role layout starts on,
      // exactly like a guild first created by /setup.
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
      // Read under the row lock, so it is exactly the value this change replaces.
      const previous = saved[column];
      // A concurrent setup may have enabled channel gating after the remote role preflight.
      if (saved.access_policy_enabled && field.endsWith("role_id")) {
        authorizeRoleManager(actor);
        if (!value)
          throw new Failure("input", ONBOARDING_ROLES, 0, { kind: "option", option: "role" });
        if (!existing?.access_policy_enabled) throw new Failure("conflict", SETTINGS_CHANGED);
      }
      if (field === "fc_id" && value && saved.fc_id && saved.fc_id !== value)
        throw fcLinked(saved.fc_id);
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
          throw new Failure("input", DISTINCT_ROLES, 0, { kind: "option", option: "role" });
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
      const [updated] = await db
        .update(t.guilds)
        .set({ [column]: value, revision: sql`${t.guilds.revision}+1`, active: true })
        .where(eq(t.guilds.id, actor.guildId))
        .returning();
      if (!updated) throw new Error("Missing guild");
      if (field === "fc_id" && value) {
        await db
          .insert(t.ledgerAccounts)
          .values({ guild_id: actor.guildId, fc_id: value })
          .onConflictDoNothing();
        await enqueue(client, "roster", `roster:${value}`, { fcId: value });
      }
      await audit(
        client,
        actor.guildId,
        actor.userId,
        "config",
        field,
        bindsOfficer ? { value, adoptHolders, adopted: adopted.length } : { value },
      );
      // Role bindings change the managed block, but presentation work follows the guild's switch.
      if (field.endsWith("role_id") && saved.role_layout_enabled)
        await layoutGuildRoles(client, actor.guildId);
      if (saved.access_policy_enabled) await secureGuildChannels(client, actor.guildId);
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
      // Parked work retries against the new settings, one row per dedupe key: the repair pass
      // just queued above replaces a parked reconcile.guild instead of colliding with it.
      const requeued = await requeueParked(client, [actor.guildId], ["blocked", "disabled"]);
      const change = {
        status: "saved",
        effects: "queued",
        effectsMode: this.effectsMode(updated),
        field,
        value,
        previous,
        rebound: previous === value,
        requeued: requeued.length,
        company: fc ? { id: fc.id, name: fc.name, tag: fc.tag, world: fc.world } : null,
        guild: updated,
      } as const;
      if (!bindsOfficer) return change;
      const sample = adopted.slice(0, 20).map((member) => member.id);
      return {
        ...change,
        officerHolders: adoptHolders
          ? { adopt: true, adopted: adopted.length, sample }
          : {
              adopt: false,
              adopted: 0,
              sample: [],
              note: "Current holders were not granted officer access. Officers come from /config officer_rank and /officer grant; holders with neither can lose this role once effects apply.",
            },
      };
    });
  }
  /**
   * Selecting an automatic authority source is reserved for actual server role managers. The
   * result says whether an FC and Officer role exist yet, because a rank alone grants nothing
   * until both do.
   */
  async configureOfficerRank(actor: Actor, rank: string | null): Promise<OfficerRankResult> {
    authorizeRoleManager(actor);
    await this.guild(actor);
    if (rank !== null) rank = note(rank, "rank");
    return this.db.transaction(async (client) => {
      const db = orm(client);
      const [saved] = await db
        .select()
        .from(t.guilds)
        .where(eq(t.guilds.id, actor.guildId))
        .for("update");
      if (!saved) throw new Error("Missing guild");
      await db
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
        previous: saved.officer_rank_name,
        mode: rank ? "rank_and_manual_overrides" : "manual_only",
        effects: "queued",
        effectsMode: this.effectsMode(saved),
        fcLinked: saved.fc_id !== null,
        officerRoleId: saved.officer_role_id,
      };
    });
  }
  /**
   * Managed-role presentation opt-in (decision 4, CFG-07): manager-only, audited and
   * revision-fenced. Enabling first repeats the AUTH-03 hierarchy checks for every managed role and
   * queues one layout pass; disabling queues nothing and never reverts earlier hoist or order (a
   * queued pass completes as skipped, a running pass is fenced before its next write).
   */
  async configureRoleLayout(actor: Actor, enabled: boolean): Promise<RoleLayoutResult> {
    authorizeRoleManager(actor);
    // An active, configured guild only; this setting never creates a guild implicitly.
    const guild = await this.guild(actor);
    // A blocked or out-of-reach role names itself: the gateway's failure carries its role detail.
    if (enabled)
      for (const role of managedRoleOrder(guild))
        await this.discord.validateRole(guild.id, role, actor.userId, guild.access_policy_enabled);
    return this.db.transaction(async (client) => {
      const db = orm(client);
      const [saved] = await db
        .select()
        .from(t.guilds)
        .where(and(eq(t.guilds.id, actor.guildId), eq(t.guilds.active, true)))
        .for("update");
      // The bot may have left the guild since the preflight read.
      if (!saved)
        throw new Failure(
          "setup",
          "This server has no TaruBot configuration yet. Start with /setup, or link the Free Company with /config fc link.",
          0,
          { kind: "setup", missing: "guild" },
        );
      const roleLayout = enabled ? "enabled" : "disabled";
      const effectsMode = this.effectsMode(saved);
      // A repeated choice is a no-op: no revision bump (which would fence other work) and no audit.
      if (saved.role_layout_enabled === enabled)
        return { status: "unchanged", roleLayout, effectsMode };
      await db
        .update(t.guilds)
        .set({ role_layout_enabled: enabled, revision: sql`${t.guilds.revision}+1` })
        .where(eq(t.guilds.id, actor.guildId));
      await audit(client, actor.guildId, actor.userId, "config.role_layout", actor.guildId, {
        enabled,
        previous: saved.role_layout_enabled,
      });
      const layoutJob = enabled ? await layoutGuildRoles(client, actor.guildId) : null;
      return {
        status: "saved",
        roleLayout,
        effects: enabled ? "queued" : "none",
        effectsMode,
        layoutJob,
        // The order a layout pass applies, from the row read under this transaction's lock.
        order: managedRoleOrder(saved),
        note: enabled
          ? "FC Leader > Officer > Member > Guest will display separately in one consecutive block; see /sync status."
          : "Current role display and order are left as they are; the bot will no longer change them.",
      };
    });
  }
  /** Matching the stored ID prevents stale unlink requests; all historical/account data survives. */
  async unlinkCompany(actor: Actor, fcId: string): Promise<FcUnlinkResult> {
    authorize(actor, actor.guildId, "officer");
    if ((await this.guild(actor)).officer_rank_key) authorizeRoleManager(actor);
    return this.db.transaction(async (client) => {
      const db = orm(client);
      const [updated] = await db
        .update(t.guilds)
        .set({ fc_id: null, revision: sql`${t.guilds.revision}+1` })
        .where(and(eq(t.guilds.id, actor.guildId), eq(t.guilds.fc_id, fcId)))
        .returning();
      if (!updated)
        throw new Failure(
          "not_found",
          `FC ${fcId} isn't the linked Free Company. Unlinking needs the linked FC's exact ID; /config show lists it.`,
          0,
          { kind: "resource", resource: "fc_link", id: fcId },
        );
      await audit(client, actor.guildId, actor.userId, "fc.unlink", fcId);
      await enqueue(client, "reconcile.guild", `guild:${actor.guildId}`, {}, actor.guildId);
      return {
        status: "unlinked",
        effects: "queued",
        effectsMode: this.effectsMode(updated),
        company: await this.company(db, fcId),
      };
    });
  }
  /**
   * Serialize ownership by character; an active link and any fresh positive evidence commit
   * together. Another owner's link refuses with the character and that owner in the detail; the
   * reply decides per audience whether the owner is shown (officers only).
   */
  private async trust(
    client: PoolClient,
    actor: Actor,
    owner: string,
    character: string,
    provenance: string,
    reason: string | null,
    source: unknown,
  ): Promise<TrustResult> {
    const db = orm(client);
    // Callers store the character first, so the locked row is its current public identity.
    const [identity] = await db
      .select({ id: t.characters.id, name: t.characters.name, world: t.characters.world })
      .from(t.characters)
      .where(eq(t.characters.id, character))
      .for("update");
    if (!identity) throw new Error("Missing character");
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
      if (linked.user_id !== owner) throw ownershipConflict(identity, linked.user_id);
      await reconcileUser(client, actor.guildId, owner);
      return {
        id: linked.id,
        created: false,
        firstLink: false,
        listed: false,
        character: identity,
      };
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
    return {
      id: link.id,
      created: true,
      firstLink: !previous,
      listed: evidence !== undefined,
      character: identity,
    };
  }
  /** Issue a bounded, replaceable challenge; plaintext is returned once and never persisted. */
  async claim(actor: Actor, identity: CharacterIdentity): Promise<ClaimResult> {
    const guild = await this.guild(actor);
    const member = await this.discord.member(actor.guildId, actor.userId);
    if (!member || member.bot) throw notCurrentMember();
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
      const character = { id: identity.id, name: identity.name, world: identity.world };
      if (existing) {
        if (existing.user_id === actor.userId) {
          await reconcileUser(client, actor.guildId, actor.userId);
          return {
            status: "already_linked",
            effects: "queued",
            effectsMode: this.effectsMode(guild),
            character,
          };
        }
        throw ownershipConflict(character, existing.user_id);
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
      const own = sql`${t.challenges.guild_id}=${actor.guildId} AND ${t.challenges.user_id}=${actor.userId}`;
      const [counts] = await db
        .select({
          own: sql<bigint>`count(*) FILTER(WHERE ${own})`.mapWith(BigInt),
          total: sql<bigint>`count(*)`.mapWith(BigInt),
          // When each limit lifts: the oldest unexpired token frees the next slot.
          ownExpiry: sql<Date | null>`min(${t.challenges.expires_at}) FILTER(WHERE ${own})`.mapWith(
            t.challenges.expires_at,
          ),
          allExpiry: sql<Date | null>`min(${t.challenges.expires_at})`.mapWith(
            t.challenges.expires_at,
          ),
        })
        .from(t.challenges)
        .where(
          and(
            gt(t.challenges.expires_at, sql`now()`),
            isNull(t.challenges.consumed_at),
            isNull(t.challenges.replaced_at),
          ),
        );
      if (!counts) throw new Error("Missing challenge counts");
      if (counts.own >= 5n)
        throw new Failure(
          "cooldown",
          "You already have 5 unfinished claims. Finish one with /verify, or wait until the oldest token expires.",
          secondsUntil(counts.ownExpiry),
          {
            kind: "limit",
            limit: "claims_own",
            ...(counts.ownExpiry && { until: counts.ownExpiry }),
          },
        );
      if (counts.total >= 1000n)
        throw new Failure(
          "cooldown",
          "Verification is busy right now. Try again in a few minutes.",
          secondsUntil(counts.allExpiry),
          {
            kind: "limit",
            limit: "claims_all",
            ...(counts.allExpiry && { until: counts.allExpiry }),
          },
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
      if (!row) throw new Error("Missing challenge");
      return {
        status: "pending",
        character: identity.id,
        name: identity.name,
        world: identity.world,
        token,
        challenge: row.id,
        expiresAt: row.expires_at,
        instructions: `Place the exact token in your public Lodestone biography, then use /verify character:${identity.id}. Publication may take several minutes.`,
      };
    });
  }
  /**
   * Fresh biography proof is checked against a locked, still-valid tuple-bound challenge. A missing
   * or expired claim is not_found (run /claim again); a token not yet published is pending_proof,
   * which keeps the claim valid until its expiry.
   */
  async verify(actor: Actor, characterId: string): Promise<VerifyResult> {
    const guild = await this.guild(actor);
    const identity = await this.lodestone.profile(characterId, true);
    const character = { id: identity.id, name: identity.name, world: identity.world };
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
        throw new Failure(
          "not_found",
          "You don't have an unexpired claim for this character. Run /claim for a new token, then /verify.",
          0,
          { kind: "resource", resource: "challenge", id: characterId },
        );
      if (challenge.consumed_at) return { status: "already_verified", character };
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
          "pending_proof",
          "The Lodestone hasn't published the token for this character yet. This often takes a few minutes after you save; the token is still valid.",
          // Retrying is allowed at once; the detail says how long the token stays valid.
          0,
          { kind: "proof", character, expiresAt: challenge.expires_at },
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
          "The token expired just before verification finished. Run /claim for a new token.",
        );
      await audit(client, actor.guildId, actor.userId, "verification.complete", link.id, {
        challengeId: challenge.id,
      });
      return {
        status: "verified",
        link: link.id,
        effects: "queued",
        effectsMode: this.effectsMode(guild),
        character: link.character,
        primary: link.firstLink,
        roster: await this.rosterEvidence(db, guild, link.listed),
      };
    });
  }
  /** Manual trust requires an officer reason and a currently present human recipient. */
  async assign(
    actor: Actor,
    owner: string,
    identity: CharacterIdentity,
    reason: string,
  ): Promise<AssignResult> {
    authorize(actor, actor.guildId, "officer");
    const guild = await this.guild(actor);
    reason = note(reason, "reason");
    const member = await this.discord.member(actor.guildId, owner);
    if (!member || member.bot) throw memberNotFound(owner);
    // Delegated officers may vouch for membership, but cannot indirectly appoint officers.
    const officerAuthority = (actor.serverManager ?? actor.officer) && actor.manageRoles;
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
        { officerAuthority },
      );
      await audit(client, actor.guildId, actor.userId, "character.assign", link.id, {
        owner,
        character: identity.id,
        reason,
      });
      return {
        // The same member already owning the link is the idempotent repeat, not a new link.
        status: link.created ? "assigned" : "already_assigned",
        link: link.id,
        effects: "queued",
        effectsMode: this.effectsMode(guild),
        character: link.character,
        owner,
        reason,
        primary: link.firstLink,
        officerAuthority,
        roster: await this.rosterEvidence(orm(client), guild, link.listed),
      };
    });
  }
  /** Resolve stored ownership locally and retain history even when the character is unavailable. */
  async unclaim(
    actor: Actor,
    owner: string,
    character: string,
    reason?: string,
  ): Promise<UnlinkResult> {
    authorize(actor, actor.guildId, owner === actor.userId ? "user" : "officer");
    const guild = await this.guild(actor);
    if (owner !== actor.userId || reason !== undefined) reason = note(reason ?? "", "reason");
    return this.db.transaction(async (client) => {
      const db = orm(client);
      await db
        .select({ user_id: t.guildUsers.user_id })
        .from(t.guildUsers)
        .where(and(eq(t.guildUsers.guild_id, actor.guildId), eq(t.guildUsers.user_id, owner)))
        .for("update");
      const [identity] = await db
        .select({ id: t.characters.id, name: t.characters.name, world: t.characters.world })
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
      if (!link || link.user_id !== owner || !identity)
        throw new Failure(
          "not_found",
          owner === actor.userId
            ? "That character isn't one of your linked characters. Pick one from the suggestions."
            : "That character isn't linked to that member.",
          0,
          { kind: "resource", resource: "link", id: character },
        );
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
      const cleared = await db
        .update(t.guildUsers)
        .set({ primary_character_id: null, nickname_restore: true })
        .where(
          and(
            eq(t.guildUsers.guild_id, actor.guildId),
            eq(t.guildUsers.user_id, owner),
            eq(t.guildUsers.primary_character_id, character),
          ),
        )
        .returning({ user_id: t.guildUsers.user_id });
      const [left] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(t.links)
        .where(
          and(
            eq(t.links.guild_id, actor.guildId),
            eq(t.links.user_id, owner),
            eq(t.links.active, true),
          ),
        );
      await audit(client, actor.guildId, actor.userId, "character.unlink", link.id, {
        reason: reason ?? null,
      });
      await reconcileUser(client, actor.guildId, owner);
      return {
        status: "unlinked",
        effects: "queued",
        effectsMode: this.effectsMode(guild),
        instructions: "If this was your primary character, select another with /main.",
        link: link.id,
        owner,
        character: identity,
        primaryCleared: cleared.length > 0,
        remainingActive: left?.count ?? 0,
        reason: reason ?? null,
      };
    });
  }
  /**
   * Persist explicit primary/nickname intent and let the worker safely project or restore it. A
   * request that would change nothing (/main naming the current main, or turning sync on or off
   * when it already is) saves nothing, queues no reconciliation and returns 'unchanged', so the
   * reply never implies a change (owner decision, 2026-09-24).
   */
  async preferences(
    actor: Actor,
    character: string | null,
    enabled: boolean | null,
  ): Promise<PreferencesResult> {
    const guild = await this.guild(actor);
    return this.db.transaction(async (client) => {
      const db = orm(client);
      const scope = and(
        eq(t.guildUsers.guild_id, actor.guildId),
        eq(t.guildUsers.user_id, actor.userId),
      );
      const [current] = await db
        .select({
          primary: t.guildUsers.primary_character_id,
          enabled: t.guildUsers.nickname_enabled,
          suspended: t.guildUsers.nickname_suspended,
        })
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
          throw new Failure(
            "not_found",
            "Choose one of your linked characters from the suggestions.",
            0,
            { kind: "resource", resource: "link", id: character },
          );
      }
      if (enabled === true && !current?.primary && !character)
        throw new Failure(
          "input",
          "Choose a main character with /main before turning on nicknames.",
          0,
          { kind: "option", option: "enabled" },
        );
      // Resuming sync that a manual nickname suspended is a change; on-and-not-suspended is not.
      const mainChanges = character !== null && current?.primary !== character;
      const syncChanges =
        enabled !== null &&
        current !== undefined &&
        (enabled ? !current.enabled || current.suspended : current.enabled);
      if (mainChanges)
        await db
          .update(t.guildUsers)
          .set({ primary_character_id: character, nickname_restore: false })
          .where(scope);
      if (syncChanges)
        await db
          .update(t.guildUsers)
          .set({
            nickname_enabled: enabled,
            nickname_suspended: false,
            nickname_restore: !enabled,
            nickname_baseline_set: enabled ? false : t.guildUsers.nickname_baseline_set,
          })
          .where(scope);
      const changed = mainChanges || syncChanges;
      if (changed) await reconcileUser(client, actor.guildId, actor.userId);
      const [saved] = await db
        .select({
          enabled: t.guildUsers.nickname_enabled,
          suspended: t.guildUsers.nickname_suspended,
          id: t.characters.id,
          name: t.characters.name,
          world: t.characters.world,
        })
        .from(t.guildUsers)
        .leftJoin(t.characters, eq(t.characters.id, t.guildUsers.primary_character_id))
        .where(scope);
      return {
        status: changed ? "saved" : "unchanged",
        effects: changed ? "queued" : "unchanged",
        effectsMode: this.effectsMode(guild),
        primary:
          saved?.id && saved.name !== null && saved.world !== null
            ? { id: saved.id, name: saved.name, world: saved.world }
            : null,
        nickname: { enabled: saved?.enabled ?? false, suspended: saved?.suspended ?? false },
      };
    });
  }
  /**
   * Registration is derived from current trusted links in every guild, with or without lobby
   * onboarding (ROLE-07); it never recreates a revoked durable grant.
   */
  async registrationGuestEligible(
    client: Connection,
    guild: GuildRecord,
    user: string,
  ): Promise<boolean> {
    return registrationEligible(
      await accessFacts(orm(client), guild, user, this.config.ROSTER_INTERVAL_SECONDS),
    );
  }

  /** A trusted link makes character eligibility authoritative, even while a roster is uncertain. */
  private async hasActiveRegistration(
    client: Connection,
    guild: string,
    user: string,
  ): Promise<boolean> {
    const links = await orm(client)
      .select({ id: t.links.id })
      .from(t.links)
      .where(and(eq(t.links.guild_id, guild), eq(t.links.user_id, user), eq(t.links.active, true)))
      .limit(1);
    return links.length > 0;
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
  /**
   * Account locking orders exact-once financial mutations independently of notification delivery.
   * The result carries the FC identity, ledger channel and corrected entry number the receipt
   * shows; a replayed interaction also reports its channel post's delivery state.
   */
  async ledger(
    actor: Actor,
    operation: string,
    input: string | number,
    noteText: string,
    key: string,
    correction: string | null = null,
  ): Promise<LedgerReceipt> {
    const guild = await this.guild(actor);
    noteText = note(noteText);
    if (operation !== "deposit") {
      if (!actor.officer)
        throw new Failure(
          "forbidden",
          "Only officers can record withdrawals, opening balances and corrections. Members can record deposits with /ledger deposit.",
          0,
          { kind: "scope", scope: "officer" },
        );
      authorize(actor, actor.guildId, "officer");
    }
    if (!guild.fc_id)
      throw new Failure(
        "setup",
        "Link the Free Company and choose a ledger channel before recording gil.",
        0,
        { kind: "setup", missing: "fc" },
      );
    if (!guild.ledger_channel_id)
      throw new Failure(
        "setup",
        "Choose a ledger channel with /config ledger before recording gil.",
        0,
        { kind: "setup", missing: "ledger" },
      );
    const linkedFc = guild.fc_id;
    const channelId = guild.ledger_channel_id;
    await this.discord.validateChannel(actor.guildId, channelId);
    let amount: bigint;
    if (operation === "deposit" || operation === "withdraw") {
      if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 999999999)
        throw new Failure("input", "Amount must be between 1 and 999,999,999 gil.", 0, {
          kind: "option",
          option: "amount",
        });
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
        throw new Failure("conflict", SETTINGS_CHANGED);
      if (!actor.officer && !(await this.memberEligible(client, current, actor.userId)))
        throw membershipNeeded();
      const [account] = await db
        .select()
        .from(t.ledgerAccounts)
        .where(
          and(eq(t.ledgerAccounts.guild_id, actor.guildId), eq(t.ledgerAccounts.fc_id, linkedFc)),
        )
        .for("update");
      // Linking an FC creates its account in the same transaction, so this is a broken invariant
      // like "Missing guild": no command repairs it (re-linking the same FC is a no-op), so it is
      // the unexpected card with its Ref, logged at error, rather than a setup step that can't work.
      if (!account) throw new Error("Missing ledger account");
      const context = {
        effectsMode: this.effectsMode(current),
        fc: await this.company(db, linkedFc),
        channelId,
      };
      const [duplicate] = await db
        .select()
        .from(t.ledgerEntries)
        .where(eq(t.ledgerEntries.idempotency_key, key));
      if (duplicate) {
        // Interaction IDs are unique, so a key on another account is an internal invariant.
        if (duplicate.guild_id !== actor.guildId || duplicate.account_id !== account.id)
          throw new Failure("idempotency_conflict", "Idempotency key belongs to another account.");
        const [post] = await db
          .select({
            status: t.jobs.status,
            message_id: t.jobs.message_id,
            last_error: t.jobs.last_error,
            // The channel the post went to (null for posts made before 2.14.0 recorded it).
            channel_id: sql<string | null>`${t.jobs.result}->>'channelId'`,
          })
          .from(t.jobs)
          .where(eq(t.jobs.dedupe_key, `ledger:${duplicate.id}`))
          .orderBy(desc(t.jobs.created_at))
          .limit(1);
        return {
          ...context,
          entry: duplicate,
          status: "already_recorded",
          correction: await this.correction(db, account.id, duplicate.correction_id),
          post: post ?? null,
        };
      }
      if (operation === "initialize" && account.balance !== null)
        throw new Failure("initialized", "This FC's ledger already has an opening balance.");
      if (operation !== "initialize" && account.balance === null)
        throw new Failure(
          "uninitialized",
          "This FC's ledger has no opening balance yet, so it can't record changes.",
        );
      const corrected = correction ? await this.correction(db, account.id, correction) : null;
      if (correction && !corrected)
        throw new Failure(
          "not_found",
          "That entry isn't in this FC's ledger. Copy the entry ID from /ledger history.",
          0,
          { kind: "resource", resource: "entry", id: correction },
        );
      const before = account.balance ?? 0n;
      const balance =
        operation === "deposit"
          ? before + amount
          : operation === "withdraw"
            ? before - amount
            : amount;
      // Only a withdrawal can go below zero; only a deposit can pass the storable maximum.
      if (balance < 0n)
        throw new Failure(
          "insufficient_funds",
          `Withdrawing ${amount.toLocaleString("en-US")} gil would take the recorded balance below zero.`,
          0,
          { kind: "funds", balance: before, amount },
        );
      if (balance > MAX_GIL)
        throw new Failure(
          "input",
          "That would exceed the largest balance the ledger can store (9,223,372,036,854,775,807 gil).",
          0,
          { kind: "option", option: "amount" },
        );
      if (operation === "adjust" && balance === before)
        return { ...context, status: "unchanged", balance };
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
        ...context,
        entry,
        status: "recorded",
        delivery: "queued",
        inspect: "/ledger history or /sync status",
        correction: corrected,
      };
    });
  }
  /** The entry number of a corrected entry in the same account, or null when there is none. */
  private async correction(
    db: Orm,
    account: string,
    entry: string | null,
  ): Promise<CorrectionRef | null> {
    if (!entry) return null;
    const [row] = await db
      .select({ id: t.ledgerEntries.id, sequence: t.ledgerEntries.sequence })
      .from(t.ledgerEntries)
      .where(and(eq(t.ledgerEntries.id, entry), eq(t.ledgerEntries.account_id, account)));
    return row ?? null;
  }
  /**
   * Historical accounts remain guild-owned and officer-only even while the current FC is unlinked.
   * `expect: 'current'` comes from a control that showed the linked FC's ledger: if another FC is
   * linked now, the control is out of date, which is checked before authorization so a member's
   * old button never reads as an officer-only refusal.
   */
  async ledgerRead(
    actor: Actor,
    fcId: string | null,
    before: string | null,
    history: false,
    expect?: "current" | "any",
  ): Promise<LedgerBalanceView>;
  async ledgerRead(
    actor: Actor,
    fcId: string | null,
    before: string | null,
    history: true,
    expect?: "current" | "any",
  ): Promise<LedgerHistoryView>;
  async ledgerRead(
    actor: Actor,
    fcId: string | null,
    before: string | null,
    history: boolean,
    expect?: "current" | "any",
  ): Promise<LedgerBalanceView | LedgerHistoryView>;
  async ledgerRead(
    actor: Actor,
    fcId: string | null,
    before: string | null,
    history: boolean,
    expect: "current" | "any" = "any",
  ): Promise<LedgerBalanceView | LedgerHistoryView> {
    const guild = await this.guild(actor);
    if (expect === "current" && fcId !== guild.fc_id)
      throw new Failure(
        "stale",
        "The linked Free Company changed since this ledger view was shown. Run /ledger history again.",
        0,
        { kind: "stale", what: "control" },
      );
    const target = fcId ?? guild.fc_id;
    if (!target)
      throw new Failure("setup", "No Free Company is linked to this server yet.", 0, {
        kind: "setup",
        missing: "fc",
      });
    if (target !== guild.fc_id) {
      if (!actor.officer)
        throw new Failure("forbidden", "Only officers can view a previous FC's ledger.", 0, {
          kind: "scope",
          scope: "officer",
        });
      authorize(actor, actor.guildId, "officer");
    }
    if (!actor.officer && !(await this.memberEligible(this.db.pool, guild, actor.userId)))
      throw membershipNeeded();
    const db = this.db.orm;
    const [account] = await db
      .select()
      .from(t.ledgerAccounts)
      .where(and(eq(t.ledgerAccounts.guild_id, actor.guildId), eq(t.ledgerAccounts.fc_id, target)));
    if (!account)
      throw new Failure("not_found", `This server has no ledger for FC ${target}.`, 0, {
        kind: "resource",
        resource: "account",
        id: target,
      });
    const context = {
      account,
      fc: await this.company(db, target),
      current: target === guild.fc_id,
      channelId: guild.ledger_channel_id,
      effectsMode: this.effectsMode(guild),
    };
    /** Channel posts for the given entries, or for the account's newest ten when none are given. */
    const delivery = (entries?: readonly string[]) =>
      db
        .select({
          id: t.jobs.id,
          status: t.jobs.status,
          last_error: t.jobs.last_error,
          message_id: t.jobs.message_id,
          // The channel the post went to, so a rebound ledger channel keeps earlier jump links.
          channel_id: sql<string | null>`${t.jobs.result}->>'channelId'`,
          entry_id: sql<string>`${t.jobs.payload}->>'entryId'`,
          sequence: t.ledgerEntries.sequence,
          attempts: t.jobs.attempts,
          due_at: t.jobs.due_at,
        })
        .from(t.jobs)
        .innerJoin(t.ledgerEntries, sql`${t.ledgerEntries.id}::text=${t.jobs.payload}->>'entryId'`)
        .where(
          and(
            eq(t.jobs.kind, "ledger.notify"),
            eq(t.ledgerEntries.account_id, account.id),
            entries ? inArray(t.ledgerEntries.id, [...entries]) : undefined,
          ),
        )
        .orderBy(desc(t.ledgerEntries.sequence))
        .limit(10);
    if (!history) {
      const [latest] = await db
        .select({
          sequence: t.ledgerEntries.sequence,
          operation: t.ledgerEntries.operation,
          event_at: t.ledgerEntries.event_at,
        })
        .from(t.ledgerEntries)
        .where(eq(t.ledgerEntries.account_id, account.id))
        .orderBy(desc(t.ledgerEntries.sequence))
        .limit(1);
      return {
        ...context,
        view: "balance",
        balanceState: account.balance === null ? "uninitialized" : "known",
        delivery: await delivery(),
        latest: latest ?? null,
      };
    }
    // A newest-first page holds the entries below the cursor; the newest page has no cursor.
    const cursor = before === null ? null : sequenceCursor(before);
    const top = cursor ?? account.sequence + 1n;
    const rows = await db
      .select()
      .from(t.ledgerEntries)
      .where(and(eq(t.ledgerEntries.account_id, account.id), lt(t.ledgerEntries.sequence, top)))
      .orderBy(desc(t.ledgerEntries.sequence))
      .limit(11);
    // The eleventh row only proves an older page exists, so no final page is ever empty.
    const entries = rows.slice(0, 10);
    const older = rows.length > 10 ? (entries.at(-1)?.sequence ?? null) : null;
    // Up to eleven entries above the page decide the newer cursor: ten or fewer means the newer
    // page is the newest one; more means it starts just above its tenth entry. Sequences can have
    // gaps (imports), so the cursor is read from the rows, never computed from page numbers.
    const newerRows = await db
      .select({ sequence: t.ledgerEntries.sequence })
      .from(t.ledgerEntries)
      .where(and(eq(t.ledgerEntries.account_id, account.id), gte(t.ledgerEntries.sequence, top)))
      .orderBy(asc(t.ledgerEntries.sequence))
      .limit(11);
    const tenth = newerRows[9];
    const newer =
      newerRows.length === 0
        ? null
        : newerRows.length > 10 && tenth
          ? tenth.sequence + 1n
          : "latest";
    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        above: sql<number>`(count(*) FILTER(WHERE ${t.ledgerEntries.sequence}>=${top}))::int`,
      })
      .from(t.ledgerEntries)
      .where(eq(t.ledgerEntries.account_id, account.id));
    const targets = [
      ...new Set(entries.flatMap((entry) => (entry.correction_id ? [entry.correction_id] : []))),
    ];
    const corrections = targets.length
      ? await db
          .select({ id: t.ledgerEntries.id, sequence: t.ledgerEntries.sequence })
          .from(t.ledgerEntries)
          .where(
            and(eq(t.ledgerEntries.account_id, account.id), inArray(t.ledgerEntries.id, targets)),
          )
      : [];
    return {
      ...context,
      view: "history",
      before: cursor,
      entries,
      // Page-aligned: exactly this page's posts, not the account's newest ten.
      delivery: entries.length ? await delivery(entries.map((entry) => entry.id)) : [],
      older,
      newer,
      next: older?.toString() ?? null,
      total: counts?.total ?? 0,
      above: counts?.above ?? 0,
      corrections: Object.fromEntries(corrections.map((row) => [row.id, row.sequence])),
    };
  }
  /**
   * Whether /apply may open its form in this guild: one primary-key read, fast enough for the
   * router's pre-modal check. A guild with no active row, no review channel (imports start that
   * way) or no Guest role is closed, by the same rule apply() enforces at submission, so a visitor
   * is never shown a form that would then be refused. It reveals nothing beyond that and grants
   * nothing.
   */
  async guestApplicationsOpen(guildId: string): Promise<boolean> {
    const [row] = await this.db.orm
      .select({
        guest_application_channel_id: t.guilds.guest_application_channel_id,
        guest_role_id: t.guilds.guest_role_id,
      })
      .from(t.guilds)
      .where(and(eq(t.guilds.id, guildId), eq(t.guilds.active, true)));
    return row !== undefined && guestApplicationsOpen(row);
  }
  /**
   * One pending application per join context; duplicate submissions reuse the persisted request.
   * The outcome says whether this submission created it, found it, or replaced one from an
   * earlier join.
   */
  async apply(actor: Actor, input: GuestApplicationInput): Promise<ApplyResult> {
    const submitted = guestApplicationInput.safeParse(input);
    if (!submitted.success)
      throw new Failure("input", "Both answers need 10–300 characters. Run /apply again.");
    const guild = await this.guild(actor);
    // Closed without a review channel (imports start closed; owner decision 2026-09-23) or without
    // a Guest role. Either way the visitor gets the same message as the pre-modal refusal, never
    // officer setup text; the detail tells an officer's reply which piece is missing.
    if (!guild.guest_application_channel_id)
      throw new Failure("setup", GUEST_APPLICATIONS_CLOSED, 0, {
        kind: "setup",
        missing: "guest_applications",
      });
    if (!guild.guest_role_id)
      throw new Failure("setup", GUEST_APPLICATIONS_CLOSED, 0, {
        kind: "setup",
        missing: "guest_role",
      });
    const reviewChannel = guild.guest_application_channel_id;
    await this.discord.validateRole(
      actor.guildId,
      guild.guest_role_id,
      undefined,
      guild.access_policy_enabled,
    );
    await this.discord.validateChannel(actor.guildId, guild.guest_application_channel_id);
    const member = await this.discord.member(actor.guildId, actor.userId);
    if (!member || member.bot) throw notCurrentMember();
    if (member.joinedAt.getTime() !== submitted.data.joinedAt.getTime()) throw joinChanged();
    return this.db.transaction(async (client) => {
      const db = orm(client);
      const [current] = await db
        .select()
        .from(t.guilds)
        .where(eq(t.guilds.id, actor.guildId))
        .for("share");
      if (!current?.active || current.revision !== guild.revision)
        throw new Failure("conflict", SETTINGS_CHANGED);
      const effectsMode = this.effectsMode(current);
      // Lock before refreshing presence so a departed/newer join cannot be overwritten by
      // the earlier Discord observation. Member events serialize on this same user row.
      await ensureUser(client, actor.guildId, actor.userId);
      const [presence] = await db
        .select({ present: t.guildUsers.present, joined_at: t.guildUsers.joined_at })
        .from(t.guildUsers)
        .where(
          and(eq(t.guildUsers.guild_id, actor.guildId), eq(t.guildUsers.user_id, actor.userId)),
        )
        .for("update");
      if (
        presence?.joined_at &&
        (presence.joined_at.getTime() > member.joinedAt.getTime() ||
          (!presence.present && presence.joined_at.getTime() === member.joinedAt.getTime()))
      )
        throw joinChanged();
      await ensureUser(client, actor.guildId, actor.userId, member.joinedAt);
      if (await this.hasActiveRegistration(client, guild.id, actor.userId))
        throw new Failure(
          "eligible",
          "You have a linked character, so your access follows your character and FC membership instead of a guest application.",
        );
      const facts = await accessFacts(
        db,
        guild,
        actor.userId,
        this.config.ROSTER_INTERVAL_SECONDS,
        member.roles,
      );
      if (
        facts.membership === "member" ||
        facts.hasMember ||
        facts.hasGuest ||
        (!facts.revoked && (facts.grant || facts.former))
      )
        throw new Failure(
          "eligible",
          "You already have member or guest access here. If a role looks missing, TaruBot will restore it automatically.",
        );
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
      if (pending && pending.joined_at.getTime() === member.joinedAt.getTime())
        return { ...pending, outcome: "existing", effectsMode };
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
      // The newest recent denial decides when reapplying opens again.
      const [denied] = await db
        .select({
          until:
            sql<Date | null>`max(${t.guestApplications.decided_at})+${this.config.GUEST_COOLDOWN_SECONDS}*interval '1 second'`.mapWith(
              t.guestApplications.decided_at,
            ),
        })
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
      if (denied?.until)
        throw new Failure(
          "cooldown",
          "Your last application was declined recently. You can apply again later.",
          secondsUntil(denied.until),
          { kind: "limit", limit: "apply", until: denied.until },
        );
      const [application] = await db
        .insert(t.guestApplications)
        .values({
          guild_id: actor.guildId,
          user_id: actor.userId,
          joined_at: member.joinedAt,
          channel_id: reviewChannel,
          introduction: submitted.data.introduction,
          interest: submitted.data.interest,
        })
        .returning();
      if (!application) throw new Error("Missing application");
      await audit(client, actor.guildId, actor.userId, "guest.applied", application.id, {
        channelId: reviewChannel,
        joinedAt: member.joinedAt.toISOString(),
      });
      await enqueue(
        client,
        "guest.review",
        `review:${application.id}`,
        { applicationId: application.id },
        actor.guildId,
        actor.userId,
      );
      return { ...application, outcome: pending ? "replaced" : "created", effectsMode };
    });
  }
  /**
   * Lock user then application consistently so approval, denial, and revocation serialize. An
   * optional denial reason is validated like every officer reason; the applicant may see it.
   */
  async decide(
    actor: Actor,
    applicationId: string,
    approve: boolean,
    reason: string | null = null,
    messageId?: string,
  ): Promise<DecisionResult> {
    authorizeGuestDecision(actor);
    await this.guild(actor);
    if (reason !== null) reason = note(reason, "reason");
    const [preliminary] = await this.db.orm
      .select()
      .from(t.guestApplications)
      .where(
        and(
          eq(t.guestApplications.id, applicationId),
          eq(t.guestApplications.guild_id, actor.guildId),
        ),
      );
    if (!preliminary) throw applicationNotFound(applicationId);
    const member = await this.discord.member(actor.guildId, preliminary.user_id);
    return this.db.transaction(async (client) => {
      const db = orm(client);
      const [guild] = await db
        .select()
        .from(t.guilds)
        .where(eq(t.guilds.id, actor.guildId))
        .for("share");
      if (!guild)
        throw new Failure(
          "setup",
          "This server has no TaruBot configuration yet. Start with /setup, or link the Free Company with /config fc link.",
          0,
          { kind: "setup", missing: "guild" },
        );
      const outcome = {
        effectsMode: this.effectsMode(guild),
        cooldownSeconds: this.config.GUEST_COOLDOWN_SECONDS,
      };
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
      if (!application) throw applicationNotFound(applicationId);
      if (messageId && application.message_id !== messageId)
        throw new Failure(
          "stale",
          "A newer review message replaced this one. Use the latest message in the review channel, or /guest approve.",
          0,
          { kind: "stale", what: "review" },
        );
      if (application.state !== "pending")
        return {
          ...outcome,
          id: application.id,
          status: application.state as ApplicationState,
          effects: "unchanged",
          userId: application.user_id,
          reason: application.reason,
          reviewerId: application.reviewer_id,
          decidedAt: application.decided_at,
        };
      let state: ApplicationState = approve ? "approved" : "denied";
      if (
        !member ||
        member.bot ||
        member.joinedAt.getTime() !== application.joined_at.getTime() ||
        !presence?.present ||
        presence.joined_at?.getTime() !== application.joined_at.getTime()
      )
        state = "cancelled";
      else if (
        (await this.memberEligible(client, guild, application.user_id)) ||
        (await this.hasActiveRegistration(client, guild.id, application.user_id))
      )
        state = "superseded";
      const [decided] = await db
        .update(t.guestApplications)
        .set({ state, reviewer_id: actor.userId, decided_at: sql`now()`, reason })
        .where(eq(t.guestApplications.id, application.id))
        .returning({ decided_at: t.guestApplications.decided_at });
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
      return {
        ...outcome,
        id: application.id,
        status: state,
        effects: "queued",
        userId: application.user_id,
        reason,
        reviewerId: actor.userId,
        decidedAt: decided?.decided_at ?? null,
      };
    });
  }
  /**
   * A new explicit grant can restore revoked access; replaying an old grant cannot undo a later
   * revocation. `restored` reports that this grant lifted a revocation.
   */
  private async grantWithin(
    client: Connection,
    actor: Actor,
    user: string,
    provenance: string,
    key: string,
    reason: string | null,
  ): Promise<{ restored: boolean }> {
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
      // Interaction and application keys are unique, so this is an internal invariant.
      if (!existing.length)
        throw new Failure(
          "idempotency_conflict",
          "Grant idempotency key belongs to a different target.",
        );
      return { restored: false };
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
    return { restored: previous?.revoked === true };
  }
  /** Officer grants/revocations are durable policy decisions, with reconciliation queued separately. */
  async guestAction(
    actor: Actor,
    user: string,
    revoke: boolean,
    reason: string,
    key: string,
  ): Promise<GuestActionResult> {
    authorizeGuestDecision(actor);
    const guild = await this.guild(actor);
    reason = note(reason, "reason");
    const member = await this.discord.member(actor.guildId, user);
    if (member?.bot)
      throw new Failure("input", "Guest access is for human members, not bots.", 0, {
        kind: "option",
        option: "member",
      });
    return this.db.transaction(async (client) => {
      await ensureUser(client, actor.guildId, user);
      const db = orm(client);
      await db
        .select({ user_id: t.guildUsers.user_id })
        .from(t.guildUsers)
        .where(and(eq(t.guildUsers.guild_id, actor.guildId), eq(t.guildUsers.user_id, user)))
        .for("update");
      let restored = false;
      let cancelledApplications = 0;
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
        cancelledApplications = cancelled.length;
        for (const row of cancelled)
          await enqueue(
            client,
            "guest.review",
            `review:${row.id}`,
            { applicationId: row.id },
            actor.guildId,
            user,
          );
      } else ({ restored } = await this.grantWithin(client, actor, user, "manual", key, reason));
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
      return {
        status: state?.revoked ? "revoked" : "granted",
        effects: "queued",
        effectsMode: this.effectsMode(guild),
        user,
        reason,
        restored,
        cancelledApplications,
        // A departed user keeps the durable decision; it applies if they rejoin.
        present: member !== null,
        guestRoleConfigured: guild.guest_role_id !== null,
      };
    });
  }
}
