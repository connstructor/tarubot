/** Submit or retrieve a caller's durable application for their current join context. */
import { PermissionFlagsBits } from "discord.js";
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { guestApplicationModal } from "../../discord/guest-application.js";
import { applicationsClosedReply } from "../../discord/presenters/guests.js";

export default defineCommand({
  data: command("apply", "Apply for officer-reviewed Guest access without a verified character"),
  requires: [applicationKey],
  // Imported servers start with applications closed (owner decision 2026-09-23). One indexed read
  // refuses before the form opens, so a visitor never writes answers that cannot be submitted.
  // The submission path (Service.apply) still refuses on its own.
  async beforeModal({ guildId, interaction, services }) {
    if (await services.get(applicationKey).guestApplicationsOpen(guildId)) return null;
    // Manage Server comes with the interaction payload, so the officer hint costs no request.
    return applicationsClosedReply({
      officerHint: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    });
  },
  modal: guestApplicationModal,
});
