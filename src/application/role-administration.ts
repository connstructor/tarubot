/** Role provisioning and explicit officer decisions, restricted to server role managers. */
import type { Actor } from "../domain/policy.js";
import { authorizeRoleManager } from "../domain/policy.js";
import { Failure, normalized, note } from "../domain/values.js";
import { audit, ensureUser } from "../infrastructure/postgres/database.js";
import { enqueue, layoutGuildRoles, reconcileUser } from "../jobs/queue.js";
import type { DiscordPort, GuildRecord } from "./records.js";
import type { Service } from "./service.js";

/** Extra provisioning capability, separate from the reconciliation/test port. */
export interface RoleProvisioner extends DiscordPort {
  ensureRole(
    guild: string,
    name: string,
    actor: string,
    configured: string | null,
    canonicalName: string,
  ): Promise<{ id: string; created: boolean }>;
}

/** Setup is serialized per guild; Discord resource creation precedes one configuration commit. */
export class RoleAdministration {
  constructor(
    private readonly app: Service,
    private readonly discord: RoleProvisioner,
  ) {}

  /** Create/reuse four ordinary roles, optionally link an FC and select its officer rank. */
  async setup(
    actor: Actor,
    prefix: string,
    fcId: string | null,
    officerRank: string | null,
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
      const previous = (
        await this.app.db.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1", [actor.guildId])
      )[0];
      if (fcId && previous?.fc_id && previous.fc_id !== fcId)
        throw new Failure(
          "input",
          "Unlink the current FC explicitly before selecting a different one.",
        );
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
          )),
        });
      }
      if (new Set(roles.map((role) => role.id)).size !== 4)
        throw new Failure("input", "The four managed roles must be distinct.");
      const officerRole = roles.find((role) => role.field === "officer_role_id");
      // Adopting an existing staff role is an explicit manager decision; preserve its human holders.
      const adopted =
        officerRole && !officerRole.created && previous?.officer_role_id !== officerRole.id
          ? (await this.discord.members(actor.guildId)).filter(
              (member) => !member.bot && member.roles.includes(officerRole.id),
            )
          : [];
      return await this.app.db.transaction(async (client) => {
        if (company) await this.app.storeCompany(client, company);
        await client.query(
          "INSERT INTO guilds(id,effects_enabled) VALUES($1,true) ON CONFLICT DO NOTHING",
          [actor.guildId],
        );
        const current = (
          await client.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1 FOR UPDATE", [
            actor.guildId,
          ])
        ).rows[0];
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
            await client.query(
              "INSERT INTO retired_roles(guild_id,role_id,revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
              [actor.guildId, old, current.revision],
            );
          await client.query("DELETE FROM retired_roles WHERE guild_id=$1 AND role_id=$2", [
            actor.guildId,
            role.id,
          ]);
        }
        await client.query(
          `UPDATE guilds SET fc_id=$2,member_role_id=$3,guest_role_id=$4,officer_role_id=$5,leader_role_id=$6,
          officer_rank_name=COALESCE($7,officer_rank_name),officer_rank_key=COALESCE($8,officer_rank_key),revision=revision+1,active=true WHERE id=$1`,
          [
            actor.guildId,
            targetFc,
            roles[0]?.id,
            roles[1]?.id,
            roles[2]?.id,
            roles[3]?.id,
            officerRank,
            officerRank ? normalized(officerRank) : null,
          ],
        );
        for (const member of adopted) {
          await ensureUser(client, actor.guildId, member.id, member.joinedAt);
          await client.query(
            "INSERT INTO officer_overrides(guild_id,user_id,state,actor_id,reason) VALUES($1,$2,'granted',$3,'Existing Officer role adopted by setup') ON CONFLICT DO NOTHING",
            [actor.guildId, member.id, actor.userId],
          );
          await audit(client, actor.guildId, actor.userId, "officer.adopt", member.id, {
            roleId: officerRole?.id,
          });
        }
        if (targetFc) {
          await client.query(
            "INSERT INTO ledger_accounts(guild_id,fc_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [actor.guildId, targetFc],
          );
          await enqueue(client, "roster", `roster:${targetFc}`, { fcId: targetFc });
        }
        await enqueue(client, "reconcile.guild", `guild:${actor.guildId}`, {}, actor.guildId);
        await layoutGuildRoles(client, actor.guildId);
        await audit(client, actor.guildId, actor.userId, "setup", actor.guildId, {
          roles,
          fcId: targetFc,
          officerRank,
        });
        return {
          status: "configured",
          roles,
          fcId: targetFc,
          officerRank: officerRank ?? current.officer_rank_name,
          effects: "queued",
          roleLayout: "FC Leader > Officer > Member > Guest; consecutive block; display separately",
          instructions: "Configure notification channels, then run /config validate and /refresh.",
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

  /** A durable revoke overrides rank automation until a manager explicitly grants again. */
  async officer(actor: Actor, user: string, grant: boolean, reason: string): Promise<unknown> {
    authorizeRoleManager(actor);
    reason = note(reason);
    const guild = await this.app.guild(actor);
    if (!guild.officer_role_id)
      throw new Failure("setup", "Run /setup or configure an Officer role first.");
    await this.discord.validateRole(guild.id, guild.officer_role_id, actor.userId);
    const member = await this.discord.member(guild.id, user);
    if (member?.bot || (grant && !member))
      throw new Failure("input", "Officer grants require a current human guild member.");
    return this.app.db.transaction(async (client) => {
      await ensureUser(client, guild.id, user, member?.joinedAt);
      await client.query(
        "INSERT INTO officer_overrides(guild_id,user_id,state,actor_id,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(guild_id,user_id) DO UPDATE SET state=$3,actor_id=$4,reason=$5,changed_at=now()",
        [guild.id, user, grant ? "granted" : "revoked", actor.userId, reason],
      );
      await audit(
        client,
        guild.id,
        actor.userId,
        grant ? "officer.grant" : "officer.revoke",
        user,
        { reason },
      );
      await reconcileUser(client, guild.id, user);
      return { status: grant ? "granted" : "revoked", effects: "queued" };
    });
  }
}
