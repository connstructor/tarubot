/**
 * Failure reports log at the level the caller passes (error by default), with catalog fields and
 * never the text of an error that is not an approved Failure.
 */
import { expect, test } from "bun:test";
import { createReporter, type ReportLog } from "../../src/application/reporting.js";
import type { ReportLevel } from "../../src/domain/failures.js";
import { Failure } from "../../src/domain/values.js";

/** A pino-shaped fake that records each call's level, fields and message. */
function recorder() {
  const calls: { level: ReportLevel; fields: Readonly<Record<string, unknown>>; msg: string }[] =
    [];
  const method =
    (level: ReportLevel) =>
    (fields: Readonly<Record<string, unknown>>, msg: string): void => {
      calls.push({ level, fields, msg });
    };
  const log: ReportLog = { info: method("info"), warn: method("warn"), error: method("error") };
  return { calls, report: createReporter(log) };
}

test("reports default to error, the level lifecycle and event callers rely on", () => {
  const { calls, report } = recorder();
  report(new Failure("writer_lease", "The writer lease was lost."), "writer-lease");
  expect(calls).toEqual([
    {
      level: "error",
      fields: {
        operation: "writer-lease",
        code: "writer_lease",
        category: "unexpected",
        source: "Failure",
        scope: undefined,
        diagnostic: "The writer lease was lost.",
      },
      msg: "Operation failed; inspect scoped work status.",
    },
  ]);
});

test("the passed level selects the logger method and its fixed message", () => {
  const { calls, report } = recorder();
  const refusal = new Failure("forbidden", "Only officers can use this.");
  report(refusal, "1001", { level: "info", scope: "/config fc link" });
  report(new Failure("blocked", "Recheck channel permissions."), "1002", { level: "warn" });
  report(refusal, "1003", { level: "error" });
  expect(calls.map(({ level, msg }) => [level, msg])).toEqual([
    ["info", "Interaction refused with an approved reason."],
    ["warn", "Operation could not complete; a dependency or setting needs attention."],
    ["error", "Operation failed; inspect scoped work status."],
  ]);
  expect(calls[0]?.fields).toEqual({
    operation: "1001",
    code: "forbidden",
    category: "forbidden",
    source: "Failure",
    scope: "/config fc link",
    diagnostic: "Only officers can use this.",
  });
});

test("a non-Failure error logs its class as source and never its message", () => {
  const { calls, report } = recorder();
  report(new Error("secret token abc in a transport error"), "2001", { scope: "/verify" });
  report("secret thrown string", "2002");
  expect(calls[0]?.fields).toEqual({
    operation: "2001",
    code: "unexpected",
    category: "unexpected",
    source: "Error",
    scope: "/verify",
    diagnostic: undefined,
  });
  expect(calls[1]?.fields).toMatchObject({ code: "unexpected", source: "unknown" });
  // No field, and no message, carries any part of the raw error text.
  expect(JSON.stringify(calls)).not.toContain("secret");
});
