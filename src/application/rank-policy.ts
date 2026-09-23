/** Derive extra roles only from trusted links and accepted FC roster rank observations. */
import type { Database } from "../infrastructure/postgres/database.js";
import type { GuildRecord } from "./records.js";
import { and, eq, exists, gt, sql } from "drizzle-orm";
import * as t from "../infrastructure/postgres/schema.js";

export type RankState = "yes" | "no" | "unknown";

/** One active trusted link's accepted evidence for the guild's currently linked FC. */
export interface RankEvidence {
  /** Membership for the linked FC; null means the link has not been evaluated against a roster. */
  state: "present" | "missing" | "absent" | null;
  /** Normalized FC rank from the roster that last confirmed the character. */
  fc_rank_key: string | null;
  is_fc_leader: boolean | null;
  /** False only for an officer_assignment made by a bot-only officer (service.ts assign()). */
  officer_authority: boolean;
}

/**
 * Officer and FC Leader are unions over a user's linked characters (ROLE-07): any character with
 * confirmed membership (present, or awaiting departure confirmation) that holds the leader flag or
 * the configured officer rank qualifies. Unevaluated links or missing rank data yield "unknown"
 * unless a local unlink already removed the last confirmed character; manager overrides are
 * applied by the caller, not here.
 */
export function rankUnion(
  rows: readonly RankEvidence[],
  context: { fcLinked: boolean; officerRankKey: string | null; localLoss: boolean },
): { officer: RankState; leader: RankState } {
  const eligible = rows.filter((row) => row.state === "present" || row.state === "missing");
  const unresolved = !context.localLoss && rows.some((row) => row.state === null);
  let officer: RankState = "no";
  let leader: RankState = "no";
  if (context.fcLinked) {
    if (eligible.some((row) => row.is_fc_leader === true)) leader = "yes";
    else if (unresolved || eligible.some((row) => row.is_fc_leader === null)) leader = "unknown";
    if (context.officerRankKey) {
      if (
        eligible.some((row) => row.officer_authority && row.fc_rank_key === context.officerRankKey)
      )
        officer = "yes";
      else if (
        unresolved ||
        eligible.some((row) => row.officer_authority && row.fc_rank_key === null)
      )
        officer = "unknown";
    }
  }
  return { officer, leader };
}

export interface RankAccess {
  officer: RankState;
  leader: RankState;
  manualOfficer: boolean;
  revoked: boolean;
  fresh: boolean;
}

/** Missing rank evidence preserves old projections; it never manufactures a new privilege. */
export async function rankAccess(
  db: Database,
  guild: GuildRecord,
  user: string,
  freshnessSeconds: number,
): Promise<RankAccess> {
  const [override] = await db.orm
    .select({ state: t.officerOverrides.state })
    .from(t.officerOverrides)
    .where(and(eq(t.officerOverrides.guild_id, guild.id), eq(t.officerOverrides.user_id, user)));
  const rows = await db.orm
    .select({
      state: t.membership.state,
      fc_rank_key: t.rosterMembers.fc_rank_key,
      is_fc_leader: t.rosterMembers.is_fc_leader,
      officer_authority: sql<boolean>`(${t.links.provenance}<>'officer_assignment' OR COALESCE((${t.links.source}->>'officerAuthority')::boolean,true))`,
    })
    .from(t.links)
    .leftJoin(
      t.membership,
      and(
        eq(t.membership.guild_id, t.links.guild_id),
        eq(t.membership.character_id, t.links.character_id),
        guild.fc_id ? eq(t.membership.fc_id, guild.fc_id) : sql`false`,
      ),
    )
    .leftJoin(
      t.rosterMembers,
      and(
        eq(t.rosterMembers.snapshot_id, t.membership.confirmed_snapshot_id),
        eq(t.rosterMembers.character_id, t.links.character_id),
      ),
    )
    .where(
      and(eq(t.links.guild_id, guild.id), eq(t.links.user_id, user), eq(t.links.active, true)),
    );
  const fresh = guild.fc_id
    ? exists(
        db.orm
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
          ),
      )
    : sql<boolean>`false`;
  const localLoss = exists(
    db.orm
      .select({ user_id: t.guildUsers.user_id })
      .from(t.guildUsers)
      .where(
        and(
          eq(t.guildUsers.guild_id, guild.id),
          eq(t.guildUsers.user_id, user),
          eq(t.guildUsers.local_member_loss, true),
        ),
      ),
  );
  const [facts] = await db.orm
    .select({ fresh: sql<boolean>`${fresh}`, local_loss: sql<boolean>`${localLoss}` })
    .from(t.guilds)
    .where(eq(t.guilds.id, guild.id));
  let { officer, leader } = rankUnion(rows, {
    fcLinked: Boolean(guild.fc_id),
    officerRankKey: guild.officer_rank_key,
    localLoss: facts?.local_loss ?? false,
  });
  // Explicit manager grants and revocations override the automatic officer union.
  if (override?.state === "granted") officer = "yes";
  if (override?.state === "revoked") officer = "no";
  return {
    officer,
    leader,
    manualOfficer: override?.state === "granted",
    revoked: override?.state === "revoked",
    fresh: facts?.fresh ?? false,
  };
}

/** Fresh evidence gates new automatic roles; explicit local grants do not depend on Lodestone. */
export function desiredRankRole(
  state: RankState,
  held: boolean,
  fresh: boolean,
  manual = false,
): boolean {
  return state === "unknown" ? held : state === "yes" && (manual || fresh || held);
}
