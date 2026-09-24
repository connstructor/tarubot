/**
 * 'Check sync status' (sync:status[:<run>]): the same read as /sync status for whoever clicks,
 * always as a new reply so the message it sits on (the /setup summary) stays visible. The custom
 * ID carries only the optional run; the service scopes runs and work to the presser, so a member
 * who clicks an officer's public test-guild button sees only their own requests.
 */
import { applicationKey } from "../application/keys.js";
import { defineComponent } from "../bot/component.js";
import { parseControlFor } from "../discord/custom-ids.js";
import { syncStatusReply } from "../discord/presenters/synchronization.js";
import { Failure } from "../domain/values.js";

/** A sync control on anything but a button can only come from an older release or a forgery. */
const obsolete = (): Failure =>
  new Failure(
    "stale",
    "This button is out of date. Run the command again to get a current one.",
    0,
    { kind: "stale", what: "control" },
  );

export default defineComponent({
  prefix: "sync",
  requires: [applicationKey],
  acknowledge: "reply",
  async execute({ actor, viewer, interaction, services }) {
    if (!interaction.isButton()) throw obsolete();
    const control = parseControlFor("sync", interaction.customId);
    return syncStatusReply(
      await services.get(applicationKey).syncStatus(actor, control.run),
      viewer,
      { run: control.run },
    );
  },
});
