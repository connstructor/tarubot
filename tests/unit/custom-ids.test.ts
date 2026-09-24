/**
 * The custom-ID codec: every control round-trips losslessly within Discord's 100 characters at
 * maximum inputs, carries selectors only, and parsing refuses anything non-canonical as an
 * out-of-date control (Failure 'stale') rather than guessing.
 */
import { describe, expect, test } from "bun:test";
import {
  encodeControl,
  parseControl,
  parseControlFor,
  type ControlId,
} from "../../src/discord/custom-ids.js";
import { Failure, MAX_GIL, MAX_ID } from "../../src/domain/values.js";

/** Each prefix and action pair the grammar defines, derived from the parsed type. */
type ControlKey = ControlId extends infer Control
  ? Control extends {
      readonly prefix: infer P extends string;
      readonly action: infer A extends string;
    }
    ? `${P}:${A}`
    : never
  : never;

/** 20-digit IDs, a 19-digit cursor and a full UUID: the longest selectors each control takes. */
const ID = MAX_ID.toString();
const UUID = "ffffffff-ffff-4fff-bfff-ffffffffffff";

/**
 * One maximal control per action. `satisfies` makes a new action in the grammar fail typecheck
 * here until it has a case.
 */
const MAXIMAL = {
  "ledger:open": { prefix: "ledger", action: "open", scope: "h", fcId: ID },
  "ledger:latest": { prefix: "ledger", action: "latest", scope: "h", fcId: ID },
  "ledger:newer": { prefix: "ledger", action: "newer", scope: "h", fcId: ID, before: MAX_GIL },
  "ledger:older": { prefix: "ledger", action: "older", scope: "c", fcId: ID, before: MAX_GIL },
  "details:balance": { prefix: "details", action: "balance", scope: "h", fcId: ID },
  "details:history": {
    prefix: "details",
    action: "history",
    scope: "h",
    fcId: ID,
    before: MAX_GIL,
  },
  "details:sync": { prefix: "details", action: "sync", run: UUID },
  "details:guest": { prefix: "details", action: "guest", userId: ID },
  "details:characters": { prefix: "details", action: "characters", userId: ID },
  "details:config": { prefix: "details", action: "config" },
  "verify:claim": { prefix: "verify", action: "claim", characterId: ID },
  "verify:again": { prefix: "verify", action: "again", characterId: ID },
  "config:validate": { prefix: "config", action: "validate" },
  "sync:status": { prefix: "sync", action: "status", run: UUID },
  "guest:approve": { prefix: "guest", action: "approve", application: UUID },
  "guest:deny": { prefix: "guest", action: "deny", application: UUID },
} as const satisfies Record<ControlKey, ControlId>;

/** The same controls with their optional trailing selector left out. */
const SHORTEST: readonly ControlId[] = [
  { prefix: "ledger", action: "newer", scope: "c", fcId: "1", before: null },
  { prefix: "ledger", action: "older", scope: "c", fcId: "1", before: null },
  { prefix: "details", action: "history", scope: "c", fcId: "1", before: null },
  { prefix: "details", action: "sync", run: null },
  { prefix: "sync", action: "status", run: null },
];

/** Assert that parsing refuses a custom ID as an out-of-date control. */
function expectStale(customId: string): void {
  let caught: unknown;
  try {
    parseControl(customId);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Failure);
  expect(caught).toMatchObject({ code: "stale", detail: { kind: "stale", what: "control" } });
}

describe("encoding", () => {
  for (const [key, control] of Object.entries(MAXIMAL))
    test(`${key} stays within 100 characters and round-trips at maximum inputs`, () => {
      const customId = encodeControl(control);
      expect(customId.length).toBeLessThanOrEqual(100);
      expect(customId === key || customId.startsWith(`${key}:`)).toBe(true);
      expect(parseControl(customId)).toEqual(control);
    });

  test("an omitted optional selector round-trips as null", () => {
    expect(SHORTEST.map(encodeControl)).toEqual([
      "ledger:newer:c:1",
      "ledger:older:c:1",
      "details:history:c:1",
      "details:sync",
      "sync:status",
    ]);
    for (const control of SHORTEST) expect(parseControl(encodeControl(control))).toEqual(control);
  });

  test("the longest IDs are the ones the plan budgets for", () => {
    expect(encodeControl(MAXIMAL["details:history"])).toHaveLength(58);
    expect(encodeControl(MAXIMAL["ledger:newer"])).toHaveLength(55);
    expect(encodeControl(MAXIMAL["guest:approve"])).toHaveLength(50);
    expect(encodeControl(MAXIMAL["details:sync"])).toHaveLength(49);
  });

  test("the review buttons keep their 2.12.0 format", () => {
    expect(encodeControl({ prefix: "guest", action: "approve", application: UUID })).toBe(
      `guest:approve:${UUID}`,
    );
    expect(parseControl(`guest:deny:${UUID}`)).toEqual({
      prefix: "guest",
      action: "deny",
      application: UUID,
    });
  });

  test("controls carry selectors only, never an actor, role or permission", () => {
    const selectors = new Set([
      "prefix",
      "action",
      "scope",
      "fcId",
      "before",
      "run",
      "userId",
      "characterId",
      "application",
    ]);
    for (const control of [...Object.values(MAXIMAL), ...SHORTEST])
      for (const key of Object.keys(parseControl(encodeControl(control)))) {
        expect(selectors.has(key)).toBe(true);
        expect(key).not.toMatch(/actor|officer|permission|role|audience|viewer|guild|manager/iu);
      }
  });

  test("a non-canonical selector is a presenter bug, not a stale control", () => {
    for (const control of [
      { prefix: "verify", action: "claim", characterId: "0123" },
      { prefix: "verify", action: "claim", characterId: (MAX_ID + 1n).toString() },
      { prefix: "ledger", action: "older", scope: "c", fcId: "1", before: 0n },
      { prefix: "ledger", action: "older", scope: "c", fcId: "1", before: MAX_GIL + 1n },
      { prefix: "sync", action: "status", run: UUID.toUpperCase() },
      { prefix: "details", action: "guest", userId: "<@1>" },
    ] as const satisfies readonly ControlId[]) {
      expect(() => encodeControl(control)).toThrow("A custom ID selector is not canonical.");
      expect(() => encodeControl(control)).not.toThrow(Failure);
    }
  });
});

describe("parsing", () => {
  test("extra or missing segments are stale", () => {
    for (const customId of [
      "ledger:open:c:123:4",
      "ledger:latest:c:123:4",
      "ledger:newer:c:123:4:5",
      "details:balance:c:123:4",
      "details:config:x",
      `details:sync:${UUID}:x`,
      "config:validate:x",
      "verify:claim:1:2",
      `sync:status:${UUID}:x`,
      `guest:approve:${UUID}:x`,
      "ledger:open:c",
      "ledger:newer:c",
      "details:guest",
      "verify:claim",
      "guest:approve",
      "ledger:open:c:123:",
      "ledger:newer:c:123:",
    ])
      expectStale(customId);
  });

  test("leading zeros, signs, non-digits and out-of-range numbers are stale", () => {
    for (const customId of [
      "verify:claim:0123",
      "verify:claim:0",
      "verify:claim:+123",
      "verify:claim:-123",
      "verify:claim:12a",
      "verify:claim: 123",
      "verify:claim:1e5",
      `verify:claim:${MAX_ID + 1n}`,
      "ledger:older:c:123:034",
      "ledger:older:c:123:0",
      "ledger:older:c:123:-5",
      "ledger:older:c:123:+5",
      "ledger:older:c:123:x",
      `ledger:older:c:123:${MAX_GIL + 1n}`,
      `details:history:h:123:${MAX_GIL + 1n}`,
    ])
      expectStale(customId);
    expect(parseControl(`ledger:older:c:123:${MAX_GIL}`)).toMatchObject({ before: MAX_GIL });
  });

  test("uppercase, short and malformed UUIDs are stale", () => {
    for (const customId of [
      `sync:status:${UUID.toUpperCase()}`,
      "sync:status:ffffffff-ffff",
      `sync:status:${UUID.replaceAll("-", "")}`,
      `details:sync:${UUID}0`,
      `guest:approve:${UUID.replace("f", "g")}`,
    ])
      expectStale(customId);
  });

  test("unknown scopes, actions and prefixes are stale", () => {
    for (const customId of [
      "ledger:open:x:123",
      "ledger:open:C:123",
      "details:balance:current:123",
      "ledger:delete:c:123",
      "details:secret",
      "config:reset",
      "verify:now:123",
      "sync:run",
      `guest:grant:${UUID}`,
      "admin:grant:1",
      "guest-apply:1:2:3",
      "",
      ":",
      "ledger",
      `verify:claim:${"1".repeat(100)}`,
    ])
      expectStale(customId);
  });

  test("a module parses only its own prefix", () => {
    expect(parseControlFor("verify", "verify:again:12345678")).toEqual({
      prefix: "verify",
      action: "again",
      characterId: "12345678",
    });
    expect(() => parseControlFor("verify", "ledger:open:c:1")).toThrow(Failure);
    expect(() => parseControlFor("details", "config:validate")).toThrow(
      "This button is out of date. Run the command again to get a current one.",
    );
  });
});
