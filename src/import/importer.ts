/** Map validated legacy/cache facts into guild-scoped policy with one atomic publication. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { Failure, idSchema, json } from "../domain/values.js";
import { audit, ensureUser, type Database } from "../infrastructure/postgres/database.js";
import { enqueue } from "../jobs/queue.js";
import type { LegacyData } from "./dump.js";

/** Only complete, duplicate-free human captures can grandfather the guest population. */
export const snapshotSchema = z
  .object({
    capturedAt: z.iso.datetime({ offset: true }),
    guilds: z.array(
      z
        .object({
          id: idSchema,
          complete: z.literal(true),
          expectedCount: z.number().int().nonnegative(),
          enumeratedCount: z.number().int().nonnegative(),
          members: z.array(
            z.object({
              id: idSchema,
              roles: z.array(idSchema),
              nickname: z.string().nullable(),
              joinedAt: z.iso.datetime({ offset: true }),
            }),
          ),
        })
        .refine(
          (row) =>
            row.enumeratedCount === row.expectedCount &&
            row.members.length <= row.enumeratedCount &&
            new Set(row.members.map((member) => member.id)).size === row.members.length,
          "Incomplete or duplicate Discord membership",
        ),
    ),
  })
  .refine(
    (value) => new Set(value.guilds.map((guild) => guild.id)).size === value.guilds.length,
    "Duplicate guild snapshot",
  );
export type Snapshot = z.infer<typeof snapshotSchema>;
/** Ownership may map to several guilds; each source account balance maps exactly once. */
export const mappingSchema = z.object({
  ownership: z.record(z.string(), z.array(idSchema).min(1)),
  accounts: z.record(z.string(), idSchema),
});
export type Mapping = z.infer<typeof mappingSchema>;
/** Map key/order differences are irrelevant, but changed destinations require explicit review. */
function canonicalMapping(mapping: Mapping): string {
  const order = ([left]: [string, unknown], [right]: [string, unknown]) =>
    left.localeCompare(right);
  return json({
    ownership: Object.fromEntries(
      Object.entries(mapping.ownership)
        .sort(order)
        .map(([key, guilds]) => [key, [...guilds].sort()]),
    ),
    accounts: Object.fromEntries(Object.entries(mapping.accounts).sort(order)),
  });
}
/** The single-guild fixture has an unambiguous default; multi-guild inputs need explicit mapping. */
export function mappings(data: LegacyData, input?: Mapping): Mapping {
  const first = data.guilds[0];
  if (!first) throw new Failure("input", "No guild in input.");
  if (data.guilds.length > 1 && !input)
    throw new Failure("input", "Multi-guild input requires explicit ownership/account mapping.");
  const result = input ?? {
    ownership: Object.fromEntries(
      data.characters.filter((row) => row.owner).map((row) => [row.char_id, [first.guild_id]]),
    ),
    accounts: Object.fromEntries(data.companies.map((row) => [row.fc_id, first.guild_id])),
  };
  const guilds = new Set(data.guilds.map((row) => row.guild_id));
  const owners = new Set(data.characters.filter((row) => row.owner).map((row) => row.char_id));
  const companies = new Set(data.companies.map((row) => row.fc_id));
  if (
    Object.keys(result.ownership).some((key) => !owners.has(key)) ||
    Object.keys(result.accounts).some((key) => !companies.has(key))
  )
    throw new Failure("input", "Mapping contains unknown source record keys.");
  for (const company of data.companies)
    if (!guilds.has(result.accounts[company.fc_id] ?? ""))
      throw new Failure("input", `Missing or invalid account mapping for ${company.fc_id}.`);
  for (const character of data.characters.filter((row) => row.owner)) {
    const destinations = result.ownership[character.char_id];
    if (
      !destinations?.length ||
      destinations.some((guild) => !guilds.has(guild)) ||
      new Set(destinations).size !== destinations.length
    )
      throw new Failure("input", `Missing or invalid ownership mapping for ${character.char_id}.`);
  }
  return result;
}
/** Read-only reconciliation report; a missing live snapshot stays unknown rather than becoming zero guests. */
export function importReport(data: LegacyData, snapshot: Snapshot | null, mapping: Mapping) {
  if (snapshot?.guilds.some((guild) => !data.guilds.some((source) => source.guild_id === guild.id)))
    throw new Failure("input", "Discord snapshot contains a guild outside this import mapping.");
  const sourceUsers = new Set(data.users);
  const additions = new Set(
    snapshot?.guilds
      .flatMap((guild) => guild.members.map((member) => member.id))
      .filter((user) => !sourceUsers.has(user)) ?? [],
  );
  const guestGrants =
    snapshot?.guilds.reduce((total, guild) => {
      const role = data.guilds.find((row) => row.guild_id === guild.id)?.guest_role_id;
      return total + guild.members.filter((member) => role && member.roles.includes(role)).length;
    }, 0) ?? null;
  return {
    fingerprint: data.fingerprint,
    sourceTimezone: "UTC",
    counts: {
      freecompany: data.companies.length,
      gamecharacter: data.characters.length,
      member: data.users.length,
      guild: data.guilds.length,
      ownershipLinks: data.characters.filter((row) => row.owner).length,
      knownBalances: data.companies.filter((row) => row.gil_balance !== null).length,
      unknownBalances: data.companies.filter((row) => row.gil_balance === null).length,
      discordOnlyUsers: additions.size,
      importedGuestGrants: guestGrants,
    },
    mapping,
    balances: data.companies.map((row) => ({
      fcId: row.fc_id,
      guildId: mapping.accounts[row.fc_id],
      balance: row.gil_balance,
      state: row.gil_balance === null ? "uninitialized" : "known",
    })),
    timestamps: data.companies
      .filter((row) => row.last_updated)
      .map((row) => ({
        fcId: row.fc_id,
        raw: row.last_updated,
        utc: `${row.last_updated?.replace(" ", "T")}Z`,
      })),
    bootstrap: {
      primaryCharacters: "unset",
      nicknames: "disabled",
      liveRoster: "pending",
      effects: "disabled",
      snapshotComplete: snapshot !== null,
    },
  };
}
/** Repeat fingerprints preserve later decisions; new imports publish completely or roll back. */
export async function importLegacy(
  db: Database,
  data: LegacyData,
  snapshot: Snapshot,
  mapping: Mapping,
): Promise<unknown> {
  snapshot = snapshotSchema.parse(snapshot);
  mapping = mappings(data, mapping);
  for (const guild of data.guilds)
    if (!snapshot.guilds.some((row) => row.id === guild.guild_id))
      throw new Failure(
        "input",
        `A complete Discord snapshot is required for guild ${guild.guild_id}.`,
      );
  const report = importReport(data, snapshot, mapping);
  const checksum = createHash("sha256").update(json(snapshot)).digest("hex");
  return db.transaction(async (client) => {
    // One importer owns publication; all validation/network capture was completed beforehand.
    await client.query("SELECT pg_advisory_xact_lock(714882492)");
    const previous = (
      await client.query<{ report: unknown }>("SELECT report FROM imports WHERE fingerprint=$1", [
        data.fingerprint,
      ])
    ).rows[0];
    if (previous) {
      // A recaptured snapshot cannot silently grandfather users added after the original cutover.
      const saved = z.object({ mapping: mappingSchema }).parse(previous.report);
      if (canonicalMapping(saved.mapping) !== canonicalMapping(mapping))
        throw new Failure(
          "conflict",
          "This source fingerprint was imported with a different mapping. An explicit migration decision is required.",
        );
      return { status: "already_imported", report: previous.report };
    }
    for (const guild of data.guilds) {
      const existing = await client.query("SELECT id FROM guilds WHERE id=$1", [guild.guild_id]);
      if (existing.rowCount)
        throw new Failure(
          "conflict",
          `Guild ${guild.guild_id} already has application state. A changed input needs an explicit migration decision.`,
        );
    }
    // Shared display caches are historical input facts, not successful live synchronization.
    for (const fc of data.companies)
      await client.query(
        "INSERT INTO free_companies(id,name,tag,world,source_timestamp) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [fc.fc_id, fc.name, fc.tag, fc.world, fc.last_updated],
      );
    for (const character of data.characters)
      await client.query(
        "INSERT INTO characters(id,name,world,fc_hint) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [
          character.char_id,
          `${character.forename} ${character.surname}`,
          character.world,
          character.fc,
        ],
      );
    for (const user of data.users)
      await client.query("INSERT INTO users(id) VALUES($1) ON CONFLICT DO NOTHING", [user]);
    for (const guild of data.guilds) {
      await client.query(
        "INSERT INTO guilds(id,fc_id,member_role_id,guest_role_id,ledger_channel_id,officer_notifications_channel_id,guest_application_channel_id,effects_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,false)",
        [
          guild.guild_id,
          guild.fc,
          guild.member_role_id,
          guild.guest_role_id,
          guild.ledger_channel_id,
          guild.officer_notifications_channel_id,
          guild.guest_application_channel_id,
        ],
      );
      if (data.guilds.length === 1)
        for (const user of data.users) {
          await ensureUser(client, guild.guild_id, user);
          await client.query(
            "UPDATE guild_users SET imported=true WHERE guild_id=$1 AND user_id=$2",
            [guild.guild_id, user],
          );
        }
      const capture = snapshot.guilds.find((row) => row.id === guild.guild_id);
      if (!capture) throw new Error("Missing validated snapshot");
      for (const member of capture.members) {
        // Snapshot-only users are retained separately from SQL counts and start nickname-disabled.
        await ensureUser(client, guild.guild_id, member.id, new Date(member.joinedAt));
        await client.query(
          "UPDATE guild_users SET imported=true,nickname_enabled=false,primary_character_id=NULL,nickname_before=$3 WHERE guild_id=$1 AND user_id=$2",
          [guild.guild_id, member.id, member.nickname],
        );
        if (guild.guest_role_id && member.roles.includes(guild.guest_role_id))
          await client.query(
            "INSERT INTO guest_grants(guild_id,user_id,provenance,source_key,source) VALUES($1,$2,'imported_guest',$3,$4)",
            [
              guild.guild_id,
              member.id,
              `import:${data.fingerprint}:guest:${guild.guild_id}:${member.id}`,
              json({
                roleId: guild.guest_role_id,
                capturedAt: snapshot.capturedAt,
                snapshotChecksum: checksum,
              }),
            ],
          );
      }
      await audit(client, guild.guild_id, null, "migration.import", data.fingerprint, {
        snapshotChecksum: checksum,
        sourceTimezone: "UTC",
      });
      if (guild.fc) await enqueue(client, "roster", `roster:${guild.fc}`, { fcId: guild.fc });
    }
    for (const character of data.characters) {
      if (!character.owner) continue;
      for (const guildId of mapping.ownership[character.char_id] ?? []) {
        await ensureUser(client, guildId, character.owner);
        await client.query(
          "UPDATE guild_users SET imported=true WHERE guild_id=$1 AND user_id=$2",
          [guildId, character.owner],
        );
        const provenance = {
          checksum: data.fingerprint,
          characterKey: character.char_id,
          ownerKey: character.owner,
          guildKey: guildId,
        };
        const link = (
          await client.query<{ id: string }>(
            "INSERT INTO links(guild_id,user_id,character_id,provenance,source) VALUES($1,$2,$3,'imported_link',$4) RETURNING id",
            [guildId, character.owner, character.char_id, json(provenance)],
          )
        ).rows[0];
        if (!link) throw new Error("Missing imported link");
        const guild = data.guilds.find((row) => row.guild_id === guildId);
        if (guild?.fc && character.fc === guild.fc) {
          // Historical eligibility requires both the supplied trusted ownership and matching FC.
          await client.query(
            "INSERT INTO membership_history(guild_id,user_id,fc_id,link_id,source) VALUES($1,$2,$3,$4,$5)",
            [guildId, character.owner, guild.fc, link.id, json(provenance)],
          );
          const holder = snapshot.guilds
            .find((row) => row.id === guildId)
            ?.members.find((row) => row.id === character.owner);
          if (guild.member_role_id && holder?.roles.includes(guild.member_role_id))
            // This baseline preserves existing access until two accepted absence observations.
            await client.query(
              "INSERT INTO membership(guild_id,fc_id,character_id,state,source) VALUES($1,$2,$3,'present',$4) ON CONFLICT DO NOTHING",
              [guildId, guild.fc, character.char_id, json(provenance)],
            );
        }
      }
    }
    for (const fc of data.companies) {
      // NULL is uninitialized; known zero still gets an immutable opening entry at sequence one.
      const guild = mapping.accounts[fc.fc_id];
      if (!guild) throw new Error("Missing account mapping");
      const account = (
        await client.query<{ id: string }>(
          "INSERT INTO ledger_accounts(guild_id,fc_id,balance,sequence) VALUES($1,$2,$3,$4) RETURNING id",
          [guild, fc.fc_id, fc.gil_balance, fc.gil_balance === null ? 0 : 1],
        )
      ).rows[0];
      if (!account) throw new Error("Missing account");
      if (fc.gil_balance !== null)
        await client.query(
          "INSERT INTO ledger_entries(account_id,sequence,operation,delta,balance,guild_id,note,idempotency_key,source) VALUES($1,1,'import',$2,$2,$3,'Imported opening balance',$4,$5)",
          [
            account.id,
            fc.gil_balance,
            guild,
            `import:${data.fingerprint}:balance:${fc.fc_id}`,
            json({
              checksum: data.fingerprint,
              fcKey: fc.fc_id,
              rawTimestamp: fc.last_updated,
              sourceTimezone: "UTC",
            }),
          ],
        );
    }
    for (const guild of data.guilds)
      if (guild.fc)
        await client.query(
          "INSERT INTO ledger_accounts(guild_id,fc_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [guild.guild_id, guild.fc],
        );
    await client.query(
      "INSERT INTO imports(fingerprint,report,source_timezone,snapshot_checksum) VALUES($1,$2,'UTC',$3)",
      [data.fingerprint, json(report), checksum],
    );
    return { status: "imported", report };
  });
}
