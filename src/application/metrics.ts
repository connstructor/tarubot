/** Cheap persisted capability metrics, independent of live Discord and Lodestone requests. */
import { and, eq, exists, inArray, isNotNull, sql } from "drizzle-orm";
import type { Orm } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";

/** Aggregate before joining so empty queues and FC caches still report one metrics row. */
export async function capabilityMetrics(db: Orm) {
  const work = db
    .select({
      pending:
        sql<number>`count(*) FILTER (WHERE ${inArray(t.jobs.status, ["queued", "running"])})::int`.as(
          "pending",
        ),
      blocked:
        sql<number>`count(*) FILTER (WHERE ${inArray(t.jobs.status, ["blocked", "failed"])})::int`.as(
          "blocked",
        ),
    })
    .from(t.jobs)
    .as("work");
  const rosters = db
    .select({
      oldest_roster_age_seconds: sql<
        number | null
      >`max(extract(epoch FROM now()-${t.freeCompanies.last_successful_roster_at}))::float`.as(
        "oldest_roster_age_seconds",
      ),
      degraded_fcs:
        sql<number>`count(*) FILTER (WHERE ${isNotNull(t.freeCompanies.last_error)})::int`.as(
          "degraded_fcs",
        ),
    })
    .from(t.freeCompanies)
    .where(
      exists(
        db
          .select({ id: t.guilds.id })
          .from(t.guilds)
          .where(and(eq(t.guilds.fc_id, t.freeCompanies.id), eq(t.guilds.active, true))),
      ),
    )
    .as("rosters");
  const [metrics] = await db
    .select({
      pending: work.pending,
      blocked: work.blocked,
      oldest_roster_age_seconds: rosters.oldest_roster_age_seconds,
      degraded_fcs: rosters.degraded_fcs,
    })
    .from(work)
    .crossJoin(rosters);
  if (!metrics) throw new Error("Missing capability aggregates");
  return metrics;
}
