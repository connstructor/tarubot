/** Configuration command group: its schema and dispatch remain together as one feature. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import { dataReply } from "../../discord/replies.js";
import { authorize } from "../../domain/policy.js";
import { Failure, lodestoneId } from "../../domain/values.js";

const data = command("config", "Configure this guild's FC, roles, and notification channels");

// FC unlink carries the expected ID so stale confirmations cannot unlink a replacement FC.
data.addSubcommandGroup((group) =>
  group
    .setName("fc")
    .setDescription("FC association")
    .addSubcommand((sub) =>
      sub
        .setName("link")
        .setDescription("Link an FC and queue synchronization")
        .addStringOption(string("fc_id", "FC ID or canonical Lodestone URL", true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unlink")
        .setDescription("Unlink the matching FC locally")
        .addStringOption(string("fc_id", "Currently linked FC ID", true)),
    ),
);
data.addSubcommandGroup((group) => {
  group.setName("roles").setDescription("Bot-managed access roles");
  for (const name of ["member", "guest", "officer", "leader"])
    group.addSubcommand((sub) =>
      sub
        .setName(name)
        .setDescription(`Set or clear the ${name} role`)
        .addRoleOption((option) => option.setName("role").setDescription("Access role"))
        .addBooleanOption((option) =>
          option.setName("clear").setDescription("Clear the configuration and clean up this role"),
        ),
    );
  return group;
});
// Role-based officers cannot be represented by Discord's static default permission bitfield.
// Runtime authorization remains mandatory; authority-changing settings require server managers.
data.addSubcommand((sub) =>
  sub
    .setName("officer_rank")
    .setDescription("Set or clear the in-game rank granting bot officer access")
    .addStringOption(string("rank", "Exact in-game FC rank name"))
    .addBooleanOption((option) =>
      option.setName("clear").setDescription("Use manual officer grants only"),
    ),
);
for (const name of ["ledger", "officer_notifications", "guest_applications"])
  data.addSubcommand((sub) =>
    sub
      .setName(name)
      .setDescription(`Set or clear the ${name.replaceAll("_", " ")} channel`)
      .addChannelOption((option) => option.setName("channel").setDescription("Guild text channel"))
      .addBooleanOption((option) =>
        option.setName("clear").setDescription("Clear this channel configuration"),
      ),
  );
for (const name of ["show", "validate"])
  data.addSubcommand((sub) =>
    sub
      .setName(name)
      .setDescription(
        name === "show"
          ? "Show configuration and capabilities"
          : "Validate resources without applying effects",
      ),
  );

export default defineCommand({
  data,
  access: "officer",
  requires: [applicationKey],
  async execute({ actor, interaction, services }) {
    authorize(actor, actor.guildId, "officer");
    const app = services.get(applicationKey);
    const options = interaction.options;
    const sub = options.getSubcommand(true);
    const group = options.getSubcommandGroup(false);
    if (group === "fc") {
      const fc = lodestoneId(options.getString("fc_id", true), "freecompany");
      return dataReply(
        await (sub === "link" ? app.configure(actor, "fc_id", fc) : app.unlinkCompany(actor, fc)),
      );
    }
    if (sub === "show" || sub === "validate") return dataReply(await app.validate(actor));
    if (sub === "officer_rank") {
      const rank = options.getString("rank");
      const clear = options.getBoolean("clear") === true;
      if ((rank !== null) === clear)
        throw new Failure("input", "Supply exactly one rank or clear:true.");
      return dataReply(await app.configureOfficerRank(actor, rank));
    }
    const value =
      group === "roles" ? options.getRole("role")?.id : options.getChannel("channel")?.id;
    const clear = options.getBoolean("clear") === true;
    if (!!value === clear) throw new Failure("input", "Supply exactly one value or clear:true.");
    const field =
      group === "roles"
        ? `${sub}_role_id`
        : sub === "guest_applications"
          ? "guest_application_channel_id"
          : `${sub}_channel_id`;
    // The service independently validates the field allowlist, ManageRoles, and hierarchy.
    return dataReply(await app.configure(actor, field, value ?? null));
  },
});
