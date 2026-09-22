/** Persistent guest buttons bind namespace, action, application, guild, and message identity. */
import { z } from "zod";
import { applicationKey } from "../application/keys.js";
import { defineComponent } from "../bot/component.js";
import { dataReply } from "../discord/replies.js";
import { Failure } from "../domain/values.js";

export default defineComponent({
  prefix: "guest",
  access: "officer",
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    if (!interaction.isButton())
      throw new Failure("input", "This guest control requires a review button.");
    const match = /^guest:(approve|deny):([0-9a-f-]{36})$/.exec(interaction.customId);
    if (!match?.[1] || !match[2]) throw new Failure("input", "Unknown or obsolete control.");
    return dataReply(
      await services
        .get(applicationKey)
        .decide(
          actor,
          z.uuid().parse(match[2]),
          match[1] === "approve",
          null,
          interaction.message.id,
        ),
    );
  },
});
