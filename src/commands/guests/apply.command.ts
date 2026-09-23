/** Submit or retrieve a caller's durable application for their current join context. */
import { applicationKey } from "../../application/keys.js";
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { guestApplicationModal } from "../../discord/guest-application.js";
import { GUEST_APPLICATIONS_CLOSED } from "../../domain/guest-application.js";

export default defineCommand({
  data: command("apply", "Apply for officer-reviewed Guest access without a verified character"),
  requires: [applicationKey],
  // Imported servers start with applications closed (owner decision 2026-09-23). One indexed read
  // refuses before the form opens, so a visitor never writes answers that cannot be submitted.
  // The submission path (Service.apply) still refuses on its own.
  async beforeModal({ guildId, services }) {
    return (await services.get(applicationKey).guestApplicationsOpen(guildId))
      ? null
      : GUEST_APPLICATIONS_CLOSED;
  },
  modal: guestApplicationModal,
});
