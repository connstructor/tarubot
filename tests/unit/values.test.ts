/** Lossless ID parsing rejects every malformed input as a user-safe Failure, never a raw SDK error. */
import { expect, test } from "bun:test";
import { Failure, id, idSchema, MAX_ID } from "../../src/domain/values.js";

test("valid decimal IDs parse losslessly up to the unsigned 64-bit maximum", () => {
  expect(id("1010097911566180445")).toBe("1010097911566180445");
  expect(id(MAX_ID.toString())).toBe(MAX_ID.toString());
  expect(id(42)).toBe("42");
});

test("typed names, mentions and spaced IDs fail validation instead of throwing SyntaxError", () => {
  // DevBot 2.12.3: /assign member:<typed name> reached BigInt() through the Zod 4 refinement.
  for (const input of ["Pazzberry", "@Pazzberry", "<@123>", "12 34", " 123", "-5", "0123", ""]) {
    expect(idSchema.safeParse(input).success).toBe(false);
    expect(() => id(input)).toThrow(Failure);
  }
});

test("out-of-range IDs are rejected without losing precision", () => {
  expect(idSchema.safeParse((MAX_ID + 1n).toString()).success).toBe(false);
  expect(() => id("99999999999999999999")).toThrow("Expected a lossless positive decimal ID.");
});
