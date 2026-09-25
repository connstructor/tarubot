/** Private Nodestone HTTP service with bounded workers, real transport throttling, and cancellation. */
import { z } from "zod";
import { LodestoneGate } from "./gate.js";
import { revisionsSchema, UpstreamMonitor } from "./upstreams.js";
import {
  requestSchema,
  responseSchema,
  type ParseRequest,
} from "../src/infrastructure/nodestone/protocol.js";

const environment = z
  .object({
    PAGE_REGION: z.enum(["na", "eu", "fr", "de", "jp"]).default("na"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LODESTONE_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
    LODESTONE_START_MS: z.coerce.number().int().min(1000).max(60000).default(1000),
    LODESTONE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
    LODESTONE_BODY_BYTES: z.coerce.number().int().min(1024).max(8000000).default(2000000),
    NODESTONE_UPSTREAM_CHECK_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .refine((value) => value === 0 || value >= 300)
      .default(3600),
  })
  .parse(process.env);
// Workers inherit this before importing Nodestone's import-time region constant.
process.env.PAGE_REGION = environment.PAGE_REGION;
let active = 0;
// Capacity, request-start pacing and the 429 cooldown are process-wide across every parser worker.
const processGate = new LodestoneGate(environment.LODESTONE_START_MS);
/** Structured service log; silent when imported by tests, console output in the running sidecar. */
let log: (event: Record<string, unknown>) => void = () => {};
let stopping = false;
const shutdown = new AbortController();
const fetchMessage = z.object({ type: z.literal("fetch"), url: z.string().url() });
let updates: UpstreamMonitor | undefined;
/** Injectable transport/worker paths keep normal contract tests independent of live Lodestone. */
export interface ExecutionOptions {
  transport?: (url: URL, options: RequestInit) => Promise<Response>;
  workerURL?: string;
  /** A test's own gate, so one test's cooldown never leaks into another. */
  gate?: LodestoneGate;
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

/** Execute only validated regional Lodestone URLs and bound the actual streamed network response. */
async function upstream(
  urlString: string,
  signal: AbortSignal,
  transport: NonNullable<ExecutionOptions["transport"]>,
  gate: LodestoneGate,
): Promise<unknown> {
  const url = new URL(urlString);
  if (
    url.protocol !== "https:" ||
    url.hostname !== `${environment.PAGE_REGION}.finalfantasyxiv.com` ||
    !url.pathname.startsWith("/lodestone/")
  )
    return { type: "http_error", code: "invalid_response", retryAfter: 0 };
  // While the Lodestone is throttling us, refuse locally with the remaining cooldown.
  const cooling = await gate.admit(signal);
  if (cooling > 0) return { type: "http_error", code: "rate_limited", retryAfter: cooling };
  try {
    const response = await transport(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(environment.LODESTONE_TIMEOUT_MS)]),
      redirect: "error",
    });
    if (response.status === 429) {
      // Close the gate for every request, not just this one; retryAfter is the whole cooldown.
      const cooldown = gate.throttled(retryAfterSeconds(response));
      // Throttled jobs wait quietly (debug), so the sidecar says once per 429 that the gate closed.
      log({ event: "lodestone_throttled", ...gate.status(), cooldownSeconds: cooldown });
      await response.body?.cancel();
      return { type: "http_error", code: "rate_limited", retryAfter: cooldown };
    }
    gate.answered();
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
      return { type: "http_error", code, retryAfter };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > environment.LODESTONE_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Body limit");
      }
      chunks.push(item.value);
    }
    return { type: "http", status: response.status, body: Buffer.concat(chunks).toString("utf8") };
  } catch {
    return { type: "http_error", code: "unavailable", retryAfter: 0 };
  }
}

/** Isolate synchronous parser work so a deadline can terminate both CPU work and its fetch. */
export async function execute(
  input: ParseRequest,
  signal: AbortSignal,
  options: ExecutionOptions = {},
): Promise<unknown> {
  const worker = new Worker(options.workerURL ?? new URL("./worker.js", import.meta.url).href);
  const controller = new AbortController();
  const combined = AbortSignal.any([
    signal,
    controller.signal,
    shutdown.signal,
    AbortSignal.timeout(30000),
  ]);
  try {
    return await new Promise<unknown>((resolve) => {
      const aborted = (): void => {
        resolve({ ok: false, code: "unavailable", retryAfter: 0 });
      };
      combined.addEventListener("abort", aborted, { once: true });
      worker.onerror = () => {
        resolve({ ok: false, code: "invalid_response", retryAfter: 0 });
      };
      worker.onmessage = async (event: MessageEvent<unknown>) => {
        // The worker requests transport; the parent remains the only network policy authority.
        const network = fetchMessage.safeParse(event.data);
        if (network.success) {
          try {
            const reply = await upstream(
              network.data.url,
              combined,
              options.transport ?? fetch,
              options.gate ?? processGate,
            );
            if (!combined.aborted) worker.postMessage(reply);
          } catch {
            resolve({ ok: false, code: "unavailable", retryAfter: 0 });
          }
          return;
        }
        const result = responseSchema.safeParse(event.data);
        if (result.success) resolve(result.data);
        else resolve({ ok: false, code: "invalid_response", retryAfter: 0 });
      };
      if (combined.aborted) aborted();
      else worker.postMessage(input);
    });
  } finally {
    controller.abort();
    worker.terminate();
  }
}

/** Every parser slot is taken; a slot frees within a request's deadline, usually a second. */
const busyResponse = () =>
  Response.json({ ok: false, code: "busy", retryAfter: 1 }, { status: 429 });
/** Shutting down: the client treats a 5xx as the sidecar being unavailable and retries. */
const stoppingResponse = () =>
  Response.json({ ok: false, code: "unavailable", retryAfter: 1 }, { status: 503 });

/** Admit bounded validated operations; probes never acquire a Lodestone page. */
export function serve(port = environment.PORT, options: ExecutionOptions = {}) {
  return Bun.serve({
    port,
    maxRequestBodySize: 4096,
    async fetch(request) {
      if (new URL(request.url).pathname === "/health")
        return Response.json({
          ready: !stopping,
          active,
          lodestone: (options.gate ?? processGate).status(),
          upstream: updates?.status() ?? null,
        });
      // A stopping sidecar is unavailable; a full one is `busy`, never the Lodestone's rate limit.
      if (stopping) return stoppingResponse();
      if (active >= environment.LODESTONE_CONCURRENCY) return busyResponse();
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/parse")
        return new Response("Not found", { status: 404 });
      const body: unknown = await request.json().catch(() => null);
      const input = requestSchema.safeParse(body);
      if (!input.success) return new Response("Invalid operation", { status: 400 });
      // Parsing the request body yields; reserve capacity only after that await.
      if (stopping) return stoppingResponse();
      if (active >= environment.LODESTONE_CONCURRENCY) return busyResponse();
      active++;
      try {
        return Response.json(await execute(input.data, request.signal, options), {
          headers: { "cache-control": "no-store" },
        });
      } finally {
        active--;
      }
    },
  });
}
// Importing this module in tests exposes the factory without opening a production listener.
if (import.meta.main) {
  log = (event) => console.log(JSON.stringify({ service: "nodestone", ...event }));
  const revisions = revisionsSchema.parse(
    await Bun.file(new URL("./upstream-revisions.json", import.meta.url)).json(),
  );
  updates = new UpstreamMonitor(revisions, undefined, (state) => {
    console.log(
      JSON.stringify({
        service: "nodestone",
        event: "upstream_status",
        ...state,
        updateCommand:
          state.status === "update_available" ? "bun run nodestone:update --deploy" : undefined,
      }),
    );
  });
  updates.start(environment.NODESTONE_UPSTREAM_CHECK_SECONDS);
  const server = serve();
  for (const event of ["SIGINT", "SIGTERM"] as const)
    process.on(event, () => {
      stopping = true;
      updates?.stop();
      shutdown.abort();
      void server.stop(true);
    });
  console.log(JSON.stringify({ service: "nodestone", port: environment.PORT, ready: true }));
}
