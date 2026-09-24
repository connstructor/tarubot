/**
 * /claim's 'I've added it — verify now' and the pending-token card's 'Check again'. Both run the
 * same verification as /verify for whoever clicks: the custom ID carries only the character, and
 * Service.verify binds the claim to the clicking actor, so a click on someone else's public
 * test-guild card can only check the clicker's own claim.
 */
import { applicationKey } from "../application/keys.js";
import { defineComponent, rendersSourceInPlace } from "../bot/component.js";
import { parseControlFor } from "../discord/custom-ids.js";
import { verifyReply } from "../discord/presenters/characters.js";
import { Failure } from "../domain/values.js";

/** 'Check again' waits this long after its card was last rendered, so clicks can't flood. */
export const CHECK_AGAIN_INTERVAL_MS = 15_000;

/** A verify control on anything but a button can only come from an older release or a forgery. */
const obsolete = (): Failure =>
  new Failure(
    "stale",
    "This button is out of date. Run the command again to get a current one.",
    0,
    { kind: "stale", what: "control" },
  );

export default defineComponent({
  prefix: "verify",
  requires: [applicationKey],
  // verify:claim sits on the /claim message, whose content is the one-time token, so it always
  // opens a new reply and that message is never edited. Check again re-renders its own card; the
  // router still replies instead unless that card is private or belongs to the presser. A parse
  // error here falls back to a reply, and execute's strict parse reports the stale control.
  acknowledge: (customId) =>
    parseControlFor("verify", customId).action === "again" ? "update" : "reply",
  async execute({ actor, viewer, interaction, services }) {
    if (!interaction.isButton()) throw obsolete();
    const control = parseControlFor("verify", interaction.customId);
    // The card's own timestamps are the throttle's only state: edited on every re-render. Only a
    // card this click re-renders (private, or opened by the presser) records the presser's last
    // check; a click on someone else's public test-guild card is answered with a new reply, like
    // /verify and 'verify now', because throttling it would need stored per-user state.
    if (control.action === "again" && rendersSourceInPlace(interaction)) {
      const source = interaction.message;
      const elapsed = Date.now() - (source.editedTimestamp ?? source.createdTimestamp);
      if (elapsed < CHECK_AGAIN_INTERVAL_MS)
        throw new Failure(
          "cooldown",
          "You just checked. The Lodestone can take a few minutes to publish your token, so give it a moment before checking again.",
          Math.ceil((CHECK_AGAIN_INTERVAL_MS - Math.max(0, elapsed)) / 1_000),
        );
    }
    // The server owner is told Discord keeps their nickname, as /verify says it.
    return verifyReply(
      await services.get(applicationKey).verify(actor, control.characterId),
      viewer,
      { guildOwner: interaction.guild?.ownerId === actor.userId },
    );
  },
});
