/** Derive extra roles only from trusted links and accepted FC roster rank observations. */
import type { Database } from "../infrastructure/postgres/database.js";
import type { GuildRecord } from "./records.js";

export type RankState = "yes" | "no" | "unknown";
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
  const override = (
    await db.query<{ state: string }>(
      "SELECT state FROM officer_overrides WHERE guild_id=$1 AND user_id=$2",
      [guild.id, user],
    )
  )[0];
  const rows = await db.query<{
    state: string | null;
    fc_rank_key: string | null;
    is_fc_leader: boolean | null;
    officer_authority: boolean;
  }>(
    `SELECT m.state,r.fc_rank_key,r.is_fc_leader,
      (l.provenance<>'officer_assignment' OR COALESCE((l.source->>'officerAuthority')::boolean,true)) AS officer_authority
      FROM links l LEFT JOIN membership m ON m.guild_id=l.guild_id AND m.character_id=l.character_id AND m.fc_id=$3
      LEFT JOIN roster_members r ON r.snapshot_id=m.confirmed_snapshot_id AND r.character_id=l.character_id
      WHERE l.guild_id=$1 AND l.user_id=$2 AND l.active`,
    [guild.id, user, guild.fc_id],
  );
  const facts = (
    await db.query<{ fresh: boolean; local_loss: boolean }>(
      `SELECT
    EXISTS(SELECT 1 FROM free_companies WHERE id=$3 AND last_successful_roster_at>now()-$4*interval '1 second') AS fresh,
    EXISTS(SELECT 1 FROM guild_users WHERE guild_id=$1 AND user_id=$2 AND local_member_loss) AS local_loss`,
      [guild.id, user, guild.fc_id, freshnessSeconds],
    )
  )[0];
  const eligible = rows.filter((row) => row.state === "present" || row.state === "missing");
  const unresolved = !facts?.local_loss && rows.some((row) => row.state === null);
  let officer: RankState = "no";
  let leader: RankState = "no";
  if (guild.fc_id) {
    if (eligible.some((row) => row.is_fc_leader === true)) leader = "yes";
    else if (unresolved || eligible.some((row) => row.is_fc_leader === null)) leader = "unknown";
    if (guild.officer_rank_key) {
      if (
        eligible.some((row) => row.officer_authority && row.fc_rank_key === guild.officer_rank_key)
      )
        officer = "yes";
      else if (
        unresolved ||
        eligible.some((row) => row.officer_authority && row.fc_rank_key === null)
      )
        officer = "unknown";
    }
  }
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
