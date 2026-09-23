/** User form submissions authenticate independently from the officer-only review controls. */
import { applicationKey } from "../application/keys.js";
import { defineComponent } from "../bot/component.js";
import { guestApplicationSubmission } from "../discord/guest-application.js";
import { applicationReceivedReply } from "../discord/presenters/guests.js";
import { Failure } from "../domain/values.js";

export default defineComponent({
  prefix: "guest-apply",
  requires: [applicationKey],
  async execute({ actor, viewer, interaction, services }) {
    // Only the /apply form submits under this prefix; anything else is an obsolete control.
    if (!interaction.isModalSubmit())
      throw new Failure(
        "stale",
        "This button or command is from an older version of TaruBot. Use the current command. If it keeps happening, ask a server manager to redeploy the commands.",
        0,
        { kind: "stale", what: "control" },
      );
    const application = await services
      .get(applicationKey)
      .apply(actor, guestApplicationSubmission(interaction, actor));
    // The receipt never echoes answers, including in the public-response development guild.
    return applicationReceivedReply(application, viewer);
  },
});
