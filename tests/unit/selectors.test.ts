/**
 * Live Lodestone selectors (2.19.0): the sidecar validates a new upstream selector revision and
 * activates it for new parser workers, or keeps the active set when it can't.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SelectorStore, validateSelectorFile } from "../../sidecar/selectors.js";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);

/** A small bundled baseline: two files, in the repository's real shape. */
const baseline = {
  repository: "xivapi/lodestone-css-selectors",
  revision: OLD,
  files: {
    "freecompany/freecompany.json": {
      NAME: { selector: ".freecompany__text__name", type: "string" },
      ACTIVE_MEMBER_COUNT: { selector: ".freecompany__text", regex: "(?P<Count>\\d+)" },
    },
    "profile/character.json": {
      NAME: { selector: ".frame__chara__name", type: "string" },
      CLASSJOB_ICONS: {
        ROOT: { selector: "li", multiple: true },
        ICON: { selector: "img", attribute: "src" },
      },
    },
  },
};

let directories: string[] = [];
afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories = [];
});

/** A store over a fresh directory, with a fake GitHub serving `served` at `NEW`. */
async function store(served: Record<string, unknown>, status = 200) {
  const root = await mkdtemp(`${tmpdir()}/selectors-test-`);
  directories.push(root);
  const baselineFile = `${root}/baseline.json`;
  await writeFile(baselineFile, JSON.stringify(baseline));
  const requests: string[] = [];
  const fetcher = async (url: string) => {
    requests.push(url);
    const path = url.split(`/${NEW}/`)[1] ?? "";
    return path in served
      ? new Response(JSON.stringify(served[path]), { status })
      : new Response("Not found", { status: 404 });
  };
  const directory = `${root}/live`;
  return {
    store: new SelectorStore(directory, new URL(`file://${baselineFile}`), fetcher),
    directory,
    requests,
  };
}

test("real selector shapes validate, including new keys and Python-style named groups", () => {
  const next = {
    ...baseline.files["profile/character.json"],
    BEASTMASTER: { selector: ".bst", regex: "LEVEL (?P<Level>\\d*)", type: { Level: "integer" } },
  };
  expect(
    validateSelectorFile("profile/character.json", next, baseline.files["profile/character.json"]),
  ).toBe(next);
});

test("a file that isn't a usable selector set is rejected with the reason", () => {
  const bundled = baseline.files["freecompany/freecompany.json"];
  expect(() => validateSelectorFile("f.json", [], bundled)).toThrow("is not an object");
  expect(() =>
    validateSelectorFile("f.json", { ...bundled, NAME: { selector: "" } }, bundled),
  ).toThrow("NAME is not a valid selector");
  expect(() =>
    validateSelectorFile("f.json", { ...bundled, NAME: { selector: ".x", regex: 7 } }, bundled),
  ).toThrow("NAME is not a valid selector");
  // A regex Nodestone can't translate only breaks its own column, as upstream's achievements
  // ENTRY.NAME already does, so it isn't a reason to reject the set.
  const upstreamRegex = {
    selector: ".entry",
    regex: '(?P<NameDE>.*) aus der Kategorie „|.*[\\"「](?P<Name>.*)[\\"」]',
  };
  expect(
    validateSelectorFile("f.json", { ...bundled, NAME: upstreamRegex }, bundled),
  ).toMatchObject({
    NAME: upstreamRegex,
  });
  expect(() => validateSelectorFile("f.json", { NAME: bundled.NAME }, bundled)).toThrow(
    "lost ACTIVE_MEMBER_COUNT",
  );
  expect(() => validateSelectorFile("f.json", { ...bundled, EXTRA: "text" }, bundled)).toThrow(
    "EXTRA is not a selector or a group",
  );
});

test("a valid new revision is downloaded at its commit, written, and activated atomically", async () => {
  const { store: live, directory, requests } = await store(baseline.files);
  expect(live.status()).toMatchObject({ revision: OLD, source: "bundled", bundled: OLD });
  expect(await live.activate(NEW)).toBe(NEW);
  // Every file the parsers load, pinned to the commit.
  expect(requests.sort()).toEqual([
    `https://raw.githubusercontent.com/xivapi/lodestone-css-selectors/${NEW}/freecompany/freecompany.json`,
    `https://raw.githubusercontent.com/xivapi/lodestone-css-selectors/${NEW}/profile/character.json`,
  ]);
  expect(live.status()).toMatchObject({ revision: NEW, source: "upstream", bundled: OLD });
  const pointer = JSON.parse(await readFile(`${directory}/active.json`, "utf8"));
  expect(pointer).toMatchObject({ file: `selectors-${NEW}.json`, revision: NEW });
  expect(
    Object.keys(JSON.parse(await readFile(`${directory}/${pointer.file}`, "utf8")).files),
  ).toEqual(["freecompany/freecompany.json", "profile/character.json"]);
  // The same revision again downloads nothing.
  requests.length = 0;
  expect(await live.activate(NEW)).toBe(NEW);
  expect(requests).toEqual([]);
  // A restarted sidecar adopts the set this container already activated.
  const restarted = new SelectorStore(directory, new URL(`file://${directory}/../baseline.json`));
  await restarted.restore();
  expect(restarted.status()).toMatchObject({ revision: NEW, source: "upstream" });
});

test("a download or validation failure leaves the active set untouched", async () => {
  const missing = await store({
    "freecompany/freecompany.json": baseline.files["freecompany/freecompany.json"],
  });
  await expect(missing.store.activate(NEW)).rejects.toThrow("profile/character.json failed (404)");
  expect(missing.store.status()).toMatchObject({ revision: OLD, source: "bundled" });
  expect(await readdir(missing.directory).catch(() => [])).toEqual([]);
  const broken = await store({
    ...baseline.files,
    "profile/character.json": { NAME: { selector: ".x" } },
  });
  await expect(broken.store.activate(NEW)).rejects.toThrow("lost CLASSJOB_ICONS");
  expect(broken.store.status().revision).toBe(OLD);
  await expect(broken.store.activate("not-a-sha")).rejects.toThrow("Invalid selector revision");
});
