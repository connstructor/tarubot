/**
 * Officer status notices (2.29.0, issue #31; owner decisions of 2026-09-25, REQUIREMENTS.md
 * "Approved status-notice amendments"): the per-member state behind the one post in the officer
 * notifications channel that lists gained or lost Member, Guest, Officer and FC Leader, and the
 * linked characters that left the FC. Pure: the application layer reads and writes the state on
 * `guild_users` (migration 010) and calls these functions under the member's row lock.
 *
 * A member's state keeps, per flag, the value last announced (or silently taken as the baseline)
 * and the last decisive value: one that doesn't depend on the roles the member already holds
 * (accessDecisive, rankDecisive). A member is pending when a flag differs between the two, or a
 * confirmed departure is unposted. A change reversed before the post cancels itself, so there is
 * no change log and no collapse step. Only decisive values are recorded, so a rebind, an
 * out-of-date roster or a hand edit the policy keeps never reads as a change.
 */
import { z } from "zod";

/** A status post goes out this long after the first change it holds (owner decision 3). */
export const STATUS_WINDOW_SECONDS = 120;
/** At most this many members per post; fewer when their lines wouldn't fit (decision 4). */
export const STATUS_POST_MEMBERS = 100;

/** The four access flags a status post reports, in the order they are recorded. */
export const STATUS_FLAGS = ["member", "guest", "officer", "leader"] as const;
/** One access flag. */
export type Flag = (typeof STATUS_FLAGS)[number];

/**
 * Why a decisive value is what it is, derived from the facts the policy read (statusReason). The
 * presenter turns each into its words; `is_member` shows as part of "→ Member".
 */
export const REASON_CODES = [
  "in_fc",
  "not_in_fc",
  "no_fc",
  "guest_grant",
  "former_member",
  "registered",
  "is_member",
  "guest_revoked",
  "no_guest_basis",
  "officer_override",
  "officer_rank",
  "officer_revoked",
  "officer_rank_unset",
  "no_officer_rank",
  "fc_leader",
  "no_fc_leader",
] as const;
/** One reason code. */
export type ReasonCode = (typeof REASON_CODES)[number];

/** A flag's value: null while its role is unbound, or before the first decisive observation. */
const flagValue = z.boolean().nullable();
const flagsSchema = z.object({
  member: flagValue,
  guest: flagValue,
  officer: flagValue,
  leader: flagValue,
});
/** One value per flag. */
export type Flags = z.infer<typeof flagsSchema>;
const reasonsSchema = z.partialRecord(z.enum(STATUS_FLAGS), z.enum(REASON_CODES));
/** The reason for each flag whose last decisive value differs from the announced one. */
export type Reasons = z.infer<typeof reasonsSchema>;
/** A confirmed FC departure of a linked character, from the roster snapshot that confirmed it. */
const departureSchema = z.object({
  character: z.string(),
  name: z.string(),
  world: z.string(),
  snapshot: z.string(),
});
/** One confirmed departure, with the character's last known name and world. */
export type Departure = z.infer<typeof departureSchema>;

/** `guild_users.status_state`, validated on every read. */
export const statusStateSchema = z.object({
  /** The member.joinedAt (ISO) this baseline belongs to; null for a departure-only state. */
  joined: z.string().nullable(),
  /** The last posted values, or the silent baseline. */
  announced: flagsSchema,
  /** The last decisive values. */
  current: flagsSchema,
  reasons: reasonsSchema,
  /** Confirmed departures not yet posted, oldest first. */
  departed: z.array(departureSchema),
});
/** A member's status state. */
export type StatusState = z.infer<typeof statusStateSchema>;

/**
 * The lines one member contributes to a post, frozen with the batch: the announced values (`from`),
 * those values with every pending flag replaced by its decisive value (`to`), the reasons of the
 * pending flags, and the unposted departures. `joined` is copied from the state at freeze, so the
 * mark can tell whether the member rejoined while the post was in flight.
 */
export const statusEntrySchema = z.object({
  user: z.string(),
  joined: z.string().nullable(),
  from: flagsSchema,
  to: flagsSchema,
  reasons: reasonsSchema,
  departed: z.array(departureSchema),
});
/** One member's frozen lines. */
export type StatusEntry = z.infer<typeof statusEntrySchema>;

/**
 * `guild_users.status_posting`: this member's entry in the batch being sent. The batch UUID is the
 * nonce key's; `seq` orders the entries and `frozenAt` (ISO) is the post's timestamp, so a resend
 * renders byte-identical content.
 */
export const statusPostingSchema = z.object({
  batch: z.uuid(),
  seq: z.number().int().nonnegative(),
  frozenAt: z.string(),
  entry: statusEntrySchema,
});
/** A frozen batch membership. */
export type StatusPosting = z.infer<typeof statusPostingSchema>;

/** A stored state, or null when there is none or it can't be read (then a new silent baseline). */
export function readState(value: unknown): StatusState | null {
  const parsed = statusStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
/** A stored posting, or null when there is none or it can't be read. */
export function readPosting(value: unknown): StatusPosting | null {
  const parsed = statusPostingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Every flag null. */
const noFlags = (): Flags => ({ member: null, guest: null, officer: null, leader: null });

/** The same state rebuilt with a fixed key order, so equal states serialize identically. */
function normalized(state: StatusState): StatusState {
  const flags = (value: Flags): Flags => ({
    member: value.member,
    guest: value.guest,
    officer: value.officer,
    leader: value.leader,
  });
  const reasons: Reasons = {};
  for (const flag of STATUS_FLAGS) {
    const reason = state.reasons[flag];
    if (reason) reasons[flag] = reason;
  }
  return {
    joined: state.joined,
    announced: flags(state.announced),
    current: flags(state.current),
    reasons,
    departed: state.departed.map((departure) => ({
      character: departure.character,
      name: departure.name,
      world: departure.world,
      snapshot: departure.snapshot,
    })),
  };
}

/** Whether two states hold the same values. */
const sameState = (a: StatusState, b: StatusState): boolean =>
  JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));

/** Flags with both values known and different: what the member is waiting to have announced. */
export function changedFlags(state: Pick<StatusState, "announced" | "current">): Flag[] {
  return STATUS_FLAGS.filter(
    (flag) =>
      state.announced[flag] !== null &&
      state.current[flag] !== null &&
      state.announced[flag] !== state.current[flag],
  );
}

/** Keep a reason only for a flag that is still waiting; any other reason is stale. */
function tidied(state: StatusState): StatusState {
  const waiting = new Set(changedFlags(state));
  const reasons: Reasons = {};
  for (const flag of STATUS_FLAGS) {
    const reason = state.reasons[flag];
    if (reason && waiting.has(flag)) reasons[flag] = reason;
  }
  return { ...state, reasons };
}

/** Whether the member has something waiting to be announced. */
export function isPending(state: StatusState): boolean {
  return changedFlags(state).length > 0 || state.departed.length > 0;
}

/** One pass's view of a flag: its value (null while unbound), whether it is decisive, and why. */
export interface FlagObservation {
  readonly value: boolean | null;
  readonly decisive: boolean;
  /** Why the value is what it is; used only when the value is decisive and differs. */
  readonly reason: ReasonCode;
}
/** One reconciliation pass's view of every flag. */
export type Observation = Readonly<Record<Flag, FlagObservation>>;

/** What recording one pass does to a member's state. */
export interface Observed {
  readonly next: StatusState;
  /** The stored state must be written (an unchanged pass writes nothing). */
  readonly changed: boolean;
  /** Something is waiting to be announced after this pass. */
  readonly pending: boolean;
  /** A decisive value moved against a known baseline: the guild's status post is queued. */
  readonly moved: boolean;
}

/**
 * Record one successful reconciliation pass (§4 of the plan):
 * - a new join context (no state, or `joined` differs from the member's join time) resets every
 *   flag to null and keeps the unposted departures, so a rejoin is a silent baseline;
 * - an unbound flag becomes null (silently; a later rebind is null → value, also silent);
 * - a decisive flag with no baseline takes the value as its baseline, silently;
 * - any other decisive flag takes the value, with its reason while it differs from the announced
 *   one;
 * - a non-decisive flag is left alone in both directions.
 */
export function observe(
  previous: StatusState | null,
  observation: Observation,
  joined: string,
): Observed {
  const base: StatusState =
    previous && previous.joined === joined
      ? previous
      : {
          joined,
          announced: noFlags(),
          current: noFlags(),
          reasons: {},
          departed: previous?.departed ?? [],
        };
  const announced = { ...base.announced };
  const current = { ...base.current };
  const reasons: Reasons = { ...base.reasons };
  let moved = false;
  for (const flag of STATUS_FLAGS) {
    const seen = observation[flag];
    if (seen.value === null) {
      announced[flag] = null;
      current[flag] = null;
      continue;
    }
    if (!seen.decisive) continue;
    if (announced[flag] === null) {
      announced[flag] = seen.value;
      current[flag] = seen.value;
      continue;
    }
    if (current[flag] !== seen.value) moved = true;
    current[flag] = seen.value;
    if (seen.value !== announced[flag]) reasons[flag] = seen.reason;
  }
  const next = tidied({ joined, announced, current, reasons, departed: [...base.departed] });
  return {
    next,
    changed: previous === null || !sameState(previous, next),
    pending: isPending(next),
    moved,
  };
}

/**
 * Add one confirmed departure to an owner's state, creating a departure-only state (no join
 * context, every flag null) when there is none. The same character and snapshot is added once.
 */
export function addDeparture(previous: StatusState | null, departure: Departure): StatusState {
  const base: StatusState = previous ?? {
    joined: null,
    announced: noFlags(),
    current: noFlags(),
    reasons: {},
    departed: [],
  };
  const known = base.departed.some(
    (item) => item.character === departure.character && item.snapshot === departure.snapshot,
  );
  return { ...base, departed: known ? [...base.departed] : [...base.departed, departure] };
}

/** A pending member's lines for a post, or null when nothing is waiting. */
export function entryFor(user: string, state: StatusState): StatusEntry | null {
  if (!isPending(state)) return null;
  const changed = changedFlags(state);
  const to = { ...state.announced };
  const reasons: Reasons = {};
  for (const flag of changed) {
    to[flag] = state.current[flag];
    const reason = state.reasons[flag];
    if (reason) reasons[flag] = reason;
  }
  return {
    user,
    joined: state.joined,
    from: { ...state.announced },
    to,
    reasons,
    departed: [...state.departed],
  };
}

/** An access level: Member and Guest shown together, a null flag counting as not held. */
export type AccessLevel = "none" | "guest" | "member";
/** The access level a set of flags gives. */
export const levelOf = (flags: Flags): AccessLevel =>
  flags.member ? "member" : flags.guest ? "guest" : "none";

/**
 * Whether an entry shows anything: a changed access level, Officer or FC Leader, or a departure.
 * A Member or Guest flag that moved without changing the level (an unbound Member role, say) has
 * no line of its own, so the freeze announces it silently instead of posting an empty entry.
 */
export function entryVisible(entry: StatusEntry): boolean {
  return (
    levelOf(entry.from) !== levelOf(entry.to) ||
    entry.from.officer !== entry.to.officer ||
    entry.from.leader !== entry.to.leader ||
    entry.departed.length > 0
  );
}

/**
 * Apply a posted entry to the member's current state (the mark, §6 step 3c). Within the join
 * context it was frozen in, each posted flag whose announced value is still the one frozen becomes
 * the posted value; a flag unbound or re-baselined in flight is left alone. After a rejoin in
 * flight the flags already belong to the new join, so none is touched. The posted departures are
 * removed either way. Changes made after the freeze stay pending.
 */
export function applyPosted(state: StatusState, entry: StatusEntry): StatusState {
  const announced = { ...state.announced };
  if (entry.joined === state.joined)
    for (const flag of STATUS_FLAGS) {
      const from = entry.from[flag];
      if (from !== null && from !== entry.to[flag] && announced[flag] === from)
        announced[flag] = entry.to[flag];
    }
  const departed = state.departed.filter(
    (item) =>
      !entry.departed.some(
        (posted) => posted.character === item.character && posted.snapshot === item.snapshot,
      ),
  );
  return tidied({ ...state, announced, current: { ...state.current }, departed });
}

/**
 * With no officer notifications channel nothing is saved for later (owner decision 5): what is
 * waiting becomes the announced state and unposted departures are dropped.
 */
export function dropPending(state: StatusState): StatusState {
  return { ...state, announced: { ...state.current }, reasons: {}, departed: [] };
}

/** The facts a reason is read from; all come from the same pass as the decisive values. */
export interface ReasonFacts {
  /** The guild has a linked FC. */
  readonly fcLinked: boolean;
  /** The guild has an officer rank set. */
  readonly officerRankSet: boolean;
  /** An active guest grant. */
  readonly grant: boolean;
  /** FC history with the linked FC. */
  readonly former: boolean;
  /** Guest access revoked. */
  readonly guestRevoked: boolean;
  /** An /officer grant (or an adopted holder's override). */
  readonly manualOfficer: boolean;
  /** An /officer revoke. */
  readonly officerRevoked: boolean;
}

/**
 * The reason for a decisive value, from the same facts the policy used. Guest: grant, then FC
 * history, then registration (the policy's order); a lost Guest is part of becoming a Member,
 * a revocation, or no remaining basis. Officer: an override or the rank; lost through a
 * revocation, no FC, no officer rank set, or no linked character holding it, in that order.
 */
export function statusReason(
  flag: Flag,
  value: boolean,
  member: boolean,
  facts: ReasonFacts,
): ReasonCode {
  if (flag === "member") return value ? "in_fc" : facts.fcLinked ? "not_in_fc" : "no_fc";
  if (flag === "guest") {
    if (value) return facts.grant ? "guest_grant" : facts.former ? "former_member" : "registered";
    return member ? "is_member" : facts.guestRevoked ? "guest_revoked" : "no_guest_basis";
  }
  if (flag === "officer") {
    if (value) return facts.manualOfficer ? "officer_override" : "officer_rank";
    if (facts.officerRevoked) return "officer_revoked";
    if (!facts.fcLinked) return "no_fc";
    return facts.officerRankSet ? "no_officer_rank" : "officer_rank_unset";
  }
  return value ? "fc_leader" : facts.fcLinked ? "no_fc_leader" : "no_fc";
}

/**
 * One pass's observation: a bound flag carries the pass's value, whether it is decisive and its
 * reason; an unbound flag is null. A lost Guest reads as being a Member (`is_member`) only when the
 * same pass decided Member decisively: a Member kept only because the role is held (out-of-date
 * evidence) isn't why Guest went, so the reason falls through to a revocation or no Guest basis.
 * With no Member role bound, a decisive FC member still gets `is_member` ("a linked character is in
 * the FC"): that is why the policy removed Guest, and the other two reasons would be untrue.
 */
export function statusObservation(input: {
  readonly bound: Readonly<Record<Flag, boolean>>;
  readonly values: Readonly<Record<Flag, boolean>>;
  readonly decisive: Readonly<Record<Flag, boolean>>;
  readonly facts: ReasonFacts;
}): Observation {
  const member = input.decisive.member && input.values.member;
  const one = (flag: Flag): FlagObservation => ({
    value: input.bound[flag] ? input.values[flag] : null,
    decisive: input.decisive[flag],
    reason: statusReason(flag, input.values[flag], member, input.facts),
  });
  return {
    member: one("member"),
    guest: one("guest"),
    officer: one("officer"),
    leader: one("leader"),
  };
}
