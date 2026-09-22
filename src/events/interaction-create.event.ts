/** Forward all supported interaction kinds to the dynamically populated router. */
import { Events } from "discord.js";
import { defineEvent } from "../bot/event.js";
import { interactionRouterKey } from "../bot/router.js";

export default defineEvent({
  id: "interaction-dispatch",
  event: Events.InteractionCreate,
  requires: [interactionRouterKey],
  execute(context, interaction) {
    return context.services.get(interactionRouterKey).handle(interaction);
  },
});
