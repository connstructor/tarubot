/**
 * Live Lodestone selectors (2.19.0): the bot validates a new upstream selector revision and makes it
 * the set later parses use, or keeps the active set when it can't. Since 2.20.0 only the columns
 * TaruBot's parser reads (pages.ts) must survive. Since 2.21.0 the set lives in memory.
 */
import { expect, test } from "bun:test";
import { BUNDLED_SELECTORS } from "../../src/infrastructure/lodestone/bundled.js";
import { SELECTOR_FILES } from "../../src/infrastructure/lodestone/pages.js";
import {
  SelectorStore,
  validateSelectorFile,
} from "../../src/infrastructure/lodestone/selectors.js";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);

/** A small bundled set: two files, in the repository's real shape. */
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
      FREE_COMPANY: {
        ID: { selector: ".fc a", attribute: "href", regex: "/freecompany/(?P<ID>\\d+)/" },
        NAME: { selector: ".fc a" },
      },
      // A column the parser never reads.
      CLASSJOB_ICONS: {
        ROOT: { selector: "li", multiple: true },
        ICON: { selector: "img", attribute: "src" },
      },
    },
  },
};

/** A store with a fake GitHub serving `served` at any commit, or answering with `answer`. */
function store(served: Record<string, unknown>, status = 200, answer?: () => Promise<Response>) {
  const requests: string[] = [];
  const fetcher = async (url: string) => {
    requests.push(url);
    if (answer) return answer();
    const path = url.split(/\/[0-9a-f]{40}\//u)[1] ?? "";
    return path in served
      ? new Response(JSON.stringify(served[path]), { status })
      : new Response("Not found", { status: 404 });
  };
  return { store: new SelectorStore(baseline, fetcher), requests };
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
  // A regex that doesn't compile only breaks its own column, as upstream's achievements ENTRY.NAME
  // already does, so it isn't a reason to reject the set.
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
  // Keeping FREE_COMPANY but dropping its ID would lose every character's FC on every parse.
  expect(() =>
    validateSelectorFile(
      "c.json",
      { ...bundled, FREE_COMPANY: { NAME: bundled.FREE_COMPANY.NAME } },
      bundled,
    ),
  ).toThrow("lost FREE_COMPANY.ID");
  expect(() =>
    validateSelectorFile("c.json", { ...bundled, NAME: { FIRST: { selector: ".x" } } }, bundled),
  ).toThrow("lost NAME (now a group)");
  expect(() =>
    validateSelectorFile("c.json", { ...bundled, FREE_COMPANY: { selector: ".fc" } }, bundled),
  ).toThrow("lost FREE_COMPANY (now a selector)");
  // New nested keys are fine.
  const grown = {
    ...bundled,
    FREE_COMPANY: { ...bundled.FREE_COMPANY, CREST: { selector: ".crest", attribute: "src" } },
  };
  expect(validateSelectorFile("c.json", grown, bundled)).toBe(grown);
});

test("columns the parser never reads may change or go without holding back an update (2.20.0)", () => {
  const bundled = baseline.files["profile/character.json"];
  const { CLASSJOB_ICONS, ...withoutIcons } = bundled;
  expect(validateSelectorFile("c.json", withoutIcons, bundled)).toBe(withoutIcons);
  const reshaped = { ...bundled, CLASSJOB_ICONS: { ROOT: CLASSJOB_ICONS.ROOT } };
  expect(validateSelectorFile("c.json", reshaped, bundled)).toBe(reshaped);
  // Their definitions must still be well-formed, since the set is stored whole.
  expect(() =>
    validateSelectorFile(
      "c.json",
      { ...bundled, CLASSJOB_ICONS: { ICON: { selector: "" } } },
      bundled,
    ),
  ).toThrow("CLASSJOB_ICONS.ICON is not a valid selector");
});

test("the bundled set holds every file the parser reads, and validates against itself", () => {
  expect(Object.keys(BUNDLED_SELECTORS.files).sort()).toEqual([...SELECTOR_FILES].sort());
  for (const [path, file] of Object.entries(BUNDLED_SELECTORS.files))
    expect(validateSelectorFile(path, file, file)).toBe(file);
  expect(new SelectorStore().status()).toMatchObject({
    revision: BUNDLED_SELECTORS.revision,
    source: "bundled",
  });
});

test("a valid new revision is downloaded at its commit and becomes the set parses use", async () => {
  const replaced = {
    ...baseline.files,
    "freecompany/freecompany.json": {
      ...baseline.files["freecompany/freecompany.json"],
      NAME: { selector: ".freecompany__text__tag" },
    },
  };
  const { store: live, requests } = store(replaced);
  expect(live.status()).toMatchObject({ revision: OLD, source: "bundled", bundled: OLD });
  expect(live.selectorFiles(["freecompany/freecompany.json"])).toEqual([
    baseline.files["freecompany/freecompany.json"],
  ]);
  expect(await live.activate(NEW)).toBe(NEW);
  // Every file the parser reads, pinned to the commit.
  expect(requests.sort()).toEqual([
    `https://raw.githubusercontent.com/xivapi/lodestone-css-selectors/${NEW}/freecompany/freecompany.json`,
    `https://raw.githubusercontent.com/xivapi/lodestone-css-selectors/${NEW}/profile/character.json`,
  ]);
  expect(live.status()).toMatchObject({ revision: NEW, source: "upstream", bundled: OLD });
  expect(live.status().activatedAt).toEqual(expect.any(String));
  // The next parse gets the new files, in the order the operation merges them.
  expect(live.selectorFiles(["profile/character.json", "freecompany/freecompany.json"])).toEqual([
    replaced["profile/character.json"],
    replaced["freecompany/freecompany.json"],
  ]);
  expect(() => live.selectorFiles(["search/character.json"])).toThrow("Missing selector file");
  // The same revision again downloads nothing.
  requests.length = 0;
  expect(await live.activate(NEW)).toBe(NEW);
  expect(requests).toEqual([]);
});

test("a selector file over the size limit is refused without reading it into memory", async () => {
  // A declared length over the limit is refused before reading.
  const declared = store({}, 200, async () => {
    return new Response("{}", { headers: { "content-length": String(600 * 1024) } });
  });
  await expect(declared.store.activate(NEW)).rejects.toThrow("exceeds the size limit");
  // Without one, the read stops just past 512 KiB (8 chunks of 64 KiB), not at the 2 MiB end.
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(32);
  const streamed = store({}, 200, async () => {
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

test("a download or validation failure leaves the active set untouched", async () => {
  const missing = store({
    "freecompany/freecompany.json": baseline.files["freecompany/freecompany.json"],
  });
  await expect(missing.store.activate(NEW)).rejects.toThrow("profile/character.json failed (404)");
  expect(missing.store.status()).toMatchObject({ revision: OLD, source: "bundled" });
  expect(missing.store.selectorFiles(["profile/character.json"])).toEqual([
    baseline.files["profile/character.json"],
  ]);
  const broken = store({
    ...baseline.files,
    "profile/character.json": { NAME: { selector: ".x" } },
  });
  await expect(broken.store.activate(NEW)).rejects.toThrow("lost FREE_COMPANY");
  expect(broken.store.status().revision).toBe(OLD);
  await expect(broken.store.activate("not-a-sha")).rejects.toThrow("Invalid selector revision");
});
