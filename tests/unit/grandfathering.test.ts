/**
 * First-activation grandfathering, pure part: classification, plan identity (amendment C8), the
 * review report including pending departures (C2), the preview overlay, the reviewed-plan file and
 * the activate/preview command lines (C11).
 */
import { expect, test } from "bun:test";
import { parseActivateArguments } from "../../scripts/activate.js";
import { parsePreviewArguments, roleTotals } from "../../scripts/preview.js";
import { alreadyActive, guestApplicationsChoice } from "../../src/application/activation.js";
import {
  assemblePlan,
  GRANDFATHER_SAMPLE,
  type GrandfatherCandidate,
  grandfatherBasis,
  grandfatherReport,
  overlayPlannedGrant,
  planChecksum,
  planDifference,
  reviewedPlan,
  subset,
} from "../../src/domain/grandfathering.js";
import { type AccessFacts, desiredAccess } from "../../src/domain/policy.js";
import { Failure, json } from "../../src/domain/values.js";

/** A fresh, ineligible, role-less human with no grant or history. */
const facts = (overrides: Partial<AccessFacts> = {}): AccessFacts => ({
  membership: "ineligible",
  fresh: true,
  former: false,
  grant: false,
  revoked: false,
  hasMember: false,
  hasGuest: false,
  verified: false,
  ...overrides,
});

/** A planned (basis `grant`) candidate unless overridden. */
const candidate = (
  userId: string,
  overrides: Partial<GrandfatherCandidate> = {},
): GrandfatherCandidate => ({
  userId,
  basis: "grant",
  membership: "ineligible",
  former: false,
  registered: false,
  heldMember: false,
  heldGuest: false,
  newSinceImport: false,
  joinedAt: new Date("2026-01-01T00:00:00Z"),
  existingProvenance: [],
  projected: { member: false, guest: true },
  ...overrides,
});

const plan = (candidates: GrandfatherCandidate[], overrides: { enumeratedAt?: Date } = {}) =>
  assemblePlan({
    guildId: "1036062273631952955",
    importFingerprint: "fingerprint-1",
    rosterSnapshotId: "00000000-0000-4000-8000-000000000001",
    guestRoleId: "700",
    enumeratedAt: overrides.enumeratedAt ?? new Date("2026-09-23T00:00:00Z"),
    rosterObservedAt: new Date("2026-09-22T23:00:00Z"),
    bots: 2,
    candidates,
  });

test("grandfathering keeps only confirmed fresh FC eligibility out of the grant set", () => {
  // A 'missing' imported baseline still classifies as member until a roster confirms departure.
  expect(grandfatherBasis(facts({ membership: "member" }))).toBe("member");
  expect(grandfatherBasis(facts({ membership: "member", hasMember: true }))).toBe("member");
  // Member precedence: a revocation does not change FC eligibility.
  expect(grandfatherBasis(facts({ membership: "member", revoked: true }))).toBe("member");
  for (const grant of [
    facts(),
    facts({ former: true }),
    facts({ verified: true }),
    facts({ hasMember: true }),
    facts({ membership: "uncertain" }),
    facts({ membership: "uncertain", hasMember: true }),
  ])
    expect(grandfatherBasis(grant)).toBe("grant");
  expect(grandfatherBasis(facts({ grant: true }))).toBe("existing_grant");
  expect(grandfatherBasis(facts({ revoked: true, grant: true }))).toBe("revoked");
  expect(grandfatherBasis(facts({ revoked: true }))).toBe("revoked");
  expect(() => grandfatherBasis(facts({ fresh: false }))).toThrow(
    expect.objectContaining({ code: "stale" }),
  );
});

test("a grant never changes the Member bit for any membership state or held role", () => {
  for (const membership of ["member", "ineligible", "uncertain"] as const)
    for (const fresh of [true, false])
      for (const hasMember of [true, false])
        for (const revoked of [true, false]) {
          const base = facts({ membership, fresh, hasMember, revoked });
          expect(desiredAccess({ ...base, grant: true }).member).toBe(desiredAccess(base).member);
        }
});

test("plan checksum covers the guild, import, roster snapshot and grant set only", () => {
  const identity = {
    guildId: "1036062273631952955",
    importFingerprint: "fingerprint-1",
    rosterSnapshotId: "00000000-0000-4000-8000-000000000001",
    grants: ["300", "20", "1000"],
  };
  const checksum = planChecksum(identity);
  expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  // Enumeration order is irrelevant.
  expect(planChecksum({ ...identity, grants: ["1000", "300", "20"] })).toBe(checksum);
  for (const changed of [
    { ...identity, grants: ["300", "20"] },
    { ...identity, grants: [...identity.grants, "4000"] },
    { ...identity, guildId: "1040379370159743139" },
    { ...identity, importFingerprint: "fingerprint-2" },
    { ...identity, importFingerprint: null },
    { ...identity, rosterSnapshotId: "00000000-0000-4000-8000-000000000002" },
  ])
    expect(planChecksum(changed)).not.toBe(checksum);
});

test("plan checksum ignores held roles, join times and enumeration time", () => {
  const first = plan([candidate("30"), candidate("10"), candidate("20", { basis: "member" })]);
  // Same planned users re-enumerated later, with different roles, join dates and order.
  const second = plan(
    [
      candidate("20", { basis: "member", heldMember: true }),
      candidate("10", { heldGuest: true, joinedAt: new Date("2026-09-22T00:00:00Z") }),
      candidate("30", { heldMember: true, projected: { member: false, guest: true } }),
    ],
    { enumeratedAt: new Date("2026-09-23T02:00:00Z") },
  );
  expect(first.grants).toEqual(["10", "30"]);
  expect(second.checksum).toBe(first.checksum);
  expect(first.candidates.map((row) => row.userId)).toEqual(["10", "20", "30"]);
  expect(first).toMatchObject({ humans: 3, bots: 2 });
});

test("report counts subsets, bounds samples and tallies skipped provenance", () => {
  // 30 planned users: numeric order puts 9 before 10, and only 25 are sampled.
  const planned = Array.from({ length: 30 }, (_, index) =>
    candidate(String(index + 1), {
      heldMember: index < 4,
      heldGuest: index >= 28,
      newSinceImport: index % 10 === 0,
      former: index === 5,
      registered: index === 6 || index === 7,
      // Two uncertain Member holders keep Member behind a dormant grant.
      ...(index < 2
        ? { membership: "uncertain" as const, projected: { member: true, guest: false } }
        : {}),
    }),
  );
  const report = grandfatherReport({
    state: "pending",
    plan: plan([
      ...planned,
      candidate("100", { basis: "member" }),
      candidate("101", { basis: "existing_grant", existingProvenance: ["imported_guest"] }),
      candidate("102", { basis: "existing_grant", existingProvenance: ["approved", "manual"] }),
      candidate("103", { basis: "existing_grant", existingProvenance: ["imported_guest"] }),
      candidate("104", { basis: "revoked" }),
    ]),
    completedAt: null,
  });
  expect(report.planned?.count).toBe(30);
  expect(report.planned?.sample).toHaveLength(GRANDFATHER_SAMPLE);
  expect(report.planned?.sample.slice(8, 11)).toEqual(["9", "10", "11"]);
  expect(report.planned?.sample.at(-1)).toBe("25");
  expect(report).toMatchObject({
    state: "pending",
    completedAt: null,
    blocked: null,
    humans: 35,
    bots: 2,
    memberEligible: 1,
    pendingDepartures: { count: 0, sample: [] },
    plannedDetail: {
      memberRoleRemoved: { count: 2, sample: ["3", "4"] },
      guestRoleAdded: { count: 26 },
      guestRoleAlreadyHeld: { count: 2, sample: ["29", "30"] },
      uncertainKeepsMember: { count: 2, sample: ["1", "2"] },
      formerMembers: { count: 1, sample: ["6"] },
      registeredVisitors: { count: 2, sample: ["7", "8"] },
      newSinceImport: { count: 3, sample: ["1", "11", "21"] },
    },
    skipped: {
      existingGrant: {
        count: 3,
        sample: ["101", "102", "103"],
        byProvenance: { imported_guest: 2, approved: 1, manual: 1 },
      },
      revoked: { count: 1, sample: ["104"] },
    },
  });
  expect(report.planChecksum).toMatch(/^[0-9a-f]{64}$/);
});

test("completed, not-applicable and blocked reports carry no plan fields", () => {
  const completedAt = new Date("2026-09-23T01:00:00Z");
  const completed = grandfatherReport({ state: "completed", plan: null, completedAt });
  expect(completed).toMatchObject({
    state: "completed",
    completedAt,
    planChecksum: null,
    humans: null,
    planned: null,
    plannedDetail: null,
    skipped: null,
    pendingDepartures: { count: 0, sample: [] },
  });
  expect(
    grandfatherReport({ state: "not_applicable", plan: null, completedAt: null }),
  ).toMatchObject({ state: "not_applicable", completedAt: null, planChecksum: null });
  // Pending departures block the plan and are reported with a sample (C2).
  const blocked = grandfatherReport({
    state: "pending",
    plan: null,
    completedAt: null,
    pendingDepartures: subset(["20", "3"]),
    blocked: "Confirm departures first.",
  });
  expect(blocked).toMatchObject({
    state: "pending",
    blocked: "Confirm departures first.",
    pendingDepartures: { count: 2, sample: ["3", "20"] },
    planChecksum: null,
  });
});

test("preview overlay adds only the planned Guest delta", () => {
  const reviewed = plan([
    candidate("1"),
    candidate("2", { heldGuest: true }),
    // An uncertain Member holder keeps Member; the dormant grant adds no Guest.
    candidate("3", {
      membership: "uncertain",
      heldMember: true,
      projected: { member: true, guest: false },
    }),
    candidate("4", { basis: "member", projected: { member: true, guest: false } }),
  ]);
  // Member removal and retired-role cleanup stay; Guest is added once.
  expect(
    overlayPlannedGrant(
      {
        user: "1",
        add: [],
        remove: ["500", "900"],
        desired: { member: false, guest: false },
        nickname: { current: "A", desired: "A" },
      },
      reviewed,
    ),
  ).toEqual({
    user: "1",
    add: ["700"],
    remove: ["500", "900"],
    desired: { member: false, guest: true },
    nickname: { current: "A", desired: "A" },
    grandfathered: "planned",
  });
  // A held Guest that current facts would remove is kept instead.
  expect(overlayPlannedGrant({ user: "2", add: [], remove: ["700"] }, reviewed)).toEqual({
    user: "2",
    add: [],
    remove: [],
    desired: { member: false, guest: true },
    grandfathered: "planned",
  });
  expect(overlayPlannedGrant({ user: "3", add: ["800"], remove: [] }, reviewed)).toEqual({
    user: "3",
    add: ["800"],
    remove: [],
    desired: { member: true, guest: false },
    grandfathered: "planned",
  });
  // Unplanned users and skipped results pass through unchanged.
  const member = { user: "4", add: ["500"], remove: [] };
  expect(overlayPlannedGrant(member, reviewed)).toBe(member);
  const skipped = { skipped: "user absent or bot" };
  expect(overlayPlannedGrant(skipped, reviewed)).toBe(skipped);
});

test("a reviewed plan file must be self-consistent and match the confirmed checksum", () => {
  const reviewed = plan([candidate("10"), candidate("30")]);
  // The file round-trips through JSON exactly as preview --output writes it.
  const file = JSON.parse(json(reviewed, 2));
  expect(reviewedPlan(file, reviewed.checksum)).toEqual({
    guildId: reviewed.guildId,
    importFingerprint: "fingerprint-1",
    rosterSnapshotId: reviewed.rosterSnapshotId,
    grants: ["10", "30"],
    checksum: reviewed.checksum,
  });
  const refused = (value: unknown, confirmed = reviewed.checksum) => {
    try {
      reviewedPlan(value, confirmed);
    } catch (error) {
      return error instanceof Failure ? error.code : "other";
    }
    return "accepted";
  };
  expect(refused({ ...file, grants: ["10"] })).toBe("input");
  expect(refused(file, "0".repeat(64))).toBe("input");
  expect(refused({ checksum: reviewed.checksum })).toBe("input");
});

test("a changed plan reports only the added and removed users and which evidence moved", () => {
  const before = plan([candidate("10"), candidate("20"), candidate("30")]);
  const after = {
    ...before,
    rosterSnapshotId: "00000000-0000-4000-8000-000000000002",
    grants: ["20", "30", "40", "5"],
  };
  expect(planDifference(before, after)).toEqual({
    added: ["5", "40"],
    removed: ["10"],
    guildChanged: false,
    importChanged: false,
    rosterSnapshotChanged: true,
  });
});

test("activation choices: no-op reruns and explicit guest applications", () => {
  expect(
    alreadyActive({ active: true, effects_enabled: true, guest_grandfather: "completed" }),
  ).toBe(true);
  expect(alreadyActive({ active: true, effects_enabled: true, guest_grandfather: null })).toBe(
    true,
  );
  expect(alreadyActive({ active: true, effects_enabled: true, guest_grandfather: "pending" })).toBe(
    false,
  );
  expect(alreadyActive({ active: true, effects_enabled: false, guest_grandfather: null })).toBe(
    false,
  );
  // 2.15.0 imports store the legacy review channel with the switch off: no choice keeps it off,
  // `open` switches it on, and `closed` is already the state (owner decision, 2026-09-24).
  const imported = { guest_application_channel_id: "555", guest_applications_enabled: false };
  expect(guestApplicationsChoice(imported, undefined)).toBeUndefined();
  expect(guestApplicationsChoice(imported, "closed")).toBeUndefined();
  expect(guestApplicationsChoice(imported, "open")).toBe(true);
  const unset = { guest_application_channel_id: null, guest_applications_enabled: false };
  expect(guestApplicationsChoice(unset, undefined)).toBeUndefined();
  expect(guestApplicationsChoice(unset, "closed")).toBeUndefined();
  expect(() => guestApplicationsChoice(unset, "open")).toThrow(
    expect.objectContaining({ code: "input" }),
  );
  // An open guild closes only when asked, and keeps its channel either way.
  const open = { guest_application_channel_id: "555", guest_applications_enabled: true };
  expect(guestApplicationsChoice(open, undefined)).toBeUndefined();
  expect(guestApplicationsChoice(open, "closed")).toBe(false);
  expect(guestApplicationsChoice(open, "open")).toBeUndefined();
});

test("activate and preview command lines are strict", () => {
  const sha = "a".repeat(64);
  expect(parseActivateArguments(["1036062273631952955"])).toEqual({
    guildId: "1036062273631952955",
    requeue: false,
  });
  expect(
    parseActivateArguments([
      "1036062273631952955",
      "--grandfather-plan",
      sha,
      "--grandfather-plan-file",
      "plan.json",
      "--guest-applications",
      "closed",
      "--requeue",
    ]),
  ).toEqual({
    guildId: "1036062273631952955",
    grandfatherPlan: sha,
    planFile: "plan.json",
    guestApplications: "closed",
    requeue: true,
  });
  for (const invalid of [
    [],
    ["not-a-guild"],
    ["1036062273631952955", "--grandfather-plan", "short"],
    ["1036062273631952955", "--grandfather-plan-file", "plan.json"],
    ["1036062273631952955", "--guest-applications", "maybe"],
    ["1036062273631952955", "--grandfather-plan", sha, "--grandfather-plan", sha],
    ["1036062273631952955", "--grandfather-plan"],
    ["1036062273631952955", "--force"],
    ["1036062273631952955", "1040379370159743139"],
  ])
    expect(() => parseActivateArguments(invalid)).toThrow(Failure);
  expect(parsePreviewArguments(["1036062273631952955", "--output", "work/plan.json"])).toEqual({
    guildId: "1036062273631952955",
    output: "work/plan.json",
    lateJoiners: false,
  });
  expect(parsePreviewArguments(["1036062273631952955", "--late-joiners"])).toEqual({
    guildId: "1036062273631952955",
    lateJoiners: true,
  });
  for (const invalid of [
    [],
    ["1036062273631952955", "--output"],
    ["1036062273631952955", "--late-joiners", "--output", "plan.json"],
    ["1036062273631952955", "--dump", "x"],
  ])
    expect(() => parsePreviewArguments(invalid)).toThrow(Failure);
});

test("role totals count additions and removals per managed binding", () => {
  expect(
    roleTotals(
      [
        { user: "1", add: ["700"], remove: ["500"] },
        { user: "2", add: ["700"], remove: ["500", "900"] },
        { user: "3", add: [], remove: [] },
        { skipped: "user absent or bot" },
      ],
      { member: "500", guest: "700", officer: "600", leader: null },
    ),
  ).toEqual({
    "700": { binding: "guest", add: 2, remove: 0 },
    "500": { binding: "member", add: 0, remove: 2 },
    "900": { binding: "retired", add: 0, remove: 1 },
  });
});
