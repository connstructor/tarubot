/**
 * Display labels for stored enumerations: link and grant provenance, and application states. The
 * stored values stay the source of truth; an unknown value (from a newer release) shows raw.
 */
import type { ApplicationState } from "../../application/results.js";
import { isOfficer, type Viewer } from "./audience.js";

/**
 * How a character link was established, in the words each audience's approved card uses:
 * members read a sentence (characters#18), officers a short label (characters#20).
 */
export const LINK_PROVENANCE = {
  member: {
    profile_token: "Verified with a Lodestone token",
    officer_assignment: "Assigned by an officer",
    imported_link: "Imported from the previous bot",
  },
  officer: {
    profile_token: "Lodestone token",
    officer_assignment: "Officer assignment",
    imported_link: "Imported link",
  },
} as const satisfies Record<"member" | "officer", Record<string, string>>;

/** How a durable Guest grant came about (/guest status). */
export const GRANT_PROVENANCE = {
  approved: "Application approved",
  manual: "Granted by an officer",
  imported_guest: "Imported from the previous bot",
  grandfathered: "Granted at launch",
} as const satisfies Record<string, string>;

/** A guest application's state as a word; 'superseded' means a later join replaced it. */
export const APPLICATION_STATE = {
  pending: "Pending",
  approved: "Approved",
  denied: "Denied",
  cancelled: "Cancelled",
  superseded: "No longer needed",
} as const satisfies Record<ApplicationState, string>;

/** Look up a stored value's label, falling back to the value itself. */
function labelOf(table: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(table, value) ? (table[value] ?? value) : value;
}

/** A link's provenance for this viewer. */
export const linkProvenance = (value: string, viewer: Viewer): string =>
  labelOf(isOfficer(viewer) ? LINK_PROVENANCE.officer : LINK_PROVENANCE.member, value);

/** A Guest grant's provenance. */
export const grantProvenance = (value: string): string => labelOf(GRANT_PROVENANCE, value);

/** An application state's label. */
export const applicationState = (value: string): string => labelOf(APPLICATION_STATE, value);
