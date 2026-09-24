/**
 * Read-only cutover CLI: compare current complete Discord membership to accepted policy evidence.
 *
 *   bun dist/scripts/preview.js GUILD_ID [--output PLAN.json]
 *   bun dist/scripts/preview.js GUILD_ID --late-joiners
 *
 * The preview reports every human's role and nickname delta, the first-activation grandfathering
 * plan (counts, samples and the planChecksum that activate --grandfather-plan confirms), users
 * whose departure awaits a confirming roster, the guest-application, onboarding and role-layout
 * switches, and what a layout pass would do if enabled. --output writes the full plan for
 * activate --grandfather-plan-file. --late-joiners is a database-only report for after go-live:
 * humans who joined after activation's enumeration and hold no grant or link (amendment C9).
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Events } from "discord.js";
import { assertFreshRoster } from "../src/application/activation.js";
import {
  lateJoiners,
  pendingDepartureFailure,
  pendingDepartures,
  planGrandfathering,
} from "../src/application/grandfathering.js";
import { Service } from "../src/application/service.js";
import { Synchronization } from "../src/application/synchronization.js";
import {
  assertAuthenticatedApplication,
  assertToolScope,
  type ToolScope,
} from "../src/config/deployment.js";
import { configuration } from "../src/config/env.js";
import { DiscordGateway } from "../src/discord/gateway.js";
import {
  type GrandfatherPlan,
  grandfatherReport,
  overlayPlannedGrant,
} from "../src/domain/grandfathering.js";
import { classifyFailure } from "../src/domain/failures.js";
import { guestApplicationsOpen } from "../src/domain/guest-application.js";
import { managedRoleOrder } from "../src/domain/role-layout.js";
import { Failure, id, json } from "../src/domain/values.js";
import { Database } from "../src/infrastructure/postgres/database.js";
import { Nodestone } from "../src/infrastructure/nodestone/client.js";
import { eq } from "drizzle-orm";
import * as t from "../src/infrastructure/postgres/schema.js";

/** Parsed command line; --output and --late-joiners are mutually exclusive. */
export interface PreviewArguments {
  guildId: string;
  output?: string;
  lateJoiners: boolean;
}

/** Parse `GUILD_ID [--output PLAN.json | --late-joiners]`. */
export function parsePreviewArguments(argv: readonly string[]): PreviewArguments {
  let guildId: string | undefined;
  let output: string | undefined;
  let late = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--late-joiners" && !late) late = true;
    else if (argument === "--output" && output === undefined) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Failure("input", "--output needs a file path.");
      output = value;
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
  if (late && output !== undefined)
    throw new Failure("input", "--late-joiners writes no plan; drop --output.");
  return { guildId, lateJoiners: late, ...(output === undefined ? {} : { output }) };
}

/**
 * The deployment guard's view of a preview: the guild and DATABASE_URL, with a Discord read unless
 * --late-joiners (which reads only PostgreSQL). Exported so tests check exactly what preview.js
 * declares.
 */
export function previewToolScope(args: PreviewArguments): ToolScope {
  return {
    tool: "preview",
    guilds: [args.guildId],
    discord: args.lateJoiners ? "none" : "read",
    databases: ["DATABASE_URL"],
  };
}

/**
 * Add/remove counts per role across the previewed actions, labelled with the managed binding each
 * role has (or `retired`), so Member removals and Guest additions are visible at a glance.
 */
export function roleTotals(
  actions: readonly unknown[],
  bindings: Record<"member" | "guest" | "officer" | "leader", string | null>,
): Record<string, { binding: string; add: number; remove: number }> {
  const names = new Map(
    Object.entries(bindings).flatMap(([name, role]) => (role ? [[role, name] as const] : [])),
  );
  const totals: Record<string, { binding: string; add: number; remove: number }> = {};
  const count = (role: string, key: "add" | "remove") => {
    const entry = totals[role] ?? { binding: names.get(role) ?? "retired", add: 0, remove: 0 };
    entry[key]++;
    totals[role] = entry;
  };
  for (const action of actions) {
    if (typeof action !== "object" || action === null) continue;
    const { add, remove } = action as { add?: unknown; remove?: unknown };
    if (Array.isArray(add))
      for (const role of add) if (typeof role === "string") count(role, "add");
    if (Array.isArray(remove))
      for (const role of remove) if (typeof role === "string") count(role, "remove");
  }
  return totals;
}

if (import.meta.main) {
  const args = parsePreviewArguments(process.argv.slice(2));
  const guild = args.guildId;
  // The guild and database must belong to this env's deployment profile before any I/O. The
  // late-joiner report reads only PostgreSQL.
  const deployment = assertToolScope(process.env, previewToolScope(args));
  const config = configuration();
  const db = new Database(config.DATABASE_URL);
  const gateway = new DiscordGateway();
  try {
    await db.schema();
    if (args.lateJoiners) {
      console.log(json(await lateJoiners(db.orm, guild), 2));
    } else {
      const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, guild));
      if (!row) throw new Failure("input", "Unknown guild.");
      // The same predicate as activation: a linked FC needs an accepted roster within
      // ROSTER_INTERVAL_SECONDS (acquire.js GUILD_ID); a guild with no FC has no roster evidence to
      // wait for, so it still gets its role delta, grandfathering plan and checksum.
      await assertFreshRoster(db.orm, row, config.ROSTER_INTERVAL_SECONDS);
      await gateway.client.login(config.DISCORD_TOKEN);
      // Connection readiness is the only subscription needed by this isolated read-only tool.
      if (!gateway.client.isReady())
        await new Promise<void>((resolve) =>
          gateway.client.once(Events.ClientReady, () => resolve()),
        );
      // The token must belong to the profile's application before any member is read.
      assertAuthenticatedApplication(deployment, gateway.client.application?.id);
      const sync = new Synchronization(
        new Service(db, gateway, new Nodestone(config.NODESTONE_URL), config),
      );
      const actions = [];
      // The grandfathering plan classifies exactly this enumeration.
      const enumeratedAt = new Date();
      const members = await gateway.members(guild);
      for (const member of members) {
        // Preview mode uses a transient job-shaped context and never publishes it to the queue.
        if (member.bot) continue;
        actions.push(
          await sync.user(
            {
              id: randomUUID(),
              kind: "reconcile.user",
              guild_id: guild,
              user_id: member.id,
              payload: {},
              payload_version: 1,
              generation: 1,
              attempts: 0,
              lease_token: randomUUID(),
              message_id: null,
              // Timing fields only feed queue logs; a transient preview job is created and due now.
              created_at: new Date(),
              due_at: new Date(),
            },
            async () => {},
            true,
          ),
        );
      }
      // Departures awaiting confirmation block the plan until a confirming acquisition (C2).
      const departures = await pendingDepartures(db.orm, row);
      let plan: GrandfatherPlan | null = null;
      let blocked: string | null = null;
      if (row.guest_grandfather === "pending") {
        if (departures.count) blocked = pendingDepartureFailure(departures).message;
        else
          try {
            plan = await planGrandfathering(
              db.orm,
              row,
              members,
              config.ROSTER_INTERVAL_SECONDS,
              enumeratedAt,
            );
          } catch (error) {
            // Stale evidence is reported, not fatal: the rest of the preview is still useful.
            if (!(error instanceof Failure && error.code === "stale")) throw error;
            blocked = error.message;
          }
      }
      const grandfathering = grandfatherReport({
        state: row.guest_grandfather ?? "not_applicable",
        plan,
        completedAt: row.guest_grandfathered_at,
        pendingDepartures: departures,
        blocked,
      });
      const reviewed = plan;
      const overlaid = reviewed
        ? actions.map((action) => overlayPlannedGrant(action, reviewed))
        : actions;
      // What a layout pass would do now, whether or not this guild's switch is on.
      let ifEnabled: unknown;
      try {
        ifEnabled = await gateway.planRoleLayout(guild, managedRoleOrder(row));
      } catch (error) {
        // An approved Failure explains itself; any other error is named by catalog code and class
        // only, because raw SDK or transport text may carry request details.
        const { code, failure, source } = classifyFailure(error);
        ifEnabled = { blocked: failure?.message ?? `${code} (${source})` };
      }
      console.log(
        json({
          guildId: guild,
          previewedAt: new Date().toISOString(),
          enumeratedAt: enumeratedAt.toISOString(),
          enumerationComplete: true,
          // The same rule /apply enforces: a review channel and a Guest role.
          guestApplications: guestApplicationsOpen(row) ? "open" : "closed",
          onboarding: row.access_policy_enabled,
          roleLayout: {
            enabled: row.role_layout_enabled,
            // Activation's reconcile.guild attaches a layout pass only while the switch is on.
            wouldRun: row.role_layout_enabled,
            skipped: row.role_layout_enabled ? null : "layout disabled",
            ifEnabled,
          },
          pendingDepartures: departures,
          grandfathering,
          roleTotals: roleTotals(overlaid, {
            member: row.member_role_id,
            guest: row.guest_role_id,
            officer: row.officer_role_id,
            leader: row.leader_role_id,
          }),
          actions: overlaid,
        }),
      );
      if (plan) {
        if (args.output !== undefined) {
          await mkdir(dirname(args.output), { recursive: true });
          await Bun.write(args.output, json(plan, 2));
        }
        // stderr keeps stdout a single JSON document.
        console.error(
          `Grandfathering plan ${plan.checksum}: ${plan.grants.length} planned grants; activate with --grandfather-plan ${plan.checksum}${args.output === undefined ? "" : ` --grandfather-plan-file ${args.output}`}.`,
        );
      } else if (args.output !== undefined) {
        console.error(
          `No grandfathering plan written (${grandfathering.state}${blocked ? `: ${blocked}` : ""}).`,
        );
        process.exitCode = 1;
      }
    }
  } finally {
    gateway.client.destroy();
    await db.close();
  }
}
