/**
 * Profile-refresh pacing and the two-404 rule (2.17.0). A failing profile is retried at most once per
 * PROFILE_RETRY_SECONDS, whatever its job's outcome; a character the Lodestone answers 404 for is
 * unlinked only when a second 404 comes at least MISSING_CONFIRM_SECONDS after the first (owner
 * decision, 2026-09-24: "require two 404s before unlinking, just in case").
 */

/** Scheduled refreshes of one character's profile are at least this far apart. */
export const PROFILE_RETRY_SECONDS = 3600;

/** The second 404 must come at least this long after the first before links are ended. */
export const MISSING_CONFIRM_SECONDS = 3600;
