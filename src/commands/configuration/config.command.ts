/**
 * Configuration command group: its schema and dispatch remain together as one feature. Every
 * subcommand answers with its configuration presenter; failures reach the router's failure
 * presenter unchanged.
 */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command, string } from "../../discord/options.js";
import {
  changeReply,
  fcUnlinkReply,
  healthReply,
  officerRankReply,
  roleLayoutReply,
  showReply,
} from "../../discord/presenters/configuration.js";
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
    group.addSubcommand((sub) => {
      sub
        .setName(name)
        .setDescription(`Set or clear the ${name} role`)
        .addRoleOption((option) => option.setName("role").setDescription("Access role"))
        .addBooleanOption((option) =>
          option.setName("clear").setDescription("Clear the configuration and clean up this role"),
        );
      // Binding an existing staff role normally grants its current holders officer access; a
      // rank-based launch binds it with adopt_holders:false instead (owner decision O1).
      if (name === "officer")
        sub.addBooleanOption((option) =>
          option
            .setName("adopt_holders")
            .setDescription(
              "Grant the role's current human holders officer access (default: true)",
            ),
        );
      return sub;
    });
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
// Managed-role display/ordering is a per-guild opt-in; server managers with Manage Roles change it.
data.addSubcommand((sub) =>
  sub
    .setName("role_layout")
    .setDescription("Turn automatic display and ordering of the managed roles on or off")
    .addBooleanOption((option) =>
      option
        .setName("enabled")
        .setDescription("Show managed roles separately in one ordered block")
        .setRequired(true),
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
  async execute({ actor, viewer, interaction, services }) {
    authorize(actor, actor.guildId, "officer");
    const app = services.get(applicationKey);
    const options = interaction.options;
    const sub = options.getSubcommand(true);
    const group = options.getSubcommandGroup(false);
    if (group === "fc") {
      const fc = lodestoneId(options.getString("fc_id", true), "freecompany");
      if (sub === "link") return changeReply(await app.configure(actor, "fc_id", fc), viewer);
      // The typed ID names the FC when the result can't (its record was never read).
      return fcUnlinkReply(await app.unlinkCompany(actor, fc), viewer, { fcId: fc });
    }
    // Both read the same report; show summarizes it, validate lists every check.
    if (sub === "show") return showReply(await app.validate(actor), viewer);
    if (sub === "validate") return healthReply(await app.validate(actor), viewer);
    if (sub === "officer_rank") {
      const rank = options.getString("rank");
      const clear = options.getBoolean("clear") === true;
      if ((rank !== null) === clear)
        throw new Failure("input", "Give a rank name or set clear:true, not both.", 0, {
          kind: "option",
          option: "rank",
        });
      return officerRankReply(await app.configureOfficerRank(actor, rank), viewer);
    }
    if (sub === "role_layout")
      return roleLayoutReply(
        await app.configureRoleLayout(actor, options.getBoolean("enabled", true)),
        viewer,
      );
    const value =
      group === "roles" ? options.getRole("role")?.id : options.getChannel("channel")?.id;
    const clear = options.getBoolean("clear") === true;
    // Exactly one of the resource and clear:true; the wording names the resource kind.
    if (!!value === clear)
      throw new Failure(
        "input",
        `Choose a ${group === "roles" ? "role" : "channel"} or set clear:true, not both.`,
        0,
        { kind: "option", option: group === "roles" ? "role" : "channel" },
      );
    const field =
      group === "roles"
        ? `${sub}_role_id`
        : sub === "guest_applications"
          ? "guest_application_channel_id"
          : `${sub}_channel_id`;
    // Only /config roles officer declares adopt_holders; omitted means the service default (true).
    const adoptHolders = group === "roles" ? options.getBoolean("adopt_holders") : null;
    // The service independently validates the field allowlist, ManageRoles, hierarchy, and that
    // adopt_holders accompanies an Officer role binding.
    return changeReply(
      await app.configure(
        actor,
        field,
        value ?? null,
        adoptHolders === null ? {} : { adoptHolders },
      ),
      viewer,
    );
  },
});
