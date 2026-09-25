/**
 * Fetching and parsing one Lodestone page (2.21.0: inside the bot, replacing the sidecar's HTTP
 * service). The runner is the only network policy: the configured region's Lodestone only, start
 * spacing and the shared 429 cooldown (gate.ts), a fetch deadline, no redirects, a body bound, and
 * private-profile detection. The fetched page is parsed in a fresh worker (worker.ts), which the
 * runner terminates when the request's deadline or shutdown aborts it.
 */
import type { SelectorRegistry } from "./bundled.js";
import type { LodestoneGate } from "./gate.js";
import { pageUrl } from "./pages.js";
import { type ParseRequest, type ParseResponse, responseSchema } from "./protocol.js";

/** The Lodestone regions TaruBot can read. */
export const REGIONS = ["na", "eu", "fr", "de", "jp"] as const;
export type Region = (typeof REGIONS)[number];

/** A parse failure, as the adapter maps it to a catalog code. */
type ParseFailure = Extract<ParseResponse, { ok: false }>;

export interface RunnerOptions {
  readonly region: Region;
  /** Shared by every request of the process: spacing and the 429 cooldown are process-wide. */
  readonly gate: LodestoneGate;
  /** The Lodestone fetch deadline (LODESTONE_TIMEOUT_MS). */
  readonly fetchTimeoutMs: number;
  /** The most page bytes read (LODESTONE_BODY_BYTES). */
  readonly bodyBytes: number;
  /** Told of each Lodestone 429, with the cooldown it started and the 429s in a row. */
  readonly throttled?: (state: { cooldownSeconds: number; strikes: number }) => void;
  /** Injectable for tests: the Lodestone transport, and the worker script. */
  readonly transport?: (url: URL, init: RequestInit) => Promise<Response>;
  readonly workerURL?: string;
}

/** A character profile page: the only page a private profile's 403 can come from. */
const CHARACTER_PAGE = /^\/lodestone\/character\/\d+\/?$/u;
/** Error pages are small; reading more than this to classify one is never needed. */
const ERROR_PAGE_BYTES = 65536;

/** Seconds from a Retry-After header (delta seconds or an HTTP date), or 0 when absent/unusable. */
function retryAfterSeconds(response: Response): number {
  const retry = response.headers.get("retry-after");
  const seconds = retry
    ? /^\d+$/.test(retry)
      ? Number(retry)
      : Math.max(0, (Date.parse(retry) - Date.now()) / 1000)
    : 0;
  return Number.isFinite(seconds) ? seconds : 0;
}

/**
 * Whether a 403 is the Lodestone's own "Access Restricted" page, which it serves for a private
 * character profile. The page carries the Lodestone's error window markup (`ldst__error`) in every
 * region's language; an edge or firewall block (such as the one DigitalOcean's addresses get) is a
 * bare CDN error page without it, and stays `unavailable`. Reads at most ERROR_PAGE_BYTES.
 */
async function restricted(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      chunks.push(item.value);
      size += item.value.byteLength;
      if (size >= ERROR_PAGE_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return /\bldst__error\b/u.test(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Fetch one Lodestone page under the network policy. Never throws: the result is the page body or
 * the failure category, with retryAfter for the Lodestone's throttling.
 */
export async function fetchPage(
  url: URL,
  signal: AbortSignal,
  options: RunnerOptions,
): Promise<{ ok: true; body: string } | ParseFailure> {
  try {
    // While the Lodestone is throttling us, refuse locally with the remaining cooldown.
    const cooling = await options.gate.admit(signal);
    if (cooling > 0) return { ok: false, code: "rate_limited", retryAfter: cooling };
    const response = await (options.transport ?? fetch)(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.fetchTimeoutMs)]),
      redirect: "error",
    });
    if (response.status === 429) {
      // Close the gate for every request, not just this one; retryAfter is the whole cooldown.
      const cooldown = options.gate.throttled(retryAfterSeconds(response));
      options.throttled?.({ ...options.gate.status(), cooldownSeconds: cooldown });
      await response.body?.cancel().catch(() => {});
      return { ok: false, code: "rate_limited", retryAfter: cooldown };
    }
    options.gate.answered();
    if (!response.ok) {
      const retryAfter = retryAfterSeconds(response);
      const code =
        response.status === 404
          ? "not_found"
          : response.status === 403 &&
              CHARACTER_PAGE.test(url.pathname) &&
              (await restricted(response))
            ? "private"
            : "unavailable";
      await response.body?.cancel().catch(() => {});
      return { ok: false, code, retryAfter };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > options.bodyBytes) {
        await reader.cancel();
        throw new Error("Body limit");
      }
      chunks.push(item.value);
    }
    return { ok: true, body: Buffer.concat(chunks).toString("utf8") };
  } catch {
    // An abort while waiting for the gate, a network failure, a redirect or an oversized body.
    return { ok: false, code: "unavailable", retryAfter: 0 };
  }
}

/**
 * Parse a fetched page in a fresh worker. The worker is terminated when the parse ends or `signal`
 * aborts, so a deadline also stops CPU-bound parsing; a crashed or silent worker is a failure.
 */
export async function parseInWorker(
  input: ParseRequest,
  body: string,
  files: readonly SelectorRegistry[],
  signal: AbortSignal,
  workerURL = new URL("./worker.js", import.meta.url).href,
): Promise<ParseResponse> {
  const worker = new Worker(workerURL);
  let aborted = (): void => {};
  try {
    return await new Promise<ParseResponse>((resolve) => {
      aborted = () => resolve({ ok: false, code: "unavailable", retryAfter: 0 });
      signal.addEventListener("abort", aborted, { once: true });
      worker.onerror = () => resolve({ ok: false, code: "invalid_response", retryAfter: 0 });
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const result = responseSchema.safeParse(event.data);
        resolve(
          result.success ? result.data : { ok: false, code: "invalid_response", retryAfter: 0 },
        );
      };
      if (signal.aborted) aborted();
      else worker.postMessage({ input, body, files });
    });
  } finally {
    signal.removeEventListener("abort", aborted);
    worker.terminate();
  }
}

/** Fetch and parse one operation's page with the operation's selector files. */
export async function run(
  input: ParseRequest,
  files: readonly SelectorRegistry[],
  signal: AbortSignal,
  options: RunnerOptions,
): Promise<ParseResponse> {
  const page = await fetchPage(new URL(pageUrl(input, options.region)), signal, options);
  if (!page.ok) return page;
  return parseInWorker(input, page.body, files, signal, options.workerURL);
}
