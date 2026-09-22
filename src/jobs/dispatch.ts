/** TaruBot's durable application jobs, distinct from dynamically loaded gateway/command adapters. */
import { escapeMarkdown } from "discord.js";
import { z } from "zod";
import { and, eq, lt, ne, sql } from "drizzle-orm";
import { orm } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import type { Service } from "../application/service.js";
import type { Synchronization } from "../application/synchronization.js";
import { Failure } from "../domain/values.js";
import { managedRoleOrder } from "../domain/role-layout.js";
import { enqueue, reconcileUser, type Job } from "./queue.js";

/** Bind application capabilities once; each invocation revalidates its persisted payload. */
export function dispatcher(
  app: Service,
  sync: Synchronization,
): (job: Job, guard: () => Promise<void>) => Promise<unknown> {
  return async (job, guard) => {
    if (job.payload_version !== 1)
      throw new Failure(
        "invalid_job",
        "Unsupported job payload version. Use a compatible application image.",
      );
    if (job.kind === "roster") return sync.roster(job, guard);
    if (job.kind === "roster.confirm") {
      // Confirmation shares the normal FC lock, deduplication key, and acquisition bounds.
      const input = z.object({ fcId: z.string() }).parse(job.payload);
      await enqueue(app.db.pool, "roster", `roster:${input.fcId}`, input);
      return { status: "queued" };
    }
    if (job.kind === "reconcile.guild") {
      if (!job.guild_id) throw new Failure("invalid_job", "Missing guild.");
      return sync.guild(job.guild_id, job.id);
    }
    if (job.kind === "reconcile.user") return sync.user(job, guard);
    if (job.kind === "profile") {
      // Shared public profiles are needed only while a trusted linked owner is actually present.
      const input = z.object({ characterId: z.string() }).parse(job.payload);
      const owners = await app.db.orm
        .select({ guild_id: t.links.guild_id, user_id: t.links.user_id })
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
            eq(t.links.character_id, input.characterId),
            eq(t.links.active, true),
            eq(t.guildUsers.present, true),
            eq(t.guilds.active, true),
          ),
        );
      let present = false;
      for (const owner of owners) {
        const member = await app.discord.member(owner.guild_id, owner.user_id);
        if (member && !member.bot) {
          present = true;
          break;
        }
        await app.db.orm
          .update(t.guildUsers)
          .set({ present: false })
          .where(
            and(eq(t.guildUsers.guild_id, owner.guild_id), eq(t.guildUsers.user_id, owner.user_id)),
          );
      }
      if (!present) return { skipped: "no present linked owner" };
      const identity = await app.lodestone.profile(input.characterId);
      await guard();
      await app.db.transaction(async (client) => {
        await app.storeCharacter(client, identity);
        const links = await orm(client)
          .select({ guild_id: t.links.guild_id, user_id: t.links.user_id })
          .from(t.links)
          .where(and(eq(t.links.character_id, input.characterId), eq(t.links.active, true)));
        for (const link of links) await reconcileUser(client, link.guild_id, link.user_id);
      });
      return { status: "updated" };
    }
    // Outbound messages use current guild configuration, not a stale channel copied into a job.
    const [guild] = await app.db.orm
      .select()
      .from(t.guilds)
      .where(
        and(job.guild_id ? eq(t.guilds.id, job.guild_id) : sql`false`, eq(t.guilds.active, true)),
      );
    if (!guild) return { skipped: "guild inactive" };
    if (!app.config.ENABLE_EFFECTS || !guild.effects_enabled)
      throw new Failure("disabled", "Discord effects are disabled pending activation.");
    if (job.kind === "roles.layout") {
      // Setup and layout share a session lock, keeping network operations outside transactions.
      const client = await app.db.pool.connect();
      let locked = false;
      try {
        locked =
          (
            await client.query<{ locked: boolean }>(
              "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
              [`setup:${guild.id}`],
            )
          ).rows[0]?.locked ?? false;
        if (!locked)
          throw new Failure("busy", "Role setup/layout is already running for this guild.");
        const [current] = await app.db.orm
          .select()
          .from(t.guilds)
          .where(and(eq(t.guilds.id, guild.id), eq(t.guilds.active, true)));
        if (!current) return { skipped: "guild inactive" };
        const currentGuard = async () => {
          await guard();
          const valid = await app.db.orm
            .select({ id: t.guilds.id })
            .from(t.guilds)
            .where(
              and(
                eq(t.guilds.id, guild.id),
                eq(t.guilds.revision, current.revision),
                eq(t.guilds.active, true),
                eq(t.guilds.effects_enabled, true),
              ),
            );
          if (!valid.length)
            throw new Failure("superseded", "Role configuration changed during layout.");
        };
        await currentGuard();
        return await app.discord.layoutRoles(guild.id, managedRoleOrder(current), currentGuard);
      } finally {
        if (locked)
          await client
            .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`setup:${guild.id}`])
            .catch(() => {});
        client.release();
      }
    }
    await guard();
    await app.db.orm.insert(t.deliveryAttempts).values({ job_id: job.id, status: "started" });
    let messageId: string | undefined;
    try {
      if (job.kind === "ledger.notify") {
        // The immutable entry is authoritative; retrying this job never changes money again.
        const { entryId } = z.object({ entryId: z.string().uuid() }).parse(job.payload);
        const [entry] = await app.db.orm
          .select()
          .from(t.ledgerEntries)
          .where(and(eq(t.ledgerEntries.id, entryId), eq(t.ledgerEntries.guild_id, guild.id)));
        if (!entry) throw new Failure("invalid_job", "Ledger entry is unavailable.");
        // Keep visible account history ordered even if later jobs are claimed concurrently.
        const earlier = await app.db.orm
          .select({ id: t.jobs.id })
          .from(t.jobs)
          .innerJoin(
            t.ledgerEntries,
            sql`${t.ledgerEntries.id}::text=${t.jobs.payload}->>'entryId'`,
          )
          .where(
            and(
              eq(t.jobs.kind, "ledger.notify"),
              eq(t.ledgerEntries.account_id, entry.account_id),
              lt(t.ledgerEntries.sequence, entry.sequence),
              ne(t.jobs.status, "succeeded"),
            ),
          )
          .limit(1);
        if (earlier.length)
          throw new Failure("ordered", "An earlier ledger notification is still pending.", 30);
        if (!guild.ledger_channel_id)
          throw new Failure("blocked", "Configure a ledger notification channel.");
        const content = `Ledger ${entry.operation} • #${entry.sequence}\nEntry: ${entry.id}\nActor: ${entry.actor_id ?? "legacy import"}\nDelta: ${entry.delta} gil • Balance: ${entry.balance} gil\nTime: ${entry.event_at.toISOString()}\n${escapeMarkdown(entry.note).slice(0, 1300)}`;
        messageId = await app.discord.send(
          guild.id,
          guild.ledger_channel_id,
          content,
          `ledger:${entry.id}`,
        );
      } else if (job.kind === "guest.review" || job.kind === "guest.dm") {
        // Review repair and best-effort DMs have independent delivery outcomes.
        const { applicationId } = z.object({ applicationId: z.string().uuid() }).parse(job.payload);
        const [application] = await app.db.orm
          .select()
          .from(t.guestApplications)
          .where(
            and(
              eq(t.guestApplications.id, applicationId),
              eq(t.guestApplications.guild_id, guild.id),
            ),
          );
        if (!application) throw new Failure("invalid_job", "Application unavailable.");
        const content = `Guest application ${application.id}\nGuild: ${guild.id}\nApplicant: ${application.user_id}\nSubmitted: ${application.created_at.toISOString()}\nOutcome: ${application.state}${application.reason ? `\nReason: ${escapeMarkdown(application.reason).slice(0, 1200)}` : ""}`;
        if (job.kind === "guest.dm") await app.discord.dm(application.user_id, content);
        else {
          messageId = await app.discord.editReview(application, content);
          await guard();
          await app.db.orm
            .update(t.guestApplications)
            .set({ message_id: messageId })
            .where(
              and(
                eq(t.guestApplications.id, application.id),
                eq(t.guestApplications.guild_id, guild.id),
              ),
            );
        }
      } else if (job.kind === "officer.notify") {
        if (!guild.officer_notifications_channel_id)
          return { skipped: "officer notifications unconfigured" };
        const { message } = z.object({ message: z.string() }).parse(job.payload);
        messageId = await app.discord.send(
          guild.id,
          guild.officer_notifications_channel_id,
          escapeMarkdown(message),
          `${job.id}:${job.generation}`,
        );
      } else throw new Failure("invalid_job", "Unknown job kind.");
      await guard();
      // An ambiguous acknowledgement can yield duplicates, all associated with the same decision.
      await app.db.orm
        .update(t.jobs)
        .set({ message_id: messageId ?? t.jobs.message_id })
        .where(and(eq(t.jobs.id, job.id), eq(t.jobs.lease_token, job.lease_token)));
      await app.db.orm
        .insert(t.deliveryAttempts)
        .values({ job_id: job.id, status: "delivered", message_id: messageId ?? null });
      return { status: "delivered", messageId: messageId ?? null };
    } catch (error) {
      // Delivery failure is operational history; the application decision remains committed.
      await app.db.orm.insert(t.deliveryAttempts).values({
        job_id: job.id,
        status: "failed",
        diagnostic: error instanceof Failure ? error.code : "delivery_failed",
      });
      throw error;
    }
  };
}
