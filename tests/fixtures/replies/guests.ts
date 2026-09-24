/**
 * The guests reply catalog: one case per GuestReplyKind, rendered from typed sample results that
 * reproduce the approved mockups (guests#0, #7, #10 and #11) and the reply-specs states. The
 * sample results are exported so command and component tests can return them from service stubs
 * and expect the same cards.
 */
import type {
  ApplicationStatusRow,
  ApplyResult,
  DecisionResult,
  GuestActionResult,
  GuestResetResult,
  GuestStatusView,
} from "../../../src/application/results.js";
import {
  applicationReceivedReply,
  decisionReply,
  guestActionReply,
  guestResetReply,
  guestStatusReply,
  type GuestReplyKind,
} from "../../../src/discord/presenters/guests.js";
import { GUEST_ID, GUILD_ID, job, MEMBER_ID, NOW, OFFICER_ID, VIEWERS } from "../results.js";
import type { ReplyCatalog } from "./index.js";

/** The approved cards' application (guests#3, #4, #7 and #13–#23). */
export const APPLICATION_ID = "3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b";
/** The review channel and message the approved officer record links to (guests#7). */
const REVIEW_CHANNEL = "678901234567890123";
const REVIEW_MESSAGE = "789012345678901234";

/** A time as the approved cards' <t:…> values write it. */
const unix = (seconds: number): Date => new Date(seconds * 1_000);

/** An application row as /guest status reads it; overrides state only what a case varies. */
export const applicationRow = (
  overrides: Partial<ApplicationStatusRow> = {},
): ApplicationStatusRow => ({
  id: APPLICATION_ID,
  guild_id: GUILD_ID,
  user_id: GUEST_ID,
  joined_at: unix(1_789_900_000),
  created_at: unix(1_790_150_400),
  state: "pending",
  channel_id: REVIEW_CHANNEL,
  message_id: REVIEW_MESSAGE,
  reviewer_id: null,
  decided_at: null,
  reason: null,
  ...overrides,
});

/** A guest record with nothing on it; each state adds what it rests on. */
export const guestStatus = (overrides: Partial<GuestStatusView> = {}): GuestStatusView => ({
  applications: [],
  grants: [],
  revocation: [],
  formerMember: [{ eligible: false }],
  delivery: [],
  verifiedGuestEligible: false,
  membership: "ineligible",
  rosterFresh: true,
  registered: false,
  cooldownSeconds: 86_400,
  effectsMode: "live",
  ...overrides,
});

/** The approved grandfathered grant (guests#0 and #7). */
const GRANDFATHERED = {
  provenance: "grandfathered",
  created_at: unix(1_790_121_600),
  reason: "Grandfathered Guest at first activation",
};
/** The approved officer grant (guests#7). */
const MANUAL = {
  provenance: "manual",
  created_at: unix(1_790_150_400),
  reason: "Rejoined after a break; vouched for by staff.",
};

/** The member's role update, done (guests#0: 'Up to date'). */
const ROLES_DONE = job({
  id: "4d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a",
  status: "succeeded",
  attempts: 1,
  completed_at: unix(1_790_160_000),
  result: { add: ["456789012345678901"], remove: ["567890123456789012"], status: "applied" },
});

/** The approved officer record's deliveries (guests#7): role update, review message and DM. */
const RECORD_DELIVERIES = [
  ROLES_DONE,
  job({
    id: "5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b",
    kind: "guest.review",
    status: "succeeded",
    attempts: 1,
    completed_at: unix(1_790_150_460),
  }),
  job({
    id: "6f5e4d3c-2b1a-4f0e-9d8c-7b6a5f4e3d2c",
    kind: "guest.dm",
    status: "failed",
    attempts: 1,
    last_error: "dm_blocked: The recipient has disabled DMs.",
  }),
];

/** A blocked role update with the stored diagnostic officers see (guests#8). */
const ROLES_BLOCKED = job({
  status: "blocked",
  attempts: 3,
  last_error:
    "blocked: Recheck Discord roles, channel permissions, and bot hierarchy with /config validate.",
});

/** Sample service results for every guest state, named by the kind they render as. */
export const GUEST_RESULTS = {
  /** guests#0: a grandfathered member whose roles are up to date. */
  granted: guestStatus({ grants: [GRANDFATHERED], delivery: [ROLES_DONE] }),
  memberAccess: guestStatus({ membership: "member", registered: true, delivery: [ROLES_DONE] }),
  revoked: guestStatus({
    grants: [MANUAL],
    revocation: [
      { revoked: true, changed_at: unix(1_790_150_400), reason: "Repeated disruption." },
    ],
  }),
  former: guestStatus({ formerMember: [{ eligible: true }] }),
  registered: guestStatus({
    registered: true,
    verifiedGuestEligible: true,
    delivery: [job({ status: "running", attempts: 1 })],
  }),
  waitingRoster: guestStatus({ registered: true, rosterFresh: false }),
  uncertain: guestStatus({ registered: true, membership: "uncertain" }),
  pending: guestStatus({ applications: [applicationRow()] }),
  denied: guestStatus({
    applications: [
      applicationRow({
        state: "denied",
        decided_at: unix(1_790_150_400),
        reviewer_id: OFFICER_ID,
        reason: "Please tell us a little more about how you found the Free Company.",
      }),
    ],
  }),
  closed: guestStatus({
    applications: [applicationRow({ state: "cancelled", decided_at: unix(1_790_150_400) })],
  }),
  none: guestStatus(),
  /** guests#7: the officer record of a grandfathered member with a later officer grant. */
  record: guestStatus({
    grants: [MANUAL, GRANDFATHERED],
    revocation: [{ revoked: false, changed_at: unix(1_790_150_400), reason: MANUAL.reason }],
    applications: [
      applicationRow({
        state: "approved",
        created_at: unix(1_790_000_000),
        decided_at: unix(1_790_078_400),
        reviewer_id: MEMBER_ID,
      }),
    ],
    delivery: RECORD_DELIVERIES,
  }),
  /** guests#8: an officer grant whose role update is blocked. */
  recordBlocked: guestStatus({ grants: [MANUAL], delivery: [ROLES_BLOCKED] }),
} as const satisfies Record<string, GuestStatusView>;

/** Sample grant and revoke results (guests#10 and #11). */
export const ACTION_RESULTS = {
  granted: {
    status: "granted",
    effects: "queued",
    effectsMode: "live",
    user: GUEST_ID,
    reason: "Long-time friend of the FC; vouched for by staff.",
    restored: false,
    cancelledApplications: 0,
    present: true,
    guestRoleConfigured: true,
  },
  revoked: {
    status: "revoked",
    effects: "queued",
    effectsMode: "live",
    user: GUEST_ID,
    reason: "Repeated disruption in public channels.",
    restored: false,
    cancelledApplications: 1,
    present: true,
    guestRoleConfigured: true,
  },
} as const satisfies Record<string, GuestActionResult>;

/** A /guest reset result: a revocation lifted and two grants ended unless overridden. */
export const guestReset = (overrides: Partial<GuestResetResult> = {}): GuestResetResult => ({
  status: "reset",
  effects: "queued",
  effectsMode: "live",
  user: GUEST_ID,
  reason: "Back to the automatic rules after the dispute was settled.",
  revocationLifted: true,
  grantsEnded: ["approved", "manual"],
  present: true,
  guestRoleConfigured: true,
  ...overrides,
});

/** A decision result; overrides state only what a case varies. */
export const decision = (overrides: Partial<DecisionResult> = {}): DecisionResult => ({
  id: APPLICATION_ID,
  status: "approved",
  effects: "queued",
  effectsMode: "live",
  userId: GUEST_ID,
  reason: null,
  reviewerId: OFFICER_ID,
  decidedAt: NOW,
  cooldownSeconds: 86_400,
  ...overrides,
});

/** A submitted application; overrides state only what a case varies. The answers are samples. */
export const applied = (overrides: Partial<ApplyResult> = {}): ApplyResult => ({
  id: APPLICATION_ID,
  guild_id: GUILD_ID,
  user_id: GUEST_ID,
  joined_at: unix(1_789_900_000),
  created_at: unix(1_790_150_400),
  state: "pending",
  channel_id: REVIEW_CHANNEL,
  message_id: null,
  reviewer_id: null,
  decided_at: null,
  reason: null,
  introduction: "SECRET-INTRODUCTION I play with friends from this server.",
  interest: "SECRET-INTEREST My friend invited me here.",
  outcome: "created",
  effectsMode: "live",
  ...overrides,
});

/** Shorthands for the sample results. */
const R = GUEST_RESULTS;
const A = ACTION_RESULTS;
/** Every case renders against the mockups' clock. */
const now = NOW;
/** Status options for the member's own view and the officer record view. */
const self = { owner: MEMBER_ID, memberOption: false, now } as const;
const record = { owner: GUEST_ID, memberOption: true, now } as const;

/** Every guest reply state, rendered for the audience its card is written for. */
export const GUEST_CASES = {
  "status.member_access": {
    spec: null,
    audience: "member",
    tone: "success",
    title: "Your guest access",
    timestamp: false,
    render: () => guestStatusReply(R.memberAccess, VIEWERS.member, self),
  },
  "status.revoked": {
    spec: "guests-sync-utility#5",
    audience: "member",
    tone: "warning",
    title: "Your guest access",
    timestamp: false,
    render: () => guestStatusReply(R.revoked, VIEWERS.member, self),
  },
  "status.granted": {
    spec: "guests-sync-utility#0",
    audience: "member",
    tone: "success",
    title: "Your guest access",
    timestamp: false,
    render: () => guestStatusReply(R.granted, VIEWERS.member, self),
  },
  "status.former": {
    spec: "guests-sync-utility#2",
    audience: "member",
    tone: "success",
    title: "Your guest access",
    timestamp: false,
    render: () => guestStatusReply(R.former, VIEWERS.member, self),
  },
  "status.registered": {
    spec: "guests-sync-utility#1",
    audience: "member",
    tone: "success",
    title: "Your guest access",
    timestamp: false,
    render: () => guestStatusReply(R.registered, VIEWERS.member, self),
  },
  "status.waiting_roster": {
    spec: null,
    audience: "member",
    tone: "pending",
    title: "Your guest access",
    timestamp: false,
    render: () => guestStatusReply(R.waitingRoster, VIEWERS.member, self),
  },
  "status.uncertain": {
    spec: null,
    audience: "member",
    tone: "pending",
    title: "Your guest access",
    timestamp: false,
    render: () => guestStatusReply(R.uncertain, VIEWERS.member, self),
  },
  "status.pending": {
    spec: "guests-sync-utility#3",
    audience: "member",
    tone: "pending",
    title: "Your guest access",
    timestamp: false,
    render: () => guestStatusReply(R.pending, VIEWERS.member, self),
  },
  "status.denied": {
    spec: "guests-sync-utility#4",
    audience: "member",
    tone: "warning",
    title: "Your guest access",
    timestamp: false,
    render: () => guestStatusReply(R.denied, VIEWERS.member, self),
  },
  "status.closed": {
    spec: "guests-sync-utility#4",
    audience: "member",
    tone: "neutral",
    title: "Your guest access",
    timestamp: false,
    render: () => guestStatusReply(R.closed, VIEWERS.member, self),
  },
  "status.none": {
    spec: "guests-sync-utility#6",
    audience: "member",
    tone: "neutral",
    title: "Your guest access",
    timestamp: false,
    render: () => guestStatusReply(R.none, VIEWERS.member, self),
  },
  "status.officer": {
    spec: "guests-sync-utility#7",
    audience: "officer",
    tone: "info",
    title: "Guest access · member record",
    timestamp: true,
    render: () => guestStatusReply(R.record, VIEWERS.officer, record),
  },
  "status.officer_attention": {
    spec: "guests-sync-utility#8",
    audience: "officer",
    tone: "warning",
    title: "Guest access · member record",
    timestamp: true,
    render: () => guestStatusReply(R.recordBlocked, VIEWERS.officer, record),
  },
  "grant.granted": {
    spec: "guests-sync-utility#10",
    audience: "officer",
    tone: "success",
    title: "Guest access granted",
    timestamp: false,
    render: () => guestActionReply(A.granted, VIEWERS.officer, { now }),
  },
  "grant.restored": {
    spec: "guests-sync-utility#10",
    audience: "officer",
    tone: "success",
    title: "Guest access granted",
    timestamp: false,
    render: () => guestActionReply({ ...A.granted, restored: true }, VIEWERS.officer, { now }),
  },
  "grant.absent": {
    spec: "guests-sync-utility#10",
    audience: "officer",
    tone: "success",
    title: "Guest access granted",
    timestamp: false,
    render: () => guestActionReply({ ...A.granted, present: false }, VIEWERS.officer, { now }),
  },
  "grant.no_role": {
    spec: "guests-sync-utility#10",
    audience: "officer",
    tone: "warning",
    title: "Guest access granted",
    timestamp: false,
    render: () =>
      guestActionReply({ ...A.granted, guestRoleConfigured: false }, VIEWERS.officer, { now }),
  },
  "revoke.revoked": {
    spec: "guests-sync-utility#11",
    audience: "officer",
    tone: "success",
    title: "Guest access revoked",
    timestamp: false,
    render: () => guestActionReply(A.revoked, VIEWERS.officer, { now }),
  },
  "action.paused": {
    spec: "errors-and-style#26",
    audience: "officer",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      guestActionReply({ ...A.granted, effectsMode: "awaiting_activation" }, VIEWERS.officer, {
        now,
      }),
  },
  "reset.reset": {
    spec: null,
    audience: "officer",
    tone: "success",
    title: "Guest access reset",
    timestamp: false,
    render: () => guestResetReply(guestReset(), VIEWERS.officer, { now }),
  },
  "reset.unchanged": {
    spec: null,
    audience: "officer",
    noOp: true,
    tone: "info",
    title: "No Guest overrides to remove",
    timestamp: false,
    render: () =>
      guestResetReply(
        guestReset({
          status: "unchanged",
          effects: "unchanged",
          revocationLifted: false,
          grantsEnded: [],
        }),
        VIEWERS.officer,
        { now },
      ),
  },
  "reset.paused": {
    spec: "errors-and-style#26",
    audience: "officer",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      guestResetReply(guestReset({ effectsMode: "deployment_disabled" }), VIEWERS.officer, {
        now,
      }),
  },
  "decision.approved": {
    spec: "guests-sync-utility#13",
    audience: "officer",
    tone: "success",
    title: "Application approved",
    timestamp: false,
    render: () => decisionReply(decision(), VIEWERS.officer, { via: "command", now }),
  },
  "decision.denied": {
    spec: "guests-sync-utility#14",
    audience: "officer",
    tone: "success",
    title: "Application denied",
    timestamp: false,
    render: () =>
      decisionReply(
        decision({
          status: "denied",
          reason: "Please tell us a little more about how you found the Free Company.",
        }),
        VIEWERS.officer,
        { via: "command", now },
      ),
  },
  "decision.cancelled": {
    spec: "guests-sync-utility#15",
    audience: "officer",
    tone: "info",
    title: "Application closed · applicant left",
    timestamp: false,
    render: () =>
      decisionReply(decision({ status: "cancelled" }), VIEWERS.officer, { via: "command", now }),
  },
  "decision.superseded": {
    spec: "guests-sync-utility#16",
    audience: "officer",
    tone: "info",
    title: "Application no longer needed",
    timestamp: false,
    render: () =>
      decisionReply(decision({ status: "superseded" }), VIEWERS.officer, { via: "command", now }),
  },
  "decision.already": {
    spec: "guests-sync-utility#17",
    audience: "officer",
    noOp: true,
    tone: "info",
    title: "Already decided",
    timestamp: false,
    render: () =>
      decisionReply(
        decision({ effects: "unchanged", decidedAt: unix(1_790_150_400) }),
        VIEWERS.officer,
        { via: "button", now },
      ),
  },
  "decision.button": {
    spec: "guests-sync-utility#19",
    audience: "officer",
    tone: "success",
    title: "Application approved",
    timestamp: false,
    render: () => decisionReply(decision(), VIEWERS.officer, { via: "button", now }),
  },
  "decision.paused": {
    spec: "errors-and-style#26",
    audience: "officer",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      decisionReply(
        decision({ status: "denied", effectsMode: "deployment_disabled" }),
        VIEWERS.officer,
        { via: "command", now },
      ),
  },
  "apply.created": {
    spec: "guests-sync-utility#22",
    audience: "member",
    tone: "pending",
    title: "Application sent",
    timestamp: false,
    render: () => applicationReceivedReply(applied(), VIEWERS.member, { now }),
  },
  "apply.replaced": {
    spec: "guests-sync-utility#22",
    audience: "member",
    tone: "pending",
    title: "Application sent",
    timestamp: false,
    render: () =>
      applicationReceivedReply(applied({ outcome: "replaced" }), VIEWERS.member, { now }),
  },
  "apply.existing": {
    spec: "guests-sync-utility#23",
    audience: "member",
    noOp: true,
    tone: "info",
    title: "Application already sent",
    timestamp: false,
    render: () =>
      applicationReceivedReply(applied({ outcome: "existing" }), VIEWERS.member, { now }),
  },
  // A saved application whose review message is held is a paused save (O2).
  "apply.held": {
    spec: "errors-and-style#26",
    concept: "paused_save",
    audience: "member",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      applicationReceivedReply(applied({ effectsMode: "awaiting_activation" }), VIEWERS.member, {
        now,
      }),
  },
} as const satisfies ReplyCatalog<GuestReplyKind>;
