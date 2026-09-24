/**
 * Ledger replies: every catalog state follows the house style; the approved cards (ledger#0, #2,
 * #7, #16, #17 and #21) are reproduced exactly; receipts show UUIDs and the Ref only to officers
 * and become the paused-save card while Discord changes are paused; the balance view never shows
 * an unset balance as 0 gil and its officer tone follows the posts; history page numbers and
 * pager buttons come from the exact counts (amendment C1), including hand-typed cursors; maximal
 * pages stay within Discord's limits without truncation; and the ledger failures render as their
 * approved concepts.
 */
import { describe, expect, test } from "bun:test";
import { embedLength } from "discord.js";
import type {
  DeliveryRow,
  LedgerBalanceView,
  LedgerEntryView,
  LedgerHistoryView,
  LedgerReceipt,
} from "../../src/application/results.js";
import { failureReply } from "../../src/discord/presenters/failure.js";
import {
  balanceReply,
  historyPage,
  historyReply,
  LEDGER_REPLY_KINDS,
  receiptReply,
} from "../../src/discord/presenters/ledger.js";
import { DISCORD_LIMITS } from "../../src/discord/presenters/style.js";
import { cursor, uuid } from "../../src/discord/selectors.js";
import type { FailureCode, FailureDetail } from "../../src/domain/failures.js";
import { Failure, MAX_GIL, note } from "../../src/domain/values.js";
import {
  buttonsOf,
  expectFailure,
  expectHouseStyle,
  onlyEmbed,
  stress,
  visibleText,
} from "../fixtures/replies.js";
import { catalogTests } from "../fixtures/replies/index.js";
import {
  ACCOUNT_ID,
  BLOCKED_POST,
  E41,
  E42,
  E43,
  ENTRY_IDS,
  entry,
  HEALTHY_POSTS,
  historyView,
  IMPORTED,
  LEDGER_CASES,
  LEDGER_CHANNEL,
  LEDGER_FC,
  LEDGER_RESULTS as R,
  OLD_FC,
  PAGE_ONE,
  postFor,
  WAITING_POST,
} from "../fixtures/replies/ledger.js";
import { at, MEMBER_ID, OFFICER_ID, REF, VIEWERS } from "../fixtures/results.js";

catalogTests("ledger", LEDGER_CASES);

/** The embed a case renders. */
const embedOf = (kind: keyof typeof LEDGER_CASES) => onlyEmbed(LEDGER_CASES[kind].render());
/** A field's value by name, or undefined. */
const fieldOf = (embed: ReturnType<typeof onlyEmbed>, name: string) =>
  embed.fields?.find((field) => field.name === name)?.value;
/** Field names in order. */
const namesOf = (embed: ReturnType<typeof onlyEmbed>) =>
  (embed.fields ?? []).map((field) => field.name);
/** Button labels, custom IDs and disabled flags, in order. */
const controlsOf = (presented: Parameters<typeof buttonsOf>[0]) =>
  buttonsOf(presented).map((button) => ({
    label: "label" in button ? button.label : undefined,
    id: "custom_id" in button ? button.custom_id : undefined,
    disabled: button.disabled ?? false,
  }));
/** The approved jump link of entry #41's post. */
const POSTED_41 =
  "[Posted](https://discord.com/channels/123456789012345678/234567890123456789/567890123456789012)";

test("the catalog covers every ledger reply kind", () => {
  expect(Object.keys(LEDGER_CASES).sort()).toEqual([...LEDGER_REPLY_KINDS].sort());
});

describe("approved cards are reproduced exactly", () => {
  test("ledger#0: a member's deposit receipt", () => {
    expect(embedOf("deposit.recorded")).toEqual({
      color: 0x57f287,
      title: "Deposit recorded",
      description:
        "**+10,005,000 gil** was added to the Example Free Company ledger.\nIt will be posted in <#234567890123456789> shortly.",
      fields: [
        { name: "New balance", value: "120,450,000 gil", inline: true },
        { name: "Entry", value: "#41", inline: true },
        { name: "Note", value: "Sold housing furnishings on the market board" },
      ],
      footer: { text: "Example Free Company «EXFC» · Diabolos" },
      timestamp: E41.event_at.toISOString(),
    });
    expect(buttonsOf(LEDGER_CASES["deposit.recorded"].render())).toEqual([]);
  });

  test("ledger#2: an officer's withdrawal receipt, with the Ref footer", () => {
    expect(embedOf("withdraw.recorded")).toEqual({
      color: 0x57f287,
      title: "Withdrawal recorded",
      description:
        "**−2,500,000 gil** was taken from the Example Free Company ledger.\nIt will be posted in <#234567890123456789> shortly.",
      fields: [
        { name: "Previous balance", value: "120,450,000 gil", inline: true },
        { name: "New balance", value: "117,950,000 gil", inline: true },
        { name: "Entry", value: "#42", inline: true },
        {
          name: "Channel post",
          value: "Queued for <#234567890123456789>. Track it with `/ledger history`.",
        },
        { name: "Entry ID", value: "`7c1d2e3f-8a9b-4c0d-8e1f-2a3b4c5d6e7f`" },
        { name: "Note", value: "Company workshop materials for airship parts" },
      ],
      footer: { text: "Ref 1290000000000000001 · Example Free Company «EXFC»" },
      timestamp: E42.event_at.toISOString(),
    });
  });

  test("ledger#7: not enough recorded gil, warning with the Code · Ref footer", () => {
    const presented = failureReply(
      new Failure(
        "insufficient_funds",
        "Withdrawing 150,000,000 gil would take the recorded balance below zero.",
        0,
        { kind: "funds", balance: 117_900_000n, amount: 150_000_000n },
      ),
      { ref: REF, viewer: VIEWERS.officer, scope: "/ledger withdraw" },
    );
    expect(onlyEmbed(presented)).toEqual({
      color: 0xe67e22,
      title: "Not enough recorded gil",
      description:
        "Withdrawing **150,000,000 gil** would take the recorded balance below zero. Nothing was recorded.",
      fields: [
        { name: "Requested", value: "150,000,000 gil", inline: true },
        { name: "Recorded balance", value: "117,900,000 gil", inline: true },
      ],
      footer: { text: "Code insufficient_funds · Ref 1290000000000000001" },
    });
  });

  test("ledger#16: the member balance, with View history", () => {
    const presented = LEDGER_CASES["balance.member"].render();
    expect(onlyEmbed(presented)).toEqual({
      color: 0x5865f2,
      title: "Example Free Company ledger",
      description: "Recorded balance\n**117,900,000 gil**",
      fields: [
        { name: "Entries", value: "43", inline: true },
        { name: "Last entry", value: "#43 · Correction · <t:1790168400:R>", inline: true },
        {
          name: "Ledger posts",
          value:
            "2 recent entries are still waiting to be posted in <#234567890123456789>. The balance above already includes them.",
        },
      ],
      footer: { text: "Recorded by FC members and officers · not read from the game" },
    });
    expect(controlsOf(presented)).toEqual([
      { label: "View history", id: "ledger:open:c:9200000000000000001", disabled: false },
    ]);
  });

  test("ledger#17: the officer balance with post states, collapsed posts and next steps", () => {
    const presented = LEDGER_CASES["balance.officer"].render();
    expect(onlyEmbed(presented)).toEqual({
      color: 0xe67e22,
      title: "Example Free Company ledger",
      description: "Recorded balance\n**117,900,000 gil**",
      fields: [
        { name: "Entries", value: "43", inline: true },
        { name: "Last entry", value: "#43 · Correction · <t:1790168400:R>", inline: true },
        { name: "FC", value: "`9200000000000000001` · linked", inline: true },
        {
          name: "Channel posts (last 10 entries)",
          value: [
            "#43 · Waiting: posts after #42",
            "#42 · **Blocked**: bot can't post in <#234567890123456789> (missing channel permissions)",
            `#41 · ${POSTED_41}`,
            "#34–#40 · Posted (7)",
          ].join("\n"),
        },
        {
          name: "What to do",
          value:
            "Fix the channel with `/config ledger` (see `/config validate`). Saving any setting re-queues blocked posts. The entries themselves are already recorded.",
        },
      ],
      footer: { text: "Account 0f6f1c52-7a3e-4c1b-9d2e-6b5a4c3d2e1f" },
    });
    expect(controlsOf(presented)).toEqual([
      { label: "View history", id: "ledger:open:c:9200000000000000001", disabled: false },
      {
        label: "Full details (JSON)",
        id: "details:balance:c:9200000000000000001",
        disabled: false,
      },
    ]);
  });

  test("ledger#21: the member's first history page and its pager", () => {
    const presented = LEDGER_CASES["history.member"].render();
    const embed = onlyEmbed(presented);
    expect(embed).toMatchObject({
      color: 0x5865f2,
      title: "Ledger history · Example Free Company",
      description: "Newest first · entries #43–#34 of 43",
      footer: { text: "Page 1 of 5" },
    });
    expect(embed.timestamp).toBeUndefined();
    // The approved card draws the first four of the page's ten fields.
    expect(embed.fields).toHaveLength(10);
    expect(embed.fields?.slice(0, 4)).toEqual([
      {
        name: "#43 · Correction · −50,000 gil",
        value:
          "Balance **117,900,000 gil** · <@456789012345678901> · <t:1790168400:R>\nCorrects #42\n> Withdrawal #42 was actually 2,550,000 gil (receipt in officer chat)",
      },
      {
        name: "#42 · Withdrawal · −2,500,000 gil",
        value:
          "Balance **117,950,000 gil** · <@456789012345678901> · <t:1790164800:R>\n> Company workshop materials for airship parts",
      },
      {
        name: "#41 · Deposit · +10,005,000 gil",
        value:
          "Balance **120,450,000 gil** · <@345678901234567890> · <t:1790161200:R>\n> Sold housing furnishings on the market board",
      },
      {
        name: "#40 · Deposit · +1,200,000 gil",
        value:
          "Balance **110,445,000 gil** · <@345678901234567890> · <t:1790078400:R>\n> Leftover gil from the FC map run",
      },
    ]);
    // Newer is disabled and Latest hidden on the newest page; Older carries the page's cursor.
    expect(controlsOf(presented)).toEqual([
      { label: "Newer", id: "ledger:newer:c:9200000000000000001", disabled: true },
      { label: "Older", id: "ledger:older:c:9200000000000000001:34", disabled: false },
    ]);
  });
});

describe("receipts", () => {
  /** Every recorded result, as a member and as an officer. */
  const RECORDED = [R.deposit, R.withdraw, R.initialize, R.adjust] as const;

  test("member receipts hide the entry UUID, post status and Ref; officer receipts show them", () => {
    for (const result of RECORDED) {
      const member = receiptReply(result, VIEWERS.member);
      const text = visibleText(member);
      expect(text).not.toContain(result.entry.id);
      expect(text).not.toContain(REF);
      expect(text).not.toContain("Channel post");
      expect(onlyEmbed(member).footer?.text).toBe("Example Free Company «EXFC» · Diabolos");
      const officer = onlyEmbed(receiptReply(result, VIEWERS.officer));
      expect(fieldOf(officer, "Entry ID")).toBe(`\`${result.entry.id}\``);
      expect(officer.footer?.text).toBe(`Ref ${REF} · Example Free Company «EXFC»`);
      expect(fieldOf(officer, "Channel post")).toBe(
        `Queued for <#${LEDGER_CHANNEL}>. Track it with \`/ledger history\`.`,
      );
    }
  });

  test("the previous balance is exact, far beyond Number precision", () => {
    const result = {
      ...R.withdraw,
      entry: entry({ operation: "withdraw", delta: -(MAX_GIL - 1n), balance: 1n }),
    } satisfies LedgerReceipt;
    const embed = onlyEmbed(receiptReply(result, VIEWERS.officer));
    expect(fieldOf(embed, "Previous balance")).toBe("9,223,372,036,854,775,807 gil");
    expect(fieldOf(embed, "New balance")).toBe("1 gil");
    expect(embed.description).toStartWith("**−9,223,372,036,854,775,806 gil** was taken");
  });

  test("an opening balance shows no change field; a correction names what it corrects", () => {
    const opening = embedOf("initialize.recorded");
    expect(namesOf(opening)).toEqual([
      "Opening balance",
      "Entry",
      "Channel post",
      "Entry ID",
      "Note",
    ]);
    expect(opening.description).toBe(
      "The Example Free Company ledger now starts at **95,000,000 gil**.\nMembers can record deposits from now on. The entry will be posted in <#234567890123456789> shortly.",
    );
    const correction = embedOf("adjust.recorded");
    expect(fieldOf(correction, "Corrects")).toBe(`#42 · \`${ENTRY_IDS[42]}\``);
    expect(correction.description).toBe(
      "The recorded balance was corrected by **−50,000 gil** to **117,900,000 gil**.\nIt will be posted in <#234567890123456789> shortly.",
    );
    // A positive correction carries its plus sign, and members see only the entry number.
    const up = receiptReply(
      { ...R.adjust, entry: { ...E43, delta: 50_000n, balance: 118_000_000n } },
      VIEWERS.member,
    );
    expect(onlyEmbed(up).description).toStartWith(
      "The recorded balance was corrected by **+50,000 gil**",
    );
    expect(fieldOf(onlyEmbed(up), "Corrects")).toBe("#42");
  });

  test("an unchanged correction is neutral '= NO CHANGE' with no entry", () => {
    const embed = embedOf("adjust.unchanged");
    expect(embed.description).toBe(
      "The recorded balance is already **117,900,000 gil**, so nothing was written and nothing will be posted.",
    );
    expect(embed.fields).toEqual([{ name: "Recorded", value: "`= NO CHANGE`", inline: true }]);
    expect(embed.timestamp).toBeUndefined();
    expect(visibleText(LEDGER_CASES["adjust.unchanged"].render())).not.toMatch(/Entry ID|shortly/u);
  });

  test("a replayed interaction shows the balance after its entry and, for officers, its post", () => {
    const officer = embedOf("receipt.already_recorded");
    expect(officer.description).toBe(
      "This request was already recorded as entry **#41**. No additional gil was recorded.",
    );
    expect(fieldOf(officer, "Balance after entry")).toBe("120,450,000 gil");
    expect(fieldOf(officer, "Amount")).toBe("+10,005,000 gil");
    expect(fieldOf(officer, "Channel post")).toBe(POSTED_41);
    const member = receiptReply(R.alreadyRecorded, VIEWERS.member);
    expect(namesOf(onlyEmbed(member))).toEqual([
      "Operation",
      "Amount",
      "Balance after entry",
      "Note",
    ]);
    expect(visibleText(member)).not.toContain(E41.id);
    // A replayed post that is still queued or blocked reads as it does everywhere else.
    const blocked = receiptReply(
      {
        ...R.alreadyRecorded,
        post: { status: "blocked", message_id: null, last_error: BLOCKED_POST.last_error },
      },
      VIEWERS.officer,
    );
    expect(fieldOf(onlyEmbed(blocked), "Channel post")).toBe(
      `**Blocked**: bot can't post in <#${LEDGER_CHANNEL}> (missing channel permissions)`,
    );
    const missing = receiptReply({ ...R.alreadyRecorded, post: null }, VIEWERS.officer);
    expect(fieldOf(onlyEmbed(missing), "Channel post")).toBe(
      "No channel post was queued for this entry.",
    );
  });

  test("a paused receipt is the pending paused-save card and never claims a post", () => {
    for (const mode of ["awaiting_activation", "deployment_disabled"] as const)
      for (const result of RECORDED)
        for (const viewer of [VIEWERS.member, VIEWERS.officer]) {
          const presented = receiptReply({ ...result, effectsMode: mode }, viewer);
          const embed = expectHouseStyle(presented, {
            tone: "pending",
            title: "Saved, Discord changes paused",
            timestamp: false,
          });
          expect(namesOf(embed).slice(0, 2)).toEqual(["Saved", "Discord changes"]);
          expect(fieldOf(embed, "Discord changes")).toStartWith("`‖ PAUSED`");
          expect(visibleText(presented)).not.toMatch(/posted|shortly|QUEUED/iu);
          expect(embed.description).toContain(
            mode === "awaiting_activation"
              ? "goes out once this server is activated."
              : "goes out once Discord changes are turned back on.",
          );
          // The receipt keeps its own ledger facts.
          expect(fieldOf(embed, "Entry")).toBe(`#${result.entry.sequence}`);
        }
  });

  test("notes in receipts are escaped and capped at 300 characters", () => {
    const text = stress.text(1_000);
    const embed = expectHouseStyle(
      receiptReply({ ...R.deposit, entry: entry({ note: text }) }, VIEWERS.member),
    );
    const value = fieldOf(embed, "Note") ?? "";
    expect(value.length).toBeLessThanOrEqual(300);
    expect(value).toEndWith("…");
    expect(value).not.toMatch(/(?<!\\)<@/u);
  });

  test("an FC not yet read from the Lodestone reads as 'the FC ledger' with no FC footer", () => {
    const member = onlyEmbed(receiptReply({ ...R.deposit, fc: null }, VIEWERS.member));
    expect(member.description).toStartWith("**+10,005,000 gil** was added to the FC ledger.");
    expect(member.footer).toBeUndefined();
    const officer = onlyEmbed(receiptReply({ ...R.deposit, fc: null }, VIEWERS.officer));
    expect(officer.footer?.text).toBe(`Ref ${REF}`);
  });
});

describe("balance", () => {
  /** The officer balance over these posts. */
  const officerBalance = (
    delivery: readonly DeliveryRow[],
    extra: Partial<LedgerBalanceView> = {},
  ) => balanceReply({ ...R.balance, delivery, ...extra }, VIEWERS.officer);

  test("the officer tone is info when healthy, warning for blocked or failed, pending when paused", () => {
    const healthy = officerBalance(HEALTHY_POSTS);
    expectHouseStyle(healthy, { tone: "info" });
    expect(namesOf(onlyEmbed(healthy))).not.toContain("What to do");
    const failed = officerBalance([
      postFor(E43, { status: "failed", message_id: null }),
      ...HEALTHY_POSTS.slice(1),
    ]);
    expectHouseStyle(failed, { tone: "warning" });
    expect(fieldOf(onlyEmbed(failed), "What to do")).toBe(
      "Failed posts won't retry on their own, so report them to the bot operator. The entries themselves are already recorded.",
    );
    const paused = officerBalance(
      [postFor(E43, { status: "disabled", message_id: null }), ...HEALTHY_POSTS.slice(1)],
      { effectsMode: "awaiting_activation" },
    );
    expectHouseStyle(paused, { tone: "pending" });
    expect(fieldOf(onlyEmbed(paused), "What to do")).toBe(
      "Paused posts go out once this server is activated. The entries themselves are already recorded.",
    );
    expect(fieldOf(onlyEmbed(paused), "Channel posts (last 10 entries)")).toStartWith(
      "#43 · Paused: waiting for activation",
    );
    // Paused beside a block stays a warning (C4).
    expectHouseStyle(
      officerBalance([postFor(E43, { status: "disabled", message_id: null }), BLOCKED_POST]),
      { tone: "warning" },
    );
  });

  test("a run of posted entries keeps the newest with its link and collapses the rest", () => {
    const embed = onlyEmbed(officerBalance(HEALTHY_POSTS));
    expect(fieldOf(embed, "Channel posts (last 10 entries)")).toBe(
      [
        "#43 · [Posted](https://discord.com/channels/123456789012345678/234567890123456789/567890123456700043)",
        "#34–#42 · Posted (9)",
      ].join("\n"),
    );
    // A run of two keeps both lines rather than collapsing a single entry.
    const two = onlyEmbed(officerBalance(HEALTHY_POSTS.slice(0, 2)));
    expect(fieldOf(two, "Channel posts (last 10 entries)")?.split("\n")).toHaveLength(2);
  });

  test("every post state reads in words, and the member count covers everything unposted", () => {
    const rows: DeliveryRow[] = [
      postFor(entry({ sequence: 50n, id: E43.id }), { status: "queued", message_id: null }),
      postFor(entry({ sequence: 49n, id: E42.id }), { status: "running", message_id: null }),
      postFor(entry({ sequence: 48n }), {
        status: "queued",
        message_id: null,
        attempts: 2,
        last_error: "transient",
        due_at: at(120),
      }),
      postFor(entry({ sequence: 47n }), {
        status: "blocked",
        message_id: null,
        last_error: "blocked: Configure a ledger notification channel.",
      }),
      postFor(entry({ sequence: 46n }), {
        status: "blocked",
        message_id: null,
        last_error: "blocked: Text channel unavailable.",
      }),
      postFor(entry({ sequence: 45n }), {
        status: "blocked",
        message_id: null,
        last_error:
          "blocked: Recheck Discord roles, channel permissions, and bot hierarchy with /config validate.",
      }),
      postFor(entry({ sequence: 44n }), { status: "failed", message_id: null, attempts: 8 }),
      postFor(entry({ sequence: 43n }), { message_id: null }),
    ];
    const lines = fieldOf(onlyEmbed(officerBalance(rows)), "Channel posts (last 10 entries)");
    expect(lines?.split("\n")).toEqual([
      "#50 · Queued",
      "#49 · Posting now",
      `#48 · Retrying after a Discord error: next try <t:${Math.floor(at(120).getTime() / 1000)}:R>`,
      "#47 · **Blocked**: no ledger channel is set",
      "#46 · **Blocked**: bot can't post in <#234567890123456789> (channel unavailable)",
      "#45 · **Blocked**: bot can't post in <#234567890123456789> (Discord refused the post)",
      "#44 · **Failed** after repeated attempts",
      "#43 · Completed, no message",
    ]);
    // Without a ledger channel any block names that, and no jump link can be built.
    const unset = onlyEmbed(
      officerBalance([rows[5] as DeliveryRow, postFor(E41)], { channelId: null }),
    );
    expect(fieldOf(unset, "Channel posts (last 10 entries)")?.split("\n")).toEqual([
      "#45 · **Blocked**: no ledger channel is set",
      "#41 · Completed, no message",
    ]);
    const member = onlyEmbed(balanceReply({ ...R.balance, delivery: rows }, VIEWERS.member));
    expect(fieldOf(member, "Ledger posts")).toStartWith("7 recent entries are still waiting");
    const one = onlyEmbed(
      balanceReply(
        { ...R.balance, delivery: [WAITING_POST, ...HEALTHY_POSTS.slice(1)] },
        VIEWERS.member,
      ),
    );
    expect(fieldOf(one, "Ledger posts")).toBe(
      "1 recent entry is still waiting to be posted in <#234567890123456789>. The balance above already includes it.",
    );
    expect(
      namesOf(onlyEmbed(balanceReply({ ...R.balance, delivery: HEALTHY_POSTS }, VIEWERS.member))),
    ).toEqual(["Entries", "Last entry"]);
  });

  test("members never see UUIDs, the FC ID, post diagnostics or Full details", () => {
    const presented = balanceReply(R.balance, VIEWERS.member);
    const text = visibleText(presented);
    for (const hidden of [ACCOUNT_ID, LEDGER_FC.id, "Blocked", "Full details", "Posted"])
      expect(text).not.toContain(hidden);
  });

  test("an unset opening balance is never shown as 0 gil", () => {
    for (const viewer of [VIEWERS.member, VIEWERS.officer]) {
      const presented = balanceReply(R.uninitialized, viewer);
      expectHouseStyle(presented, { tone: "warning" });
      expect(visibleText(presented)).not.toMatch(/(?<![\d,])0 gil/u);
      // With no entries there is no history to open.
      expect(controlsOf(presented).map((control) => control.label)).not.toContain("View history");
    }
    expect(embedOf("balance.uninitialized_officer").description).toContain(
      "`/ledger initialize balance:<gil> note:<how it was counted>`",
    );
    // A known zero is a real balance and is shown.
    const zero = balanceReply(
      { ...R.balance, account: { ...R.balance.account, balance: 0n } },
      VIEWERS.member,
    );
    expect(onlyEmbed(zero).description).toBe("Recorded balance\n**0 gil**");
  });

  test("a historical account is neutral and read-only, titled by its FC name or its ID", () => {
    const embed = embedOf("balance.historical");
    expect(embed.title).toBe("Historical ledger · Example Old Company");
    expect(embed.description).toContain("Its ledger is kept read-only here.");
    expect(fieldOf(embed, "FC")).toBe("`9200000000000000002` · not linked");
    expect(controlsOf(LEDGER_CASES["balance.historical"].render())).toEqual([
      { label: "View history", id: "ledger:open:h:9200000000000000002", disabled: false },
      {
        label: "Full details (JSON)",
        id: "details:balance:h:9200000000000000002",
        disabled: false,
      },
    ]);
    const unnamed = expectHouseStyle(balanceReply({ ...R.historical, fc: null }, VIEWERS.officer), {
      tone: "neutral",
      title: "Historical ledger",
    });
    expect(unnamed.description).toStartWith(`Free Company \`${OLD_FC.id}\`\nRecorded balance`);
  });

  test("ten long blocked lines split across fields that each fit 1,024 characters", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      postFor(entry({ sequence: stress.cursor - BigInt(index) }), {
        status: "blocked",
        message_id: null,
        last_error: BLOCKED_POST.last_error,
      }),
    );
    const presented = balanceReply(
      {
        ...R.balance,
        account: { ...R.balance.account, sequence: stress.cursor, fc_id: stress.id },
        channelId: stress.id,
        delivery: rows,
      },
      VIEWERS.officer,
    );
    const embed = expectHouseStyle(presented);
    const posts = (embed.fields ?? []).filter((field) => field.name.startsWith("Channel posts"));
    expect(posts.map((field) => field.name)).toEqual([
      "Channel posts (last 10 entries) (1/2)",
      "Channel posts (last 10 entries) (2/2)",
    ]);
    expect(posts.flatMap((field) => field.value.split("\n"))).toHaveLength(10);
  });
});

describe("history", () => {
  test("page numbers come from the exact counts (C1)", () => {
    // 43 entries: the newest page, a middle page, the last page and past the end.
    expect(historyPage(0, 43)).toEqual({ page: 1, pages: 5 });
    expect(historyPage(20, 43)).toEqual({ page: 3, pages: 5 });
    expect(historyPage(40, 43)).toEqual({ page: 5, pages: 5 });
    // A hand-typed cursor off the ten-entry grid: before:35 leaves nine newer entries.
    expect(historyPage(9, 43)).toEqual({ page: 2, pages: 5 });
    expect(historyPage(0, 0)).toEqual({ page: 1, pages: 0 });
  });

  test("a cursor that isn't a multiple of 10 still reaches the newer entries", () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry({
        sequence: 34n - BigInt(index),
        id: `eeeeeeee-0000-4000-8000-0000000000${34 - index}`,
      }),
    );
    const presented = historyReply(
      historyView({ before: 35n, entries, delivery: [], older: 25n, newer: "latest", above: 9 }),
      VIEWERS.member,
    );
    const embed = expectHouseStyle(presented, { tone: "info" });
    expect(embed.description).toBe("Newest first · entries #34–#25 of 43");
    expect(embed.footer?.text).toBe("Page 2 of 5");
    expect(controlsOf(presented)).toEqual([
      { label: "Newer", id: "ledger:newer:c:9200000000000000001", disabled: false },
      { label: "Older", id: "ledger:older:c:9200000000000000001:25", disabled: false },
      { label: "Latest", id: "ledger:latest:c:9200000000000000001", disabled: false },
    ]);
  });

  test("a cursor past the newest entry shows the newest page as page 1", () => {
    const presented = historyReply(historyView({ before: 44n }), VIEWERS.member);
    expect(onlyEmbed(presented).footer?.text).toBe("Page 1 of 5");
    expect(controlsOf(presented).map(({ label, disabled }) => [label, disabled])).toEqual([
      ["Newer", true],
      ["Older", false],
    ]);
  });

  test("a middle page links both ways, and the last page ends the history", () => {
    const middle = historyReply(
      historyView({ before: 24n, newer: 34n, older: 14n, above: 20 }),
      VIEWERS.member,
    );
    expect(onlyEmbed(middle).footer?.text).toBe("Page 3 of 5");
    expect(controlsOf(middle)).toEqual([
      { label: "Newer", id: "ledger:newer:c:9200000000000000001:34", disabled: false },
      { label: "Older", id: "ledger:older:c:9200000000000000001:14", disabled: false },
      { label: "Latest", id: "ledger:latest:c:9200000000000000001", disabled: false },
    ]);
    const last = LEDGER_CASES["history.last"].render();
    expect(onlyEmbed(last)).toMatchObject({
      description: "Newest first · entries #3–#1 of 43",
      footer: { text: "Page 5 of 5 · end of history" },
    });
    expect(controlsOf(last)).toEqual([
      { label: "Newer", id: "ledger:newer:c:9200000000000000001:14", disabled: false },
      { label: "Older", id: "ledger:older:c:9200000000000000001", disabled: true },
      { label: "Latest", id: "ledger:latest:c:9200000000000000001", disabled: false },
    ]);
  });

  test("past the end and an empty ledger are neutral and say why", () => {
    const past = LEDGER_CASES["history.past_end"].render();
    expect(onlyEmbed(past)).toMatchObject({
      description:
        "No older entries. Nothing is recorded before #1.\nUse **Latest** to go back to the newest entries.",
      footer: { text: "Past the end of history" },
    });
    expect(controlsOf(past).map(({ label, disabled }) => [label, disabled])).toEqual([
      ["Newer", false],
      ["Older", true],
      ["Latest", false],
    ]);
    expect(embedOf("history.empty")).toEqual({
      color: 0x99aab5,
      title: "Ledger history · Example Free Company",
      description:
        "No entries yet. The ledger starts when an officer records the opening balance with `/ledger initialize`.",
    });
    const officer = onlyEmbed(historyReply(R.empty, VIEWERS.officer));
    expect(officer.description).toContain(
      "`/ledger initialize balance:<gil> note:<how it was counted>`",
    );
    expect(officer.footer?.text).toBe(`Account ${ACCOUNT_ID}`);
  });

  test("officers see entry UUIDs, post states, a problem line, the account and Full details", () => {
    const presented = LEDGER_CASES["history.officer"].render();
    const embed = onlyEmbed(presented);
    expect(embed.description).toBe(
      "Newest first · entries #43–#34 of 43\n1 post blocked, 1 waiting. Fix the channel with `/config ledger`; saving any setting re-queues blocked posts.",
    );
    expect(embed.fields?.slice(0, 3).map((field) => field.value)).toEqual([
      `Balance **117,900,000 gil** · <@${OFFICER_ID}> · <t:1790168400:R>\nCorrects #42 · Entry \`${ENTRY_IDS[43]}\`\nPost: Waiting (posts after #42)\n> Withdrawal #42 was actually 2,550,000 gil (receipt in officer chat)`,
      `Balance **117,950,000 gil** · <@${OFFICER_ID}> · <t:1790164800:R>\nEntry \`${ENTRY_IDS[42]}\`\nPost: **Blocked** (missing channel permissions in <#${LEDGER_CHANNEL}>)\n> Company workshop materials for airship parts`,
      `Balance **120,450,000 gil** · <@${MEMBER_ID}> · <t:1790161200:R>\nEntry \`${ENTRY_IDS[41]}\`\nPost: ${POSTED_41}\n> Sold housing furnishings on the market board`,
    ]);
    expect(embed.footer?.text).toBe(`Page 1 of 5 · Account ${ACCOUNT_ID}`);
    expect(controlsOf(presented).at(-1)).toEqual({
      label: "Full details (JSON)",
      id: "details:history:c:9200000000000000001",
      disabled: false,
    });
    // The details button re-reads the same page: it carries this page's cursor.
    const paged = historyReply(
      historyView({ before: 34n, older: 24n, newer: "latest", above: 10 }),
      VIEWERS.officer,
    );
    expect(controlsOf(paged).at(-1)?.id).toBe("details:history:c:9200000000000000001:34");
    // A healthy page is info with no problem line.
    const healthy = historyReply(historyView({ delivery: HEALTHY_POSTS }), VIEWERS.officer);
    expect(expectHouseStyle(healthy, { tone: "info" }).description).toBe(
      "Newest first · entries #43–#34 of 43",
    );
  });

  test("members never see UUIDs, post states, the account or Full details", () => {
    const presented = LEDGER_CASES["history.member"].render();
    const text = visibleText(presented);
    for (const hidden of [ACCOUNT_ID, ...PAGE_ONE.map((row) => row.id), "Post:", "Full details"])
      expect(text).not.toContain(hidden);
  });

  test("imports read 'Legacy import' and, for officers, 'Imported (not posted)'", () => {
    const member = onlyEmbed(LEDGER_CASES["history.last"].render());
    expect(member.fields?.at(-1)).toEqual({
      name: "#1 · Imported opening balance · 88,300,000 gil",
      value:
        "Balance **88,300,000 gil** · Legacy import · <t:1788134400:R>\n> Imported opening balance",
    });
    const officer = onlyEmbed(historyReply(R.lastPage, VIEWERS.officer));
    expect(officer.fields?.at(-1)?.value).toBe(
      `Balance **88,300,000 gil** · Legacy import · <t:1788134400:R>\nEntry \`${IMPORTED.id}\`\nPost: Imported (not posted)\n> Imported opening balance`,
    );
  });

  test("another FC's history is neutral, read-only and pages with historical controls", () => {
    const presented = LEDGER_CASES["history.historical"].render();
    const embed = onlyEmbed(presented);
    expect(embed.description).toBe(
      "Newest first · entries #18–#9 of 18\nRead-only. This Free Company isn't linked to this server anymore.",
    );
    expect(controlsOf(presented).map((control) => control.id)).toEqual([
      "ledger:newer:h:9200000000000000002",
      "ledger:older:h:9200000000000000002:9",
      "details:history:h:9200000000000000002",
    ]);
  });

  /** A page of ten maximal entries: longest IDs, sequences, amounts and 1,000-character notes. */
  function maximalPage(): LedgerHistoryView {
    const entries: LedgerEntryView[] = Array.from({ length: 10 }, (_, index) =>
      entry({
        id: `ffffffff-ffff-4fff-bfff-${index.toString().padStart(12, "f")}`,
        sequence: stress.cursor - BigInt(index),
        operation: index % 2 ? "withdraw" : "adjust",
        delta: -MAX_GIL,
        balance: MAX_GIL,
        actor_id: stress.id,
        note: stress.text(1_000),
        correction_id: stress.uuid,
      }),
    );
    return historyView({
      account: {
        ...R.history.account,
        fc_id: stress.id,
        guild_id: stress.id,
        sequence: stress.cursor,
      },
      fc: { ...LEDGER_FC, id: stress.id, name: "W".repeat(100) },
      channelId: stress.id,
      before: stress.cursor,
      entries,
      delivery: entries.map((row, index) =>
        postFor(row, {
          message_id: stress.id,
          status: index % 3 ? "succeeded" : "blocked",
          last_error: index % 3 ? null : BLOCKED_POST.last_error,
        }),
      ),
      older: stress.cursor - 10n,
      newer: stress.cursor,
      total: 2_000_000_000,
      above: 1_000_000_000,
      corrections: { [stress.uuid]: stress.cursor - 1n },
    });
  }

  test("maximal pages stay within Discord's limits without truncating", () => {
    for (const viewer of [VIEWERS.member, VIEWERS.officer]) {
      const presented = historyReply(maximalPage(), viewer);
      const embed = expectHouseStyle(presented);
      expect(embedLength(embed)).toBeLessThanOrEqual(DISCORD_LIMITS.embedTotal);
      expect(embed.fields).toHaveLength(10);
      const cap = viewer === VIEWERS.member ? 250 : 180;
      for (const field of embed.fields ?? []) {
        expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue);
        const excerpt = field.value.slice(field.value.indexOf("\n> ") + 1);
        // Every entry still quotes its note, cut to the audience's cap.
        expect(excerpt).toStartWith("> ");
        expect(excerpt.length).toBeLessThanOrEqual(cap);
        expect(excerpt).toEndWith("…");
      }
    }
  });

  test("pager and details custom IDs are unique and fit 100 characters at maximal inputs", () => {
    const presented = historyReply(maximalPage(), VIEWERS.officer);
    const ids = controlsOf(presented).map((control) => control.id ?? "");
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(100);
  });
});

describe("ledger failures render as their approved concepts", () => {
  /** A Failure as its throw site builds it. */
  const failure = (code: FailureCode, message: string, detail?: FailureDetail) =>
    new Failure(code, message, 0, detail);
  /** The error a call throws. */
  const thrown = (action: () => unknown): unknown => {
    try {
      action();
    } catch (error) {
      return error;
    }
    throw new Error("Expected the call to throw");
  };
  /** Render a ledger failure for an audience and command path. */
  const render = (error: unknown, audience: "member" | "officer", scope: string) =>
    failureReply(error, { ref: REF, viewer: VIEWERS[audience], scope });

  test("insufficient_funds says nothing was recorded", () => {
    const embed = expectFailure(
      render(
        failure("insufficient_funds", "Too low.", {
          kind: "funds",
          balance: 1n,
          amount: 2n,
        }),
        "officer",
        "/ledger withdraw",
      ),
      { code: "insufficient_funds", ref: REF, tone: "warning", title: "Not enough recorded gil" },
    );
    expect(embed.description).toEndWith("Nothing was recorded.");
  });

  test("an unset opening balance asks members for an officer and gives officers the command", () => {
    const error = failure(
      "uninitialized",
      "This FC's ledger has no opening balance yet, so it can't record changes.",
    );
    const member = expectFailure(render(error, "member", "/ledger deposit"), {
      code: "uninitialized",
      ref: REF,
      tone: "warning",
      title: "Opening balance not set",
    });
    expect(fieldOf(member, "Next step")).toBe(
      "Ask an officer to record the opening balance with `/ledger initialize`.",
    );
    const officer = expectFailure(render(error, "officer", "/ledger withdraw"), {
      code: "uninitialized",
      ref: REF,
      title: "Opening balance not set",
    });
    expect(fieldOf(officer, "Next step")).toContain("`/ledger initialize balance:");
  });

  test("the other ledger refusals keep their approved titles", () => {
    const cases: [unknown, "member" | "officer", string, FailureCode, string][] = [
      [
        failure("initialized", "This FC's ledger already has an opening balance."),
        "officer",
        "/ledger initialize",
        "initialized",
        "Opening balance already set",
      ],
      [
        failure(
          "forbidden",
          "The FC ledger is for confirmed members of this server's Free Company.",
          {
            kind: "scope",
            scope: "membership",
          },
        ),
        "member",
        "/ledger deposit",
        "forbidden",
        "FC membership needed",
      ],
      [
        failure(
          "conflict",
          "Server settings changed while this was running, so nothing was saved. Run the command again.",
        ),
        "officer",
        "/ledger adjust",
        "conflict",
        "Settings changed — try again",
      ],
      [thrown(() => cursor("next")), "member", "/ledger history", "input", "Check your input"],
      [thrown(() => note("   ")), "member", "/ledger deposit", "input", "Check your input"],
      [
        thrown(() => uuid("#42", "entry")),
        "officer",
        "/ledger adjust",
        "input",
        "Check your input",
      ],
      [
        failure(
          "not_found",
          "That entry isn't in this FC's ledger. Copy the entry ID from /ledger history.",
          {
            kind: "resource",
            resource: "entry",
            id: stress.uuid,
          },
        ),
        "officer",
        "/ledger adjust",
        "not_found",
        "Entry not found",
      ],
    ];
    // Each is something the user or an officer can fix, so every one is a warning.
    for (const [error, audience, scope, code, title] of cases)
      expectFailure(render(error, audience, scope), { code, ref: REF, tone: "warning", title });
  });

  test("an unexpected error while recording warns before retrying; a read doesn't", () => {
    const mutation = onlyEmbed(render(new TypeError("boom"), "member", "/ledger deposit"));
    expect(fieldOf(mutation, "Before retrying")).toBe(
      "If you were recording gil, check `/ledger history` first so the entry isn't recorded twice.",
    );
    const read = onlyEmbed(render(new TypeError("boom"), "member", "/ledger balance"));
    expect(fieldOf(read, "Before retrying")).toBeUndefined();
  });
});
