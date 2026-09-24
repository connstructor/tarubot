/**
 * /ledger: deposits, withdrawals, the opening balance and corrections, the balance and the paged
 * history. Options are parsed here into input failures that name the option; exact accounting and
 * authorization stay transactional in the service, and the ledger presenters render its results.
 */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { balanceReply, historyReply, receiptReply } from "../../discord/presenters/ledger.js";
import { cursor, entryRef } from "../../discord/selectors.js";
import { lodestoneId } from "../../domain/values.js";

const data = command("ledger", "Exact, human-maintained FC gil ledger");
for (const name of ["deposit", "withdraw"])
  data.addSubcommand((sub) =>
    sub
      .setName(name)
      .setDescription(`Record a gil ${name}`)
      .addIntegerOption((option) =>
        option
          .setName("amount")
          .setDescription("Gil amount")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(999999999),
      )
      .addStringOption(string("note", "Transaction explanation", true)),
  );
for (const name of ["initialize", "adjust"])
  data.addSubcommand((sub) => {
    sub
      .setName(name)
      .setDescription(
        name === "initialize"
          ? "Initialize an unknown opening balance"
          : "Append a correction to a target balance",
      )
      .addStringOption(string("balance", "Nonnegative exact decimal balance", true))
      .addStringOption(string("note", "Required explanation", true));
    // The entry number (5 or #5) or its ID, as /ledger history shows both (owner decision).
    if (name === "adjust")
      sub.addStringOption(
        string("entry", "Entry this corrects: its number (e.g. 5) or ID from /ledger history"),
      );
    return sub;
  });
for (const name of ["balance", "history"])
  data.addSubcommand((sub) => {
    sub
      .setName(name)
      .setDescription(`Inspect ledger ${name}`)
      .addStringOption(string("fc_id", "Officers may select a historical FC account"));
    if (name === "history")
      // Entry numbers read '#34' on history pages; the pager buttons carry the same cursor.
      sub.addStringOption(string("before", "Entry number from a previous page (e.g. 34)"));
    return sub;
  });

export default defineCommand({
  data,
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    const app = services.get(applicationKey);
    const options = interaction.options;
    const sub = options.getSubcommand(true);
    // Free text, so an FC ID or Lodestone link is accepted and a typo is an input failure that
    // names the fc_id option.
    const fcId = options.getString("fc_id")
      ? lodestoneId(options.getString("fc_id", true), "freecompany")
      : null;
    if (sub === "balance")
      return balanceReply(await app.ledgerRead(actor, fcId, null, false), viewer);
    if (sub === "history")
      return historyReply(
        await app.ledgerRead(actor, fcId, cursor(options.getString("before")), true),
        viewer,
      );
    const amount =
      sub === "deposit" || sub === "withdraw"
        ? options.getInteger("amount", true)
        : options.getString("balance", true);
    const correction = options.getString("entry");
    // Discord's interaction ID is the stable financial idempotency key for retries, and the Ref
    // an officer's receipt shows.
    return receiptReply(
      await app.ledger(
        actor,
        sub,
        amount,
        options.getString("note", true),
        interaction.id,
        correction ? entryRef(correction) : null,
      ),
      viewer,
    );
  },
});
