/**
 * Guest presenters. 2.14.0 starts with the closed-applications card (approved guests#21), which
 * /apply shows before its form opens and the failure presenter reuses when a submission is
 * refused for the same reason; the remaining guest replies join this module as they migrate.
 */
import { GUEST_APPLICATIONS_CLOSED } from "../../domain/guest-application.js";
import { cmd } from "./format.js";
import { reply, type EmbedSpec, type FieldSpec, type Presented } from "./reply.js";

/** The approved hint for players, who get Guest through /claim rather than an application. */
const ALREADY_PLAY: FieldSpec = {
  name: "Already play FFXIV?",
  value: "Register your character with /claim. Registered players get Guest access automatically.",
};

/**
 * What an officer runs to open applications: a review channel and a Guest role, both required
 * (the shared guestApplicationsOpen rule). Shown only to people who could run it.
 */
const OPEN_APPLICATIONS: FieldSpec = {
  name: "Open applications",
  value: [
    `${cmd("config guest_applications", { channel: "#guest-reviews" })} sets the review channel.`,
    `${cmd("config roles guest", { role: "@Guest" })} sets the Guest role.`,
    "Applications open once both are set.",
  ].join("\n"),
};

/**
 * The closed-applications card as data, so the failure presenter can add its Code · Ref footer and
 * an officer next step to the same card: info tone, the shared refusal text and the player hint.
 * It carries no timestamp, as approved.
 */
export function applicationsClosedSpec(extra: readonly FieldSpec[] = []): EmbedSpec {
  return {
    tone: "info",
    title: "Guest applications are closed",
    description: GUEST_APPLICATIONS_CLOSED,
    fields: [ALREADY_PLAY, ...extra],
  };
}

/**
 * /apply's pre-form refusal (approved guests#21). It is an expected state, not a failure, so it
 * has no footer and is never reported. `officerHint` is read from the interaction's own
 * permissions (Manage Server), because the pre-form check cannot afford a network lookup; it only
 * adds the commands that open applications, never any access.
 */
export function applicationsClosedReply(options: { readonly officerHint: boolean }): Presented {
  return reply(applicationsClosedSpec(options.officerHint ? [OPEN_APPLICATIONS] : []));
}
