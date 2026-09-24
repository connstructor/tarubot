/** Exercise the compiled upstream parsers and bundled selectors through isolated workers. */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  requestSchema,
  responseSchema,
  type ParseRequest,
} from "../../src/infrastructure/nodestone/protocol.js";
import { Failure } from "../../src/domain/values.js";
import { Nodestone } from "../../src/infrastructure/nodestone/client.js";

// Real bundled workers have slower cold starts in cross-architecture image builds.
const workerTestTimeout = 30000;

/** Supply controlled HTML/errors at the transport boundary while running the real parser code. */
async function parse(
  input: ParseRequest,
  html: string | { code: string; retryAfter: number },
  inspect?: (url: URL) => void,
): Promise<Record<string, unknown>> {
  const worker = new Worker(new URL("../../dist/sidecar/worker.js", import.meta.url).href);
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Parser deadline")), 15000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const transport = z
          .object({ type: z.literal("fetch"), url: z.string() })
          .safeParse(event.data);
        if (transport.success) {
          try {
            inspect?.(new URL(transport.data.url));
          } catch (error) {
            clearTimeout(timer);
            reject(error);
            return;
          }
          worker.postMessage(
            typeof html === "string"
              ? { type: "http", status: 200, body: html }
              : { type: "http_error", ...html },
          );
        } else {
          clearTimeout(timer);
          resolve(event.data);
        }
      };
      worker.postMessage(requestSchema.parse(input));
    });
    const response = responseSchema.parse(result);
    if (!response.ok) throw new Failure(response.code, response.code, response.retryAfter);
    return z.record(z.string(), z.unknown()).parse(response.data);
  } finally {
    worker.terminate();
  }
}

const fcId = "9232097761132958152";
/** Minimal pinned-selector DOM; omitting count differs from rendering an explicit zero. */
function fc(count: string): string {
  return `<div class="ldst__window"><div></div><div><a href="/lodestone/freecompany/${fcId}/"><div></div><div><p>x</p><p>x</p><p>Diabolos [Crystal]</p></div></a></div><section><p class="freecompany__text__name">Woven Souls</p><p class="freecompany__text freecompany__text__tag">Souls</p><p>x</p><p>x</p><p>x</p>${count}</section></div>`;
}
const entry = `<a class="entry__bg entry__link" href="/lodestone/character/123/"></a><p class="entry__name">Al'ice O&#39;Neil</p><p class="entry__world">Diabolos [Crystal]</p>`;
const pager = `<ul class="btn__pager"><li>x</li><li>x</li><li>Page 1 of 2</li><li>x</li></ul>`;

describe("pinned source-built Nodestone under Bun", () => {
  test(
    "FC identity is lossless and explicit zero differs from missing count",
    async () => {
      const zero = await parse(
        { operation: "fc", id: fcId },
        fc('<p class="freecompany__text">0</p>'),
      );
      const missing = await parse({ operation: "fc", id: fcId }, fc(""));
      expect(zero.ID).toBe(fcId);
      expect(zero.ActiveMemberCount).toBe("0");
      expect(missing.ActiveMemberCount).toBeNull();
      expect(zero.World).toBe("Diabolos");
    },
    workerTestTimeout,
  );
  test(
    "profile operation preserves biography and canonical source attributes",
    async () => {
      const result = await parse(
        { operation: "profile", id: "123", biography: true },
        '<div><div></div><div class="frame__chara__box"><p class="frame__chara__name">Al\'ice O&#39;Neil</p></div></div><p class="frame__chara__world">Diabolos [Crystal]</p><div class="character__selfintroduction">tarubot_test-proof</div>',
      );
      expect(result.Bio).toBe("tarubot_test-proof");
      expect(result.World).toBe("Diabolos");
    },
    workerTestTimeout,
  );
  test(
    "members return entries and complete pagination fields",
    async () => {
      const result = await parse(
        { operation: "members", id: fcId, page: 1 },
        `<div class="ldst__window"><i></i><i></i><ul><li class="entry">${entry}</li></ul>${pager}</div>`,
      );
      expect(result.Pagination).toEqual({ Page: 1, PageTotal: 2, PageNext: 2, PagePrev: null });
      expect(z.array(z.object({ ID: z.string() })).parse(result.List)[0]?.ID).toBe("123");
    },
    workerTestTimeout,
  );
  test(
    "search encodes once and appends pagination correctly",
    async () => {
      const name = "Al'ice O'Neil & Élan";
      const result = await parse(
        { operation: "search", name, world: "Diabolos", page: 2 },
        `<div class="ldst__window"><div class="entry">${entry}</div>${pager}</div>`,
        (url) => {
          expect(url.searchParams.get("q")).toBe(name);
          expect(url.searchParams.get("worldname")).toBe("Diabolos");
          expect(url.searchParams.get("page")).toBe("2");
        },
      );
      expect(Array.isArray(result.List)).toBe(true);
    },
    workerTestTimeout,
  );
  test(
    "missing roster root is rejected rather than accepted as empty",
    async () => {
      await expect(
        parse({ operation: "members", id: fcId, page: 1 }, "<html>Maintenance</html>"),
      ).rejects.toThrow("invalid_response");
    },
    workerTestTimeout,
  );
  test(
    "transport categories and retry metadata survive the parser boundary",
    async () => {
      for (const code of ["not_found", "rate_limited", "unavailable"]) {
        await expect(
          parse(
            { operation: "fc", id: fcId },
            { code, retryAfter: code === "rate_limited" ? 7 : 0 },
          ),
        ).rejects.toMatchObject({ code, retryAfter: code === "rate_limited" ? 7 : 0 });
      }
    },
    workerTestTimeout,
  );
});

describe("Lodestone failures name the page they concern", () => {
  test("missing profiles and FCs are not_found with their resource; a missing biography keeps invalid_response", async () => {
    // The sidecar answers every operation with its failure envelope; profiles with a body but no
    // biography model a selector the parser could not find.
    let failing = true;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const input = requestSchema.parse(await request.json());
        if (failing) return Response.json({ ok: false, code: "not_found", retryAfter: 0 });
        return Response.json({
          ok: true,
          data: {
            ID: input.operation === "profile" ? input.id : "1",
            Name: "Example Character",
            World: "Diabolos",
            DC: "Crystal",
            FreeCompany: null,
          },
        });
      },
    });
    const adapter = new Nodestone(`http://localhost:${server.port}`);
    try {
      await expect(adapter.profile("99000001")).rejects.toMatchObject({
        code: "not_found",
        detail: { kind: "resource", resource: "character", id: "99000001" },
      });
      await expect(adapter.company(fcId)).rejects.toMatchObject({
        code: "not_found",
        detail: { kind: "resource", resource: "freecompany", id: fcId },
      });
      await expect(adapter.search("Example Character", "Diabolos")).rejects.toMatchObject({
        code: "not_found",
        detail: {
          kind: "resource",
          resource: "character",
          name: "Example Character",
          world: "Diabolos",
        },
      });
      failing = false;
      // The claim stays valid, so this is still the retryable invalid_response code.
      await expect(adapter.profile("99000001", true)).rejects.toMatchObject({
        code: "invalid_response",
        detail: { kind: "resource", resource: "biography", id: "99000001" },
      });
    } finally {
      adapter.stop();
      await server.stop(true);
    }
  });
});
