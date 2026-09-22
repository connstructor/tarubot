/** Authorized application decisions. Commit state and its outbox together; perform remote I/O outside transactions. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { Configuration } from "../config/env.js";
import { authorize, authorizeRoleManager, type Actor } from "../domain/policy.js";
import { rankAccess } from "./rank-policy.js";
import { Failure, gil, json, MAX_GIL, note, normalized } from "../domain/values.js";
import {
  audit,
  ensureUser,
  type Connection,
  type Database,
} from "../infrastructure/postgres/database.js";
import type {
  CharacterIdentity,
  CompanyIdentity,
  Nodestone,
} from "../infrastructure/nodestone/client.js";
import { enqueue, layoutGuildRoles, reconcileUser } from "../jobs/queue.js";
import type { ApplicationRecord, DiscordPort, EntryRecord, GuildRecord } from "./records.js";

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
    const guild = (
      await this.db.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1 AND active", [
        actor.guildId,
      ])
    )[0];
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
    const row = (
      await this.db.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1 AND active", [
        actor.guildId,
      ])
    )[0];
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
      characters: await this.db.query(
        "SELECT l.id,l.character_id,l.active,l.provenance,l.created_at,c.name,c.world,c.fc_hint,f.name AS fc_name,u.primary_character_id,u.nickname_enabled,u.nickname_suspended FROM links l JOIN characters c ON c.id=l.character_id LEFT JOIN free_companies f ON f.id=c.fc_hint JOIN guild_users u ON u.guild_id=l.guild_id AND u.user_id=l.user_id WHERE l.guild_id=$1 AND l.user_id=$2 ORDER BY l.created_at",
        [actor.guildId, owner],
      ),
    };
  }
  /** Keep application outcomes, grants, revocation, history, and delivery visibly separate. */
  async guestStatus(actor: Actor, owner: string): Promise<unknown> {
    authorize(actor, actor.guildId, "user", owner);
    const guild = await this.guild(actor);
    return {
      applications: await this.db.query(
        "SELECT * FROM guest_applications WHERE guild_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 10",
        [actor.guildId, owner],
      ),
      grants: await this.db.query(
        "SELECT provenance,created_at,reason FROM guest_grants WHERE guild_id=$1 AND user_id=$2",
        [actor.guildId, owner],
      ),
      revocation: await this.db.query(
        "SELECT revoked,changed_at,reason FROM guest_state WHERE guild_id=$1 AND user_id=$2",
        [actor.guildId, owner],
      ),
      formerMember: await this.db.query(
        "SELECT EXISTS(SELECT 1 FROM membership_history WHERE guild_id=$1 AND user_id=$2 AND fc_id=$3) AS eligible",
        [actor.guildId, owner, guild.fc_id],
      ),
      delivery: await this.db.query(
        "SELECT id,kind,status,last_error,result FROM jobs WHERE guild_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 10",
        [actor.guildId, owner],
      ),
    };
  }
  /** Aggregate child work without exposing another requester's private run or user effects. */
  async syncStatus(actor: Actor, run: string | null): Promise<unknown> {
    const guild = await this.guild(actor);
    const runs = await this.db.query(
      `SELECT r.id,r.created_at,r.enumeration_completed_at,j.kind AS acquisition_kind,j.status AS acquisition_status,j.last_error,j.result,
      CASE WHEN s.failed>0 THEN 'failed' WHEN s.blocked>0 THEN 'blocked' WHEN s.pending>0 THEN 'queued' ELSE 'completed' END AS status,
      s.total AS work_total,s.completed AS work_completed,s.blocked AS work_blocked,s.failed AS work_failed
      FROM sync_runs r LEFT JOIN jobs j ON j.id=r.job_id
      LEFT JOIN LATERAL(SELECT count(*)::int AS total,count(*) FILTER(WHERE w.status='succeeded')::int AS completed,
      count(*) FILTER(WHERE w.status IN ('queued','running'))::int AS pending,count(*) FILTER(WHERE w.status IN ('blocked','disabled'))::int AS blocked,
      count(*) FILTER(WHERE w.status='failed')::int AS failed FROM sync_run_jobs p JOIN jobs w ON w.id=p.job_id WHERE p.run_id=r.id) s ON true
      WHERE r.guild_id=$1 AND ($2::boolean OR r.requester_id=$3) AND ($4::uuid IS NULL OR r.id=$4) ORDER BY r.created_at DESC LIMIT 10`,
      [actor.guildId, actor.officer, actor.userId, run],
    );
    const work = await this.db.query(
      `SELECT j.id,j.kind,j.status,j.attempts,j.due_at,j.last_error,j.result FROM jobs j
      WHERE ((j.guild_id=$1 AND ($2::boolean OR j.user_id=$3)) OR (j.guild_id IS NULL AND
      (($2::boolean AND j.payload->>'fcId'=$4) OR EXISTS(SELECT 1 FROM links l WHERE l.guild_id=$1 AND l.active AND l.character_id::text=j.payload->>'characterId' AND ($2::boolean OR l.user_id=$3)))))
      AND j.status IN ('queued','running','blocked','failed','disabled') ORDER BY j.created_at DESC LIMIT 25`,
      [actor.guildId, actor.officer, actor.userId, guild.fc_id],
    );
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
        ? await this.db.query(
            "SELECT id,last_successful_roster_at,last_attempt_at,last_error FROM free_companies WHERE id=$1",
            [guild.fc_id],
          )
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
      const rows = await this.db.query<{ id: string; user_id: string }>(
        "SELECT id,user_id FROM guest_applications WHERE guild_id=$1 AND state='pending' AND (id::text ILIKE $2 OR user_id::text ILIKE $2) LIMIT 25",
        [actor.guildId, `%${query}%`],
      );
      return rows.map((row) => ({
        name: `${row.user_id} — ${row.id}`.slice(0, 100),
        value: row.id,
      }));
    }
    const rows =
      kind === "verify"
        ? await this.db.query<{ id: string; name: string; world: string }>(
            "SELECT DISTINCT c.id,c.name,c.world FROM challenges v JOIN characters c ON c.id=v.character_id WHERE v.guild_id=$1 AND v.user_id=$2 AND v.expires_at>now() AND v.consumed_at IS NULL AND v.replaced_at IS NULL AND (c.name ILIKE $3 OR c.id::text ILIKE $3) LIMIT 25",
            [actor.guildId, owner, `%${query}%`],
          )
        : await this.db.query<{ id: string; name: string; world: string }>(
            "SELECT c.id,c.name,c.world FROM links l JOIN characters c ON c.id=l.character_id WHERE l.guild_id=$1 AND l.user_id=$2 AND l.active AND (c.name ILIKE $3 OR c.id::text ILIKE $3) LIMIT 25",
            [actor.guildId, owner, `%${query}%`],
          );
    return rows.map((row) => ({
      name: `${row.name} @ ${row.world} (${row.id})`.slice(0, 100),
      value: row.id,
    }));
  }
  /** Refresh public display metadata without treating a profile fetch as an accepted roster. */
  async storeCompany(client: Connection, value: CompanyIdentity): Promise<void> {
    await client.query(
      "INSERT INTO free_companies(id,name,tag,world,dc,profile_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(id) DO UPDATE SET name=$2,tag=$3,world=$4,dc=$5,profile_at=now()",
      [value.id, value.name, value.tag, value.world, value.dc],
    );
  }
  /** Roster display updates must not advance profile freshness or overwrite independent FC hints. */
  async storeCharacter(
    client: Connection,
    value: CharacterIdentity,
    profile = true,
  ): Promise<void> {
    // Profile FC hints are deliberately independent from roster authority.
    await client.query(
      "INSERT INTO characters(id,name,world,dc,fc_hint,profile_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN now() ELSE NULL END) ON CONFLICT(id) DO UPDATE SET name=$2,world=$3,dc=$4,fc_hint=CASE WHEN $6 THEN $5 ELSE characters.fc_hint END,profile_at=CASE WHEN $6 THEN now() ELSE characters.profile_at END",
      [value.id, value.name, value.world, value.dc, value.fcId, profile],
    );
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
    ];
    if (!fields.includes(field)) throw new Failure("input", "Invalid configuration field.");
    if (field === "officer_role_id" || field === "leader_role_id") authorizeRoleManager(actor);
    if (field === "fc_id" && value === null)
      throw new Failure("input", "Use FC unlink with the currently linked ID.");
    const existing = (
      await this.db.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1", [actor.guildId])
    )[0];
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
      await client.query(
        "INSERT INTO guilds(id,effects_enabled) VALUES($1,true) ON CONFLICT DO NOTHING",
        [actor.guildId],
      );
      const saved = (
        await client.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1 FOR UPDATE", [
          actor.guildId,
        ])
      ).rows[0];
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
          await client.query(
            "INSERT INTO retired_roles(guild_id,role_id,revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [actor.guildId, old, saved.revision],
          );
        if (value)
          await client.query("DELETE FROM retired_roles WHERE guild_id=$1 AND role_id=$2", [
            actor.guildId,
            value,
          ]);
      }
      // field is selected exclusively from the allowlist above; values remain parameterized.
      await client.query(
        `UPDATE guilds SET ${field}=$2,revision=revision+1,active=true WHERE id=$1`,
        [actor.guildId, value],
      );
      if (field === "fc_id" && value) {
        await client.query(
          "INSERT INTO ledger_accounts(guild_id,fc_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [actor.guildId, value],
        );
        await enqueue(client, "roster", `roster:${value}`, { fcId: value });
      }
      await audit(client, actor.guildId, actor.userId, "config", field, { value });
      if (field.endsWith("role_id")) await layoutGuildRoles(client, actor.guildId);
      for (const member of adopted) {
        await ensureUser(client, actor.guildId, member.id, member.joinedAt);
        await client.query(
          "INSERT INTO officer_overrides(guild_id,user_id,state,actor_id,reason) VALUES($1,$2,'granted',$3,'Existing Officer role adopted by configuration') ON CONFLICT DO NOTHING",
          [actor.guildId, member.id, actor.userId],
        );
        await audit(client, actor.guildId, actor.userId, "officer.adopt", member.id, {
          roleId: value,
        });
      }
      await enqueue(client, "reconcile.guild", `guild:${actor.guildId}`, {}, actor.guildId);
      await client.query(
        "UPDATE jobs SET status='queued',attempts=0,due_at=now() WHERE guild_id=$1 AND status IN ('blocked','disabled')",
        [actor.guildId],
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
      await client.query(
        "UPDATE guilds SET officer_rank_name=$2,officer_rank_key=$3,revision=revision+1 WHERE id=$1",
        [actor.guildId, rank, rank ? normalized(rank) : null],
      );
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
      const result = await client.query(
        "UPDATE guilds SET fc_id=NULL,revision=revision+1 WHERE id=$1 AND fc_id=$2 RETURNING id",
        [actor.guildId, fcId],
      );
      if (!result.rowCount)
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
    await client.query("SELECT id FROM characters WHERE id=$1 FOR UPDATE", [character]);
    const linked = (
      await client.query<{ id: string; user_id: string }>(
        "SELECT id,user_id FROM links WHERE guild_id=$1 AND character_id=$2 AND active",
        [actor.guildId, character],
      )
    ).rows[0];
    if (linked) {
      if (linked.user_id !== owner)
        throw new Failure(
          "ownership_conflict",
          "This character is already linked to another user.",
        );
      await reconcileUser(client, actor.guildId, owner);
      return linked.id;
    }
    const previous = (
      await client.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM links WHERE guild_id=$1 AND user_id=$2) OR EXISTS(SELECT 1 FROM guild_users WHERE guild_id=$1 AND user_id=$2 AND imported) AS exists",
        [actor.guildId, owner],
      )
    ).rows[0]?.exists;
    await client.query("DELETE FROM membership WHERE guild_id=$1 AND character_id=$2", [
      actor.guildId,
      character,
    ]);
    const link = (
      await client.query<{ id: string }>(
        "INSERT INTO links(guild_id,user_id,character_id,provenance,actor_id,reason,source) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [actor.guildId, owner, character, provenance, actor.userId, reason, json(source)],
      )
    ).rows[0];
    if (!link) throw new Error("Missing link");
    const evidence = (
      await client.query<{ id: string; fc_id: string; observed_at: Date }>(
        `SELECT s.id,s.fc_id,s.observed_at FROM guilds g
      JOIN LATERAL(SELECT id,fc_id,observed_at FROM roster_snapshots WHERE fc_id=g.fc_id ORDER BY observed_at DESC LIMIT 1) s ON true
      JOIN roster_members r ON r.snapshot_id=s.id AND r.character_id=$2
      WHERE g.id=$1 AND s.observed_at>now()-$3*interval '1 second'`,
        [actor.guildId, character, this.config.ROSTER_INTERVAL_SECONDS],
      )
    ).rows[0];
    if (evidence) {
      await client.query(
        "INSERT INTO membership(guild_id,fc_id,character_id,state,snapshot_id,confirmed_snapshot_id) VALUES($1,$2,$3,'present',$4,$4) ON CONFLICT(guild_id,fc_id,character_id) DO UPDATE SET state='present',first_absence_at=NULL,snapshot_id=$4,confirmed_snapshot_id=$4",
        [actor.guildId, evidence.fc_id, character, evidence.id],
      );
      await client.query(
        "INSERT INTO membership_history(guild_id,user_id,fc_id,link_id,snapshot_id,observed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [actor.guildId, owner, evidence.fc_id, link.id, evidence.id, evidence.observed_at],
      );
    }
    if (!previous)
      await client.query(
        "UPDATE guild_users SET primary_character_id=$3,nickname_enabled=true,nickname_suspended=false WHERE guild_id=$1 AND user_id=$2",
        [actor.guildId, owner, character],
      );
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
      await ensureUser(client, actor.guildId, actor.userId, member.joinedAt);
      await this.storeCharacter(client, identity);
      const existing = (
        await client.query<{ user_id: string }>(
          "SELECT user_id FROM links WHERE guild_id=$1 AND character_id=$2 AND active",
          [actor.guildId, identity.id],
        )
      ).rows[0];
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
      await client.query(
        "UPDATE challenges SET replaced_at=now() WHERE guild_id=$1 AND user_id=$2 AND character_id=$3 AND consumed_at IS NULL AND replaced_at IS NULL",
        [actor.guildId, actor.userId, identity.id],
      );
      const counts = (
        await client.query<{ own: bigint; total: bigint }>(
          "SELECT count(*) FILTER(WHERE guild_id=$1 AND user_id=$2) AS own,count(*) AS total FROM challenges WHERE expires_at>now() AND consumed_at IS NULL AND replaced_at IS NULL",
          [actor.guildId, actor.userId],
        )
      ).rows[0];
      if (!counts || counts.own >= 5n || counts.total >= 1000n)
        throw new Failure(
          "cooldown",
          "Too many pending verification challenges. Try again after one expires.",
        );
      const row = (
        await client.query<{ id: string; expires_at: Date }>(
          "INSERT INTO challenges(guild_id,user_id,character_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+$5*interval '1 second') RETURNING id,expires_at",
          [actor.guildId, actor.userId, identity.id, hash, this.config.VERIFICATION_SECONDS],
        )
      ).rows[0];
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
      await client.query(
        "SELECT user_id FROM guild_users WHERE guild_id=$1 AND user_id=$2 FOR UPDATE",
        [actor.guildId, actor.userId],
      );
      const challenge = (
        await client.query<{
          id: string;
          token_hash: string;
          expires_at: Date;
          consumed_at: Date | null;
        }>(
          "SELECT * FROM challenges WHERE guild_id=$1 AND user_id=$2 AND character_id=$3 AND replaced_at IS NULL ORDER BY issued_at DESC LIMIT 1 FOR UPDATE",
          [actor.guildId, actor.userId, characterId],
        )
      ).rows[0];
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
      const consumed = await client.query(
        "UPDATE challenges SET consumed_at=clock_timestamp() WHERE id=$1 AND expires_at>clock_timestamp() AND consumed_at IS NULL AND replaced_at IS NULL RETURNING id",
        [challenge.id],
      );
      if (!consumed.rowCount)
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
      await client.query(
        "SELECT user_id FROM guild_users WHERE guild_id=$1 AND user_id=$2 FOR UPDATE",
        [actor.guildId, owner],
      );
      await client.query("SELECT id FROM characters WHERE id=$1 FOR UPDATE", [character]);
      const link = (
        await client.query<{ id: string; user_id: string }>(
          "SELECT id,user_id FROM links WHERE guild_id=$1 AND character_id=$2 AND active FOR UPDATE",
          [actor.guildId, character],
        )
      ).rows[0];
      if (!link || link.user_id !== owner)
        throw new Failure("input", "That character is not actively linked to the specified owner.");
      await client.query("UPDATE links SET active=false,ended_at=now() WHERE id=$1", [link.id]);
      await client.query(
        "UPDATE guild_users u SET local_member_loss=true WHERE guild_id=$1 AND user_id=$2 AND NOT EXISTS(SELECT 1 FROM links l JOIN membership m ON m.guild_id=l.guild_id AND m.character_id=l.character_id JOIN guilds g ON g.id=l.guild_id AND g.fc_id=m.fc_id WHERE l.guild_id=$1 AND l.user_id=$2 AND l.active AND m.state IN ('present','missing'))",
        [actor.guildId, owner],
      );
      await client.query(
        "UPDATE guild_users SET primary_character_id=NULL,nickname_restore=true WHERE guild_id=$1 AND user_id=$2 AND primary_character_id=$3",
        [actor.guildId, owner, character],
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
      await client.query(
        "SELECT user_id FROM guild_users WHERE guild_id=$1 AND user_id=$2 FOR UPDATE",
        [actor.guildId, actor.userId],
      );
      if (character) {
        const owned = await client.query(
          "SELECT id FROM links WHERE guild_id=$1 AND user_id=$2 AND character_id=$3 AND active FOR UPDATE",
          [actor.guildId, actor.userId, character],
        );
        if (!owned.rowCount)
          throw new Failure("input", "Choose one of your active linked characters.");
        await client.query(
          "UPDATE guild_users SET primary_character_id=$3,nickname_restore=false WHERE guild_id=$1 AND user_id=$2",
          [actor.guildId, actor.userId, character],
        );
      }
      if (enabled !== null) {
        const updated = await client.query(
          "UPDATE guild_users SET nickname_enabled=$3,nickname_suspended=false,nickname_restore=NOT $3,nickname_baseline_set=CASE WHEN $3 THEN false ELSE nickname_baseline_set END WHERE guild_id=$1 AND user_id=$2 AND (NOT $3 OR primary_character_id IS NOT NULL) RETURNING user_id",
          [actor.guildId, actor.userId, enabled],
        );
        if (!updated.rowCount)
          throw new Failure("input", "Select a primary character with /main first.");
      }
      await reconcileUser(client, actor.guildId, actor.userId);
      return { status: "saved", effects: "queued" };
    });
  }
  /** Ledger authority requires actual accepted positive evidence, not just imported role protection. */
  async memberEligible(client: Connection, guild: GuildRecord, user: string): Promise<boolean> {
    if (!guild.fc_id) return false;
    const row = (
      await client.query<{ eligible: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM links l JOIN membership m ON m.guild_id=l.guild_id AND m.character_id=l.character_id WHERE l.guild_id=$1 AND l.user_id=$2 AND l.active AND m.fc_id=$3 AND m.state IN ('present','missing') AND m.confirmed_snapshot_id IS NOT NULL) AS eligible",
        [guild.id, user, guild.fc_id],
      )
    ).rows[0];
    return row?.eligible ?? false;
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
    await this.discord.validateChannel(actor.guildId, guild.ledger_channel_id);
    let amount: bigint;
    if (operation === "deposit" || operation === "withdraw") {
      if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 999999999)
        throw new Failure("input", "Amount must be 1–999,999,999 gil.");
      amount = BigInt(input);
    } else amount = gil(input);
    return this.db.transaction(async (client) => {
      const current = (
        await client.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1 FOR SHARE", [
          actor.guildId,
        ])
      ).rows[0];
      if (!current || current.revision !== guild.revision)
        throw new Failure("conflict", "Configuration changed. Retry the operation.");
      if (!actor.officer && !(await this.memberEligible(client, current, actor.userId)))
        throw new Failure("forbidden", "Confirmed FC membership is required to deposit.");
      const account = (
        await client.query<{ id: string; balance: bigint | null; sequence: bigint }>(
          "SELECT * FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2 FOR UPDATE",
          [actor.guildId, guild.fc_id],
        )
      ).rows[0];
      if (!account) throw new Failure("setup", "The ledger account is unavailable.");
      const duplicate = (
        await client.query<EntryRecord>("SELECT * FROM ledger_entries WHERE idempotency_key=$1", [
          key,
        ])
      ).rows[0];
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
        const referenced = await client.query(
          "SELECT id FROM ledger_entries WHERE id=$1 AND account_id=$2",
          [correction, account.id],
        );
        if (!referenced.rowCount)
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
      const entry = (
        await client.query<EntryRecord>(
          "INSERT INTO ledger_entries(account_id,sequence,operation,delta,balance,actor_id,guild_id,note,idempotency_key,correction_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
          [
            account.id,
            account.sequence + 1n,
            operation,
            balance - before,
            balance,
            actor.userId,
            actor.guildId,
            noteText,
            key,
            correction,
          ],
        )
      ).rows[0];
      if (!entry) throw new Error("Missing entry");
      await client.query("UPDATE ledger_accounts SET balance=$2,sequence=$3 WHERE id=$1", [
        account.id,
        balance,
        entry.sequence,
      ]);
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
    const account = (
      await this.db.query<{ id: string; balance: bigint | null; sequence: bigint }>(
        "SELECT * FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
        [actor.guildId, target],
      )
    )[0];
    if (!account) throw new Failure("input", "No ledger account exists for that FC in this guild.");
    const delivery = await this.db.query(
      "SELECT j.id,j.status,j.last_error,j.message_id,j.payload->>'entryId' AS entry_id FROM jobs j JOIN ledger_entries e ON e.id::text=j.payload->>'entryId' WHERE j.kind='ledger.notify' AND e.account_id=$1 ORDER BY e.sequence DESC LIMIT 10",
      [account.id],
    );
    if (!history)
      return {
        account,
        balanceState: account.balance === null ? "uninitialized" : "known",
        delivery,
      };
    const cursor = before === null ? account.sequence + 1n : gil(before);
    const entries = await this.db.query<EntryRecord>(
      "SELECT * FROM ledger_entries WHERE account_id=$1 AND sequence<$2 ORDER BY sequence DESC LIMIT 10",
      [account.id, cursor],
    );
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
    await this.discord.validateRole(actor.guildId, guild.guest_role_id);
    await this.discord.validateChannel(actor.guildId, guild.guest_application_channel_id);
    const member = await this.discord.member(actor.guildId, actor.userId);
    if (!member || member.bot)
      throw new Failure("forbidden", "Only current human guild members may apply.");
    return this.db.transaction(async (client) => {
      const current = (
        await client.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1 FOR SHARE", [
          actor.guildId,
        ])
      ).rows[0];
      if (!current || current.revision !== guild.revision)
        throw new Failure("conflict", "Configuration changed. Retry your application.");
      await ensureUser(client, actor.guildId, actor.userId, member.joinedAt);
      await client.query(
        "SELECT user_id FROM guild_users WHERE guild_id=$1 AND user_id=$2 FOR UPDATE",
        [actor.guildId, actor.userId],
      );
      const pending = (
        await client.query<ApplicationRecord>(
          "SELECT * FROM guest_applications WHERE guild_id=$1 AND user_id=$2 AND state='pending'",
          [actor.guildId, actor.userId],
        )
      ).rows[0];
      if (pending && pending.joined_at.getTime() === member.joinedAt.getTime()) return pending;
      if (pending) {
        await client.query(
          "UPDATE guest_applications SET state='cancelled',decided_at=now() WHERE id=$1",
          [pending.id],
        );
        await enqueue(
          client,
          "guest.review",
          `review:${pending.id}`,
          { applicationId: pending.id },
          actor.guildId,
          actor.userId,
        );
      }
      const guest = (
        await client.query<{ eligible: boolean }>(
          "SELECT (EXISTS(SELECT 1 FROM guest_grants WHERE guild_id=$1 AND user_id=$2) OR EXISTS(SELECT 1 FROM membership_history WHERE guild_id=$1 AND user_id=$2 AND fc_id=$3)) AND NOT EXISTS(SELECT 1 FROM guest_state WHERE guild_id=$1 AND user_id=$2 AND revoked) AS eligible",
          [actor.guildId, actor.userId, guild.fc_id],
        )
      ).rows[0];
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
      const denied = await client.query(
        "SELECT id FROM guest_applications WHERE guild_id=$1 AND user_id=$2 AND state='denied' AND decided_at>now()-$3*interval '1 second'",
        [actor.guildId, actor.userId, this.config.GUEST_COOLDOWN_SECONDS],
      );
      if (denied.rowCount) throw new Failure("cooldown", "Your denial cooldown has not expired.");
      const application = (
        await client.query<ApplicationRecord>(
          "INSERT INTO guest_applications(guild_id,user_id,joined_at,channel_id) VALUES($1,$2,$3,$4) RETURNING *",
          [actor.guildId, actor.userId, member.joinedAt, guild.guest_application_channel_id],
        )
      ).rows[0];
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
    const preliminary = (
      await this.db.query<ApplicationRecord>(
        "SELECT * FROM guest_applications WHERE id=$1 AND guild_id=$2",
        [applicationId, actor.guildId],
      )
    )[0];
    if (!preliminary) throw new Failure("input", "Unknown application in this guild.");
    const member = await this.discord.member(actor.guildId, preliminary.user_id);
    return this.db.transaction(async (client) => {
      const guild = (
        await client.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1 FOR SHARE", [
          actor.guildId,
        ])
      ).rows[0];
      if (!guild) throw new Failure("setup", "Guild configuration unavailable.");
      const presence = (
        await client.query<{ present: boolean; joined_at: Date | null }>(
          "SELECT present,joined_at FROM guild_users WHERE guild_id=$1 AND user_id=$2 FOR UPDATE",
          [actor.guildId, preliminary.user_id],
        )
      ).rows[0];
      const application = (
        await client.query<ApplicationRecord>(
          "SELECT * FROM guest_applications WHERE id=$1 AND guild_id=$2 FOR UPDATE",
          [applicationId, actor.guildId],
        )
      ).rows[0];
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
      await client.query(
        "UPDATE guest_applications SET state=$2,reviewer_id=$3,decided_at=now(),reason=$4 WHERE id=$1",
        [application.id, state, actor.userId, reason],
      );
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
    const previous = (
      await client.query<{ revoked: boolean }>(
        "SELECT revoked FROM guest_state WHERE guild_id=$1 AND user_id=$2 FOR UPDATE",
        [actor.guildId, user],
      )
    ).rows[0];
    const inserted = await client.query(
      "INSERT INTO guest_grants(guild_id,user_id,provenance,source_key,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_key) DO NOTHING RETURNING id",
      [actor.guildId, user, provenance, key, actor.userId, reason],
    );
    if (!inserted.rowCount) {
      const existing = await client.query(
        "SELECT id FROM guest_grants WHERE source_key=$1 AND guild_id=$2 AND user_id=$3",
        [key, actor.guildId, user],
      );
      if (!existing.rowCount)
        throw new Failure("conflict", "Grant idempotency key belongs to a different target.");
      return;
    }
    await client.query(
      "INSERT INTO guest_state(guild_id,user_id,revoked,actor_id,reason) VALUES($1,$2,false,$3,$4) ON CONFLICT(guild_id,user_id) DO UPDATE SET revoked=false,actor_id=$3,reason=$4,changed_at=now()",
      [actor.guildId, user, actor.userId, reason],
    );
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
      await client.query(
        "SELECT user_id FROM guild_users WHERE guild_id=$1 AND user_id=$2 FOR UPDATE",
        [actor.guildId, user],
      );
      if (revoke) {
        await client.query(
          "INSERT INTO guest_state(guild_id,user_id,revoked,actor_id,reason) VALUES($1,$2,true,$3,$4) ON CONFLICT(guild_id,user_id) DO UPDATE SET revoked=true,actor_id=$3,reason=$4,changed_at=now()",
          [actor.guildId, user, actor.userId, reason],
        );
        const cancelled = await client.query<{ id: string }>(
          "UPDATE guest_applications SET state='cancelled',decided_at=now(),reviewer_id=$3,reason=$4 WHERE guild_id=$1 AND user_id=$2 AND state='pending' RETURNING id",
          [actor.guildId, user, actor.userId, reason],
        );
        for (const row of cancelled.rows)
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
      const state = (
        await client.query<{ revoked: boolean }>(
          "SELECT revoked FROM guest_state WHERE guild_id=$1 AND user_id=$2",
          [actor.guildId, user],
        )
      ).rows[0];
      return { status: state?.revoked ? "revoked" : "granted", effects: "queued" };
    });
  }
}
