/** Submit or retrieve a caller's durable application for their current join context. */
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { guestApplicationModal } from "../../discord/guest-application.js";

export default defineCommand({
  data: command("apply", "Apply for officer-reviewed Guest access without a verified character"),
  modal: guestApplicationModal,
});
