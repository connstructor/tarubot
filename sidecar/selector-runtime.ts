/**
 * Selector loading inside each parser worker (2.19.0). The build rewrites Nodestone's static
 * `lodestone-css-selectors/*.json` imports into calls to selectorFile(), so a worker reads the
 * selectors that are active when it starts, not the ones bundled at build time. Every request runs in
 * a fresh worker, so a newly activated upstream revision applies from the next request, with no
 * rebuild or restart.
 *
 * The server (sidecar/selectors.ts) downloads, validates and activates revisions, and exports their
 * directory as NODESTONE_SELECTORS_DIR. Here the active set is read once per worker; when there is
 * none, or it can't be read, the copy bundled at build time (selectors-baseline.json) is used.
 */
import { readFileSync } from "node:fs";

/** One selector set: every file Nodestone imports, by its path inside the repository. */
type SelectorFiles = Record<string, Record<string, unknown>>;

let files: SelectorFiles | undefined;

/** The active set, or the bundled one; read once per worker. */
function load(): SelectorFiles {
  if (files) return files;
  const directory = process.env.NODESTONE_SELECTORS_DIR;
  if (directory)
    try {
      const pointer = JSON.parse(readFileSync(`${directory}/active.json`, "utf8")) as {
        file?: unknown;
      };
      if (
        typeof pointer.file === "string" &&
        /^selectors-[0-9a-f]{40}\.json$/u.test(pointer.file)
      ) {
        const set = JSON.parse(readFileSync(`${directory}/${pointer.file}`, "utf8")) as {
          files?: SelectorFiles;
        };
        if (set.files) {
          files = set.files;
          return files;
        }
      }
    } catch {
      // A missing or unreadable active set falls back to the bundled selectors below.
    }
  const baseline = JSON.parse(
    readFileSync(new URL("./selectors-baseline.json", import.meta.url), "utf8"),
  ) as { files: SelectorFiles };
  files = baseline.files;
  return files;
}

/** The selectors of one repository file, such as `profile/character.json`. */
export function selectorFile(path: string): Record<string, unknown> {
  const file = load()[path];
  if (!file) throw new Error(`Missing selector file ${path}.`);
  return file;
}
