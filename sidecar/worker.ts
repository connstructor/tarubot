/**
 * One isolated parser operation (2.20.0: TaruBot's own parser, no Nodestone). The worker asks the
 * parent for the page, because the parent is the only network policy authority (region allowlist,
 * start spacing, the 429 gate, body bounds and private-profile detection), then parses it with the
 * active selector set. The parent terminates the worker at its deadline, which ends CPU-bound parsing
 * too.
 */
import { z } from "zod";
import { requestSchema } from "../src/infrastructure/nodestone/protocol.js";
import { parsePage } from "./lodestone.js";
import { pagePlan, pageUrl } from "./pages.js";
import { selectorFile } from "./selector-runtime.js";

/** The parent's answer to a fetch: the page, or a sanitized failure category. */
const replySchema = z.union([
  z.object({ type: z.literal("http"), body: z.string(), status: z.number() }),
  z.object({ type: z.literal("http_error"), code: z.string(), retryAfter: z.number() }),
]);
// A worker handles one operation, so exactly one fetch is pending at a time.
let respond: ((value: unknown) => void) | undefined;

/** Ask the parent to fetch `url`, and wait for its validated reply. */
async function fetchPage(url: string): Promise<z.infer<typeof replySchema>> {
  const pending = new Promise<unknown>((resolve) => {
    respond = resolve;
  });
  postMessage({ type: "fetch", url });
  return replySchema.parse(await pending);
}

/** Route fetch replies versus a new operation; failures keep only their category. */
self.onmessage = async (event: MessageEvent<unknown>) => {
  if (replySchema.safeParse(event.data).success) {
    respond?.(event.data);
    return;
  }
  try {
    const input = requestSchema.parse(event.data);
    // The parent passes its environment to each worker, including the validated region.
    const reply = await fetchPage(pageUrl(input, process.env.PAGE_REGION || "na"));
    if (reply.type === "http_error") {
      postMessage({ type: "result", ok: false, code: reply.code, retryAfter: reply.retryAfter });
      return;
    }
    const data = parsePage(input, reply.body, pagePlan(input).files.map(selectorFile));
    // The bot's adapter validates every field; parsed values stay untrusted until then.
    postMessage({ type: "result", ok: true, data });
  } catch {
    // Page text never leaves the worker in a diagnostic.
    postMessage({ type: "result", ok: false, code: "invalid_response", retryAfter: 0 });
  }
};
