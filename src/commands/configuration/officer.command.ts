/** Explicit officer overrides are restricted to actual server managers with Manage Roles. */
import { PermissionFlagsBits } from "discord.js";
import { roleAdministrationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";
import { userId } from "../../discord/selectors.js";

const data = command(
  "officer",
  "Manage explicit bot-officer grants and revocations",
).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles);
for (const name of ["grant", "revoke"])
  data.addSubcommand((sub) =>
    sub
      .setName(name)
      .setDescription(`${name} bot-only officer authority`)
      .addStringOption(string("member", "Discord user ID or mention", true))
      .addStringOption(string("reason", "Audited reason", true)),
  );
export default defineCommand({
  data,
  access: "officer",
  requires: [roleAdministrationKey],
  async execute({ actor, interaction, services }) {
    return dataReply(
      await services
        .get(roleAdministrationKey)
        .officer(
          actor,
          userId(interaction.options.getString("member", true)),
          interaction.options.getSubcommand(true) === "grant",
          interaction.options.getString("reason", true),
        ),
    );
  },
});
