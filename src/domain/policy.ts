/** Pure authorization and access policy; these functions require no Discord or database I/O. */
import { Failure } from "./values.js";

/** Permissions are resolved against the invoking guild, not inferred from managed roles. */
export interface Actor {
  guildId: string;
  userId: string;
  officer: boolean;
  manageRoles: boolean;
  /** Keep server-manager authority distinct from delegated, bot-only officer authority. */
  serverManager?: boolean;
  roleIds?: readonly string[];
}

/**
 * Sensitive authority configuration cannot be delegated through the Officer role itself. The
 * refusal carries scope 'manager', so the reply can name the missing Discord permissions.
 */
export function authorizeRoleManager(actor: Actor): void {
  if (!(actor.serverManager ?? actor.officer) || !actor.manageRoles) {
    throw new Failure(
      "forbidden",
      "Changing who has officer authority needs Discord's Manage Server and Manage Roles permissions. Bot officer access isn't enough.",
      0,
      { kind: "scope", scope: "manager" },
    );
  }
}

/**
 * The generic officer-level refusal. The reply presenter recognises exactly this text and names the
 * command instead ("Only FC officers can use /config."); refusals with their own approved wording
 * (withdrawals, a past FC's ledger, forced refreshes) are shown as written.
 */
export const OFFICERS_ONLY = "Only FC officers can do that.";

/**
 * Recheck guild ownership and privilege at the application boundary, including private reads.
 * Each refusal names its rule in the scope detail (another guild, the officer level, or another
 * member's record), so replies never match on message text. The decisions themselves are
 * unchanged.
 */
export function authorize(
  actor: Actor,
  guildId: string,
  level: "user" | "officer",
  owner?: string,
): void {
  if (actor.guildId !== guildId)
    throw new Failure("forbidden", "That record belongs to another server.", 0, {
      kind: "scope",
      scope: "test_guild",
    });
  if (level === "officer" && !actor.officer)
    throw new Failure("forbidden", OFFICERS_ONLY, 0, {
      kind: "scope",
      scope: "officer",
    });
  if (owner !== undefined && owner !== actor.userId && !actor.officer)
    throw new Failure(
      "forbidden",
      "You can view only your own records. Officers can look up other members.",
      0,
      { kind: "scope", scope: "owner" },
    );
}

/** Confirmed policy facts plus observed roles; uncertainty must not masquerade as absence. */
export interface AccessFacts {
  membership: "member" | "ineligible" | "uncertain";
  fresh: boolean;
  former: boolean;
  grant: boolean;
  revoked: boolean;
  hasMember: boolean;
  hasGuest: boolean;
  /**
   * Any active trusted character link registers the user; in every guild, with or without lobby
   * onboarding, it qualifies a non-member for Guest (ROLE-07). The name predates 2.13.0 and is kept
   * because reconciliation and `/guest status` read it.
   */
  verified?: boolean;
}

/**
 * Classify FC membership as the union over a user's active trusted links for the guild's currently
 * linked FC (ROLE-07): one confirmed character (present, or awaiting departure confirmation) makes
 * the user a member whatever their other links show. An unevaluated link keeps the user uncertain
 * unless a local unlink already removed their last confirmed character.
 */
export function membershipClass(counts: {
  fcLinked: boolean;
  confirmed: bigint;
  unknown: bigint;
  localLoss: boolean;
}): AccessFacts["membership"] {
  if (!counts.fcLinked) return "ineligible";
  if (counts.confirmed > 0n) return "member";
  return counts.unknown > 0n && !counts.localLoss ? "uncertain" : "ineligible";
}

/**
 * Member access wins; revocation suppresses guest access without changing FC eligibility.
 * Precedence over the link union: a member class never gains Guest (stale evidence only keeps one
 * already held until Member can be added); an uncertain class keeps held roles and honors durable
 * grants, but neither former-member history nor registration creates a role; an ineligible class
 * receives Guest from a durable grant, former-member history, or registration (at least one
 * trusted link, `verified`), where registration needs fresh evidence to add Guest and stale
 * evidence only keeps a held one.
 */
export function desiredAccess(facts: AccessFacts): { member: boolean; guest: boolean } {
  if (facts.membership === "member") {
    // Stale evidence can retain an existing grant, but cannot create a new member-role grant.
    const member = facts.fresh || facts.hasMember;
    return { member, guest: member ? false : facts.revoked ? false : facts.hasGuest };
  }
  if (facts.membership === "uncertain") {
    // Explicit local guest decisions remain enforceable while upstream membership is unknown.
    return {
      member: facts.hasMember,
      guest: !facts.hasMember && !facts.revoked && (facts.grant || facts.hasGuest),
    };
  }
  return {
    member: false,
    guest:
      !facts.revoked &&
      (facts.grant || facts.former || (facts.verified === true && (facts.fresh || facts.hasGuest))),
  };
}

/**
 * Which desiredAccess decisions don't depend on the roles the member already holds (officer status
 * notices, issue #31). The real policy runs once per combination of holding Member and Guest; a
 * flag is decisive when all four agree. Only decisive values are recorded for status posts, so a
 * rebind, an out-of-date roster or a hand edit the policy keeps can never read as a change.
 * Probing the function itself keeps this right if the policy changes. Worked out by class:
 * - member: `member` is decisive only with fresh evidence; `guest` when fresh or revoked (false);
 * - uncertain: `member` never is; `guest` only when revoked (a grant still defers to held Member);
 * - ineligible: `member` always is (false); `guest` is, except for a registered user with stale
 *   evidence and no grant, FC history or revocation (then a held Guest is kept).
 */
export function accessDecisive(facts: AccessFacts): { member: boolean; guest: boolean } {
  const probes = [false, true].flatMap((hasMember) =>
    [false, true].map((hasGuest) => desiredAccess({ ...facts, hasMember, hasGuest })),
  );
  const agree = (flag: "member" | "guest") =>
    probes.every((probe) => probe[flag] === probes[0]?.[flag]);
  return { member: agree("member"), guest: agree("guest") };
}

/** Advance only on accepted complete observations; reappearance clears pending departure. */
export function departure(
  previous: "present" | "missing" | "absent" | undefined,
  appears: boolean,
  firstAbsence: Date | null,
  observation: Date,
): { state: "present" | "missing" | "absent"; firstAbsence: Date | null } {
  if (appears) return { state: "present", firstAbsence: null };
  if (previous === undefined || previous === "absent")
    // A newly linked absent character has no prior confirmed membership to demote.
    return { state: "absent", firstAbsence: null };
  if (
    previous === "missing" &&
    firstAbsence &&
    observation.getTime() - firstAbsence.getTime() >= 60_000
  ) {
    // The first absence is retained across restarts and intermediate observations.
    return { state: "absent", firstAbsence };
  }
  return { state: "missing", firstAbsence: firstAbsence ?? observation };
}
