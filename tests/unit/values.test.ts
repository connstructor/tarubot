/**
 * Boundary values reject every malformed input as a user-safe Failure, never a raw SDK error:
 * lossless IDs, labelled notes, and ledger history cursors.
 */
import { expect, test } from "bun:test";
import {
  Failure,
  id,
  idSchema,
  MAX_GIL,
  MAX_ID,
  note,
  sequenceCursor,
} from "../../src/domain/values.js";

test("valid decimal IDs parse losslessly up to the unsigned 64-bit maximum", () => {
  expect(id("1234567890123456789")).toBe("1234567890123456789");
  expect(id(MAX_ID.toString())).toBe(MAX_ID.toString());
  expect(id(42)).toBe("42");
});

test("typed names, mentions and spaced IDs fail validation instead of throwing SyntaxError", () => {
  // DevBot 2.12.3: /assign member:<typed name> reached BigInt() through the Zod 4 refinement.
  for (const input of ["Wrenfield", "@Wrenfield", "<@123>", "12 34", " 123", "-5", "0123", ""]) {
    expect(idSchema.safeParse(input).success).toBe(false);
    expect(() => id(input)).toThrow(Failure);
  }
});

test("out-of-range IDs are rejected without losing precision", () => {
  expect(idSchema.safeParse((MAX_ID + 1n).toString()).success).toBe(false);
  expect(() => id("99999999999999999999")).toThrow(
    "That ID isn't valid. Pick a suggestion, or paste the numeric ID (for example 123456789012345678).",
  );
});

test("note() names the option it checks in the approved message", () => {
  expect(note("  Weekly dues  ")).toBe("Weekly dues");
  expect(() => note("   ")).toThrow("Add a note of 1–1,000 characters.");
  expect(() => note("", "reason")).toThrow("Add a reason of 1–1,000 characters.");
  expect(() => note("x".repeat(1_001), "rank")).toThrow("Add a rank of 1–1,000 characters.");
  expect(() => note("bad\0text", "reason")).toThrow(
    "The reason contains characters that can't be saved. Retype it and try again.",
  );
  try {
    note("");
  } catch (error) {
    expect(error).toBeInstanceOf(Failure);
    expect((error as Failure).code).toBe("input");
  }
});

test("sequenceCursor() accepts entry numbers 1 through MAX_GIL and nothing else", () => {
  expect(sequenceCursor("34")).toBe(34n);
  expect(sequenceCursor("1")).toBe(1n);
  expect(sequenceCursor(MAX_GIL.toString())).toBe(MAX_GIL);
  for (const input of [
    "0",
    "-1",
    "034",
    "3.4",
    " 34",
    "34 ",
    "abc",
    "",
    (MAX_GIL + 1n).toString(),
    34,
  ])
    expect(() => sequenceCursor(input)).toThrow(
      "Use an entry number from a previous page, such as 34.",
    );
  // Nineteen digits pass the shape check but exceed the range; BigInt never sees malformed text.
  expect(() => sequenceCursor("9999999999999999999")).toThrow(Failure);
});
