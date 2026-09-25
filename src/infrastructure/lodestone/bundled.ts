/**
 * The selector set shipped with a release (2.21.0): the lodestone-css-selectors files the parser
 * reads, imported straight from the package bun.lock pins, and the commit recorded for it in
 * upstream-revisions.json (a unit test checks the two agree). The bot replaces this set live with
 * upstream HEAD (selectors.ts); it is what runs until the first check, and whenever HEAD is rejected.
 * `bun run selectors:update` advances both.
 */
import character from "lodestone-css-selectors/profile/character.json" with { type: "json" };
import attributes from "lodestone-css-selectors/profile/attributes.json" with { type: "json" };
import gearset from "lodestone-css-selectors/profile/gearset.json" with { type: "json" };
import freecompany from "lodestone-css-selectors/freecompany/freecompany.json" with {
  type: "json",
};
import members from "lodestone-css-selectors/freecompany/members.json" with { type: "json" };
import search from "lodestone-css-selectors/search/character.json" with { type: "json" };
import revisions from "./upstream-revisions.json" with { type: "json" };
import type { SELECTOR_FILES } from "./pages.js";

/** A selector file or group, as lodestone-css-selectors publishes it. */
export type SelectorRegistry = Record<string, unknown>;

/** A complete selector set: every file the parser reads, by its path in the repository. */
export type SelectorFiles = Record<(typeof SELECTOR_FILES)[number], SelectorRegistry>;

/** A selector set and the commit it came from. */
export interface SelectorSet {
  readonly repository: string;
  readonly revision: string;
  readonly files: Readonly<Record<string, SelectorRegistry>>;
}

/** The bundled set: every file the parser reads (SelectorFiles), at bun.lock's commit. */
export const BUNDLED_SELECTORS: SelectorSet & { readonly files: SelectorFiles } = {
  repository: revisions["lodestone-css-selectors"].repository,
  revision: revisions["lodestone-css-selectors"].revision,
  files: {
    "profile/character.json": character,
    "profile/attributes.json": attributes,
    "profile/gearset.json": gearset,
    "freecompany/freecompany.json": freecompany,
    "freecompany/members.json": members,
    "search/character.json": search,
  },
};
