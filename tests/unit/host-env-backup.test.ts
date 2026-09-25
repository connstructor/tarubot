/**
 * The host `.env` backup tool (2.23.0): argument parsing, setting names without values, the
 * required settings, file naming and the recipients file. The SSH read and age encryption are
 * exercised on the operator machine (docs/VERIFICATION.md).
 */
import { expect, test } from "bun:test";
import {
  backupName,
  checkSettings,
  DEFAULT_HOST,
  parseArgs,
  recipients,
  settingNames,
} from "../../scripts/host-env-backup.js";

test("arguments default to the production host and the operator's backup folder", () => {
  expect(parseArgs([], "/home/op")).toEqual({
    host: DEFAULT_HOST,
    out: "/home/op/tarubot-cutover/env-backups",
    identity: null,
  });
  expect(parseArgs(["--host", "tarubot@new", "--identity", "/k/key.txt"], "/h")).toMatchObject({
    host: "tarubot@new",
    identity: "/k/key.txt",
  });
  expect(() => parseArgs(["--hots", "x"])).toThrow("Unknown argument --hots");
  expect(() => parseArgs(["--out"])).toThrow("--out needs a value");
  expect(() => parseArgs(["--out", "--host"])).toThrow("--out needs a value");
});

test("setting names are read without values, including a multi-line CA", () => {
  const env = [
    "TARUBOT_IMAGE_TAG=2.23.0",
    'DATABASE_CA_CERT="-----BEGIN CERTIFICATE-----',
    "MIIDSECRETLOOKINGLINE=",
    '-----END CERTIFICATE-----"',
    "DISCORD_TOKEN=abc.def.ghi",
    "# a comment",
    "lowercase=ignored",
  ].join("\n");
  expect(settingNames(env)).toEqual([
    "TARUBOT_IMAGE_TAG",
    "DATABASE_CA_CERT",
    "MIIDSECRETLOOKINGLINE",
    "DISCORD_TOKEN",
  ]);
});

test("a .env missing a setting production needs is refused by name", () => {
  const complete = ["TARUBOT_IMAGE_TAG", "DATABASE_URL", "DATABASE_CA_CERT", "DISCORD_TOKEN"];
  expect(checkSettings(complete)).toEqual(["GITHUB_REPORTS_TOKEN", "HEALTHCHECKS_PING_URL"]);
  expect(checkSettings([...complete, "GITHUB_REPORTS_TOKEN", "HEALTHCHECKS_PING_URL"])).toEqual([]);
  expect(() => checkSettings(["TARUBOT_IMAGE_TAG", "DATABASE_URL"])).toThrow(
    "lacks DATABASE_CA_CERT, DISCORD_TOKEN",
  );
});

test("copies are named by UTC time, so they sort in order", () => {
  expect(backupName(new Date("2026-09-25T12:34:56.789Z"))).toBe("tarubot-env-20260925T123456Z.age");
});

test("the recipients file must hold age public keys, with comments allowed", () => {
  const key = `age1${"q".repeat(58)}`;
  expect(recipients(`# the operator's key\n${key}\n\n`)).toEqual([key]);
  expect(() => recipients("# nothing yet\n")).toThrow("age public keys");
  expect(() => recipients("AGE-SECRET-KEY-1ABC\n")).toThrow("age public keys");
});

test("the committed recipients file holds a valid age public key", async () => {
  const text = await Bun.file(new URL("../../ops/age-recipients.txt", import.meta.url)).text();
  expect(recipients(text).length).toBeGreaterThan(0);
  // A private key must never be committed.
  expect(text).not.toContain("AGE-SECRET-KEY");
});
