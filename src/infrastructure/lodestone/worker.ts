/**
 * One isolated parse (2.21.0). The bot fetches the page itself (runner.ts) and sends it here with the
 * active selector files the operation reads; the worker only parses and never touches the network or
 * the disk. A fresh worker per page lets the bot terminate it at its deadline, which also ends
 * CPU-bound parsing of a hostile or pathological page.
 */
import { z } from "zod";
import { parsePage } from "./parser.js";
import { requestSchema } from "./protocol.js";

/** What the bot sends: the operation, the page body and the operation's selector files in order. */
const messageSchema = z.object({
  input: requestSchema,
  body: z.string(),
  files: z.array(z.record(z.string(), z.unknown())),
});

self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    const { input, body, files } = messageSchema.parse(event.data);
    // The adapter validates every field; parsed values stay untrusted until then.
    postMessage({ ok: true, data: parsePage(input, body, files) });
  } catch {
    // Page text never leaves the worker in a diagnostic.
    postMessage({ ok: false, code: "invalid_response", retryAfter: 0 });
  }
};
