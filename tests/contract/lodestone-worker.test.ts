/**
 * The real parser worker with the bundled selectors (2.21.0: the bot fetches and hands the worker
 * the page), and the adapter's failure naming and retry policy over scripted parse results.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Lodestone, WIRE_CODES } from "../../src/infrastructure/lodestone/client.js";
import { pagePlan, pageUrl } from "../../src/infrastructure/lodestone/pages.js";
import {
  type ParseRequest,
  type ParseResponse,
  requestSchema,
} from "../../src/infrastructure/lodestone/protocol.js";
import { parseInWorker } from "../../src/infrastructure/lodestone/runner.js";
import { SelectorStore } from "../../src/infrastructure/lodestone/selectors.js";
import { Failure } from "../../src/domain/values.js";

// Real workers have slower cold starts in cross-architecture image builds.
const workerTestTimeout = 30000;

/** Parse controlled HTML in a real worker with the bundled selectors the operation reads. */
async function parse(input: ParseRequest, html: string): Promise<Record<string, unknown>> {
  const files = new SelectorStore().selectorFiles(pagePlan(input).files);
  const response = await parseInWorker(
    requestSchema.parse(input),
    html,
    files,
    AbortSignal.timeout(15000),
  );
  if (!response.ok)
    throw new Failure(WIRE_CODES[response.code], response.code, response.retryAfter);
  return z.record(z.string(), z.unknown()).parse(response.data);
}

const fcId = "9232097761132958152";
/** Minimal pinned-selector DOM; omitting count differs from rendering an explicit zero. */
function fc(count: string): string {
  return `<div class="ldst__window"><div></div><div><a href="/lodestone/freecompany/${fcId}/"><div></div><div><p>x</p><p>x</p><p>Diabolos [Crystal]</p></div></a></div><section><p class="freecompany__text__name">Woven Souls</p><p class="freecompany__text freecompany__text__tag">Souls</p><p>x</p><p>x</p><p>x</p>${count}</section></div>`;
}
const entry = `<a class="entry__bg entry__link" href="/lodestone/character/123/"></a><p class="entry__name">Al'ice O&#39;Neil</p><p class="entry__world">Diabolos [Crystal]</p>`;
const pager = `<ul class="btn__pager"><li>x</li><li>x</li><li>Page 1 of 2</li><li>x</li></ul>`;

describe("the parser worker with the bundled selectors", () => {
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
      const input = { operation: "search", name, world: "Diabolos", page: 2 } as const;
      const url = new URL(pageUrl(input, "na"));
      expect(url.searchParams.get("q")).toBe(name);
      expect(url.searchParams.get("worldname")).toBe("Diabolos");
      expect(url.searchParams.get("page")).toBe("2");
      const result = await parse(
        input,
        `<div class="ldst__window"><div class="entry">${entry}</div>${pager}</div>`,
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
});

/** A character record, as the parser returns one for a profile. */
function profileData(input: ParseRequest) {
  return {
    ID: input.operation === "profile" ? input.id : "1",
    Name: "Example Character",
    World: "Diabolos",
    DC: "Crystal",
    FreeCompany: null,
  };
}

describe("Lodestone failures name the page they concern", () => {
  test("missing profiles and FCs are not_found with their resource; a missing biography keeps invalid_response", async () => {
    // Every operation answers not_found at first; profiles with a body but no biography model a
    // selector the parser could not find.
    let failing = true;
    const adapter = new Lodestone({
      run: async (input): Promise<ParseResponse> =>
        failing
          ? { ok: false, code: "not_found", retryAfter: 0 }
          : { ok: true, data: profileData(input) },
    });
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
    }
  });
});

describe("client retry policy (2.17.0)", () => {
  /** A scripted runner: each request takes the next failure, then a profile; calls show retries. */
  function scripted(first: ParseResponse) {
    let calls = 0;
    const adapter = new Lodestone({
      run: async (input) => (calls++ === 0 ? first : { ok: true, data: profileData(input) }),
    });
    return { adapter, calls: () => calls };
  }

  test("an outage is retried; the Lodestone's rate limit and a private profile are not", async () => {
    const outage = scripted({ ok: false, code: "unavailable", retryAfter: 0 });
    const throttled = scripted({ ok: false, code: "rate_limited", retryAfter: 30 });
    const hidden = scripted({ ok: false, code: "private", retryAfter: 0 });
    try {
      // A failed fetch or a timeout gets another attempt within the request.
      await expect(outage.adapter.profile("99000001")).resolves.toMatchObject({ id: "99000001" });
      expect(outage.calls()).toBe(2);
      // The gate refuses every start for the cooldown: fail fast with it as retryAfter, so the
      // queue waits it out instead of spending the request deadline on refusals.
      await expect(throttled.adapter.profile("99000001")).rejects.toMatchObject({
        code: "rate_limited",
        retryAfter: 30,
      });
      expect(throttled.calls()).toBe(1);
      // Private is an answer about the character, with the approved wording and its resource.
      await expect(hidden.adapter.profile("99000001")).rejects.toMatchObject({
        code: "private_profile",
        message: "The Lodestone profile for character ID 99000001 is private.",
        detail: { kind: "resource", resource: "character", id: "99000001" },
      });
      expect(hidden.calls()).toBe(1);
    } finally {
      for (const { adapter } of [outage, throttled, hidden]) adapter.stop();
    }
  });
});

test("a deadline during a retry backoff is unavailable and no Lodestone answer (2.18.0 review)", async () => {
  // An outage asks for at least a one-second backoff; the job deadline ends during it.
  const adapter = new Lodestone({
    run: async () => ({ ok: false, code: "unavailable", retryAfter: 0 }),
  });
  try {
    await expect(
      adapter.request({ operation: "fc", id: fcId }, AbortSignal.timeout(200)),
    ).rejects.toMatchObject({ code: "unavailable" });
    // Not a raw AbortError, and not counted as the Lodestone answering.
    expect(adapter.reachability()).toMatchObject({
      lastAnswerAt: null,
      failingSince: expect.any(Date),
      lastFailure: "unavailable",
    });
  } finally {
    adapter.stop();
  }
});
