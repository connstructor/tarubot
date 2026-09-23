/** Idempotent guild bootstrap, with a default DevBot prefix in development scope. */
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { applicationKey, roleAdministrationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";
import { lodestoneId } from "../../domain/values.js";

export default defineCommand({
  data: command("setup", "Set up access roles, a newcomer lobby, and officer-only channels")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild |
        PermissionFlagsBits.ManageRoles |
        PermissionFlagsBits.ManageChannels,
    )
    .addStringOption(string("fc_id", "Optional FC ID or canonical Lodestone URL"))
    .addStringOption((option) =>
      option
        .setName("prefix")
        .setDescription("Role-name prefix; defaults to DevBot in the test guild")
        .setMaxLength(50),
    )
    .addStringOption(string("officer_rank", "Optional in-game FC rank granting bot officer access"))
    .addChannelOption((option) =>
      option
        .setName("lobby")
        .setDescription("Existing lobby to reuse")
        .addChannelTypes(ChannelType.GuildText),
    )
    .addChannelOption((option) =>
      option
        .setName("officers")
        .setDescription("Existing officer-only room to reuse")
        .addChannelTypes(ChannelType.GuildText),
    ),
  access: "officer",
  requires: [applicationKey, roleAdministrationKey],
  async execute({ actor, interaction, services }) {
    const app = services.get(applicationKey);
    const options = interaction.options;
    const fc = options.getString("fc_id");
    return dataReply(
      await services
        .get(roleAdministrationKey)
        .setup(
          actor,
          options.getString("prefix") ?? (app.config.TEST_GUILD_ID ? "DevBot" : ""),
          fc ? lodestoneId(fc, "freecompany") : null,
          options.getString("officer_rank"),
          {
            lobby: options.getChannel("lobby")?.id ?? null,
            officers: options.getChannel("officers")?.id ?? null,
          },
        ),
    );
  },
});
