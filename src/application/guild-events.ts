/** Persist Discord observations and schedule work; gateway modules remain thin adapters. */
import { ensureUser, type Database } from "../infrastructure/postgres/database.js";
import { enqueue, layoutGuildRoles, reconcileUser } from "../jobs/queue.js";

/** Application operations shared by independently loaded guild/member/role listeners. */
export class GuildEvents {
  constructor(private readonly db: Database) {}

  /** A rejoin updates presence/context while retaining ownership, grants, and ledger identity. */
  async memberJoined(guildId: string, userId: string, joinedAt: Date): Promise<void> {
    await this.db.transaction(async (client) => {
      const configured = await client.query("SELECT id FROM guilds WHERE id=$1", [guildId]);
      if (!configured.rowCount) return;
      await ensureUser(client, guildId, userId, joinedAt);
      await reconcileUser(client, guildId, userId);
    });
  }

  /** Pending reviews belong to one join context; durable grants/history survive departure. */
  async memberLeft(guildId: string, userId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query("UPDATE guild_users SET present=false WHERE guild_id=$1 AND user_id=$2", [
        guildId,
        userId,
      ]);
      const cancelled = (
        await client.query<{ id: string }>(
          "UPDATE guest_applications SET state='cancelled',decided_at=now() WHERE guild_id=$1 AND user_id=$2 AND state='pending' RETURNING id",
          [guildId, userId],
        )
      ).rows;
      for (const row of cancelled)
        await enqueue(
          client,
          "guest.review",
          `review:${row.id}`,
          { applicationId: row.id },
          guildId,
          userId,
        );
    });
  }

  /** Coalesce drift, including the bot's own events; reconciliation observes fresh state. */
  async memberChanged(guildId: string, userId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const configured = await client.query("SELECT id FROM guilds WHERE id=$1", [guildId]);
      if (configured.rowCount) await reconcileUser(client, guildId, userId);
    });
  }

  /** Removing the bot disables work without deleting any guild-owned application records. */
  async guildLeft(guildId: string): Promise<void> {
    await this.db.query("UPDATE guilds SET active=false WHERE id=$1", [guildId]);
  }

  /** Reinstallation resumes a configured guild; initial configuration stays officer-owned. */
  async guildJoined(guildId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const configured = await client.query(
        "UPDATE guilds SET active=true WHERE id=$1 RETURNING id",
        [guildId],
      );
      if (configured.rowCount) {
        await enqueue(client, "reconcile.guild", `guild:${guildId}`, {}, guildId);
        await layoutGuildRoles(client, guildId);
      }
    });
  }

  /** Role changes can unblock hierarchy checks or require cleanup of managed-role drift. */
  async roleChanged(guildId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const configured = await client.query("SELECT id FROM guilds WHERE id=$1", [guildId]);
      if (configured.rowCount) {
        await enqueue(client, "reconcile.guild", `guild:${guildId}`, {}, guildId);
        await layoutGuildRoles(client, guildId);
      }
    });
  }
}
