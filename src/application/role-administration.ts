/** Role provisioning and explicit officer decisions, restricted to server role managers. */
import type { Actor } from "../domain/policy.js";
import { authorizeRoleManager } from "../domain/policy.js";
import { Failure, normalized, note } from "../domain/values.js";
import { audit, ensureUser, orm } from "../infrastructure/postgres/database.js";
import { and, eq, sql } from "drizzle-orm";
import * as t from "../infrastructure/postgres/schema.js";
import type { DiscordPort } from "./records.js";
import { enqueue, layoutGuildRoles, reconcileUser, secureGuildChannels } from "../jobs/queue.js";
import type { GuildAccess } from "./guild-access.js";
import type { Service } from "./service.js";

/** Extra provisioning capability, separate from the reconciliation/test port. */
export interface RoleProvisioner extends DiscordPort {
  /** `hoist` is the guild's role-layout switch; a created role is displayed separately only when on. */
  ensureRole(
    guild: string,
    name: string,
    actor: string,
    configured: string | null,
    canonicalName: string,
    hoist: boolean,
  ): Promise<{ id: string; created: boolean }>;
}

/** Setup is serialized per guild; Discord resource creation precedes one configuration commit. */
export class RoleAdministration {
  constructor(
    private readonly app: Service,
    private readonly discord: RoleProvisioner,
    private readonly access: GuildAccess,
  ) {}

  /** Create/reuse four ordinary roles, optionally link an FC and select its officer rank. */
  async setup(
    actor: Actor,
    prefix: string,
    fcId: string | null,
    officerRank: string | null,
    channels: { lobby: string | null; officers: string | null } = { lobby: null, officers: null },
  ): Promise<unknown> {
    authorizeRoleManager(actor);
    prefix = prefix.trim();
    if (prefix.length > 50)
      throw new Failure("input", "Role prefix must be at most 50 characters.");
    if (officerRank !== null) officerRank = note(officerRank);
    const connection = await this.app.db.pool.connect();
    let locked = false;
    try {
      locked =
        (
          await connection.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
            [`setup:${actor.guildId}`],
          )
        ).rows[0]?.locked ?? false;
      if (!locked)
        throw new Failure("busy", "Setup is already running for this guild. Retry shortly.");
      const [previous] = await this.app.db.orm
        .select()
        .from(t.guilds)
        .where(eq(t.guilds.id, actor.guildId));
      if (fcId && previous?.fc_id && previous.fc_id !== fcId)
        throw new Failure(
          "input",
          "Unlink the current FC explicitly before selecting a different one.",
        );
      await this.access.discord.check(actor.guildId, actor.userId);
      // Setup never changes the role-layout switch. An existing guild keeps its value (an imported
      // guild stays off); a guild first created here gets the column default, which is on. A
      // concurrent /config role_layout bumps the revision, so the check below turns it into a conflict.
      const layout = previous?.role_layout_enabled ?? true;
      const company =
        fcId && fcId !== previous?.fc_id ? await this.app.lodestone.company(fcId) : null;
      const specifications = [
        ["member_role_id", "Member"],
        ["guest_role_id", "Guest"],
        ["officer_role_id", "Officer"],
        ["leader_role_id", "FC Leader"],
      ] as const;
      const roles: {
        field: (typeof specifications)[number][0];
        name: string;
        id: string;
        created: boolean;
      }[] = [];
      for (const [field, label] of specifications) {
        const name = prefix ? `${prefix} ${label}` : label;
        roles.push({
          field,
          name,
          ...(await this.discord.ensureRole(
            actor.guildId,
            name,
            actor.userId,
            previous?.[field] ?? null,
            label,
            layout,
          )),
        });
      }
      if (new Set(roles.map((role) => role.id)).size !== 4)
        throw new Failure("input", "The four managed roles must be distinct.");
      const [member, guest, staff, leader] = roles;
      if (!member || !guest || !staff || !leader)
        throw new Error("Incomplete setup role selection");
      for (const selected of [channels.lobby, channels.officers])
        if (selected) await this.discord.validateChannel(actor.guildId, selected);
      const prepared = await this.access.discord.prepare(
        actor.guildId,
        actor.userId,
        { member: member.id, guest: guest.id, officer: staff.id, leader: leader.id },
        channels.lobby ?? previous?.lobby_channel_id ?? null,
        channels.officers ?? previous?.officer_channel_id ?? null,
      );
      const officerRole = roles.find((role) => role.field === "officer_role_id");
      // Adopting an existing staff role is an explicit manager decision; preserve its human holders.
      const adopted =
        officerRole && !officerRole.created && previous?.officer_role_id !== officerRole.id
          ? (await this.discord.members(actor.guildId)).filter(
              (member) => !member.bot && member.roles.includes(officerRole.id),
            )
          : [];
      return await this.app.db.transaction(async (client) => {
        const db = orm(client);
        if (company) await this.app.storeCompany(client, company);
        await db
          .insert(t.guilds)
          .values({ id: actor.guildId, effects_enabled: true })
          .onConflictDoNothing();
        const [current] = await db
          .select()
          .from(t.guilds)
          .where(eq(t.guilds.id, actor.guildId))
          .for("update");
        if (
          !current ||
          (previous && current.revision !== previous.revision) ||
          (!previous && current.revision !== 1n)
        )
          throw new Failure(
            "conflict",
            "Configuration changed during setup. Retry to reuse the created roles.",
          );
        const targetFc = fcId ?? current.fc_id;
        for (const role of roles) {
          const old = current[role.field];
          if (old && old !== role.id)
            await db
              .insert(t.retiredRoles)
              .values({ guild_id: actor.guildId, role_id: old, revision: current.revision })
              .onConflictDoNothing();
          await db
            .delete(t.retiredRoles)
            .where(
              and(eq(t.retiredRoles.guild_id, actor.guildId), eq(t.retiredRoles.role_id, role.id)),
            );
        }
        await db
          .update(t.guilds)
          .set({
            fc_id: targetFc,
            member_role_id: member.id,
            guest_role_id: guest.id,
            officer_role_id: staff.id,
            leader_role_id: leader.id,
            officer_rank_name: officerRank ?? t.guilds.officer_rank_name,
            officer_rank_key: officerRank ? normalized(officerRank) : t.guilds.officer_rank_key,
            lobby_channel_id: prepared.lobby.id,
            officer_channel_id: prepared.officers.id,
            access_policy_enabled: true,
            access_everyone_before:
              current.access_everyone_before ?? prepared.snapshot.everyonePermissions,
            officer_notifications_channel_id:
              current.officer_notifications_channel_id ?? prepared.officers.id,
            guest_application_channel_id:
              current.guest_application_channel_id ?? prepared.officers.id,
            revision: sql`${t.guilds.revision}+1`,
            active: true,
          })
          .where(eq(t.guilds.id, actor.guildId));
        await this.access.remember(
          client,
          actor.guildId,
          prepared.snapshot,
          prepared.lobby.id,
          prepared.officers.id,
          previous?.access_policy_enabled ?? false,
        );
        for (const member of adopted) {
          await ensureUser(client, actor.guildId, member.id, member.joinedAt);
          await db
            .insert(t.officerOverrides)
            .values({
              guild_id: actor.guildId,
              user_id: member.id,
              state: "granted",
              actor_id: actor.userId,
              reason: "Existing Officer role adopted by setup",
            })
            .onConflictDoNothing();
          await audit(client, actor.guildId, actor.userId, "officer.adopt", member.id, {
            roleId: officerRole?.id,
          });
        }
        if (targetFc) {
          await db
            .insert(t.ledgerAccounts)
            .values({ guild_id: actor.guildId, fc_id: targetFc })
            .onConflictDoNothing();
          await enqueue(client, "roster", `roster:${targetFc}`, { fcId: targetFc });
        }
        await enqueue(client, "reconcile.guild", `guild:${actor.guildId}`, {}, actor.guildId);
        // Presentation is opt-in per guild; with the switch off no hoist/position work is queued.
        if (current.role_layout_enabled) await layoutGuildRoles(client, actor.guildId);
        const accessJob = await secureGuildChannels(client, actor.guildId);
        await audit(client, actor.guildId, actor.userId, "setup", actor.guildId, {
          roles,
          fcId: targetFc,
          officerRank,
          lobby: prepared.lobby,
          officers: prepared.officers,
        });
        return {
          status: "configured",
          roles,
          fcId: targetFc,
          officerRank: officerRank ?? current.officer_rank_name,
          effects: "queued",
          roleLayout: current.role_layout_enabled
            ? "FC Leader > Officer > Member > Guest; consecutive block; display separately"
            : "disabled: role display and order are left unchanged; enable with /config role_layout enabled:true",
          lobby: prepared.lobby,
          officerChannel: prepared.officers,
          accessPolicy: "queued",
          accessJob,
          instructions:
            "Channel enforcement is queued; inspect /sync status until secured. Configure a ledger channel if needed, then run /config validate.",
        };
      });
    } finally {
      if (locked)
        await connection
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`setup:${actor.guildId}`])
          .catch(() => {});
      connection.release();
    }
  }

  /**
   * A durable revoke overrides rank automation until a manager explicitly grants again.
   *
   * An override may be recorded before any Officer role is bound. The production cutover (W15)
   * records the owner-approved exceptions first and only then binds the legacy role with
   * adopt_holders:false, whose repair pass would otherwise strip the role from every exception
   * until its grant arrived. Without a bound role the override confers nothing yet: officer
   * authority needs the bound role (Service.enrichActor), and reconciliation skips an unbound role.
   */
  async officer(actor: Actor, user: string, grant: boolean, reason: string): Promise<unknown> {
    authorizeRoleManager(actor);
    reason = note(reason);
    const guild = await this.app.guild(actor);
    // The bound role must still be one this manager and the bot may assign.
    if (guild.officer_role_id)
      await this.discord.validateRole(
        guild.id,
        guild.officer_role_id,
        actor.userId,
        grant && guild.access_policy_enabled,
      );
    const member = await this.discord.member(guild.id, user);
    if (member?.bot || (grant && !member))
      throw new Failure("input", "Officer grants require a current human guild member.");
    return this.app.db.transaction(async (client) => {
      await ensureUser(client, guild.id, user, member?.joinedAt);
      const data = { state: grant ? "granted" : "revoked", actor_id: actor.userId, reason };
      await orm(client)
        .insert(t.officerOverrides)
        .values({ guild_id: guild.id, user_id: user, ...data })
        .onConflictDoUpdate({
          target: [t.officerOverrides.guild_id, t.officerOverrides.user_id],
          set: { ...data, changed_at: sql`now()` },
        });
      await audit(
        client,
        guild.id,
        actor.userId,
        grant ? "officer.grant" : "officer.revoke",
        user,
        { reason },
      );
      await reconcileUser(client, guild.id, user);
      // "recorded": nothing to apply until /config roles officer binds a role (its pass applies it).
      return {
        status: grant ? "granted" : "revoked",
        effects: guild.officer_role_id ? "queued" : "recorded",
      };
    });
  }
}
