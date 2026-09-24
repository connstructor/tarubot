/**
 * The ledger reply catalog: one case per LedgerReplyKind, rendered from typed sample results that
 * reproduce the approved mockups (ledger#0, #2, #16, #17 and #21) and the reply-specs states. The
 * sample entries, posts and results are exported so command and component tests can return them
 * from service stubs and expect the same cards.
 */
import type {
  DeliveryRow,
  FcRef,
  LedgerAccountView,
  LedgerBalanceView,
  LedgerEntryView,
  LedgerHistoryView,
  LedgerReceipt,
} from "../../../src/application/results.js";
import {
  balanceReply,
  historyReply,
  receiptReply,
  type LedgerReplyKind,
} from "../../../src/discord/presenters/ledger.js";
import { at, delivery, FC, GUILD_ID, MEMBER_ID, OFFICER_ID, VIEWERS } from "../results.js";
import type { ReplyCatalog } from "./index.js";

/** The approved cards' linked FC (ledger#17 shows its ID) and a previously linked one (#20). */
export const LEDGER_FC: FcRef = { ...FC, id: "9200000000000000001" };
export const OLD_FC: FcRef = {
  id: "9200000000000000002",
  name: "Example Old Company",
  tag: "EXOC",
  world: "Diabolos",
};
/** The approved cards' ledger channel and the message #41 was posted as. */
export const LEDGER_CHANNEL = "234567890123456789";
export const POSTED_MESSAGE = "567890123456789012";
/** The approved cards' account and entry UUIDs. */
export const ACCOUNT_ID = "0f6f1c52-7a3e-4c1b-9d2e-6b5a4c3d2e1f";
export const OLD_ACCOUNT_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
export const ENTRY_IDS = {
  41: "5b8e0c7a-4d2f-4e61-9a3b-2f0c1d9e8a77",
  42: "7c1d2e3f-8a9b-4c0d-8e1f-2a3b4c5d6e7f",
  43: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
  opening: "3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d",
} as const;

/** A UUID for generated entry `sequence` (and its post), distinct from the approved ones. */
const generatedId = (sequence: bigint, prefix = "e"): string =>
  `${prefix.repeat(8).slice(0, 8)}-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;

/** A recorded entry; overrides state only what a case varies. */
export const entry = (overrides: Partial<LedgerEntryView> = {}): LedgerEntryView => ({
  id: ENTRY_IDS[41],
  account_id: ACCOUNT_ID,
  sequence: 41n,
  operation: "deposit",
  delta: 10_005_000n,
  balance: 120_450_000n,
  actor_id: MEMBER_ID,
  guild_id: GUILD_ID,
  note: "Sold housing furnishings on the market board",
  event_at: new Date(1_790_161_200_000),
  idempotency_key: "1290000000000000001",
  correction_id: null,
  ...overrides,
});

/** The four newest entries the approved history card (ledger#21) shows, newest first. */
export const E43 = entry({
  id: ENTRY_IDS[43],
  sequence: 43n,
  operation: "adjust",
  delta: -50_000n,
  balance: 117_900_000n,
  actor_id: OFFICER_ID,
  note: "Withdrawal #42 was actually 2,550,000 gil (receipt in officer chat)",
  event_at: new Date(1_790_168_400_000),
  correction_id: ENTRY_IDS[42],
});
export const E42 = entry({
  id: ENTRY_IDS[42],
  sequence: 42n,
  operation: "withdraw",
  delta: -2_500_000n,
  balance: 117_950_000n,
  actor_id: OFFICER_ID,
  note: "Company workshop materials for airship parts",
  event_at: new Date(1_790_164_800_000),
});
export const E41 = entry();
export const E40 = entry({
  id: generatedId(40n),
  sequence: 40n,
  delta: 1_200_000n,
  balance: 110_445_000n,
  note: "Leftover gil from the FC map run",
  event_at: new Date(1_790_078_400_000),
});

/** #39–#34: 250,000 gil deposits a day apart, so page 1 holds ten entries. */
const OLDER = Array.from({ length: 6 }, (_, index) => {
  const sequence = 39n - BigInt(index);
  return entry({
    id: generatedId(sequence),
    sequence,
    delta: 250_000n,
    balance: 109_245_000n - 250_000n * BigInt(index),
    note: "Weekly FC chest deposit",
    event_at: new Date(1_790_078_400_000 - 86_400_000 * (index + 1)),
  });
});

/** History page 1 of the approved ledger: #43 to #34. */
export const PAGE_ONE: readonly LedgerEntryView[] = [E43, E42, E41, E40, ...OLDER];

/** A post for `row`, succeeded with its own message unless overridden. */
export const postFor = (row: LedgerEntryView, overrides: Partial<DeliveryRow> = {}): DeliveryRow =>
  delivery({
    id: generatedId(row.sequence, "d"),
    entry_id: row.id,
    sequence: row.sequence,
    message_id: `5678901234567${row.sequence.toString().padStart(5, "0")}`,
    ...overrides,
  });

/** #43 waits behind #42, whose post is blocked on channel permissions (approved ledger#17). */
export const WAITING_POST = postFor(E43, {
  status: "queued",
  message_id: null,
  last_error: "ordered: An earlier ledger notification is still pending.",
  attempts: 0,
  due_at: at(30),
});
export const BLOCKED_POST = postFor(E42, {
  status: "blocked",
  message_id: null,
  attempts: 1,
  last_error: `blocked: TaruBot needs View Channel, Send Messages, Embed Links and Read Message History in <#${LEDGER_CHANNEL}>, and it must be a text channel in this server.`,
});

/** The newest ten posts the approved officer balance shows: waiting, blocked, then eight posted. */
export const PAGE_ONE_POSTS: readonly DeliveryRow[] = [
  WAITING_POST,
  BLOCKED_POST,
  postFor(E41, { message_id: POSTED_MESSAGE }),
  ...[E40, ...OLDER].map((row) => postFor(row)),
];

/** Every post of page 1 posted, for the healthy officer views. */
export const HEALTHY_POSTS: readonly DeliveryRow[] = PAGE_ONE.map((row) => postFor(row));

/** The approved account: 43 entries, 117,900,000 gil. */
export const ACCOUNT: LedgerAccountView = {
  id: ACCOUNT_ID,
  guild_id: GUILD_ID,
  fc_id: LEDGER_FC.id,
  balance: 117_900_000n,
  sequence: 43n,
};

/** The last page (reply spec #23): #3 and #2, then the imported opening balance #1. */
export const IMPORTED = entry({
  id: generatedId(1n),
  sequence: 1n,
  operation: "import",
  delta: 88_300_000n,
  balance: 88_300_000n,
  actor_id: null,
  note: "Imported opening balance",
  event_at: new Date(1_788_134_400_000),
});
export const LAST_PAGE: readonly LedgerEntryView[] = [
  entry({
    id: generatedId(3n),
    sequence: 3n,
    delta: 500_000n,
    balance: 89_050_000n,
    note: "Crafted and sold glamour sets",
    event_at: new Date(1_788_400_000_000),
  }),
  entry({
    id: generatedId(2n),
    sequence: 2n,
    delta: 250_000n,
    balance: 88_550_000n,
    note: "Treasure map run with the FC",
    event_at: new Date(1_788_300_000_000),
  }),
  IMPORTED,
];

/** The previously linked FC's account (approved ledger#20): 18 entries, 64,000,000 gil. */
export const OLD_ACCOUNT: LedgerAccountView = {
  id: OLD_ACCOUNT_ID,
  guild_id: GUILD_ID,
  fc_id: OLD_FC.id,
  balance: 64_000_000n,
  sequence: 18n,
};

/** Its newest ten entries, #18 to #9: withdrawals of 1,000,000 gil a week apart. */
const OLD_PAGE: readonly LedgerEntryView[] = Array.from({ length: 10 }, (_, index) => {
  const sequence = 18n - BigInt(index);
  return entry({
    id: generatedId(sequence, "a"),
    account_id: OLD_ACCOUNT_ID,
    sequence,
    operation: "withdraw",
    delta: -1_000_000n,
    balance: 64_000_000n + 1_000_000n * BigInt(index),
    actor_id: OFFICER_ID,
    note: "Housing plot upkeep",
    event_at: new Date(1_767_312_000_000 - 604_800_000 * index),
  });
});

/** Fields every ledger mutation result shares, as the service returns them. */
const mutation = { effectsMode: "live", fc: LEDGER_FC, channelId: LEDGER_CHANNEL } as const;
/** Fields both read views share for the linked FC. */
const readView = {
  account: ACCOUNT,
  fc: LEDGER_FC,
  current: true,
  channelId: LEDGER_CHANNEL,
  effectsMode: "live",
} as const;

/** A history page with the approved counts: 43 entries, the newest page unless overridden. */
export const historyView = (overrides: Partial<LedgerHistoryView> = {}): LedgerHistoryView => ({
  ...readView,
  view: "history",
  before: null,
  entries: PAGE_ONE,
  delivery: PAGE_ONE_POSTS,
  older: 34n,
  newer: null,
  next: "34",
  total: 43,
  above: 0,
  corrections: { [ENTRY_IDS[42]]: 42n },
  ...overrides,
});

/** Sample service results for every ledger state, named by the kind they render as. */
export const LEDGER_RESULTS = {
  deposit: {
    ...mutation,
    status: "recorded",
    entry: E41,
    delivery: "queued",
    inspect: "/ledger history or /sync status",
    correction: null,
  },
  withdraw: {
    ...mutation,
    status: "recorded",
    entry: E42,
    delivery: "queued",
    inspect: "/ledger history or /sync status",
    correction: null,
  },
  initialize: {
    ...mutation,
    status: "recorded",
    entry: entry({
      id: ENTRY_IDS.opening,
      sequence: 1n,
      operation: "initialize",
      delta: 95_000_000n,
      balance: 95_000_000n,
      actor_id: OFFICER_ID,
      note: "Counted the FC chest after the weekly reset",
    }),
    delivery: "queued",
    inspect: "/ledger history or /sync status",
    correction: null,
  },
  adjust: {
    ...mutation,
    status: "recorded",
    entry: E43,
    delivery: "queued",
    inspect: "/ledger history or /sync status",
    correction: { id: ENTRY_IDS[42], sequence: 42n },
  },
  unchanged: { ...mutation, status: "unchanged", balance: 117_900_000n },
  alreadyRecorded: {
    ...mutation,
    status: "already_recorded",
    entry: E41,
    correction: null,
    post: {
      status: "succeeded",
      message_id: POSTED_MESSAGE,
      last_error: null,
      channel_id: LEDGER_CHANNEL,
    },
  },
  balance: {
    ...readView,
    view: "balance",
    balanceState: "known",
    delivery: PAGE_ONE_POSTS,
    latest: { sequence: 43n, operation: "adjust", event_at: new Date(1_790_168_400_000) },
  },
  uninitialized: {
    ...readView,
    account: { ...ACCOUNT, balance: null, sequence: 0n },
    view: "balance",
    balanceState: "uninitialized",
    delivery: [],
    latest: null,
  },
  historical: {
    ...readView,
    account: OLD_ACCOUNT,
    fc: OLD_FC,
    current: false,
    view: "balance",
    balanceState: "known",
    delivery: OLD_PAGE.map((row) => postFor(row)),
    latest: { sequence: 18n, operation: "withdraw", event_at: new Date(1_767_312_000_000) },
  },
  history: historyView(),
  lastPage: historyView({
    before: 4n,
    entries: LAST_PAGE,
    delivery: LAST_PAGE.slice(0, 2).map((row) => postFor(row)),
    older: null,
    newer: 14n,
    next: null,
    above: 40,
    corrections: {},
  }),
  historicalPage: historyView({
    account: OLD_ACCOUNT,
    fc: OLD_FC,
    current: false,
    entries: OLD_PAGE,
    delivery: OLD_PAGE.map((row) => postFor(row)),
    older: 9n,
    next: "9",
    total: 18,
    corrections: {},
  }),
  empty: historyView({
    account: { ...ACCOUNT, balance: null, sequence: 0n },
    entries: [],
    delivery: [],
    older: null,
    next: null,
    total: 0,
    corrections: {},
  }),
  pastEnd: historyView({
    before: 1n,
    entries: [],
    delivery: [],
    older: null,
    newer: 11n,
    next: null,
    above: 43,
    corrections: {},
  }),
} as const satisfies Record<string, LedgerReceipt | LedgerBalanceView | LedgerHistoryView>;

/** Shorthands for the sample results. */
const R = LEDGER_RESULTS;

/** Every ledger reply state, rendered for the audience its card is written for. */
export const LEDGER_CASES = {
  "deposit.recorded": {
    spec: "ledger#0",
    audience: "member",
    tone: "success",
    title: "Deposit recorded",
    timestamp: true,
    render: () => receiptReply(R.deposit, VIEWERS.member),
  },
  "deposit.recorded_officer": {
    spec: "ledger#1",
    audience: "officer",
    tone: "success",
    title: "Deposit recorded",
    timestamp: true,
    render: () => receiptReply(R.deposit, VIEWERS.officer),
  },
  "withdraw.recorded": {
    spec: "ledger#2",
    audience: "officer",
    tone: "success",
    title: "Withdrawal recorded",
    timestamp: true,
    render: () => receiptReply(R.withdraw, VIEWERS.officer),
  },
  "initialize.recorded": {
    spec: "ledger#3",
    audience: "officer",
    tone: "success",
    title: "Opening balance recorded",
    timestamp: true,
    render: () => receiptReply(R.initialize, VIEWERS.officer),
  },
  "adjust.recorded": {
    spec: "ledger#4",
    audience: "officer",
    tone: "success",
    title: "Correction recorded",
    timestamp: true,
    render: () => receiptReply(R.adjust, VIEWERS.officer),
  },
  "receipt.paused": {
    spec: "errors-and-style#26",
    audience: "member",
    concept: "paused_save",
    tone: "pending",
    title: "Saved, Discord changes paused",
    timestamp: false,
    render: () =>
      receiptReply({ ...R.deposit, effectsMode: "awaiting_activation" }, VIEWERS.member),
  },
  "adjust.unchanged": {
    spec: "ledger#5",
    audience: "officer",
    noOp: true,
    tone: "neutral",
    title: "No correction needed",
    timestamp: false,
    render: () => receiptReply(R.unchanged, VIEWERS.officer),
  },
  "receipt.already_recorded": {
    spec: "ledger#6",
    audience: "officer",
    noOp: true,
    tone: "info",
    title: "Already recorded",
    timestamp: true,
    render: () => receiptReply(R.alreadyRecorded, VIEWERS.officer),
  },
  "balance.member": {
    spec: "ledger#16",
    audience: "member",
    tone: "info",
    title: "Example Free Company ledger",
    timestamp: false,
    render: () => balanceReply(R.balance, VIEWERS.member),
  },
  "balance.officer": {
    spec: "ledger#17",
    audience: "officer",
    tone: "warning",
    title: "Example Free Company ledger",
    timestamp: false,
    render: () => balanceReply(R.balance, VIEWERS.officer),
  },
  "balance.uninitialized": {
    spec: "ledger#18",
    audience: "member",
    tone: "warning",
    title: "Example Free Company ledger",
    timestamp: false,
    render: () => balanceReply(R.uninitialized, VIEWERS.member),
  },
  "balance.uninitialized_officer": {
    spec: "ledger#19",
    audience: "officer",
    tone: "warning",
    title: "Example Free Company ledger",
    timestamp: false,
    render: () => balanceReply(R.uninitialized, VIEWERS.officer),
  },
  "balance.historical": {
    spec: "ledger#20",
    audience: "officer",
    tone: "neutral",
    title: "Historical ledger · Example Old Company",
    timestamp: false,
    render: () => balanceReply(R.historical, VIEWERS.officer),
  },
  "history.member": {
    spec: "ledger#21",
    audience: "member",
    tone: "info",
    title: "Ledger history · Example Free Company",
    timestamp: false,
    render: () => historyReply(R.history, VIEWERS.member),
  },
  "history.officer": {
    spec: "ledger#22",
    audience: "officer",
    tone: "warning",
    title: "Ledger history · Example Free Company",
    timestamp: false,
    render: () => historyReply(R.history, VIEWERS.officer),
  },
  "history.last": {
    spec: "ledger#23",
    audience: "member",
    tone: "info",
    title: "Ledger history · Example Free Company",
    timestamp: false,
    render: () => historyReply(R.lastPage, VIEWERS.member),
  },
  "history.historical": {
    spec: null,
    audience: "officer",
    tone: "neutral",
    title: "Ledger history · Example Old Company",
    timestamp: false,
    render: () => historyReply(R.historicalPage, VIEWERS.officer),
  },
  "history.empty": {
    spec: "ledger#24",
    audience: "member",
    tone: "neutral",
    title: "Ledger history · Example Free Company",
    timestamp: false,
    render: () => historyReply(R.empty, VIEWERS.member),
  },
  "history.past_end": {
    spec: "ledger#24",
    audience: "member",
    tone: "neutral",
    title: "Ledger history · Example Free Company",
    timestamp: false,
    render: () => historyReply(R.pastEnd, VIEWERS.member),
  },
} as const satisfies ReplyCatalog<LedgerReplyKind>;
