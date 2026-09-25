/**
 * Live Lodestone selectors (2.19.0, owner decision of 2026-09-25: "xivapi/lodestone-css-selectors
 * should ALWAYS be the latest version available"). When the upstream monitor sees a new HEAD, the
 * store downloads the files the parsers load, pinned to that commit, validates them, and activates
 * them by rewriting a pointer file that every new parser worker reads (sidecar/selector-runtime.ts).
 * A download or validation failure keeps the active set and is reported; the set bundled at build
 * time remains the fallback. Parser code stays release-managed: selectors are data, the parser is code.
 */
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { z } from "zod";

/** Each downloaded file is small; anything larger is not a selector file. */
const FILE_BYTES = 512 * 1024;
/** Selector files are published here at a commit, without the GitHub API's rate limit. */
const RAW = "https://raw.githubusercontent.com";

/** One selector definition: a CSS selector with Nodestone's optional extraction settings. */
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

/** Where the active set came from: downloaded from upstream, or bundled at build time. */
export interface SelectorStatus {
  readonly repository: string;
  readonly revision: string;
  readonly source: "upstream" | "bundled";
  readonly activatedAt: string | null;
  /** The bundled fallback's revision, for comparison. */
  readonly bundled: string;
}

/** The bundled fallback written by the build (scripts/build-sidecar.ts). */
interface Baseline {
  readonly repository: string;
  readonly revision: string;
  readonly files: Record<string, Record<string, unknown>>;
}

/**
 * Throw when a downloaded file is not a usable selector file: every leaf is a definition with a
 * selector string and correctly typed options, and every top-level key the bundled copy has is still
 * present, so no column the parsers use vanishes. Regexes are not compiled here: Nodestone translates
 * and applies them per column, and upstream already ships one it can't compile (achievements'
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
  const record = candidate as Record<string, unknown>;
  const missing = Object.keys(baseline).filter((key) => !(key in record));
  if (missing.length) throw new Error(`${path} lost ${missing.slice(0, 5).join(", ")}.`);
  return record;
}

export class SelectorStore {
  private readonly baseline: Baseline;
  private active: SelectorStatus;

  constructor(
    private readonly directory: string,
    baselineUrl: URL = new URL("./selectors-baseline.json", import.meta.url),
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {
    this.baseline = JSON.parse(readFileSync(baselineUrl, "utf8")) as Baseline;
    this.active = {
      repository: this.baseline.repository,
      revision: this.baseline.revision,
      source: "bundled",
      activatedAt: null,
      bundled: this.baseline.revision,
    };
  }

  /** The repository whose HEAD the monitor follows for this store. */
  get repository(): string {
    return this.baseline.repository;
  }

  /** The active set: what new parser workers load. */
  status(): SelectorStatus {
    return { ...this.active };
  }

  /**
   * Adopt a set a previous run of this container already activated (a restart keeps /tmp), so the
   * sidecar doesn't fall back to the bundled selectors until the next check.
   */
  async restore(): Promise<void> {
    try {
      const pointer = JSON.parse(readFileSync(`${this.directory}/active.json`, "utf8")) as {
        revision?: unknown;
        activatedAt?: unknown;
      };
      if (typeof pointer.revision === "string" && /^[0-9a-f]{40}$/u.test(pointer.revision))
        this.active = {
          ...this.active,
          revision: pointer.revision,
          source: "upstream",
          activatedAt: typeof pointer.activatedAt === "string" ? pointer.activatedAt : null,
        };
    } catch {
      // No previous set: the bundled selectors stay active until the first check.
    }
  }

  /**
   * Make `revision` active: download every file the parsers load at that commit, validate each,
   * write the set, then switch the pointer atomically. Returns the active revision afterwards; a
   * failure throws with the reason and leaves the active set unchanged.
   */
  async activate(revision: string, signal?: AbortSignal): Promise<string> {
    if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error("Invalid selector revision.");
    if (revision === this.active.revision) return revision;
    const files: Record<string, Record<string, unknown>> = {};
    for (const [path, bundled] of Object.entries(this.baseline.files)) {
      const response = await this.fetcher(
        `${RAW}/${this.baseline.repository}/${revision}/${path}`,
        {
          headers: { "user-agent": "TaruBot-selector-updater" },
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Downloading ${path} failed (${response.status}).`);
      }
      const text = await response.text();
      if (text.length > FILE_BYTES) throw new Error(`${path} exceeds the size limit.`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${path} is not valid JSON.`);
      }
      files[path] = validateSelectorFile(path, parsed, bundled);
    }
    await mkdir(this.directory, { recursive: true });
    const file = `selectors-${revision}.json`;
    const activatedAt = new Date().toISOString();
    await writeFile(`${this.directory}/${file}`, JSON.stringify({ revision, files }));
    // Workers read active.json whole; a rename replaces it atomically.
    const pointer = `${this.directory}/active.json.${process.pid}.tmp`;
    await writeFile(pointer, JSON.stringify({ file, revision, activatedAt }));
    await rename(pointer, `${this.directory}/active.json`);
    // Keep only the active set; a worker that already read its set holds it in memory.
    for (const name of await readdir(this.directory))
      if (name.startsWith("selectors-") && name !== file)
        await rm(`${this.directory}/${name}`, { force: true });
    this.active = { ...this.active, revision, source: "upstream", activatedAt };
    return revision;
  }
}
