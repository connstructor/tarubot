/**
 * Member notes for update posts (owner decision 1 of 2026-09-25, issue #30): one sentence per
 * release that changes something members notice, in plain words about what they'll see. "It should
 * be what's meaningful for users, not the technical side. If people want the commit list, /version
 * will lead them there."
 *
 * Notes are opt-in: a release without an entry is never shown, and an update whose releases have no
 * entry posts nothing. Keys are the release's package.json version, and each must have its
 * CHANGELOG.md heading (tests/unit/changelog.test.ts checks that, the length, and that no note
 * carries a mention or a link). A release PR that adds a note changes only this map. Data only.
 */
export const RELEASE_NOTES: Readonly<Record<string, string>> = {
  "2.25.0":
    "Officers can now pick a channel where TaruBot shares what's new for members when an update changes something for them.",
};
