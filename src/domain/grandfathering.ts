/**
 * First-activation Guest grandfathering (owner decision 3, 2026-09-23), pure part: classify each
 * current human from the same AccessFacts reconciliation uses, give the reviewed plan a stable
 * identity (its checksum), summarize it for review, and overlay planned grants onto the preview's
 * per-user role deltas. No Discord or database I/O happens here; src/application/grandfathering.ts
 * gathers the facts and writes the grants.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { type AccessFacts, desiredAccess } from "./policy.js";
import { Failure, idSchema, json } from "./values.js";

/**
 * Why a current human is or is not grandfathered:
 * - `member`: confirmed, fresh FC eligibility (ROLE-01), so no Guest grant is owed;
 * - `revoked`: an explicit revocation stands, and grandfathering never clears one;
 * - `existing_grant`: an imported, approved or manual grant is already equally durable;
 * - `grant`: everyone else receives a `grandfathered` grant. This covers former members,
 *   registered visitors, Member holders without a qualifying link, and `uncertain` users, for
 *   whom the grant stays dormant while desiredAccess keeps the Member role they hold.
 */
export type GrandfatherBasis = "member" | "revoked" | "existing_grant" | "grant";

/** Grandfathering state reported by preview and activation. */
export type GrandfatherState = "pending" | "completed" | "not_applicable";

/** Samples stay short enough to review in a terminal; counts always cover the full subset. */
export const GRANDFATHER_SAMPLE = 25;

/** Only confirmed fresh FC eligibility keeps a human out of the grandfathered set. */
export function grandfatherBasis(facts: AccessFacts): GrandfatherBasis {
  if (!facts.fresh)
    throw new Failure("stale", "Acquire a fresh complete roster before grandfathering.");
  if (facts.membership === "member" && desiredAccess(facts).member) return "member";
  if (facts.revoked) return "revoked";
  if (facts.grant) return "existing_grant";
  return "grant";
}

/** One enumerated human and how the plan classifies them; bots never become candidates. */
export interface GrandfatherCandidate {
  userId: string;
  basis: GrandfatherBasis;
  membership: AccessFacts["membership"];
  /** Former FC membership in this guild (ROLE-03 history). */
  former: boolean;
  /** At least one active trusted character link in this guild (registration, ROLE-07). */
  registered: boolean;
  heldMember: boolean;
  heldGuest: boolean;
  /** No imported guild_users row: the user joined after the cutover snapshot. */
  newSinceImport: boolean;
  joinedAt: Date;
  /** Provenance of each grant the user already holds, sorted and distinct. */
  existingProvenance: string[];
  /** desiredAccess once a planned grant exists; a grant never changes the Member bit. */
  projected: { member: boolean; guest: boolean };
}

/**
 * What the checksum covers: the guild, the accepted import, the roster snapshot the evidence came
 * from and the planned user IDs. Timestamps, held roles and nicknames are deliberately excluded,
 * so re-enumerating an unchanged guild reproduces the reviewed checksum, while a new import or any
 * new accepted roster (which can move membership states) requires a new review.
 */
export interface PlanIdentity {
  guildId: string;
  importFingerprint: string | null;
  rosterSnapshotId: string | null;
  grants: readonly string[];
}

/** The complete reviewed plan; preview --output writes exactly this object. */
export interface GrandfatherPlan extends PlanIdentity {
  guestRoleId: string | null;
  enumeratedAt: Date;
  rosterObservedAt: Date | null;
  humans: number;
  bots: number;
  /** Every enumerated human, sorted by user ID. */
  candidates: GrandfatherCandidate[];
  /** Sorted IDs whose basis is `grant`. */
  grants: string[];
  checksum: string;
}

/** Canonical decimal snowflakes compare numerically: by length, then lexically. */
export const compareIds = (left: string, right: string): number =>
  left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);

/** Sorted copy of user IDs in numeric order. */
export function sortIds(ids: Iterable<string>): string[] {
  return [...ids].sort(compareIds);
}

/** sha256 over the plan identity with the user IDs sorted, so enumeration order is irrelevant. */
export function planChecksum(identity: PlanIdentity): string {
  return createHash("sha256")
    .update(
      json({
        guildId: identity.guildId,
        importFingerprint: identity.importFingerprint,
        rosterSnapshotId: identity.rosterSnapshotId,
        grants: sortIds(identity.grants),
      }),
    )
    .digest("hex");
}

/** Assemble a plan from classified candidates: sort them, derive the grant set and its checksum. */
export function assemblePlan(input: {
  guildId: string;
  importFingerprint: string | null;
  rosterSnapshotId: string | null;
  guestRoleId: string | null;
  enumeratedAt: Date;
  rosterObservedAt: Date | null;
  bots: number;
  candidates: readonly GrandfatherCandidate[];
}): GrandfatherPlan {
  const candidates = [...input.candidates].sort((left, right) =>
    compareIds(left.userId, right.userId),
  );
  const grants = candidates
    .filter((candidate) => candidate.basis === "grant")
    .map((candidate) => candidate.userId);
  return {
    guildId: input.guildId,
    importFingerprint: input.importFingerprint,
    rosterSnapshotId: input.rosterSnapshotId,
    guestRoleId: input.guestRoleId,
    enumeratedAt: input.enumeratedAt,
    rosterObservedAt: input.rosterObservedAt,
    humans: candidates.length,
    bots: input.bots,
    candidates,
    grants,
    checksum: planChecksum({ ...input, grants }),
  };
}

/** A reviewed subset: the full count and the first GRANDFATHER_SAMPLE sorted user IDs. */
export interface Subset {
  count: number;
  sample: string[];
}

/** Summarize user IDs as {count, sample}. */
export function subset(ids: Iterable<string>): Subset {
  const sorted = sortIds(ids);
  return { count: sorted.length, sample: sorted.slice(0, GRANDFATHER_SAMPLE) };
}

/**
 * The review summary printed by preview and by a rejected activation. `pendingDepartures` lists
 * users whose FC character awaits departure confirmation; while any remain, no plan exists and
 * `blocked` says why (amendment C2). Plan-derived fields are null without a plan.
 */
export function grandfatherReport(input: {
  state: GrandfatherState;
  plan: GrandfatherPlan | null;
  completedAt: Date | null;
  pendingDepartures?: Subset;
  blocked?: string | null;
}) {
  const { plan } = input;
  const all = plan?.candidates ?? [];
  const planned = all.filter((candidate) => candidate.basis === "grant");
  const pick = (
    rows: readonly GrandfatherCandidate[],
    keep: (candidate: GrandfatherCandidate) => boolean,
  ) => subset(rows.filter(keep).map((candidate) => candidate.userId));
  const existing = all.filter((candidate) => candidate.basis === "existing_grant");
  // Each provenance counts once per user, even if a user holds two grants of that kind.
  const byProvenance: Record<string, number> = {};
  for (const candidate of existing)
    for (const provenance of new Set(candidate.existingProvenance))
      byProvenance[provenance] = (byProvenance[provenance] ?? 0) + 1;
  return {
    state: input.state,
    completedAt: input.completedAt,
    blocked: input.blocked ?? null,
    planChecksum: plan?.checksum ?? null,
    importFingerprint: plan?.importFingerprint ?? null,
    rosterSnapshotId: plan?.rosterSnapshotId ?? null,
    enumeratedAt: plan?.enumeratedAt ?? null,
    rosterObservedAt: plan?.rosterObservedAt ?? null,
    humans: plan?.humans ?? null,
    bots: plan?.bots ?? null,
    memberEligible: plan ? all.filter((candidate) => candidate.basis === "member").length : null,
    pendingDepartures: input.pendingDepartures ?? subset([]),
    planned: plan ? subset(planned.map((candidate) => candidate.userId)) : null,
    plannedDetail: plan
      ? {
          // Member removals caused by this plan; uncertain holders keep Member (dormant grant).
          memberRoleRemoved: pick(planned, (c) => c.heldMember && !c.projected.member),
          guestRoleAdded: pick(planned, (c) => !c.heldGuest && c.projected.guest),
          guestRoleAlreadyHeld: pick(planned, (c) => c.heldGuest),
          uncertainKeepsMember: pick(
            planned,
            (c) => c.membership === "uncertain" && c.heldMember && c.projected.member,
          ),
          formerMembers: pick(planned, (c) => c.former),
          registeredVisitors: pick(planned, (c) => c.registered),
          newSinceImport: pick(planned, (c) => c.newSinceImport),
        }
      : null,
    skipped: plan
      ? {
          existingGrant: { ...pick(existing, () => true), byProvenance },
          revoked: pick(all, (c) => c.basis === "revoked"),
        }
      : null,
  };
}

/** A preview action with a role delta; `{skipped}` results fail this shape and pass unchanged. */
const actionSchema = z.looseObject({
  user: z.string(),
  add: z.array(z.string()),
  remove: z.array(z.string()),
});
/** Planned candidates per plan, built once however many actions are overlaid. */
const plannedIndex = new WeakMap<GrandfatherPlan, Map<string, GrandfatherCandidate>>();

/**
 * Preview only: show a planned user's delta as it will be once activation writes their grant.
 * Adds the Guest role when the projection grants it (and drops it from `remove`), sets `desired`
 * to the projection and marks the action `grandfathered: 'planned'`. Member, Officer, Leader and
 * retired-role entries are untouched because a grant never changes them.
 */
export function overlayPlannedGrant(action: unknown, plan: GrandfatherPlan): unknown {
  const parsed = actionSchema.safeParse(action);
  if (!parsed.success) return action;
  let planned = plannedIndex.get(plan);
  if (!planned) {
    planned = new Map(
      plan.candidates
        .filter((candidate) => candidate.basis === "grant")
        .map((candidate) => [candidate.userId, candidate]),
    );
    plannedIndex.set(plan, planned);
  }
  const candidate = planned.get(parsed.data.user);
  if (!candidate) return action;
  const guest = plan.guestRoleId;
  let add = [...parsed.data.add];
  let remove = [...parsed.data.remove];
  if (guest && candidate.projected.guest) {
    remove = remove.filter((role) => role !== guest);
    if (!candidate.heldGuest && !add.includes(guest)) add = [...add, guest];
  }
  return {
    ...parsed.data,
    add,
    remove,
    desired: candidate.projected,
    grandfathered: "planned",
  };
}

/** The identity fields of a plan file written by preview --output, as activation reads it. */
export interface ReviewedPlan extends PlanIdentity {
  checksum: string;
}

const reviewedPlanSchema = z.looseObject({
  guildId: idSchema,
  importFingerprint: z.string().nullable(),
  rosterSnapshotId: z.string().nullable(),
  grants: z.array(idSchema),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * Validate a reviewed plan file against the checksum the operator confirmed. The file must be
 * self-consistent (its identity hashes to its own checksum, so an edited grant list is refused)
 * and must be the plan for that checksum.
 */
export function reviewedPlan(value: unknown, confirmed: string): ReviewedPlan {
  const parsed = reviewedPlanSchema.safeParse(value);
  if (!parsed.success)
    throw new Failure("input", "The grandfathering plan file is not a preview --output plan.");
  const plan = parsed.data;
  if (planChecksum(plan) !== plan.checksum)
    throw new Failure(
      "input",
      "The grandfathering plan file was modified: its contents do not match its checksum.",
    );
  if (plan.checksum !== confirmed)
    throw new Failure(
      "input",
      `The grandfathering plan file is plan ${plan.checksum}, not --grandfather-plan ${confirmed}.`,
    );
  return {
    guildId: plan.guildId,
    importFingerprint: plan.importFingerprint,
    rosterSnapshotId: plan.rosterSnapshotId,
    grants: sortIds(plan.grants),
    checksum: plan.checksum,
  };
}

/** How the current plan differs from the reviewed one, so only the difference needs review. */
export interface PlanDifference {
  added: string[];
  removed: string[];
  guildChanged: boolean;
  importChanged: boolean;
  rosterSnapshotChanged: boolean;
}

/** Added and removed user IDs relative to the reviewed plan, plus which evidence changed. */
export function planDifference(reviewed: PlanIdentity, current: PlanIdentity): PlanDifference {
  const before = new Set(reviewed.grants);
  const after = new Set(current.grants);
  return {
    added: sortIds([...after].filter((user) => !before.has(user))),
    removed: sortIds([...before].filter((user) => !after.has(user))),
    guildChanged: reviewed.guildId !== current.guildId,
    importChanged: reviewed.importFingerprint !== current.importFingerprint,
    rosterSnapshotChanged: reviewed.rosterSnapshotId !== current.rosterSnapshotId,
  };
}
