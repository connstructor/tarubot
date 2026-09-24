/**
 * Maintenance CLI: validate an imported guild, grandfather it once, and atomically enable effects.
 *
 *   bun dist/scripts/activate.js GUILD_ID [--grandfather-plan SHA [--grandfather-plan-file PLAN.json]]
 *     [--guest-applications closed|open] [--requeue]
 *
 * The first activation of an imported guild writes exactly the grandfathering plan preview
 * reported: pass its checksum with --grandfather-plan, and the plan file from preview --output to
 * see only the added and removed users if the plan has changed since. A 2.12.x import that still
 * has a review channel needs an explicit --guest-applications choice. Rerunning on a live guild
 * changes nothing and skips Discord login unless --requeue is given.
 */
import { Events } from "discord.js";
import {
  activateGuild,
  alreadyActive,
  assertFreshRoster,
  guestApplicationsChoice,
  GrandfatherPlanMismatch,
} from "../src/application/activation.js";
import { pendingDepartureFailure, pendingDepartures } from "../src/application/grandfathering.js";
import {
  assertAuthenticatedApplication,
  assertToolScope,
  type ToolScope,
} from "../src/config/deployment.js";
import { configuration } from "../src/config/env.js";
import { DiscordGateway } from "../src/discord/gateway.js";
import { type ReviewedPlan, reviewedPlan, subset } from "../src/domain/grandfathering.js";
import { Failure, id, json } from "../src/domain/values.js";
import { Database } from "../src/infrastructure/postgres/database.js";
import { eq } from "drizzle-orm";
import * as t from "../src/infrastructure/postgres/schema.js";

/** Parsed command line; unknown or repeated flags are refused rather than ignored. */
export interface ActivateArguments {
  guildId: string;
  grandfatherPlan?: string;
  planFile?: string;
  guestApplications?: "open" | "closed";
  requeue: boolean;
}

/** Parse `GUILD_ID [flags]`. A plan file needs the checksum it was reviewed under. */
export function parseActivateArguments(argv: readonly string[]): ActivateArguments {
  let guildId: string | undefined;
  const values = new Map<string, string>();
  let requeue = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--requeue" && !requeue) requeue = true;
    else if (
      ["--grandfather-plan", "--grandfather-plan-file", "--guest-applications"].includes(argument)
    ) {
      const value = argv[index + 1];
      if (values.has(argument) || value === undefined || value.startsWith("--"))
        throw new Failure("input", `${argument} needs exactly one value.`);
      values.set(argument, value);
      index += 1;
    } else if (!argument.startsWith("--") && guildId === undefined) {
      try {
        guildId = id(argument);
      } catch {
        throw new Failure("input", "The first argument must be a Discord guild ID.");
      }
    } else throw new Failure("input", `Unexpected argument ${argument}.`);
  }
  if (guildId === undefined) throw new Failure("input", "A guild ID is required.");
  const plan = values.get("--grandfather-plan");
  if (plan !== undefined && !/^[0-9a-f]{64}$/.test(plan))
    throw new Failure("input", "--grandfather-plan takes the 64-character planChecksum.");
  const planFile = values.get("--grandfather-plan-file");
  if (planFile !== undefined && plan === undefined)
    throw new Failure("input", "--grandfather-plan-file needs the --grandfather-plan it matches.");
  const guestApplications = values.get("--guest-applications");
  if (
    guestApplications !== undefined &&
    guestApplications !== "open" &&
    guestApplications !== "closed"
  )
    throw new Failure("input", "--guest-applications takes closed or open.");
  return {
    guildId,
    requeue,
    ...(plan === undefined ? {} : { grandfatherPlan: plan }),
    ...(planFile === undefined ? {} : { planFile }),
    ...(guestApplications === undefined ? {} : { guestApplications }),
  };
}

/**
 * The deployment guard's view of an activation: the guild and DATABASE_URL. Discord is only read
 * (validation and enumeration); every write goes to PostgreSQL. Exported so tests check exactly
 * what activate.js declares.
 */
export function activateToolScope(args: ActivateArguments): ToolScope {
  return {
    tool: "activate",
    guilds: [args.guildId],
    discord: "read",
    databases: ["DATABASE_URL"],
  };
}

if (import.meta.main) {
  const args = parseActivateArguments(process.argv.slice(2));
  // The guild and database must belong to this env's deployment profile before any I/O.
  const deployment = assertToolScope(process.env, activateToolScope(args));
  const config = configuration();
  let reviewed: ReviewedPlan | undefined;
  if (args.planFile !== undefined && args.grandfatherPlan !== undefined) {
    reviewed = reviewedPlan(JSON.parse(await Bun.file(args.planFile).text()), args.grandfatherPlan);
    if (reviewed.guildId !== args.guildId)
      throw new Failure("input", `The plan file is for guild ${reviewed.guildId}.`);
  }
  const db = new Database(config.DATABASE_URL);
  const gateway = new DiscordGateway();
  try {
    await db.schema();
    const [guild] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, args.guildId));
    if (!guild) throw new Failure("input", "Unknown guild.");
    const input = {
      guildId: args.guildId,
      freshnessSeconds: config.ROSTER_INTERVAL_SECONDS,
      grandfatherPlan: args.grandfatherPlan,
      reviewedPlan: reviewed,
      guestApplications: args.guestApplications,
      requeue: args.requeue,
    };
    if (alreadyActive(guild) && !args.requeue) {
      // A no-op rerun needs no Discord session; activateGuild confirms it under the row lock.
      console.log(
        json(
          {
            ...(await activateGuild(db, {
              ...input,
              resourcesValidated: false,
              members: null,
              enumeratedAt: null,
            })),
            next: "Nothing changed. Pass --requeue to requeue disabled or blocked work and queue a full reconciliation.",
          },
          2,
        ),
      );
    } else {
      // Fail fast, before login and a long enumeration; activateGuild repeats these checks.
      guestApplicationsChoice(guild, args.guestApplications);
      await assertFreshRoster(db.orm, guild, config.ROSTER_INTERVAL_SECONDS);
      const pending = guild.guest_grandfather === "pending";
      if (pending) {
        const departures = await pendingDepartures(db.orm, guild);
        if (departures.count) throw pendingDepartureFailure(departures);
      }
      await gateway.client.login(config.DISCORD_TOKEN);
      // This one-shot client awaits readiness without installing the live bot's feature events.
      if (!gateway.client.isReady())
        await new Promise<void>((resolve) =>
          gateway.client.once(Events.ClientReady, () => resolve()),
        );
      // The token must belong to the profile's application before any guild is read.
      assertAuthenticatedApplication(deployment, gateway.client.application?.id);
      for (const role of [
        guild.member_role_id,
        guild.guest_role_id,
        guild.officer_role_id,
        guild.leader_role_id,
      ])
        if (role) await gateway.validateRole(args.guildId, role);
      // Only a review channel that will take applications after activation is validated; a legacy
      // channel imported with the switch off may no longer exist.
      const opens =
        args.guestApplications === "open" ||
        (args.guestApplications === undefined && guild.guest_applications_enabled);
      const reviewChannel = opens ? guild.guest_application_channel_id : null;
      for (const channel of [
        guild.ledger_channel_id,
        guild.officer_notifications_channel_id,
        reviewChannel,
      ])
        if (channel) await gateway.validateChannel(args.guildId, channel);
      // Grandfathering needs one complete, count-checked enumeration taken outside the transaction.
      const enumeratedAt = pending ? new Date() : null;
      const members = pending ? await gateway.members(args.guildId) : null;
      try {
        const result = await activateGuild(db, {
          ...input,
          resourcesValidated: true,
          members,
          enumeratedAt,
        });
        // Humans who joined between the enumeration and the commit missed grandfathering; list
        // them for an officer decision. Best effort: activation has already committed.
        let lateJoiners: unknown = null;
        if (members) {
          try {
            const seen = new Set(members.map((member) => member.id));
            lateJoiners = subset(
              (await gateway.members(args.guildId))
                .filter((member) => !member.bot && !seen.has(member.id))
                .map((member) => member.id),
            );
          } catch (error) {
            lateJoiners = {
              unavailable: error instanceof Failure ? error.message : "enumeration failed",
            };
          }
        }
        console.log(
          json(
            {
              ...result,
              lateJoiners,
              next: "Guild activated. Run the sole bot writer with ENABLE_EFFECTS=true; after it is ready, list later joiners with preview.js GUILD_ID --late-joiners.",
            },
            2,
          ),
        );
      } catch (error) {
        if (!(error instanceof GrandfatherPlanMismatch)) throw error;
        // Nothing was written. Show what changed so only the difference needs review.
        console.log(
          json(
            {
              status: "plan_mismatch",
              confirmed: args.grandfatherPlan ?? null,
              planChecksum: error.checksum,
              difference: error.difference,
              grandfathering: error.report,
              next: error.message,
            },
            2,
          ),
        );
        process.exitCode = 1;
      }
    }
  } finally {
    gateway.client.destroy();
    await db.close();
  }
}
