/** Persistent guest buttons bind namespace, action, application, guild, and message identity. */
import { z } from "zod";
import { applicationKey } from "../application/keys.js";
import { defineComponent } from "../bot/component.js";
import { dataReply } from "../discord/replies.js";
import { Failure } from "../domain/values.js";

/** A malformed or foreign guest control can only come from an older release or a forged ID. */
const obsolete = (): Failure =>
  new Failure(
    "stale",
    "This button or command is from an older version of TaruBot. Use the current command. If it keeps happening, ask a server manager to redeploy the commands.",
    0,
    { kind: "stale", what: "control" },
  );

export default defineComponent({
  prefix: "guest",
  access: "officer",
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    if (!interaction.isButton()) throw obsolete();
    const match = /^guest:(approve|deny):([0-9a-f-]{36})$/.exec(interaction.customId);
    const application = z.uuid().safeParse(match?.[2]);
    if (!match?.[1] || !application.success) throw obsolete();
    return dataReply(
      await services
        .get(applicationKey)
        .decide(actor, application.data, match[1] === "approve", null, interaction.message.id),
    );
  },
});
