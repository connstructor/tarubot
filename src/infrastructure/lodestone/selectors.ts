/**
 * Live Lodestone selectors (2.19.0, owner decision of 2026-09-25: "xivapi/lodestone-css-selectors
 * should ALWAYS be the latest version available"). When the upstream monitor sees a new HEAD, the
 * store downloads the files the parser reads, pinned to that commit, validates them, and makes them
 * the set every later parse uses. A download or validation failure keeps the active set and is
 * reported; the set bundled with the release (bundled.ts) is the fallback. Parser code stays
 * release-managed: selectors are data, the parser is code. Since 2.20.0 the parser is TaruBot's own
 * (parser.ts), and a new set only has to keep the columns it reads (pages.ts).
 *
 * Since 2.21.0 the set lives in memory in the bot, which hands each parser worker the files its
 * operation reads. Nothing is written to disk: after a restart the bundled set runs until the first
 * check, moments later, brings HEAD back.
 */
import { z } from "zod";
import { BUNDLED_SELECTORS, type SelectorRegistry, type SelectorSet } from "./bundled.js";
import { PARSED_KEYS } from "./pages.js";

/** Each downloaded file is small; anything larger is not a selector file. */
const FILE_BYTES = 512 * 1024;
/** Selector files are published here at a commit, without the GitHub API's rate limit. */
const RAW = "https://raw.githubusercontent.com";

/** One selector definition: a CSS selector with the repository's optional extraction settings. */
const definitionSchema = z
  .object({
    selector: z.string().min(1),
    attribute: z.string().optional(),
    regex: z.string().optional(),
    multiple: z.boolean().optional(),
    type: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    types: z.record(z.string(), z.unknown()).optional(),
    time: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/** Where the active set came from: downloaded from upstream, or bundled with the release. */
export interface SelectorStatus {
  readonly repository: string;
  readonly revision: string;
  readonly source: "upstream" | "bundled";
  readonly activatedAt: string | null;
  /** The bundled fallback's revision, for comparison. */
  readonly bundled: string;
}

/**
 * A downloaded file's text, read at most FILE_BYTES into memory: a larger declared length is refused
 * before reading, and the stream is cancelled as soon as it passes the limit, counted in bytes.
 */
async function boundedText(response: Response, path: string): Promise<string> {
  const tooLarge = new Error(`${path} exceeds the size limit.`);
  if (Number(response.headers.get("content-length")) > FILE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge;
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > FILE_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge;
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Whether a node is one selector definition rather than a group of them. */
function isDefinition(node: unknown): boolean {
  return typeof node === "object" && node !== null && "selector" in node;
}

/**
 * The definitions and groups of `bundled` that `candidate` lost, or turned from one kind into the
 * other, as dotted trails. Nested groups count too: FREE_COMPANY keeping its NAME but losing ID
 * would silently drop every character's FC link on every parse.
 */
function lostKeys(candidate: unknown, bundled: unknown, trail: string): string[] {
  if (isDefinition(bundled)) return isDefinition(candidate) ? [] : [`${trail} (now a group)`];
  if (isDefinition(candidate)) return [`${trail} (now a selector)`];
  const record = candidate as Record<string, unknown>;
  return Object.entries(bundled as Record<string, unknown>).flatMap(([key, child]) => {
    const next = trail ? `${trail}.${key}` : key;
    return key in record ? lostKeys(record[key], child, next) : [next];
  });
}

/**
 * Throw when a downloaded file is not a usable selector file: every leaf is a definition with a
 * selector string and correctly typed options, and every column the parser reads (PARSED_KEYS) that
 * the bundled copy has is still present, with every definition and group inside it, at any depth, of
 * the same kind, so no column the parser uses vanishes. Columns it never reads may change or go: the
 * owner wants the latest selectors, and those don't affect TaruBot. Regexes are not compiled here:
 * they are applied per column, and upstream already ships one that doesn't compile (achievements'
 * ENTRY.NAME), which only affects that column, so compiling them would reject usable sets.
 */
export function validateSelectorFile(
  path: string,
  candidate: unknown,
  baseline: Record<string, unknown>,
): Record<string, unknown> {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error(`${path} is not an object.`);
  const visit = (node: unknown, trail: string): void => {
    if (!node || typeof node !== "object" || Array.isArray(node))
      throw new Error(`${path}: ${trail} is not a selector or a group.`);
    if ("selector" in node) {
      if (!definitionSchema.safeParse(node).success)
        throw new Error(`${path}: ${trail} is not a valid selector.`);
      return;
    }
    for (const [key, value] of Object.entries(node)) visit(value, trail ? `${trail}.${key}` : key);
  };
  visit(candidate, "");
  // visit() has checked every node is an object, so the comparison only walks the bundled shape.
  const record = candidate as Record<string, unknown>;
  const missing = PARSED_KEYS.filter((key) => key in baseline).flatMap((key) =>
    key in record ? lostKeys(record[key], baseline[key], key) : [key],
  );
  if (missing.length) throw new Error(`${path} lost ${missing.slice(0, 5).join(", ")}.`);
  return record;
}

export class SelectorStore {
  private active: SelectorStatus;
  private files: SelectorSet["files"];

  constructor(
    private readonly bundled: SelectorSet = BUNDLED_SELECTORS,
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {
    this.files = bundled.files;
    this.active = {
      repository: bundled.repository,
      revision: bundled.revision,
      source: "bundled",
      activatedAt: null,
      bundled: bundled.revision,
    };
  }

  /** The repository whose HEAD the monitor follows for this store. */
  get repository(): string {
    return this.bundled.repository;
  }

  /** The active set: what the next parse uses. */
  status(): SelectorStatus {
    return { ...this.active };
  }

  /** The active files an operation reads, in its merge order (pagePlan). */
  selectorFiles(paths: readonly string[]): SelectorRegistry[] {
    return paths.map((path) => {
      const file = this.files[path];
      if (!file) throw new Error(`Missing selector file ${path}.`);
      return file;
    });
  }

  /**
   * Make `revision` active: download every file the parser reads at that commit and validate each,
   * then switch to the new set in one assignment. Returns the active revision afterwards; a failure
   * throws with the reason and leaves the active set unchanged.
   */
  async activate(revision: string, signal?: AbortSignal): Promise<string> {
    if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error("Invalid selector revision.");
    if (revision === this.active.revision) return revision;
    const files: Record<string, SelectorRegistry> = {};
    for (const [path, bundled] of Object.entries(this.bundled.files)) {
      const response = await this.fetcher(`${RAW}/${this.bundled.repository}/${revision}/${path}`, {
        headers: { "user-agent": "TaruBot-selector-updater" },
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Downloading ${path} failed (${response.status}).`);
      }
      const text = await boundedText(response, path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${path} is not valid JSON.`);
      }
      files[path] = validateSelectorFile(path, parsed, bundled);
    }
    // Every bundled path was downloaded and validated, so this is a complete set.
    this.files = files;
    this.active = {
      ...this.active,
      revision,
      source: "upstream",
      activatedAt: new Date().toISOString(),
    };
    return revision;
  }
}
