/**
 * What each Lodestone operation reads (2.20.0): its page, its selector files and the keys it parses.
 * Kept apart from the parser (sidecar/lodestone.ts) so the sidecar server, which validates new
 * selector sets against these keys (sidecar/selectors.ts), doesn't load the DOM library: linkedom is
 * bundled into the worker only.
 */
import type { ParseRequest } from "../src/infrastructure/nodestone/protocol.js";

/** The page every operation reads, on the configured region's Lodestone. */
export function pageUrl(input: ParseRequest, region: string): string {
  const origin = `https://${region}.finalfantasyxiv.com/lodestone`;
  switch (input.operation) {
    case "profile":
      return `${origin}/character/${input.id}`;
    case "fc":
      return `${origin}/freecompany/${input.id}`;
    case "members": {
      const url = new URL(`${origin}/freecompany/${input.id}/member`);
      url.searchParams.set("page", String(input.page));
      return url.toString();
    }
    case "search": {
      // Query values are encoded exactly once; setting the page re-serializes the query.
      const url = new URL(
        `${origin}/character/?q=${encodeURIComponent(input.name)}&worldname=${encodeURIComponent(input.world)}`,
      );
      url.searchParams.set("page", String(input.page));
      return url.toString();
    }
  }
}

/** Every selector file the parser reads: the bundled fallback and each live download. */
export const SELECTOR_FILES = [
  "profile/character.json",
  "profile/attributes.json",
  "profile/gearset.json",
  "freecompany/freecompany.json",
  "freecompany/members.json",
  "search/character.json",
] as const;

/** The selector files each operation reads, merged in this order, and the keys it requests. */
export function pagePlan(input: ParseRequest): { files: string[]; keys: string[] } {
  switch (input.operation) {
    case "profile":
      return {
        files: ["profile/character.json", "profile/attributes.json", "profile/gearset.json"],
        // The biography only for proof verification, never for routine refreshes.
        keys: ["NAME", "SERVER", "FREE_COMPANY", ...(input.biography ? ["BIO"] : [])],
      };
    case "fc":
      return {
        files: ["freecompany/freecompany.json"],
        keys: ["ID", "NAME", "TAG", "SERVER", "ACTIVE_MEMBER_COUNT"],
      };
    case "members":
      return { files: ["freecompany/members.json"], keys: ["ROOT", "ENTRY", "PAGE_INFO"] };
    case "search":
      return {
        files: ["search/character.json"],
        keys: ["ROOT", "ENTRY", "PAGE_INFO", "NO_RESULTS_FOUND"],
      };
  }
}

/**
 * Every top-level selector key any operation parses. A new selector set must keep these, and all
 * they contain, with the same shape (sidecar/selectors.ts); other columns may change freely.
 */
export const PARSED_KEYS: readonly string[] = [
  ...new Set(
    (
      [
        { operation: "profile", id: "1", biography: true },
        { operation: "fc", id: "1" },
        { operation: "members", id: "1", page: 1 },
        { operation: "search", name: "a", world: "b", page: 1 },
      ] as const
    ).flatMap((input) => pagePlan(input).keys),
  ),
];
