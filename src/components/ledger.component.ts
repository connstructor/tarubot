/**
 * The ledger history buttons: /ledger balance's 'View history' and the history pager (Latest,
 * Newer and Older). Each click re-reads the page as whoever pressed it, so a member who clicks an
 * officer's public test-guild page gets the member layout, and one whose access ended is refused
 * like a fresh command. The custom ID carries only the FC, its scope and the page cursor.
 *
 * Scope c ('the FC linked when this was shown') reads with expect 'current': if another FC has
 * been linked since, the service refuses the control as out of date before authorizing, and the
 * refusal arrives as a private follow-up that leaves the page alone. Scope h is a historical FC an
 * officer chose with fc_id.
 */
import { applicationKey } from "../application/keys.js";
import { defineComponent } from "../bot/component.js";
import { parseControlFor } from "../discord/custom-ids.js";
import { historyReply } from "../discord/presenters/ledger.js";
import { Failure } from "../domain/values.js";

/** A ledger control on anything but a button can only come from an older release or a forgery. */
const obsolete = (): Failure =>
  new Failure(
    "stale",
    "This button is out of date. Run the command again to get a current one.",
    0,
    { kind: "stale", what: "control" },
  );

export default defineComponent({
  prefix: "ledger",
  requires: [applicationKey],
  // View history opens page 1 as a new reply, so the balance and its post states stay visible;
  // the pager re-renders its own page. The router still replies instead unless that page is
  // private or belongs to the presser. A parse error here falls back to a reply, and execute's
  // strict parse reports the stale control.
  acknowledge: (customId) =>
    parseControlFor("ledger", customId).action === "open" ? "reply" : "update",
  async execute({ actor, viewer, interaction, services }) {
    if (!interaction.isButton()) throw obsolete();
    const control = parseControlFor("ledger", interaction.customId);
    // View history and Latest open the newest page; Newer and Older carry their page's cursor
    // (none when Newer leads to the newest page).
    const before = "before" in control && control.before !== null ? String(control.before) : null;
    return historyReply(
      await services
        .get(applicationKey)
        .ledgerRead(actor, control.fcId, before, true, control.scope === "c" ? "current" : "any"),
      viewer,
    );
  },
});
