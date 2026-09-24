/**
 * Ledger presenters: the /ledger deposit, withdraw, initialize and adjust receipts, the /ledger
 * balance view, the paged /ledger history, and each entry's post in the ledger channel (which the
 * gateway renders for the ledger.notify job). Each renders a typed service result for its viewer,
 * reproducing the approved mockups (ledger#0, #2, #16, #17, #21, #29 and #32) exactly and the
 * reply specs for the other states. Failures are never caught here: the router's failure
 * presenter renders them (approved ledger#7 among them). Pure; receipts and posts carry the
 * entry's own event_at as their timestamp, and read views carry none, as approved.
 *
 * Members see amounts, balances, entry numbers and a count of posts still on their way; officers
 * also see entry UUIDs (for `/ledger adjust entry:`), each channel post's state, the FC ID, the
 * account ID and 'Full details (JSON)'. A receipt saved while Discord changes are paused is the
 * approved paused-save card (errors-and-style#26, owner decision O2), pending tone, keeping its
 * ledger facts; an unchanged correction is the approved neutral 'No correction needed'.
 *
 * Channel-post states use the approved ledger#17 wording ('Waiting: posts after #42',
 * '**Blocked**: …', '[Posted](link)', runs of successes collapsed as '#34–#40 · Posted (7)') in
 * both the balance and the history view, so one vocabulary describes a ledger post everywhere.
 */
import type { LedgerPostView } from "../../application/records.js";
import type {
  EffectsMode,
  FcRef,
  LedgerBalanceView,
  LedgerEntryView,
  LedgerHistoryView,
  LedgerReceipt,
} from "../../application/results.js";
import { isOfficer, type Viewer } from "./audience.js";
import { detailsButton, ledgerPager, viewHistoryButton } from "./controls.js";
import {
  code,
  count,
  cutMarkdown,
  fcName,
  fcTitleName,
  gilText,
  link,
  mentionChannel,
  mentionUser,
  plain,
  quote,
  signedGilText,
  splitFields,
  when,
} from "./format.js";
import { jobCode, jobMarker, pausedSave, whenApplied } from "./jobs.js";
import {
  // Aliased: the receipts below name their channel-post wording `post`.
  post as channelPost,
  reply,
  type ButtonSpec,
  type FieldSpec,
  type Presented,
  type ReplySpec,
} from "./reply.js";
import { DISCORD_LIMITS, HOUSE_LIMITS, marker, SEPARATOR, type Tone } from "./style.js";

/**
 * Every ledger reply kind, with whether its embed carries a timestamp: the approved card's
 * `timestamp` value, or the reply spec's for states without a drawn card (C11). Receipts are
 * stamped with the entry's event_at; the paused-save card follows errors-and-style#26, which has
 * none. The reply catalog must cover every kind.
 */
const TIMESTAMP = {
  "deposit.recorded": true,
  "deposit.recorded_officer": true,
  "withdraw.recorded": true,
  "initialize.recorded": true,
  "adjust.recorded": true,
  "receipt.paused": false,
  "adjust.unchanged": false,
  "receipt.already_recorded": true,
  "balance.member": false,
  "balance.officer": false,
  "balance.uninitialized": false,
  "balance.uninitialized_officer": false,
  "balance.historical": false,
  "history.member": false,
  "history.officer": false,
  "history.last": false,
  "history.historical": false,
  "history.empty": false,
  "history.past_end": false,
} as const satisfies Record<string, boolean>;

/** A ledger reply state; tests catalogue one case per kind. */
export type LedgerReplyKind = keyof typeof TIMESTAMP;

/** Every ledger reply kind, for catalog completeness checks. */
export const LEDGER_REPLY_KINDS = Object.keys(TIMESTAMP) as readonly LedgerReplyKind[];

/** Entries per history page; the service reads eleven rows to prove an older page exists. */
export const HISTORY_PAGE_SIZE = 10;

/** Build a ledger reply of `kind`, stamping it with `at` only when its approved card does. */
function card(kind: LedgerReplyKind, spec: Omit<ReplySpec, "timestamp">, at?: Date): Presented {
  return reply({ ...spec, timestamp: TIMESTAMP[kind] ? (at ?? null) : null });
}

// ---------------------------------------------------------------------------------------------
// Shared wording

/** How each stored operation reads in titles, fields, history and the channel post. */
export const LEDGER_OPERATION = {
  deposit: "Deposit",
  withdraw: "Withdrawal",
  initialize: "Opening balance",
  adjust: "Correction",
  import: "Imported opening balance",
} as const satisfies Record<string, string>;

/** An operation's label; one this release doesn't know shows raw. */
export const operationLabel = (operation: string): string =>
  Object.hasOwn(LEDGER_OPERATION, operation)
    ? (LEDGER_OPERATION[operation as keyof typeof LEDGER_OPERATION] ?? operation)
    : operation;

/** Opening entries set the balance rather than change it, so their amount is shown unsigned. */
const opening = (operation: string): boolean =>
  operation === "initialize" || operation === "import";

/** An entry's amount: the unsigned opening balance, or the signed change ('−2,500,000 gil'). */
export const entryAmount = (entry: Pick<LedgerEntryView, "operation" | "delta" | "balance">) =>
  opening(entry.operation) ? gilText(entry.balance) : signedGilText(entry.delta);

/** en-US digit grouping for exact counts shown without a noun ('43', '1,204'). */
const grouping = new Intl.NumberFormat("en-US");
const grouped = (value: number | bigint): string => grouping.format(value);

/** The FC's plain name for sentences and titles, or 'FC <id>' before its first Lodestone read. */
const plainName = (fcId: string, fc: FcRef | null, where: "text" | "title"): string =>
  fcTitleName({ id: fcId, name: fc?.name ?? "" }, where);

/**
 * A title around the FC's plain name (C10: titles never carry the tag or world), cutting only the
 * name so the whole title stays within the 60-character house limit.
 */
function fcTitle(before: string, fcId: string, fc: FcRef | null, after = ""): string {
  const room = HOUSE_LIMITS.title - before.length - after.length;
  return `${before}${cutMarkdown(plainName(fcId, fc, "title"), room)}${after}`;
}

/** 'Example Free Company «EXFC»' without the world, as the approved officer footer shows it. */
const taggedName = (fc: FcRef): string => fcName({ ...fc, world: "" }, "footer");

/** The member balance footer (approved ledger#16): the ledger is recorded, not read from the game. */
const MEMBER_FOOTER = "Recorded by FC members and officers · not read from the game";

/** Where officers read the account's own ID, the footer of every officer read view. */
const accountFooter = (id: string): string => `Account ${id}`;

/** A user-written note in a receipt field, escaped and capped at the 300-character house limit. */
const noteField = (text: string): FieldSpec => ({
  name: "Note",
  value: plain(text, HOUSE_LIMITS.userText),
});

// ---------------------------------------------------------------------------------------------
// Channel-post states

/** What a post line needs besides its row: where the post goes and whether effects are paused. */
interface PostContext {
  readonly guildId: string;
  readonly channelId: string | null;
  readonly effectsMode: EffectsMode;
}

/** The fields of a delivery row (or a replayed receipt's post) that decide its wording. */
interface PostRow {
  readonly status: string;
  readonly last_error: string | null;
  readonly message_id: string | null;
  /**
   * The channel the post was sent to, from its job result. Null (or absent) for a post made
   * before 2.14.0 recorded it, whose link falls back to the currently configured channel.
   */
  readonly channel_id?: string | null;
  /** The entry the post announces, for 'posts after #n'. */
  readonly sequence: bigint;
  /** When a retry is due; a replayed receipt's post doesn't carry it. */
  readonly due_at?: Date | undefined;
}

/** Decimal Discord IDs, the only values a jump link is built from. */
const SNOWFLAKE = /^[1-9][0-9]{16,19}$/u;

/**
 * The posted message's jump link, in the channel the post actually went to: the dispatcher
 * records it in the job result, so rebinding the ledger channel keeps earlier links working.
 * Only a post made before 2.14.0, which stored no channel, falls back to the currently configured
 * channel, where it was posted unless the channel has since been rebound. No channel, no link.
 */
function jumpLink(context: PostContext, row: PostRow): string | null {
  const { guildId } = context;
  const channelId = row.channel_id ?? context.channelId;
  const messageId = row.message_id;
  if (!messageId || !channelId) return null;
  if (![guildId, channelId, messageId].every((id) => SNOWFLAKE.test(id))) return null;
  return link("Posted", `https://discord.com/channels/${guildId}/${channelId}/${messageId}`);
}

/**
 * Why a post is blocked, from its stored diagnostic: no ledger channel at all, or the reason the
 * bot can't post in the configured one (the dispatcher's and gateway's approved messages).
 */
function blockedReason(lastError: string | null, channelId: string | null): string | null {
  const text = lastError ?? "";
  if (!channelId || /ledger notification channel/iu.test(text)) return null;
  if (/View Channel|Send Messages|Embed Links/u.test(text)) return "missing channel permissions";
  if (/unavailable/iu.test(text)) return "channel unavailable";
  return "Discord refused the post";
}

/**
 * A paused post's reason for the current effects mode; with effects live it is left over from an
 * earlier pause rather than waiting for an activation that isn't coming.
 */
const pausedPost = (mode: EffectsMode): string =>
  mode === "deployment_disabled"
    ? "Discord changes are off for this deployment"
    : mode === "live"
      ? "held from an earlier pause"
      : "waiting for activation";

/**
 * One channel post's state in the approved ledger#17 wording. `line` is the balance view's
 * '#42 · <state>' form ('Waiting: posts after #42'); `post` is the history view's 'Post: <state>'
 * form ('Waiting (posts after #42)'). jobMarker decides the state, so these agree with every other
 * job view on what is waiting, blocked, paused or failed.
 */
function postState(row: PostRow, context: PostContext, form: "line" | "post"): string {
  const state = jobMarker(row);
  // A replayed receipt's post carries no due time, so its retry is only described.
  const retry = row.due_at ? `next try ${when(row.due_at, "R")}` : "it will retry";
  const detail = (head: string, text: string): string =>
    form === "line" ? `${head}: ${text}` : `${head} (${text})`;
  switch (state.marker) {
    case "done":
    case "skipped":
      return jumpLink(context, row) ?? "Completed, no message";
    case "running":
      return "Posting now";
    case "queued":
      return "Queued";
    case "waiting":
      // Posts go out in entry order, so an earlier entry's post holds this one back.
      if (jobCode(row.last_error) === "ordered")
        return detail(
          "Waiting",
          row.sequence > 1n ? `posts after #${row.sequence - 1n}` : "earlier posts first",
        );
      return state.wait === "next"
        ? detail("Waiting", retry)
        : detail("Retrying after a Discord error", retry);
    case "blocked": {
      const reason = blockedReason(row.last_error, context.channelId);
      if (reason === null) return detail("**Blocked**", "no ledger channel is set");
      const channel = mentionChannel(context.channelId ?? "");
      return form === "line"
        ? `**Blocked**: bot can't post in ${channel} (${reason})`
        : `**Blocked** (${reason} in ${channel})`;
    }
    case "paused":
      return detail("Paused", pausedPost(context.effectsMode));
    case "failed":
      return "**Failed** after repeated attempts";
    default:
      return "Queued";
  }
}

/** Problem counts across posts: what decides an officer view's tone and next steps. */
interface PostProblems {
  readonly blocked: number;
  readonly failed: number;
  readonly paused: number;
  /** Queued, running or waiting: on their way, not a problem on their own. */
  readonly waiting: number;
}

/** Whether a post reached its end without a problem (posted, or nothing left to post). */
function isPosted(row: PostRow): boolean {
  const state = jobMarker(row).marker;
  return state === "done" || state === "skipped";
}

/** Count each post state that needs attention or is still on its way. */
function problemsOf(rows: readonly PostRow[]): PostProblems {
  const counts = { blocked: 0, failed: 0, paused: 0, waiting: 0 };
  for (const row of rows) {
    const { marker: state } = jobMarker(row);
    if (state === "blocked") counts.blocked += 1;
    else if (state === "failed") counts.failed += 1;
    else if (state === "paused") counts.paused += 1;
    else if (!isPosted(row)) counts.waiting += 1;
  }
  return counts;
}

/**
 * The C4 tone table for an officer view: warning when a post is blocked or failed, pending when
 * one is only paused, info when everything is healthy.
 */
function officerTone(problems: PostProblems): Tone {
  if (problems.blocked || problems.failed) return "warning";
  return problems.paused ? "pending" : "info";
}

/** Whether any post needs an officer (blocked, failed or paused). */
const needsAttention = (problems: PostProblems): boolean =>
  problems.blocked + problems.failed + problems.paused > 0;

/** The next steps for each problem, in the approved order (ledger#17). */
function nextSteps(problems: PostProblems, mode: EffectsMode, form: "balance" | "history") {
  return [
    problems.blocked > 0 &&
      (form === "balance"
        ? "Fix the channel with `/config ledger` (see `/config validate`). Saving any setting re-queues blocked posts."
        : "Fix the channel with `/config ledger`; saving any setting re-queues blocked posts."),
    // With effects live nothing else resumes a post left from an earlier pause, but a /config
    // change requeues parked work, as it does blocked posts.
    problems.paused > 0 &&
      (mode === "live"
        ? "Paused posts are left from an earlier pause; saving any setting with `/config` re-queues them."
        : `Paused posts go out ${whenApplied(mode)}.`),
    problems.failed > 0 &&
      "Failed posts won't retry on their own, so report them to the bot operator.",
  ].filter((step): step is string => Boolean(step));
}

// ---------------------------------------------------------------------------------------------
// Receipts: /ledger deposit, withdraw, initialize and adjust

/** Whether a receipt's channel post is held, which turns it into the paused-save card. */
const paused = (mode: EffectsMode): mode is Exclude<EffectsMode, "live"> => mode !== "live";

/** 'the Example Free Company ledger', or 'the FC ledger' before the FC's first Lodestone read. */
const ledgerOf = (fc: FcRef | null, article: "the" | "The" = "the"): string =>
  `${article} ${fc ? plainName(fc.id, fc, "text") : "FC"} ledger`;

/**
 * The footer of a receipt. Members see the FC with its tag and world (approved ledger#0); officers
 * see the interaction Ref, which is the entry's idempotency key and the log's operation, beside
 * the tagged name (approved ledger#2 with its override).
 */
function receiptFooter(fc: FcRef | null, viewer: Viewer): readonly (string | null)[] {
  if (!isOfficer(viewer)) return [fc ? fcName(fc, "footer") : null];
  return [`Ref ${viewer.ref}`, fc ? taggedName(fc) : null];
}

/** 'Corrects #42 · `uuid`' for officers, '#42' for members; null when nothing is corrected. */
function correctsValue(
  entry: LedgerEntryView,
  correction: { readonly sequence: bigint } | null,
  officer: boolean,
): string | null {
  if (!entry.correction_id) return null;
  if (!correction) return officer ? code(entry.correction_id) : null;
  return officer
    ? `#${correction.sequence} · ${code(entry.correction_id)}`
    : `#${correction.sequence}`;
}

/**
 * /ledger deposit, withdraw, initialize and adjust. Recorded now (approved ledger#0 member, #2
 * officer; reply specs #1, #3 and #4): success, the change in bold, when it will be posted, the
 * balance facts, and for officers the post status, the entry UUID and the Ref. While Discord
 * changes are paused it is the pending paused-save card with the same facts, saying when the
 * post goes out. An unchanged correction is neutral 'No correction needed' (#5), and a replayed
 * interaction is info 'Already recorded' with the balance after that entry (#6).
 */
export function receiptReply(result: LedgerReceipt, viewer: Viewer): Presented {
  const officer = isOfficer(viewer);
  const footer = receiptFooter(result.fc, viewer);
  if (result.status === "unchanged")
    return card("adjust.unchanged", {
      tone: "neutral",
      title: "No correction needed",
      description: `The recorded balance is already **${gilText(result.balance)}**, so nothing was written and nothing will be posted.`,
      fields: [{ name: "Recorded", value: marker("unchanged"), inline: true }],
      footer,
    });
  const { entry } = result;
  const corrects = correctsValue(entry, result.correction, officer);
  if (result.status === "already_recorded") {
    const context = {
      guildId: viewer.guildId,
      channelId: result.channelId,
      effectsMode: result.effectsMode,
    };
    const post = result.post
      ? result.post.status === "queued" && !result.post.last_error
        ? `Queued for ${mentionChannel(result.channelId)}. Track it with \`/ledger history\`.`
        : postState({ ...result.post, sequence: entry.sequence }, context, "line")
      : "No channel post was queued for this entry.";
    return card(
      "receipt.already_recorded",
      {
        tone: "info",
        title: "Already recorded",
        description: `This request was already recorded as entry **#${entry.sequence}**. No additional gil was recorded.`,
        fields: [
          { name: "Operation", value: operationLabel(entry.operation), inline: true },
          { name: "Amount", value: entryAmount(entry), inline: true },
          { name: "Balance after entry", value: gilText(entry.balance), inline: true },
          corrects !== null && { name: "Corrects", value: corrects },
          officer && { name: "Channel post", value: post },
          officer && { name: "Entry ID", value: code(entry.id) },
          noteField(entry.note),
        ],
        footer: [`Ref ${viewer.ref}`, result.fc ? taggedName(result.fc) : null],
      },
      entry.event_at,
    );
  }
  const mode = result.effectsMode;
  const channel = mentionChannel(result.channelId);
  const ledger = ledgerOf(result.fc);
  const previous = {
    name: "Previous balance",
    value: gilText(entry.balance - entry.delta),
    inline: true,
  };
  const next = { name: "New balance", value: gilText(entry.balance), inline: true };
  const number = { name: "Entry", value: `#${entry.sequence}`, inline: true };
  let kind: LedgerReplyKind;
  let heading: string;
  let lead: string;
  let facts: FieldSpec[];
  // The second line says when the entry reaches the ledger channel: shortly (approved ledger#0),
  // or, while paused, when the pause ends, never claiming a post that hasn't happened.
  const post = paused(mode)
    ? `post in ${channel} goes out ${whenApplied(mode)}.`
    : `will be posted in ${channel} ${whenApplied(mode)}.`;
  let posted = paused(mode) ? `Its ${post}` : `It ${post}`;
  switch (entry.operation) {
    case "withdraw":
      kind = "withdraw.recorded";
      heading = "Withdrawal recorded";
      lead = `**${signedGilText(entry.delta)}** was taken from ${ledger}.`;
      facts = [previous, next, number];
      break;
    case "initialize":
      kind = "initialize.recorded";
      heading = "Opening balance recorded";
      lead = `${ledgerOf(result.fc, "The")} now starts at **${gilText(entry.balance)}**.`;
      posted = `Members can record deposits from now on. The entry${paused(mode) ? "'s" : ""} ${post}`;
      facts = [{ name: "Opening balance", value: gilText(entry.balance), inline: true }, number];
      break;
    case "adjust":
      kind = "adjust.recorded";
      heading = "Correction recorded";
      lead = `The recorded balance was corrected by **${signedGilText(entry.delta)}** to **${gilText(entry.balance)}**.`;
      facts = [previous, next, number];
      break;
    default:
      kind = officer ? "deposit.recorded_officer" : "deposit.recorded";
      heading = "Deposit recorded";
      lead = `**${signedGilText(entry.delta)}** was added to ${ledger}.`;
      facts = [next, number];
  }
  if (corrects !== null) facts.push({ name: "Corrects", value: corrects });
  const identity: FieldSpec[] = officer
    ? [{ name: "Entry ID", value: code(entry.id) }, noteField(entry.note)]
    : [noteField(entry.note)];
  if (paused(mode)) {
    // Owner decision O2: the approved paused-save card, never a success card with a PAUSED field.
    // Its footer is the approved #26 one; the officer's Entry ID field still carries the entry.
    const save = pausedSave(mode, viewer);
    return card(
      "receipt.paused",
      {
        tone: save.tone,
        title: save.title,
        description: [lead, posted],
        fields: [...save.fields, ...facts, ...identity],
        footer: save.footer,
      },
      entry.event_at,
    );
  }
  return card(
    kind,
    {
      tone: "success",
      title: heading,
      description: [lead, posted],
      fields: [
        ...facts,
        officer && {
          name: "Channel post",
          value: `Queued for ${channel}. Track it with \`/ledger history\`.`,
        },
        ...identity,
      ],
      footer,
    },
    entry.event_at,
  );
}

// ---------------------------------------------------------------------------------------------
// /ledger balance

/** Collapsed runs of successful posts: '#34–#40 · Posted (7)'. */
function collapsed(rows: readonly PostRow[]): string {
  const newest = rows[0]?.sequence ?? 0n;
  const oldest = rows.at(-1)?.sequence ?? 0n;
  return `#${oldest}–#${newest}${SEPARATOR}Posted (${grouped(rows.length)})`;
}

/**
 * The officer 'Channel posts' lines, newest first (approved ledger#17): each row as '#seq · state',
 * except that within a run of successful posts only the newest keeps its own line and jump link
 * and the rest collapse into one count.
 */
function postLines(rows: readonly PostRow[], context: PostContext): string[] {
  const line = (row: PostRow): string =>
    `#${row.sequence}${SEPARATOR}${postState(row, context, "line")}`;
  const lines: string[] = [];
  let run: PostRow[] = [];
  const flush = () => {
    const [newest, ...rest] = run;
    if (newest) lines.push(line(newest));
    // A single older post keeps its own line; '(1)' would say less than the line itself.
    if (rest.length > 1) lines.push(collapsed(rest));
    else if (rest[0]) lines.push(line(rest[0]));
    run = [];
  };
  for (const row of rows) {
    if (isPosted(row)) run.push(row);
    else {
      flush();
      lines.push(line(row));
    }
  }
  flush();
  return lines;
}

/** The member count of posts still on their way (approved ledger#16); null when all posted. */
function pendingPosts(rows: readonly PostRow[], channelId: string | null): FieldSpec | null {
  const waiting = rows.filter((row) => !isPosted(row)).length;
  if (!waiting) return null;
  const where = channelId ? mentionChannel(channelId) : "the ledger channel";
  const one = waiting === 1;
  return {
    name: "Ledger posts",
    value: `${count(waiting, "recent entry", "recent entries")} ${one ? "is" : "are"} still waiting to be posted in ${where}. The balance above already includes ${one ? "it" : "them"}.`,
  };
}

/**
 * /ledger balance. Known balance (approved ledger#16 member, info; #17 officer): the recorded
 * balance in bold, Entries and Last entry, and for members a count of posts still on their way.
 * Officers also see the FC ID and each recent post's state, with 'What to do' only for problems;
 * their tone is warning for blocked or failed posts, pending for paused ones and info otherwise.
 * An unset opening balance is never shown as 0 gil (#18, #19), and another FC's account is the
 * neutral read-only historical view (#20). View history opens page 1 as a new reply; officers also
 * get Full details (JSON).
 */
export function balanceReply(result: LedgerBalanceView, viewer: Viewer): Presented {
  const officer = isOfficer(viewer);
  const { account, fc } = result;
  const scope = result.current ? "c" : "h";
  const context: PostContext = {
    guildId: account.guild_id,
    channelId: result.channelId,
    effectsMode: result.effectsMode,
  };
  const buttons: (ButtonSpec | false)[] = [
    account.sequence > 0n && viewHistoryButton(scope, account.fc_id),
    officer && detailsButton({ action: "balance", scope, fcId: account.fc_id }),
  ];
  const known = account.balance !== null && result.balanceState === "known";
  const recorded = known ? `Recorded balance\n**${gilText(account.balance ?? 0n)}**` : null;
  const entries: FieldSpec = { name: "Entries", value: grouped(account.sequence), inline: true };
  const latest: FieldSpec | null = result.latest && {
    name: "Last entry",
    value: [
      `#${result.latest.sequence}`,
      operationLabel(result.latest.operation),
      when(result.latest.event_at, "R"),
    ].join(SEPARATOR),
    inline: true,
  };
  const fcField: FieldSpec = {
    name: "FC",
    value: `${code(account.fc_id)}${SEPARATOR}${result.current ? "linked" : "not linked"}`,
    inline: true,
  };
  const posts = officer
    ? splitFields("Channel posts (last 10 entries)", postLines(result.delivery, context))
    : [];
  const footer = officer ? accountFooter(account.id) : MEMBER_FOOTER;
  if (!result.current)
    return card("balance.historical", {
      tone: "neutral",
      title: fc ? fcTitle("Historical ledger · ", account.fc_id, fc) : "Historical ledger",
      description: [
        !fc && `Free Company ${code(account.fc_id)}`,
        recorded ?? "No opening balance was recorded.",
        "This Free Company isn't linked to this server anymore. Its ledger is kept read-only here. New entries always go to the linked FC.",
      ],
      fields: [entries, latest, officer && fcField, ...posts],
      footer,
      buttons,
    });
  const heading = fcTitle("", account.fc_id, fc, " ledger");
  if (!known)
    return officer
      ? card("balance.uninitialized_officer", {
          tone: "warning",
          title: heading,
          description: [
            "No opening balance has been recorded yet, so deposits and withdrawals are refused.",
            `Count the FC chest and record it once with ${code("/ledger initialize balance:<gil> note:<how it was counted>")}.`,
          ],
          fields: [entries, fcField],
          footer,
          buttons,
        })
      : card("balance.uninitialized", {
          tone: "warning",
          title: heading,
          description:
            "No opening balance has been recorded yet. Deposits open once an officer records it.",
          footer,
          buttons,
        });
  if (!officer)
    return card("balance.member", {
      tone: "info",
      title: heading,
      description: recorded ?? "",
      fields: [entries, latest, pendingPosts(result.delivery, result.channelId)],
      footer,
      buttons,
    });
  const problems = problemsOf(result.delivery);
  const steps = nextSteps(problems, result.effectsMode, "balance");
  return card("balance.officer", {
    tone: officerTone(problems),
    title: heading,
    description: recorded ?? "",
    fields: [
      entries,
      latest,
      fcField,
      ...posts,
      steps.length > 0 && {
        name: "What to do",
        value: [...steps, "The entries themselves are already recorded."].join(" "),
      },
    ],
    footer,
    buttons,
  });
}

// ---------------------------------------------------------------------------------------------
// /ledger history

/**
 * Page numbers from the service's exact counts (amendment C1): `above` entries are newer than the
 * page, so a cursor typed by hand that isn't on a ten-entry boundary still numbers correctly.
 * page = ceil(above / 10) + 1 and pages = ceil(above / 10) + ceil((total − above) / 10).
 */
export function historyPage(above: number, total: number): { page: number; pages: number } {
  const newer = Math.ceil(above / HISTORY_PAGE_SIZE);
  return {
    page: newer + 1,
    pages: newer + Math.ceil(Math.max(0, total - above) / HISTORY_PAGE_SIZE),
  };
}

/** The most a note excerpt may use: members read more, officers carry entry and post lines. */
const EXCERPT = { member: 250, officer: 180 } as const;
/** Below this an excerpt says too little to be worth its quote line. */
const MIN_EXCERPT = 24;
/** The embed's total budget, kept a little under Discord's 6,000. */
const EMBED_BUDGET = DISCORD_LIMITS.embedTotal - 100;

/** One entry's field before its note excerpt is budgeted. */
interface EntryDraft {
  readonly name: string;
  /** The value lines above the quoted note. */
  readonly head: string;
  readonly note: string;
}

/** Everything the entry fields are rendered from. */
interface EntryContext extends PostContext {
  readonly officer: boolean;
  readonly posts: ReadonlyMap<string, PostRow>;
  readonly corrections: Readonly<Record<string, bigint>>;
  /** Jump links are the first thing dropped when the page is over budget. */
  readonly links: boolean;
}

/**
 * One entry as a field (approved ledger#21; officer reply spec #22): '#seq · Label · amount' as the
 * name; the balance after it, who recorded it ('Legacy import' for imported rows) and when; the
 * corrected entry; for officers the entry UUID and 'Post: <state>'; then the quoted note.
 */
function entryDraft(entry: LedgerEntryView, context: EntryContext): EntryDraft {
  const actor = entry.actor_id ? mentionUser(entry.actor_id) : "Legacy import";
  const target = entry.correction_id ? context.corrections[entry.correction_id] : undefined;
  const corrects = entry.correction_id
    ? target !== undefined
      ? `Corrects #${target}`
      : context.officer
        ? `Corrects ${code(entry.correction_id)}`
        : "Corrects an earlier entry"
    : null;
  const lines = [
    [`Balance **${gilText(entry.balance)}**`, actor, when(entry.event_at, "R")].join(SEPARATOR),
  ];
  if (context.officer) {
    lines.push([corrects, `Entry ${code(entry.id)}`].filter(Boolean).join(SEPARATOR));
    const row = context.posts.get(entry.id);
    let state: string;
    if (entry.operation === "import") state = "Imported (not posted)";
    else if (!row) state = "Not queued";
    else {
      state = postState(row, context, "post");
      if (!context.links && state.startsWith("[Posted]")) state = "Posted";
    }
    lines.push(`Post: ${state}`);
  } else if (corrects) lines.push(corrects);
  return {
    name: [`#${entry.sequence}`, operationLabel(entry.operation), entryAmount(entry)].join(
      SEPARATOR,
    ),
    head: lines.join("\n"),
    note: entry.note,
  };
}

/**
 * The page's fields with note excerpts budgeted so the whole embed stays within 6,000 characters
 * and each field within 1,024: every excerpt gets an equal share of what the fixed text leaves,
 * capped at 250 (members) or 180 (officers). When the share falls below the cap, officers' jump
 * links are dropped first ('Posted' without a link), and only then are excerpts shortened.
 */
function entryFields(
  entries: readonly LedgerEntryView[],
  context: Omit<EntryContext, "links">,
  fixed: number,
): FieldSpec[] {
  const cap = context.officer ? EXCERPT.officer : EXCERPT.member;
  const draft = (links: boolean) => {
    const drafts = entries.map((entry) => entryDraft(entry, { ...context, links }));
    const used = drafts.reduce((sum, d) => sum + d.name.length + d.head.length + 1, fixed);
    const share = Math.floor((EMBED_BUDGET - used) / Math.max(1, drafts.length));
    return { drafts, share };
  };
  let { drafts, share } = draft(true);
  if (share < cap && context.officer) ({ drafts, share } = draft(false));
  return drafts.map(({ name, head, note }) => {
    // Each value also stays within Discord's 1,024 characters per field.
    const room = Math.min(cap, share, DISCORD_LIMITS.fieldValue - head.length - 1);
    return { name, value: room >= MIN_EXCERPT ? `${head}\n${quote(note, room)}` : head };
  });
}

/** The officer problem line under the page range (reply spec #22): counts, then next steps. */
function problemLine(problems: PostProblems, mode: EffectsMode): string | null {
  if (!needsAttention(problems)) return null;
  const parts = [
    problems.blocked > 0 && ["blocked", problems.blocked],
    problems.failed > 0 && ["failed", problems.failed],
    problems.paused > 0 && ["paused", problems.paused],
    problems.waiting > 0 && ["waiting", problems.waiting],
  ].filter((part): part is [string, number] => Boolean(part));
  const counts = parts
    .map(([state, n], index) => (index === 0 ? `${count(n, "post")} ${state}` : `${n} ${state}`))
    .join(", ");
  return [`${counts}.`, ...nextSteps(problems, mode, "history")].join(" ");
}

/** The read-only line on another FC's history. */
const READ_ONLY = "Read-only. This Free Company isn't linked to this server anymore.";

/**
 * /ledger history and its pager. A page (approved ledger#21 member, reply specs #22 officer and
 * #23 last page): 'Newest first · entries #a–#b of total', one field per entry, and 'Page n of m'
 * from the exact counts (C1), ending '· end of history' on the oldest page. Latest and Newer are
 * enabled whenever a newer entry exists, Older whenever an older one does, and every button
 * re-reads as its presser. Officers also see entry UUIDs, each post's state, a problem line, the
 * account ID and Full details (JSON) for this cursor; their tone follows the posts on the page.
 * An empty ledger and a cursor past the oldest entry are neutral (#24).
 */
export function historyReply(result: LedgerHistoryView, viewer: Viewer): Presented {
  const officer = isOfficer(viewer);
  const { account, entries } = result;
  const scope = result.current ? "c" : "h";
  const heading = fcTitle("Ledger history · ", account.fc_id, result.fc);
  const readOnly = !result.current && READ_ONLY;
  const officerFooter = officer ? accountFooter(account.id) : null;
  const pager = ledgerPager({
    scope,
    fcId: account.fc_id,
    above: result.above,
    newer: result.newer,
    older: result.older,
  });
  const newest = entries[0];
  const oldest = entries.at(-1);
  if (!newest || !oldest) {
    if (result.total === 0)
      return card("history.empty", {
        tone: "neutral",
        title: heading,
        description: [
          officer
            ? `No entries yet. Count the FC chest and record the opening balance once with ${code("/ledger initialize balance:<gil> note:<how it was counted>")}.`
            : "No entries yet. The ledger starts when an officer records the opening balance with `/ledger initialize`.",
          readOnly,
        ],
        footer: [officerFooter],
      });
    return card("history.past_end", {
      tone: "neutral",
      title: heading,
      description: [
        result.before === null
          ? "No older entries."
          : `No older entries. Nothing is recorded before #${result.before}.`,
        "Use **Latest** to go back to the newest entries.",
        readOnly,
      ],
      footer: ["Past the end of history", officerFooter],
      buttons: pager,
    });
  }
  const range =
    newest.sequence === oldest.sequence
      ? `entry #${newest.sequence}`
      : `entries #${newest.sequence}–#${oldest.sequence}`;
  const posts = new Map(result.delivery.map((row) => [row.entry_id, row]));
  const problems = problemsOf(result.delivery);
  const description = [
    `Newest first${SEPARATOR}${range} of ${grouped(result.total)}`,
    readOnly,
    officer && problemLine(problems, result.effectsMode),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  const { page, pages } = historyPage(result.above, result.total);
  const footer = [
    `Page ${page} of ${pages}`,
    result.older === null && "end of history",
    officerFooter,
  ]
    .filter((part): part is string => Boolean(part))
    .join(SEPARATOR);
  const fields = entryFields(
    entries,
    {
      officer,
      posts,
      corrections: result.corrections,
      guildId: account.guild_id,
      channelId: result.channelId,
      effectsMode: result.effectsMode,
    },
    heading.length + description.length + footer.length,
  );
  const kind: LedgerReplyKind = !result.current
    ? "history.historical"
    : officer
      ? "history.officer"
      : result.older === null
        ? "history.last"
        : "history.member";
  return card(kind, {
    tone: !result.current ? "neutral" : officer ? officerTone(problems) : "info",
    title: heading,
    description,
    fields,
    footer,
    buttons: [
      ...pager,
      officer &&
        detailsButton({ action: "history", scope, fcId: account.fc_id, before: result.before }),
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// The ledger channel post

/**
 * Every ledger channel post kind, each stamped with its entry's event_at (approved ledger#29 and
 * #32, reply specs #30 and #31). An imported opening balance never posts, but reads as an opening.
 */
const POST_TIMESTAMP = {
  "post.deposit": true,
  "post.withdraw": true,
  "post.opening": true,
  "post.correction": true,
} as const satisfies Record<string, boolean>;

/** A ledger channel post state; tests catalogue one case per kind. */
export type LedgerPostKind = keyof typeof POST_TIMESTAMP;

/** Every ledger post kind, for catalog completeness checks. */
export const LEDGER_POST_KINDS = Object.keys(POST_TIMESTAMP) as readonly LedgerPostKind[];

/**
 * Post color encodes the operation, a feed signal rather than an outcome (every entry was
 * recorded): deposit success, withdrawal and opening balance info (a withdrawal is a normal
 * event, and orange is the house warning), correction warning so a fix stands out.
 */
const POST_TONE: Readonly<Record<LedgerPostKind, Tone>> = {
  "post.deposit": "success",
  "post.withdraw": "info",
  "post.opening": "info",
  "post.correction": "warning",
};

/** Which post an entry's operation makes; an operation this release doesn't know reads as info. */
function postKind(operation: string): LedgerPostKind | null {
  if (operation === "deposit") return "post.deposit";
  if (operation === "withdraw") return "post.withdraw";
  if (opening(operation)) return "post.opening";
  if (operation === "adjust") return "post.correction";
  return null;
}

/**
 * One entry's post in the ledger channel (approved ledger#29 and #32, reply specs #30 and #31):
 * '<Operation> · <signed amount>' (an opening balance unsigned), the full note escaped as the
 * description, the new balance (a correction shows the previous and new balance and the entry
 * number it corrects; an opening balance is its own balance), who recorded it ('Legacy import'
 * without an actor) and the entry number, with 'Entry <uuid>' in the footer and event_at as the
 * timestamp. It has no content, no author line and nothing per-attempt, so a nonce retry sends
 * byte-identical JSON. Channel posts are exempt from the 1,000-character house description limit:
 * a note of 1,000 characters is shown whole, and escaping keeps it within Discord's 4,096.
 */
export function ledgerPost(view: LedgerPostView): Presented {
  const { entry } = view;
  const kind = postKind(entry.operation);
  const correction = kind === "post.correction";
  return channelPost({
    tone: kind ? POST_TONE[kind] : "info",
    title: `${operationLabel(entry.operation)}${SEPARATOR}${entryAmount(entry)}`,
    description: plain(entry.note, DISCORD_LIMITS.description),
    fields: [
      correction && {
        name: "Previous balance",
        value: gilText(entry.balance - entry.delta),
        inline: true,
      },
      correction && { name: "New balance", value: gilText(entry.balance), inline: true },
      !correction &&
        kind !== "post.opening" && { name: "Balance", value: gilText(entry.balance), inline: true },
      view.correctionSequence !== null && {
        name: "Corrects",
        value: `#${view.correctionSequence}`,
        inline: true,
      },
      {
        name: "Recorded by",
        value: entry.actor_id ? mentionUser(entry.actor_id) : "Legacy import",
        inline: true,
      },
      { name: "Entry", value: `#${entry.sequence}`, inline: true },
    ],
    footer: `Entry ${entry.id}`,
    // Every post kind is stamped (POST_TIMESTAMP), with the entry's own time, never the send time.
    timestamp: entry.event_at,
  });
}
