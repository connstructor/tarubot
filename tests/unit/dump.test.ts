/** Small syntax fixtures complement the full supplied-dump PostgreSQL acceptance tests. */
import { expect, test } from "bun:test";
import { readDump } from "../../src/import/dump.js";
import { importReport, mappings, snapshotSchema } from "../../src/import/importer.js";

// Embedded SQL comments/semicolons/quotes exercise decoding without executing input statements.
const fixture = String.raw`
/* executable dump directives are read, never executed: DROP DATABASE production */
CREATE TABLE \`freecompany\` (
  \`fc_id\` varchar(20),
  \`name\` text,
  \`tag\` text,
  \`world\` text,
  \`gil_balance\` int,
  \`last_updated\` datetime
);
CREATE TABLE \`gamecharacter\` (
  \`char_id\` varchar(20),
  \`owner\` varchar(20),
  \`fc\` varchar(20),
  \`forename\` text,
  \`surname\` text,
  \`world\` text
);
CREATE TABLE \`member\` (
  \`discord_id\` varchar(20)
);
CREATE TABLE \`guild\` (
  \`guild_id\` varchar(20),
  \`member_role_id\` varchar(20),
  \`guest_role_id\` varchar(20),
  \`ledger_channel_id\` varchar(20),
  \`officer_notifications_channel_id\` varchar(20),
  \`fc\` varchar(20),
  \`guest_application_channel_id\` varchar(20)
);
INSERT INTO \`gamecharacter\` VALUES ('123','456','9232097761132958152','${"Élise"}','O\'Brien; -- not a comment','Diabolos');
INSERT INTO \`freecompany\` VALUES ('9232097761132958152','Souls','S','Diabolos',0,'2026-06-21 20:39:49');
INSERT INTO \`member\` VALUES ('456');
INSERT INTO \`guild\` VALUES ('789','','','','','9232097761132958152','');
`.replaceAll("\\`", "`");

test("dump reader preserves escaped quotes, Unicode, semicolons and schema ordering", () => {
  const data = readDump(fixture);
  expect(data.characters[0]?.surname).toBe("O'Brien; -- not a comment");
  expect(data.characters[0]?.forename).toBe("Élise");
  expect(data.companies[0]?.gil_balance).toBe("0");
  expect(data.guilds[0]?.guest_role_id).toBeNull();
  expect(importReport(data, null, mappings(data)).timestamps[0]?.utc).toBe("2026-06-21T20:39:49Z");
});
test("import report records the legacy review channel as closed and shows every launch default", () => {
  // Legacy settings: roles 101/102, ledger 103, officer notices 104, review channel 555.
  const data = readDump(
    fixture.replace(
      "('789','','','','','9232097761132958152','')",
      "('789','101','102','103','104','9232097761132958152','555')",
    ),
  );
  const report = importReport(data, null, mappings(data));
  // Notice channels are imported as they are; the review channel is only reported (decision 5).
  expect(report.guildSettings).toEqual([
    {
      guildId: "789",
      memberRoleId: "101",
      guestRoleId: "102",
      ledgerChannelId: "103",
      officerNotificationsChannelId: "104",
      guestApplications: { state: "closed", legacyChannelId: "555" },
    },
  ]);
  expect(report.bootstrap).toMatchObject({
    effects: "disabled",
    guestApplications: "closed",
    roleLayout: "disabled",
    guestGrandfathering: "pending_first_activation",
  });
  // An empty legacy value still normalizes to null, and applications stay closed.
  const empty = readDump(fixture);
  expect(importReport(empty, null, mappings(empty)).guildSettings[0]?.guestApplications).toEqual({
    state: "closed",
    legacyChannelId: null,
  });
});
test("broken relationships and malformed quoted values are rejected", () => {
  expect(() => readDump(fixture.replace("'123','456'", "'123','999'"))).toThrow();
  expect(() => readDump(`${fixture}\nINSERT INTO \`member\` VALUES ('unterminated`)).toThrow();
});
test("incomplete Discord snapshot cannot bootstrap guests", () => {
  expect(() =>
    snapshotSchema.parse({
      capturedAt: new Date().toISOString(),
      guilds: [{ id: "1", complete: true, expectedCount: 2, enumeratedCount: 1, members: [] }],
    }),
  ).toThrow();
});
