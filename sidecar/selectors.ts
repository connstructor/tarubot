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
 * other, as dotted trails. Nested groups count too: CLASSJOB_ICONS keeping its ROOT but losing ICON
 * would silently empty that column on every parse.
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
 * selector string and correctly typed options, and every definition and group the bundled copy has,
 * at any depth, is still present as the same kind, so no column the parsers use vanishes. Regexes are
 * not compiled here: Nodestone translates and applies them per column, and upstream already ships one
 * it can't compile (achievements' ENTRY.NAME), which only affects that column, so compiling them
 * would reject usable sets.
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
  const missing = lostKeys(candidate, baseline, "");
  if (missing.length) throw new Error(`${path} lost ${missing.slice(0, 5).join(", ")}.`);
  return candidate as Record<string, unknown>;
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
   * sidecar doesn't fall back to the bundled selectors until the next check. The set the pointer
   * names must still be there and pass the same validation as a download: adopting a missing or
   * damaged one would report it live while workers quietly used the bundled copy, and activate()
   * would never fetch it again. A rejected pointer is removed, because workers read it without these
   * checks: without it they load the bundled copy the store then reports. Returns why a pointer was
   * not adopted, or undefined.
   */
  async restore(): Promise<string | undefined> {
    let pointer: { file?: unknown; revision?: unknown; activatedAt?: unknown };
    try {
      pointer = JSON.parse(readFileSync(`${this.directory}/active.json`, "utf8"));
    } catch {
      // No previous set: the bundled selectors stay active until the first check.
      return undefined;
    }
    try {
      const revision = pointer.revision;
      if (typeof revision !== "string" || !/^[0-9a-f]{40}$/u.test(revision))
        throw new Error("The pointer names no revision.");
      const file = `selectors-${revision}.json`;
      if (pointer.file !== file) throw new Error("The pointer names another set.");
      const set = JSON.parse(readFileSync(`${this.directory}/${file}`, "utf8")) as {
        revision?: unknown;
        files?: Record<string, unknown>;
      };
      if (set.revision !== revision || !set.files) throw new Error(`${file} is not that set.`);
      for (const [path, bundled] of Object.entries(this.baseline.files))
        validateSelectorFile(path, set.files[path], bundled);
      this.active = {
        ...this.active,
        revision,
        source: "upstream",
        activatedAt: typeof pointer.activatedAt === "string" ? pointer.activatedAt : null,
      };
      return undefined;
    } catch (error) {
      // The bundled selectors stay active, for workers too; the first check downloads HEAD again.
      // A pointer that can't be removed is reported rather than stopping the sidecar from starting.
      const reason = error instanceof Error ? error.message : "unreadable";
      return rm(`${this.directory}/active.json`, { force: true }).then(
        () => reason,
        () => `${reason} The pointer could not be removed.`,
      );
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
      const text = await boundedText(response, path);
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
    const replaced =
      this.active.source === "upstream" ? `selectors-${this.active.revision}.json` : undefined;
    await rename(pointer, `${this.directory}/active.json`);
    // The rename made the set live for new workers, so it is the active one from here on, whatever
    // the cleanup below does.
    this.active = { ...this.active, revision, source: "upstream", activatedAt };
    // Keep the new set and the one it replaced: a worker reads the pointer, then the set it names,
    // so one that read the old pointer just before the rename must still find the old set. Older
    // sets go: activations are at least one check interval (five minutes or more) apart, and a
    // worker lives no longer than its request deadline. Cleanup is best effort: a leftover set is
    // harmless, and the next activation tries again.
    try {
      for (const name of await readdir(this.directory))
        if (name.startsWith("selectors-") && name !== file && name !== replaced)
          await rm(`${this.directory}/${name}`, { force: true });
    } catch {
      // Unremovable old sets stay until the next activation.
    }
    return revision;
  }
}
