/** User form submissions authenticate independently from the officer-only review controls. */
import { applicationKey } from "../application/keys.js";
import { defineComponent } from "../bot/component.js";
import { guestApplicationSubmission } from "../discord/guest-application.js";
import { Failure } from "../domain/values.js";

export default defineComponent({
  prefix: "guest-apply",
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    if (!interaction.isModalSubmit())
      throw new Failure("input", "Open /apply to submit a guest application form.");
    const application = await services
      .get(applicationKey)
      .apply(actor, guestApplicationSubmission(interaction, actor));
    // Do not echo answers in command replies, including the public-response development guild.
    return {
      content: `Your guest application is awaiting officer review. Submitting again keeps the original application and answers.\nApplication: ${application.id}\nUse /guest status to check the outcome.`,
    };
  },
});
