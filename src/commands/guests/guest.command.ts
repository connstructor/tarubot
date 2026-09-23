/** Mixed-permission guest operations; each private operation reauthorizes its actor. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";
import { userId, uuid } from "../../discord/selectors.js";
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
          uuid(options.getString("application", true), "application"),
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
  async autocomplete({ actor, interaction, services }) {
    // Mixed permission groups cannot rely on root command defaults to protect completion.
    authorize(actor, actor.guildId, "officer");
    const rows = await services.get(applicationKey).applicationChoices(actor);
    // Filter in-process on what the label shows: the applicant's cached display name (no network
    // call inside Discord's autocomplete window), their user ID, and the application ID.
    const query = String(interaction.options.getFocused()).trim().toLocaleLowerCase("en-US");
    const members = interaction.guild?.members.cache;
    return rows
      .map((row) => ({ row, name: members?.get(row.user_id)?.displayName ?? row.user_id }))
      .filter(
        ({ row, name }) =>
          !query ||
          name.toLocaleLowerCase("en-US").includes(query) ||
          row.user_id.includes(query) ||
          row.id.includes(query),
      )
      .map(({ row, name }) => ({
        // '<display name or ID> · submitted YYYY-MM-DD · <short ID>'; the value is the full UUID.
        // Code-point slicing never leaves half a surrogate pair in the 100-character label.
        name: `${[...name].slice(0, 60).join("")} · submitted ${row.created_at.toISOString().slice(0, 10)} · ${row.id.slice(0, 8)}`,
        value: row.id,
      }));
  },
});
