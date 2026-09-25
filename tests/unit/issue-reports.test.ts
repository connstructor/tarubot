/**
 * Issue-report helpers (2.18.0): credentials never reach a report, fingerprints group the same
 * trouble, stacks keep first-party frames, and bodies stay within GitHub's limits and Markdown.
 */
import { describe, expect, test } from "bun:test";
import { RecentLogs } from "../../src/application/recent-logs.js";
import {
  BODY_LIMIT,
  bounded,
  details,
  fenced,
  fingerprint,
  firstPartyFrames,
  redact,
  table,
} from "../../src/domain/reports.js";

describe("redact", () => {
  test("removes every credential shape a report could carry", () => {
    // Token-shaped samples are assembled at runtime, so secret scanners never see a literal one.
    const discord = ["MTA0MDM3OTM3MDE1OTc0MzEzOQ", "GaBcDe", "a".repeat(38)].join(".");
    const fineGrained = ["github", "pat", "11TESTONLY0000000000000", "notARealTokenForTests"].join(
      "_",
    );
    const classic = ["ghp", "0123456789abcdefghijABCDEFGHIJ012345"].join("_");
    const text = [
      `token ${discord}`,
      fineGrained,
      classic,
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      "postgresql://tarubot:s3cr3t-pass@db.example:27520/tarubot",
      "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----",
    ].join("\n");
    const clean = redact(text);
    for (const secret of [
      discord,
      fineGrained,
      classic,
      "abcdefghijklmnopqrstuvwxyz0123456789",
      "s3cr3t-pass",
      "MIIBszCCAVmgAwIBAgIU",
    ])
      expect(clean).not.toContain(secret);
    // What surrounds a secret stays readable.
    expect(clean).toContain("@db.example:27520/tarubot");
  });

  test("removes this deployment's own secret values in any shape", () => {
    expect(redact("the value was hunter2hunter2 all along", ["hunter2hunter2"])).toBe(
      "the value was [secret redacted] all along",
    );
    // Short values would erase ordinary words, so they are left to the patterns.
    expect(redact("ok", ["ok"])).toBe("ok");
  });
});

test("fingerprints are stable, and differ when any part differs", () => {
  expect(fingerprint("job", "profile", "unavailable")).toBe(
    fingerprint("job", "profile", "unavailable"),
  );
  expect(fingerprint("job", "profile", "unavailable")).not.toBe(
    fingerprint("job", "roster", "unavailable"),
  );
  // Parts are separated, so shifting text between them changes the fingerprint.
  expect(fingerprint("ab", "c")).not.toBe(fingerprint("a", "bc"));
  expect(fingerprint("x")).toMatch(/^[0-9a-f]{16}$/u);
});

test("stacks keep first-party frames with repository-relative paths", () => {
  const stack = [
    "TypeError: boom",
    "    at handler (/app/dist/src/jobs/dispatch.js:88:11)",
    "    at wrap (/app/node_modules/pg/lib/client.js:10:2)",
    "    at run (/home/someone/src/tarubot/src/application/service.ts:120:5)",
    "    at native",
  ].join("\n");
  expect(firstPartyFrames(stack)).toEqual([
    "at handler (dist/src/jobs/dispatch.js:88:11)",
    "at run (src/application/service.ts:120:5)",
  ]);
  expect(firstPartyFrames(undefined)).toEqual([]);
});

test("bodies are bounded, fenced text can't close its block, and tables escape cells", () => {
  const long = "x".repeat(BODY_LIMIT + 5);
  expect(bounded(long)).toContain("5 more characters cut");
  expect(bounded("short")).toBe("short");
  expect(fenced("a ``` b", "text")).toBe("```text\na ʼʼʼ b\n```");
  expect(details("Logs", "line")).toBe("<details><summary>Logs</summary>\n\nline\n\n</details>");
  expect(table(["A", "B"], [["x|y", null]])).toBe("| A | B |\n| --- | --- |\n| x\\|y | — |");
});

test("recent logs keep the newest records within their capacity", () => {
  const logs = new RecentLogs(3);
  for (const line of ["1\n", "2\n", "3\n", "4\n"]) logs.write(line);
  expect(logs.recent()).toEqual(["2", "3", "4"]);
  expect(logs.recent(2)).toEqual(["3", "4"]);
});
