/**
 * Imported-guild activation as one testable transaction (scripts/activate.ts supplies the Discord
 * checks and enumeration). Activation enables queued effects and, the first time an imported guild
 * is activated, writes exactly the reviewed grandfathering plan in the same transaction, so grants,
 * audits, the once-only marker and the effects flip commit or roll back together. Rerunning it on a
 * live guild changes nothing unless a requeue is explicitly requested (amendment C11).
 */
import { and, eq, gt, sql } from "drizzle-orm";
import {
  type GrandfatherPlan,
  grandfatherReport,
  type PlanDifference,
  planDifference,
  type ReviewedPlan,
} from "../domain/grandfathering.js";
import { guestApplicationsOpen } from "../domain/guest-application.js";
import { Failure } from "../domain/values.js";
import { audit, type Database, type Orm, orm } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import { enqueue, requeueParked } from "../jobs/queue.js";
import { applyGrandfathering, planGrandfathering } from "./grandfathering.js";
import type { GuildRecord, MemberView } from "./records.js";

export interface ActivationInput {
  guildId: string;
  /** ROSTER_INTERVAL_SECONDS: the accepted roster must be at most this old. */
  freshnessSeconds: number;
  /**
   * True once the caller validated the configured roles and channels on Discord (and enumerated
   * members when grandfathering is pending). Without it only an already-active guild succeeds,
   * which lets the CLI skip Discord login for a no-op rerun.
   */
  resourcesValidated: boolean;
  /** Complete Discord enumeration, required while grandfathering is pending. */
  members: readonly MemberView[] | null;
  enumeratedAt: Date | null;
  /** The checksum the operator confirmed from preview (--grandfather-plan). */
  grandfatherPlan?: string | undefined;
  /** The reviewed plan file (--grandfather-plan-file), for a diff when the plan has changed. */
  reviewedPlan?: ReviewedPlan | undefined;
  /**
   * The explicit guest-application choice: `open` switches applications on (a review channel must
   * be set), `closed` switches them off and keeps the channel. Without it the switch keeps its
   * state, which is off for every import, so activation never opens applications implicitly.
   */
  guestApplications?: "open" | "closed" | undefined;
  /** Re-run the activation writes on an already-active guild (--requeue). */
  requeue?: boolean | undefined;
}

/** Summary shared by both outcomes. */
interface ActivationSummary {
  guildId: string;
  revision: bigint;
  grandfathering: {
    state: "completed" | "not_applicable";
    completedAt: Date | null;
    planChecksum: string | null;
    granted: number;
  };
  guestApplications: "open" | "closed";
  onboarding: boolean;
  roleLayout: "enabled" | "disabled";
}
export type ActivationResult =
  | (ActivationSummary & { status: "activated"; requeued: boolean })
  | (ActivationSummary & { status: "already_active" });

/**
 * The current plan differs from the confirmed checksum. Activation rolled back with nothing
 * written; the report and the difference let the operator review only what changed.
 */
export class GrandfatherPlanMismatch extends Failure {
  constructor(
    readonly checksum: string,
    readonly report: ReturnType<typeof grandfatherReport>,
    readonly difference: PlanDifference | null,
  ) {
    super(
      "conflict",
      `The grandfathering plan is now ${checksum}. Review it and activate with --grandfather-plan ${checksum}.`,
    );
    this.name = "GrandfatherPlanMismatch";
  }
}

/** The activation freshness predicate: an FC's accepted roster within freshnessSeconds. */
export async function assertFreshRoster(
  db: Orm,
  guild: Pick<GuildRecord, "fc_id">,
  freshnessSeconds: number,
): Promise<void> {
  if (!guild.fc_id) return;
  const fresh = await db
    .select({ id: t.freeCompanies.id })
    .from(t.freeCompanies)
    .where(
      and(
        eq(t.freeCompanies.id, guild.fc_id),
        gt(
          t.freeCompanies.last_successful_roster_at,
          sql`now()-${freshnessSeconds}*interval '1 second'`,
        ),
      ),
    );
  if (!fresh.length)
    throw new Failure(
      "stale",
      "Acquire a fresh complete roster and review the preview before activation.",
    );
}

/** A live guild whose rerun is a no-op: active, effects on, and no grandfathering owed. */
export function alreadyActive(
  guild: Pick<GuildRecord, "active" | "effects_enabled" | "guest_grandfather">,
): boolean {
  return guild.active && guild.effects_enabled && guild.guest_grandfather !== "pending";
}

/**
 * Resolve the guest-application choice into the switch value activation writes, or undefined to
 * leave the switch alone (no choice, or the choice it already has). `open` needs a configured
 * review channel; `closed` keeps the channel. Imports store the legacy channel with the switch
 * off (2.15.0, owner decision 2026-09-24), so a channel alone no longer forces a choice.
 */
export function guestApplicationsChoice(
  guild: Pick<GuildRecord, "guest_application_channel_id" | "guest_applications_enabled">,
  choice: "open" | "closed" | undefined,
): boolean | undefined {
  if (choice === "open" && !guild.guest_application_channel_id)
    throw new Failure(
      "input",
      "No guest review channel is configured; set one later with /config guest_applications channel:.",
    );
  if (choice === undefined) return undefined;
  const enabled = choice === "open";
  return enabled === guild.guest_applications_enabled ? undefined : enabled;
}

/** Activate one guild: validate the choices, grandfather once if owed, then enable effects. */
export async function activateGuild(
  db: Database,
  input: ActivationInput,
): Promise<ActivationResult> {
  return db.transaction(async (client) => {
    const store = orm(client);
    // The row lock serializes concurrent activations of the same guild.
    const [guild] = await store
      .select()
      .from(t.guilds)
      .where(eq(t.guilds.id, input.guildId))
      .for("update");
    if (!guild) throw new Failure("input", "Unknown guild.");
    const summary = (
      row: GuildRecord,
      planChecksum: string | null,
      granted: number,
    ): ActivationSummary => ({
      guildId: row.id,
      revision: row.revision,
      grandfathering: {
        state: row.guest_grandfather === "completed" ? "completed" : "not_applicable",
        completedAt: row.guest_grandfathered_at,
        planChecksum,
        granted,
      },
      // The same rule /apply enforces: a review channel and a Guest role.
      guestApplications: guestApplicationsOpen(row) ? "open" : "closed",
      onboarding: row.access_policy_enabled,
      roleLayout: row.role_layout_enabled ? "enabled" : "disabled",
    });
    // A rerun after go-live must not bump the revision (superseding in-flight work), write another
    // audit, or revive deliberately blocked jobs.
    if (alreadyActive(guild) && !input.requeue)
      return { status: "already_active", ...summary(guild, null, 0) };
    if (!input.resourcesValidated)
      throw new Failure(
        "conflict",
        "This guild is not active yet; activation must validate its roles and channels first.",
      );

    const pending = guild.guest_grandfather === "pending";
    const applications = guestApplicationsChoice(guild, input.guestApplications);

    await assertFreshRoster(store, guild, input.freshnessSeconds);

    let plan: GrandfatherPlan | null = null;
    let granted = 0;
    if (pending) {
      if (!input.members || !input.enumeratedAt)
        throw new Failure(
          "incomplete",
          "Grandfathering is pending: a complete Discord member enumeration is required.",
        );
      if (input.reviewedPlan && input.reviewedPlan.checksum !== input.grandfatherPlan)
        throw new Failure("input", "The plan file does not match --grandfather-plan.");
      // Planned inside the transaction: evidence and freshness are re-checked under the row lock,
      // after an enumeration that can take minutes.
      plan = await planGrandfathering(
        store,
        guild,
        input.members,
        input.freshnessSeconds,
        input.enumeratedAt,
      );
      if (plan.checksum !== input.grandfatherPlan)
        throw new GrandfatherPlanMismatch(
          plan.checksum,
          grandfatherReport({ state: "pending", plan, completedAt: null }),
          input.reviewedPlan ? planDifference(input.reviewedPlan, plan) : null,
        );
      ({ granted } = await applyGrandfathering(client, plan));
    }

    const [updated] = await store
      .update(t.guilds)
      .set({
        active: true,
        effects_enabled: true,
        revision: sql`${t.guilds.revision}+1`,
        ...(applications === undefined ? {} : { guest_applications_enabled: applications }),
      })
      .where(eq(t.guilds.id, guild.id))
      .returning();
    if (!updated) throw new Error("Missing activated guild");
    if (applications !== undefined)
      // The same config audit /config writes, attributed to activation rather than an officer.
      await audit(client, guild.id, null, "config", "guest_applications_enabled", {
        value: applications,
        source: "activation",
      });
    const result = summary(updated, plan?.checksum ?? null, granted);
    await audit(client, guild.id, null, "activation", guild.id, {
      grandfathering: {
        state: result.grandfathering.state,
        planChecksum: result.grandfathering.planChecksum,
        granted,
      },
      guestApplications: result.guestApplications,
      roleLayout: result.roleLayout,
      requeue: input.requeue === true,
    });
    // Work parked while effects were off (or blocked on resources since validated) resumes, one
    // row per dedupe key: a key enqueued again while parked would otherwise collide on requeue.
    await requeueParked(client, [guild.id], ["disabled", "blocked"]);
    await enqueue(client, "reconcile.guild", `guild:${guild.id}`, {}, guild.id);
    return { status: "activated", requeued: alreadyActive(guild), ...result };
  });
}
