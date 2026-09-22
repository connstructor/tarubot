/** Mixed-permission guest operations; each private operation reauthorizes its actor. */
import { z } from "zod";
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";
import { userId } from "../../discord/selectors.js";
import { authorize } from "../../domain/policy.js";

const data = command("guest", "Guest applications, grants, and revocations");
for (const name of ["approve", "deny"])
  data.addSubcommand((sub) => {
    sub
      .setName(name)
      .setDescription(`${name} a guest application`)
      .addStringOption(string("application", "Application ID", true, true));
    if (name === "deny") sub.addStringOption(string("reason", "Decision reason"));
    return sub;
  });
for (const name of ["grant", "revoke"])
  data.addSubcommand((sub) =>
    sub
      .setName(name)
      .setDescription(`${name} durable guest access`)
      .addStringOption(string("member", "Discord user ID or mention", true))
      .addStringOption(string("reason", "Audited reason", true)),
  );
data.addSubcommand((sub) =>
  sub
    .setName("status")
    .setDescription("Inspect durable guest access and delivery status")
    .addStringOption(string("member", "Discord user ID; officers may inspect another user")),
);

export default defineCommand({
  data,
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    const app = services.get(applicationKey);
    const options = interaction.options;
    const sub = options.getSubcommand(true);
    if (sub === "approve" || sub === "deny")
      return dataReply(
        await app.decide(
          actor,
          z.uuid().parse(options.getString("application", true)),
          sub === "approve",
          options.getString("reason"),
        ),
      );
    const owner = userId(options.getString("member") ?? actor.userId);
    if (sub === "grant" || sub === "revoke")
      return dataReply(
        await app.guestAction(
          actor,
          owner,
          sub === "revoke",
          options.getString("reason", true),
          interaction.id,
        ),
      );
    authorize(actor, actor.guildId, "user", owner);
    return dataReply(await app.guestStatus(actor, owner));
  },
  autocomplete({ actor, interaction, services }) {
    // Mixed permission groups cannot rely on root command defaults to protect completion.
    authorize(actor, actor.guildId, "officer");
    return services
      .get(applicationKey)
      .autocomplete(actor, "application", actor.userId, String(interaction.options.getFocused()));
  },
});
