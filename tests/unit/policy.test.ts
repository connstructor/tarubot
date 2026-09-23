/** Pure policy/value regression tests: precision, role precedence, evidence timing, and Unicode. */
import { expect, test } from "bun:test";
import { departure, desiredAccess, membershipClass } from "../../src/domain/policy.js";
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

test("verified visitors require current classification; revocation wins and uncertain rosters never invent access", () => {
  const visitor = {
    membership: "ineligible" as const,
    fresh: true,
    former: false,
    grant: false,
    revoked: false,
    hasMember: false,
    hasGuest: false,
    verified: true,
  };
  expect(desiredAccess(visitor)).toEqual({ member: false, guest: true });
  expect(desiredAccess({ ...visitor, verified: false })).toEqual({ member: false, guest: false });
  expect(desiredAccess({ ...visitor, revoked: true, hasGuest: true })).toEqual({
    member: false,
    guest: false,
  });
  expect(desiredAccess({ ...visitor, fresh: false })).toEqual({ member: false, guest: false });
  expect(desiredAccess({ ...visitor, fresh: false, hasGuest: true })).toEqual({
    member: false,
    guest: true,
  });
  expect(desiredAccess({ ...visitor, membership: "uncertain" })).toEqual({
    member: false,
    guest: false,
  });
  expect(desiredAccess({ ...visitor, membership: "member", revoked: true })).toEqual({
    member: true,
    guest: false,
  });
});

test("FC membership is the union of trusted links", () => {
  // Counts mirror accessFacts: confirmed = present/missing links, unknown = links never evaluated.
  const counts = { fcLinked: true, confirmed: 0n, unknown: 0n, localLoss: false };
  expect(membershipClass({ ...counts, fcLinked: false, confirmed: 1n })).toBe("ineligible");
  expect(membershipClass({ ...counts, confirmed: 1n, unknown: 1n })).toBe("member");
  expect(membershipClass({ ...counts, confirmed: 1n, localLoss: true })).toBe("member");
  expect(membershipClass(counts)).toBe("ineligible");
  expect(membershipClass({ ...counts, unknown: 1n })).toBe("uncertain");
  // A local unlink of the last confirmed character stops later unevaluated links from protecting access.
  expect(membershipClass({ ...counts, unknown: 1n, localLoss: true })).toBe("ineligible");
});

test("registered users are Guest whatever their other links, and Member wins", () => {
  // `verified` means at least one active trusted link, in onboarding-enabled and -disabled guilds.
  const registered = {
    fresh: true,
    former: false,
    grant: false,
    revoked: false,
    hasMember: false,
    hasGuest: false,
    verified: true,
  };
  const union = (confirmed: bigint, unknown: bigint) =>
    membershipClass({ fcLinked: true, confirmed, unknown, localLoss: false });
  // One character present in the FC and one outside it: Member, never both roles.
  expect(desiredAccess({ ...registered, membership: union(1n, 0n) })).toEqual({
    member: true,
    guest: false,
  });
  // Two characters, both evaluated outside the FC: registered Guest from fresh evidence.
  expect(desiredAccess({ ...registered, membership: union(0n, 0n) })).toEqual({
    member: false,
    guest: true,
  });
  expect(desiredAccess({ ...registered, membership: union(0n, 0n), revoked: true })).toEqual({
    member: false,
    guest: false,
  });
  // One absent plus one unevaluated character: uncertain, so no new Guest is created.
  expect(union(0n, 1n)).toBe("uncertain");
  expect(desiredAccess({ ...registered, membership: union(0n, 1n) })).toEqual({
    member: false,
    guest: false,
  });
});
