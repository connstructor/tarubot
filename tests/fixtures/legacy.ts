/** Deterministic invented migration input for public CI; never a production cutover artifact. */
const companyBase = 9000000000000000001n;
const userBase = 800000000000000001n;

/** Match supported MySQL quoting while deliberately exercising Unicode and apostrophes. */
function sql(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** Explicit columns make the synthetic dataset independent from a MySQL server installation. */
function insert(table: string, columns: string[], rows: (string | null)[][]): string {
  return `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(",")}) VALUES\n${rows.map((row) => `(${row.map(sql).join(",")})`).join(",\n")};\n`;
}

export function syntheticLegacyDump(): string {
  const companies = Array.from({ length: 40 }, (_, index) => [
    String(companyBase + BigInt(index)),
    `Synthetic FC ${index + 1}`,
    `F${index + 1}`,
    "Diabolos",
    index >= 36 ? null : index === 0 ? "349279945" : String((index - 1) * 1000),
    "2025-01-01 00:00:00",
  ]);
  const users = Array.from({ length: 241 }, (_, index) => [String(userBase + BigInt(index))]);
  const characters = Array.from({ length: 4251 }, (_, index) => [
    String(60000001 + index),
    index < 161 ? String(userBase + BigInt(index)) : null,
    String(companyBase + BigInt(index < 161 ? 0 : index % 40)),
    index === 0 ? "Élise" : `Fixture${index + 1}`,
    index === 0 ? "O'Brien" : "Character",
    "Diabolos",
  ]);
  return (
    "-- SYNTHETIC CI DATA: invented IDs and identities; do not import into production.\n" +
    insert(
      "freecompany",
      ["fc_id", "name", "tag", "world", "gil_balance", "last_updated"],
      companies,
    ) +
    insert("member", ["discord_id"], users) +
    insert(
      "gamecharacter",
      ["char_id", "owner", "fc", "forename", "surname", "world"],
      characters,
    ) +
    insert(
      "guild",
      [
        "guild_id",
        "fc",
        "member_role_id",
        "guest_role_id",
        "ledger_channel_id",
        "officer_notifications_channel_id",
        "guest_application_channel_id",
      ],
      [
        [
          "700000000000000001",
          String(companyBase),
          "710000000000000001",
          "710000000000000002",
          "710000000000000003",
          "710000000000000004",
          "710000000000000005",
        ],
      ],
    )
  );
}

if (import.meta.main) {
  // A fixed ignored path cannot overwrite the owner's separately supplied backup fixture.
  const output = new URL("../../.cache/ci/legacy.sql", import.meta.url);
  await Bun.write(output, syntheticLegacyDump());
  console.log("Generated synthetic CI input at .cache/ci/legacy.sql.");
}
