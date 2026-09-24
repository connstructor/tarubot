/**
 * Explicit officer overrides are restricted to actual server managers with Manage Roles. The
 * receipt names the member, what happens to their Officer role, and the audited reason.
 */
import { PermissionFlagsBits } from "discord.js";
import { roleAdministrationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { completeMember } from "../../discord/autocomplete.js";
import { command, string } from "../../discord/options.js";
import { officerOverrideReply } from "../../discord/presenters/configuration.js";
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
      .addStringOption(string("member", "Member: pick a suggestion or paste a user ID", true, true))
      .addStringOption(string("reason", "Audited reason", true)),
  );
export default defineCommand({
  data,
  access: "officer",
  requires: [roleAdministrationKey],
  async execute({ actor, viewer, interaction, services }) {
    return officerOverrideReply(
      await services
        .get(roleAdministrationKey)
        .officer(
          actor,
          userId(interaction.options.getString("member", true)),
          interaction.options.getSubcommand(true) === "grant",
          interaction.options.getString("reason", true),
        ),
      viewer,
    );
  },
  // The router authorizes officer access first; the service still requires a server manager.
  autocomplete: (context) => completeMember(context),
});
