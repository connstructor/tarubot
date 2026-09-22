/** Persist Discord observations and schedule work; gateway modules remain thin adapters. */
import { ensureUser, orm, type Database } from "../infrastructure/postgres/database.js";
import { and, eq, sql } from "drizzle-orm";
import * as t from "../infrastructure/postgres/schema.js";
import { enqueue, layoutGuildRoles, reconcileUser } from "../jobs/queue.js";

/** Application operations shared by independently loaded guild/member/role listeners. */
export class GuildEvents {
  constructor(private readonly db: Database) {}

  /** A rejoin updates presence/context while retaining ownership, grants, and ledger identity. */
  async memberJoined(guildId: string, userId: string, joinedAt: Date): Promise<void> {
    await this.db.transaction(async (client) => {
      const configured = await orm(client)
        .select({ id: t.guilds.id })
        .from(t.guilds)
        .where(eq(t.guilds.id, guildId));
      if (!configured.length) return;
      await ensureUser(client, guildId, userId, joinedAt);
      await reconcileUser(client, guildId, userId);
    });
  }

  /** Pending reviews belong to one join context; durable grants/history survive departure. */
  async memberLeft(guildId: string, userId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const db = orm(client);
      await db
        .update(t.guildUsers)
        .set({ present: false })
        .where(and(eq(t.guildUsers.guild_id, guildId), eq(t.guildUsers.user_id, userId)));
      const cancelled = await db
        .update(t.guestApplications)
        .set({ state: "cancelled", decided_at: sql`now()` })
        .where(
          and(
            eq(t.guestApplications.guild_id, guildId),
            eq(t.guestApplications.user_id, userId),
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
          guildId,
          userId,
        );
    });
  }

  /** Coalesce drift, including the bot's own events; reconciliation observes fresh state. */
  async memberChanged(guildId: string, userId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const configured = await orm(client)
        .select({ id: t.guilds.id })
        .from(t.guilds)
        .where(eq(t.guilds.id, guildId));
      if (configured.length) await reconcileUser(client, guildId, userId);
    });
  }

  /** Removing the bot disables work without deleting any guild-owned application records. */
  async guildLeft(guildId: string): Promise<void> {
    await this.db.orm.update(t.guilds).set({ active: false }).where(eq(t.guilds.id, guildId));
  }

  /** Reinstallation resumes a configured guild; initial configuration stays officer-owned. */
  async guildJoined(guildId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const configured = await orm(client)
        .update(t.guilds)
        .set({ active: true })
        .where(eq(t.guilds.id, guildId))
        .returning({ id: t.guilds.id });
      if (configured.length) {
        await enqueue(client, "reconcile.guild", `guild:${guildId}`, {}, guildId);
        await layoutGuildRoles(client, guildId);
      }
    });
  }

  /** Role changes can unblock hierarchy checks or require cleanup of managed-role drift. */
  async roleChanged(guildId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const configured = await orm(client)
        .select({ id: t.guilds.id })
        .from(t.guilds)
        .where(eq(t.guilds.id, guildId));
      if (configured.length) {
        await enqueue(client, "reconcile.guild", `guild:${guildId}`, {}, guildId);
        await layoutGuildRoles(client, guildId);
      }
    });
  }
}
