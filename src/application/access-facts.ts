/** Shared persisted eligibility facts for command decisions and Discord role reconciliation. */
import { and, eq, exists, gt, sql } from "drizzle-orm";
import type { AccessFacts } from "../domain/policy.js";
import type { Orm } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import type { GuildRecord } from "./records.js";

/** Active trusted links establish registration; accepted roster evidence separately establishes FC access. */
export async function accessFacts(
  db: Orm,
  guild: GuildRecord,
  user: string,
  freshnessSeconds: number,
  roles: readonly string[] = [],
): Promise<AccessFacts> {
  const [links] = await db
    .select({
      total: sql<bigint>`count(*)`.mapWith(BigInt),
      confirmed:
        sql<bigint>`count(*) FILTER(WHERE ${t.membership.state} IN ('present','missing'))`.mapWith(
          BigInt,
        ),
      unknown: sql<bigint>`count(*) FILTER(WHERE ${t.membership.state} IS NULL)`.mapWith(BigInt),
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
    .where(
      and(eq(t.links.guild_id, guild.id), eq(t.links.user_id, user), eq(t.links.active, true)),
    );
  const [state] = await db
    .select({
      local_loss: exists(
        db
          .select({ user_id: t.guildUsers.user_id })
          .from(t.guildUsers)
          .where(
            and(
              eq(t.guildUsers.guild_id, guild.id),
              eq(t.guildUsers.user_id, user),
              eq(t.guildUsers.local_member_loss, true),
            ),
          ),
      ).mapWith(Boolean),
      former: exists(
        db
          .select({ id: t.membershipHistory.id })
          .from(t.membershipHistory)
          .where(
            and(
              eq(t.membershipHistory.guild_id, guild.id),
              eq(t.membershipHistory.user_id, user),
              guild.fc_id ? eq(t.membershipHistory.fc_id, guild.fc_id) : sql`false`,
            ),
          ),
      ).mapWith(Boolean),
      grant: exists(
        db
          .select({ id: t.guestGrants.id })
          .from(t.guestGrants)
          .where(and(eq(t.guestGrants.guild_id, guild.id), eq(t.guestGrants.user_id, user))),
      ).mapWith(Boolean),
      revoked: exists(
        db
          .select({ user_id: t.guestState.user_id })
          .from(t.guestState)
          .where(
            and(
              eq(t.guestState.guild_id, guild.id),
              eq(t.guestState.user_id, user),
              eq(t.guestState.revoked, true),
            ),
          ),
      ).mapWith(Boolean),
      fresh: exists(
        db
          .select({ id: t.freeCompanies.id })
          .from(t.freeCompanies)
          .where(
            and(
              guild.fc_id ? eq(t.freeCompanies.id, guild.fc_id) : sql`false`,
              gt(
                t.freeCompanies.last_successful_roster_at,
                sql`now()-${freshnessSeconds}*interval '1 second'`,
              ),
            ),
          ),
      ).mapWith(Boolean),
    })
    .from(t.guilds)
    .where(eq(t.guilds.id, guild.id));
  if (!links || !state) throw new Error("Missing access facts");
  return {
    ...state,
    // With no linked FC, registration is a local Guest credential and needs no roster acquisition.
    fresh: !guild.fc_id || state.fresh,
    verified: guild.access_policy_enabled && links.total > 0n,
    membership: !guild.fc_id
      ? "ineligible"
      : links.confirmed > 0n
        ? "member"
        : links.unknown > 0n && !state.local_loss
          ? "uncertain"
          : "ineligible",
    hasMember: roles.includes(guild.member_role_id ?? ""),
    hasGuest: roles.includes(guild.guest_role_id ?? ""),
  };
}
