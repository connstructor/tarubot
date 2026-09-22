/** Pure policy/value regression tests: precision, role precedence, evidence timing, and Unicode. */
import { expect, test } from "bun:test";
import { departure, desiredAccess } from "../../src/domain/policy.js";
import { gil, id, lodestoneId, nickname } from "../../src/domain/values.js";

test("IDs preserve unsigned 64-bit values and reject unsafe numbers", () => {
  // The unsafe Number is deliberate: adapters must reject precision that is already lost.
  expect(id("9232097761132958152")).toBe("9232097761132958152");
  for (const invalid of [Number("9232097761132958152"), "01", "0", "18446744073709551616", -1, 1.2])
    expect(() => id(invalid)).toThrow();
  expect(() => lodestoneId("https://evil.test/lodestone/character/1/", "character")).toThrow();
});
test("money is exact, bounded, and integral", () => {
  expect(gil("9223372036854775807")).toBe(9223372036854775807n);
  for (const invalid of ["9223372036854775808", "1.2", "-1", "00"])
    expect(() => gil(invalid)).toThrow();
});
test("departure needs two separated observations and reappearance resets it", () => {
  // Exact boundary instants make the two-observation rule independent of wall-clock sleeps.
  const first = new Date("2026-01-01T00:00:00Z");
  expect(departure("present", false, null, first).state).toBe("missing");
  expect(departure("missing", false, first, new Date(first.getTime() + 59999)).state).toBe(
    "missing",
  );
  expect(departure("missing", false, first, new Date(first.getTime() + 60000)).state).toBe(
    "absent",
  );
  expect(departure("missing", true, first, first)).toEqual({
    state: "present",
    firstAbsence: null,
  });
});
test("member precedence, revocation, former membership, and uncertain evidence", () => {
  const base = {
    fresh: true,
    former: true,
    grant: true,
    revoked: true,
    hasMember: false,
    hasGuest: true,
  };
  expect(desiredAccess({ ...base, membership: "member" })).toEqual({ member: true, guest: false });
  expect(desiredAccess({ ...base, membership: "ineligible" })).toEqual({
    member: false,
    guest: false,
  });
  expect(desiredAccess({ ...base, membership: "ineligible", revoked: false })).toEqual({
    member: false,
    guest: true,
  });
  expect(desiredAccess({ ...base, membership: "uncertain", hasMember: true })).toEqual({
    member: true,
    guest: false,
  });
  expect(desiredAccess({ ...base, membership: "member", fresh: false })).toEqual({
    member: false,
    guest: false,
  });
});
test("nickname truncation does not split graphemes or exceed Discord's limit", () => {
  // A multi-code-point astronaut is one grapheme and must be retained or removed as a whole.
  const name = `${"x".repeat(30)}👩‍🚀`;
  expect(nickname(name)).toBe("x".repeat(30));
});
