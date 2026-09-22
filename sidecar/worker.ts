/** One isolated parser operation; the parent supplies bounded transport and owns its lifetime. */
import axios from "axios";
import { Character, CharacterSearch, FCMembers, FreeCompany } from "nodestone-upstream";
import { z } from "zod";
import { requestSchema } from "../src/infrastructure/nodestone/protocol.js";

/** Validate messages from the parent before presenting them to the dependency transport. */
const replySchema = z.union([
  z.object({ type: z.literal("http"), body: z.string(), status: z.number() }),
  z.object({ type: z.literal("http_error"), code: z.string(), retryAfter: z.number() }),
]);
let respond: ((value: unknown) => void) | undefined;
// A worker executes one parser request at a time, so exactly one transport reply is pending.

// Nodestone controls URLs and parsing. Its transport delegates to the sidecar's
// bounded fetch, so disconnects and deadlines abort actual network work.
axios.defaults.adapter = async (config) => {
  const pending = new Promise<unknown>((resolve) => {
    respond = resolve;
  });
  postMessage({ type: "fetch", url: config.url });
  const reply = replySchema.parse(await pending);
  if (reply.type === "http_error")
    throw new Error(JSON.stringify({ code: reply.code, retryAfter: reply.retryAfter }));
  return { data: reply.body, status: reply.status, statusText: "", headers: {}, config };
};

/** Route transport replies versus new parser input, retaining only sanitized failure categories. */
self.onmessage = async (event: MessageEvent<unknown>) => {
  if (replySchema.safeParse(event.data).success) {
    respond?.(event.data);
    return;
  }
  try {
    const input = requestSchema.parse(event.data);
    const params: Record<string, string> = {};
    // Only the minimal params/query fields used by the pinned parser API cross this bridge.
    const query: Record<string, string> = {};
    let parser: Character | CharacterSearch | FCMembers | FreeCompany;
    switch (input.operation) {
      case "profile":
        // Biography data is fetched only for proof verification, never routine display refreshes.
        parser = new Character();
        params.characterId = input.id;
        query.columns = `Name,Server,FreeCompany${input.biography ? ",Bio" : ""}`;
        break;
      case "fc":
        parser = new FreeCompany();
        params.fcId = input.id;
        query.columns = "ID,Name,Tag,Server,ActiveMemberCount";
        break;
      case "members":
        parser = new FCMembers();
        params.fcId = input.id;
        query.page = String(input.page);
        query.columns = "Root,Entry,PageInfo";
        break;
      case "search":
        parser = new CharacterSearch();
        query.name = input.name;
        query.server = input.world;
        query.page = String(input.page);
        query.columns = "Root,Entry,PageInfo,NoResultsFound";
        break;
    }
    const data: unknown = await parser.parse({ params, query });
    // The application adapter performs semantic validation; raw parser fields stay untrusted here.
    postMessage({ type: "result", ok: true, data });
  } catch (error) {
    let code = "invalid_response";
    let retryAfter = 0;
    if (error instanceof Error) {
      try {
        const details = z
          .object({ code: z.string(), retryAfter: z.number() })
          .parse(JSON.parse(error.message));
        code = details.code;
        retryAfter = details.retryAfter;
      } catch {
        /* Parser diagnostics deliberately exclude raw page content. */
      }
    }
    postMessage({ type: "result", ok: false, code, retryAfter });
  }
};
