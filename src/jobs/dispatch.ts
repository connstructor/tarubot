/** TaruBot's durable application jobs, distinct from dynamically loaded gateway/command adapters. */
import { escapeMarkdown } from "discord.js";
import { z } from "zod";
import type { ApplicationRecord, EntryRecord, GuildRecord } from "../application/records.js";
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
      const owners = await app.db.query<{ guild_id: string; user_id: string }>(
        "SELECT l.guild_id,l.user_id FROM links l JOIN guild_users u ON u.guild_id=l.guild_id AND u.user_id=l.user_id JOIN guilds g ON g.id=l.guild_id WHERE l.character_id=$1 AND l.active AND u.present AND g.active",
        [input.characterId],
      );
      let present = false;
      for (const owner of owners) {
        const member = await app.discord.member(owner.guild_id, owner.user_id);
        if (member && !member.bot) {
          present = true;
          break;
        }
        await app.db.query(
          "UPDATE guild_users SET present=false WHERE guild_id=$1 AND user_id=$2",
          [owner.guild_id, owner.user_id],
        );
      }
      if (!present) return { skipped: "no present linked owner" };
      const identity = await app.lodestone.profile(input.characterId);
      await guard();
      await app.db.transaction(async (client) => {
        await app.storeCharacter(client, identity);
        const links = (
          await client.query<{ guild_id: string; user_id: string }>(
            "SELECT guild_id,user_id FROM links WHERE character_id=$1 AND active",
            [input.characterId],
          )
        ).rows;
        for (const link of links) await reconcileUser(client, link.guild_id, link.user_id);
      });
      return { status: "updated" };
    }
    const guild =
      // Outbound messages use current guild configuration, not a stale channel copied into a job.
      (
        await app.db.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1 AND active", [
          job.guild_id,
        ])
      )[0];
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
        const current = (
          await app.db.query<GuildRecord>("SELECT * FROM guilds WHERE id=$1 AND active", [guild.id])
        )[0];
        if (!current) return { skipped: "guild inactive" };
        const currentGuard = async () => {
          await guard();
          const valid = await app.db.query(
            "SELECT id FROM guilds WHERE id=$1 AND revision=$2 AND active AND effects_enabled",
            [guild.id, current.revision],
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
    await app.db.query("INSERT INTO delivery_attempts(job_id,status) VALUES($1,'started')", [
      job.id,
    ]);
    let messageId: string | undefined;
    try {
      if (job.kind === "ledger.notify") {
        // The immutable entry is authoritative; retrying this job never changes money again.
        const { entryId } = z.object({ entryId: z.string().uuid() }).parse(job.payload);
        const entry = (
          await app.db.query<EntryRecord>(
            "SELECT * FROM ledger_entries WHERE id=$1 AND guild_id=$2",
            [entryId, guild.id],
          )
        )[0];
        if (!entry) throw new Failure("invalid_job", "Ledger entry is unavailable.");
        const earlier = await app.db.query(
          // Keep visible account history ordered even if later jobs are claimed concurrently.
          "SELECT j.id FROM jobs j JOIN ledger_entries e ON e.id::text=j.payload->>'entryId' WHERE j.kind='ledger.notify' AND e.account_id=$1 AND e.sequence<$2 AND j.status<>'succeeded' LIMIT 1",
          [entry.account_id, entry.sequence],
        );
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
        const application = (
          await app.db.query<ApplicationRecord>(
            "SELECT * FROM guest_applications WHERE id=$1 AND guild_id=$2",
            [applicationId, guild.id],
          )
        )[0];
        if (!application) throw new Failure("invalid_job", "Application unavailable.");
        const content = `Guest application ${application.id}\nGuild: ${guild.id}\nApplicant: ${application.user_id}\nSubmitted: ${application.created_at.toISOString()}\nOutcome: ${application.state}${application.reason ? `\nReason: ${escapeMarkdown(application.reason).slice(0, 1200)}` : ""}`;
        if (job.kind === "guest.dm") await app.discord.dm(application.user_id, content);
        else {
          messageId = await app.discord.editReview(application, content);
          await guard();
          await app.db.query(
            "UPDATE guest_applications SET message_id=$2 WHERE id=$1 AND guild_id=$3",
            [application.id, messageId, guild.id],
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
      await app.db.query(
        "UPDATE jobs SET message_id=COALESCE($3,message_id) WHERE id=$1 AND lease_token=$2",
        [job.id, job.lease_token, messageId ?? null],
      );
      await app.db.query(
        "INSERT INTO delivery_attempts(job_id,status,message_id) VALUES($1,'delivered',$2)",
        [job.id, messageId ?? null],
      );
      return { status: "delivered", messageId: messageId ?? null };
    } catch (error) {
      // Delivery failure is operational history; the application decision remains committed.
      await app.db.query(
        "INSERT INTO delivery_attempts(job_id,status,diagnostic) VALUES($1,'failed',$2)",
        [job.id, error instanceof Failure ? error.code : "delivery_failed"],
      );
      throw error;
    }
  };
}
