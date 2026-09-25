/**
 * Update posts (2.25.0, issue #30): which releases a guild still has to hear about, what one
 * changelog.post job does with its guild's current row, and the member-note map itself, checked
 * against the repository: every key is a release CHANGELOG.md records, fits the column's CHECK and
 * is no newer than package.json; every note is one short line with no mention or link, and renders
 * without being cut.
 */
import { describe, expect, test } from "bun:test";
import { project } from "../../src/config/project.js";
import { plain } from "../../src/discord/presenters/format.js";
import { HOUSE_LIMITS } from "../../src/discord/presenters/style.js";
import {
  changelogDue,
  changelogStep,
  newerVersion,
  notesSince,
} from "../../src/domain/changelog.js";
import { RELEASE_NOTES } from "../../src/domain/release-notes.js";

/** Read a repository file as text. */
const read = (path: string) => Bun.file(new URL(`../../${path}`, import.meta.url)).text();

/** A note map spanning a rollback, a prerelease and releases without notes (2.3.0 and 2.5.0). */
const NOTES = {
  "2.1.0": "First.",
  "2.2.0": "Second.",
  "2.4.0-rc.1": "A release candidate.",
  "2.4.0": "Fourth.",
  "2.6.0": "Sixth.",
};

describe("the release range", () => {
  test("notesSince excludes the last announced version and includes the running one, newest first", () => {
    expect(notesSince("2.1.0", "2.4.0", NOTES)).toEqual([
      { version: "2.4.0", note: "Fourth." },
      { version: "2.4.0-rc.1", note: "A release candidate." },
      { version: "2.2.0", note: "Second." },
    ]);
    // Several releases without notes in between are simply absent.
    expect(notesSince("2.2.0", "2.6.0", NOTES).map((row) => row.version)).toEqual([
      "2.6.0",
      "2.4.0",
      "2.4.0-rc.1",
    ]);
    // A prerelease comes before its release, so moving from the candidate lists only the release.
    expect(notesSince("2.4.0-rc.1", "2.4.0", NOTES)).toEqual([
      { version: "2.4.0", note: "Fourth." },
    ]);
    // Nothing newer, and a rollback (after at or above through), give none.
    expect(notesSince("2.4.0", "2.5.0", NOTES)).toEqual([]);
    expect(notesSince("2.6.0", "2.6.0", NOTES)).toEqual([]);
    expect(notesSince("2.6.0", "2.2.0", NOTES)).toEqual([]);
  });

  test("changelogDue needs a baseline older than the running version", () => {
    expect(changelogDue(null, "2.25.0")).toBe(false);
    expect(changelogDue("2.25.0", "2.25.0")).toBe(false);
    // A rollback: the stored version is newer, so the older process queues nothing.
    expect(changelogDue("2.26.0", "2.25.0")).toBe(false);
    expect(changelogDue("2.24.2", "2.25.0")).toBe(true);
    expect(changelogDue("2.25.0-rc.1", "2.25.0")).toBe(true);
  });

  test("newerVersion keeps a higher stored baseline and otherwise takes the running version", () => {
    expect(newerVersion(null, "2.25.0")).toBe("2.25.0");
    expect(newerVersion("2.24.2", "2.25.0")).toBe("2.25.0");
    expect(newerVersion("2.25.0", "2.25.0")).toBe("2.25.0");
    expect(newerVersion("99.0.0", "2.25.0")).toBe("99.0.0");
  });
});

describe("one changelog.post job", () => {
  test("no channel or no baseline skips as unconfigured, before anything else", () => {
    for (const [channel, stored] of [
      [null, "2.1.0"],
      ["1", null],
      [null, null],
    ] as const)
      expect(changelogStep(channel, stored, "2.6.0", NOTES)).toEqual({
        kind: "skip",
        reason: "changelog unconfigured",
      });
  });

  test("a baseline at or past the running version is already announced", () => {
    expect(changelogStep("1", "2.6.0", "2.6.0", NOTES)).toEqual({
      kind: "skip",
      reason: "already announced",
    });
    // A job a newer release left behind, run by an older process after a rollback.
    expect(changelogStep("1", "2.7.0", "2.6.0", NOTES)).toEqual({
      kind: "skip",
      reason: "already announced",
    });
  });

  test("a range without notes advances silently; a mixed range posts only the noted releases", () => {
    expect(changelogStep("1", "2.4.0", "2.5.0", NOTES)).toEqual({ kind: "advance", from: "2.4.0" });
    expect(changelogStep("1", "2.4.0", "2.5.0", {})).toEqual({ kind: "advance", from: "2.4.0" });
    expect(changelogStep("1", "2.2.0", "2.6.0", NOTES)).toEqual({
      kind: "post",
      from: "2.2.0",
      channel: "1",
      notes: [
        { version: "2.6.0", note: "Sixth." },
        { version: "2.4.0", note: "Fourth." },
        { version: "2.4.0-rc.1", note: "A release candidate." },
      ],
    });
  });

  test("the compiled notes are the default", () => {
    // The running release carries its own note, so a guild one release behind gets one field.
    const step = changelogStep("1", "2.24.2", "2.25.0");
    expect(step).toMatchObject({ kind: "post", notes: [{ version: "2.25.0" }] });
  });
});

describe("RELEASE_NOTES, checked against the repository", () => {
  test("every key is a CHANGELOG release that fits the column's CHECK and isn't ahead of package.json", async () => {
    const changelog = (await read("CHANGELOG.md")).split("\n");
    // The same pattern migration 009 enforces on guilds.changelog_version.
    const migration = await read("migrations/009_changelog_channel.sql");
    const pattern = /changelog_version ~ '([^']+)'/u.exec(migration)?.[1];
    if (!pattern) throw new Error("Migration 009 lost its version CHECK");
    const check = new RegExp(pattern, "u");
    // The running version is what setting a channel stores, so it must fit too.
    expect(check.test(project.version)).toBe(true);
    for (const bad of ["latest", "2.25", "2.25.0+build", "02.25.0"])
      expect(check.test(bad)).toBe(false);
    const keys = Object.keys(RELEASE_NOTES);
    expect(keys.length).toBeGreaterThan(0);
    for (const version of keys) {
      expect({ version, valid: check.test(version) }).toEqual({ version, valid: true });
      expect({ version, released: Bun.semver.order(version, project.version) <= 0 }).toEqual({
        version,
        released: true,
      });
      expect({
        version,
        heading: changelog.some((line) => line.startsWith(`## ${version} — `)),
      }).toEqual({ version, heading: true });
    }
  });

  test("every note is one short line with no mention, ping or link, shown whole", () => {
    for (const [version, note] of Object.entries(RELEASE_NOTES)) {
      expect({ version, length: note.length > 0 && note.length <= HOUSE_LIMITS.userText }).toEqual({
        version,
        length: true,
      });
      expect({ version, oneLine: !/[\r\n]/u.test(note) && note.trim() === note }).toEqual({
        version,
        oneLine: true,
      });
      for (const banned of ["<@", "<#", "<@&", "@everyone", "@here", "http"])
        expect({ version, banned, found: note.includes(banned) }).toEqual({
          version,
          banned,
          found: false,
        });
      // Escaped as the post escapes it, the note still fits, so nothing is ever cut.
      expect(plain(note, HOUSE_LIMITS.userText)).toBe(plain(note, Number.MAX_SAFE_INTEGER));
    }
  });
});
