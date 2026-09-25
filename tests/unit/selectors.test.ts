/**
 * Live Lodestone selectors (2.19.0): the sidecar validates a new upstream selector revision and
 * activates it for new parser workers, or keeps the active set when it can't.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SelectorStore, validateSelectorFile } from "../../sidecar/selectors.js";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const LATER = "3".repeat(40);
const LATEST = "4".repeat(40);

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

/**
 * A store over a fresh directory, with a fake GitHub serving `served` at any commit, or answering
 * every request with `answer`.
 */
async function store(
  served: Record<string, unknown>,
  status = 200,
  answer?: () => Promise<Response>,
) {
  const root = await mkdtemp(`${tmpdir()}/selectors-test-`);
  directories.push(root);
  const baselineFile = `${root}/baseline.json`;
  await writeFile(baselineFile, JSON.stringify(baseline));
  const requests: string[] = [];
  const fetcher = async (url: string) => {
    requests.push(url);
    if (answer) return answer();
    const path = url.split(/\/[0-9a-f]{40}\//u)[1] ?? "";
    return path in served
      ? new Response(JSON.stringify(served[path]), { status })
      : new Response("Not found", { status: 404 });
  };
  const directory = `${root}/live`;
  // A restarted sidecar: a new store over the same directory and fake GitHub.
  const restart = () => new SelectorStore(directory, new URL(`file://${baselineFile}`), fetcher);
  return { store: restart(), restart, directory, requests };
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

test("a nested definition that vanishes or changes kind is a lost column too", () => {
  const bundled = baseline.files["profile/character.json"];
  // Keeping CLASSJOB_ICONS but dropping its ICON would empty that column on every parse.
  expect(() =>
    validateSelectorFile(
      "c.json",
      { ...bundled, CLASSJOB_ICONS: { ROOT: bundled.CLASSJOB_ICONS.ROOT } },
      bundled,
    ),
  ).toThrow("lost CLASSJOB_ICONS.ICON");
  expect(() =>
    validateSelectorFile("c.json", { ...bundled, NAME: { FIRST: { selector: ".x" } } }, bundled),
  ).toThrow("lost NAME (now a group)");
  expect(() =>
    validateSelectorFile("c.json", { ...bundled, CLASSJOB_ICONS: { selector: "li" } }, bundled),
  ).toThrow("lost CLASSJOB_ICONS (now a selector)");
  // New nested keys are fine.
  const grown = {
    ...bundled,
    CLASSJOB_ICONS: { ...bundled.CLASSJOB_ICONS, LEVEL: { selector: ".level" } },
  };
  expect(validateSelectorFile("c.json", grown, bundled)).toBe(grown);
});

test("a valid new revision is downloaded at its commit, written, and activated atomically", async () => {
  const { store: live, restart, directory, requests } = await store(baseline.files);
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
  const restarted = restart();
  expect(await restarted.restore()).toBeUndefined();
  expect(restarted.status()).toMatchObject({ revision: NEW, source: "upstream" });
});

test("a restart adopts a saved set only when it is still there and valid", async () => {
  const { store: live, restart, directory, requests } = await store(baseline.files);
  await live.activate(NEW);
  const set = `${directory}/selectors-${NEW}.json`;
  const active = `${directory}/active.json`;
  const saved = await readFile(set, "utf8");
  const pointer = await readFile(active, "utf8");
  // Save a set and its pointer as a previous run would have left them.
  const leave = async (setText: string, pointerText = pointer) => {
    await writeFile(set, setText);
    await writeFile(active, pointerText);
  };
  // Workers read the pointer without the store's checks, so a rejected one must be gone: they then
  // load the bundled copy the store reports.
  const pointerKept = () => Bun.file(active).exists();
  // The pointer survived but its set did not: the bundled set runs and says so, and the next
  // check downloads the revision again instead of treating it as already active.
  await rm(set);
  const missing = restart();
  expect(await missing.restore()).toContain("ENOENT");
  expect(missing.status()).toMatchObject({ revision: OLD, source: "bundled" });
  expect(await pointerKept()).toBe(false);
  requests.length = 0;
  expect(await missing.activate(NEW)).toBe(NEW);
  expect(requests).toHaveLength(2);
  // A damaged set, or one whose file lost a column, isn't adopted either.
  await leave("{");
  expect(await restart().restore()).toContain("JSON");
  expect(await pointerKept()).toBe(false);
  const damaged = JSON.parse(saved);
  damaged.files["profile/character.json"] = { NAME: { selector: ".x" } };
  await leave(JSON.stringify(damaged));
  const lost = restart();
  expect(await lost.restore()).toContain("lost CLASSJOB_ICONS");
  expect(lost.status().source).toBe("bundled");
  expect(await pointerKept()).toBe(false);
  // Nor a pointer naming a different set than its revision's.
  await leave(saved, JSON.stringify({ ...JSON.parse(pointer), revision: LATER }));
  expect(await restart().restore()).toBe("The pointer names another set.");
  expect(await pointerKept()).toBe(false);
  // A valid one is adopted and stays.
  await leave(saved);
  expect(await restart().restore()).toBeUndefined();
  expect(await pointerKept()).toBe(true);
  // With nothing saved at all, there is nothing to report.
  await rm(active);
  expect(await restart().restore()).toBeUndefined();
});

test("a failed cleanup doesn't hide an activation that already went live", async () => {
  const { store: live, directory } = await store(baseline.files);
  await live.activate(NEW);
  // An old set that can't be removed: a directory, which rm refuses.
  await mkdir(`${directory}/selectors-${"9".repeat(40)}.json`);
  expect(await live.activate(LATER)).toBe(LATER);
  expect(live.status()).toMatchObject({ revision: LATER, source: "upstream" });
  expect(JSON.parse(await readFile(`${directory}/active.json`, "utf8")).revision).toBe(LATER);
});

test("a selector file over the size limit is refused without reading it into memory", async () => {
  // A declared length over the limit is refused before reading.
  const declared = await store({}, 200, async () => {
    return new Response("{}", { headers: { "content-length": String(600 * 1024) } });
  });
  await expect(declared.store.activate(NEW)).rejects.toThrow("exceeds the size limit");
  // Without one, the read stops just past 512 KiB (8 chunks of 64 KiB), not at the 2 MiB end.
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(32);
  const streamed = await store({}, 200, async () => {
    return new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          if (pulled > 32) controller.close();
          else controller.enqueue(chunk);
        },
      }),
    );
  });
  await expect(streamed.store.activate(NEW)).rejects.toThrow("exceeds the size limit");
  expect(pulled).toBeLessThan(12);
  expect(streamed.store.status().revision).toBe(OLD);
});

test("activation keeps the set it replaced, so a worker that just read the old pointer finds it", async () => {
  const { store: live, directory } = await store(baseline.files);
  const sets = async () => (await readdir(directory)).filter((name) => name !== "active.json");
  await live.activate(NEW);
  expect(await sets()).toEqual([`selectors-${NEW}.json`]);
  await live.activate(LATER);
  expect((await sets()).sort()).toEqual([`selectors-${NEW}.json`, `selectors-${LATER}.json`]);
  // Only the set before that goes.
  await live.activate(LATEST);
  expect((await sets()).sort()).toEqual([`selectors-${LATER}.json`, `selectors-${LATEST}.json`]);
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
