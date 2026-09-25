/**
 * The in-process Lodestone runner (2.21.0, formerly the sidecar): request-start spacing and parse
 * slots, cancellation down to the transport and the worker, private-profile detection, the shared
 * 429 gate, and a live selector switch reaching the parser.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BUNDLED_SELECTORS } from "../../src/infrastructure/lodestone/bundled.js";
import { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { LodestoneGate } from "../../src/infrastructure/lodestone/gate.js";
import { pagePlan } from "../../src/infrastructure/lodestone/pages.js";
import type { ParseRequest } from "../../src/infrastructure/lodestone/protocol.js";
import {
  parseInWorker,
  run,
  type RunnerOptions,
} from "../../src/infrastructure/lodestone/runner.js";
import { SelectorStore } from "../../src/infrastructure/lodestone/selectors.js";

// Keep transport assertions intact while allowing emulated worker startup to complete.
const workerTestTimeout = 30000;
/**
 * The gate reserves each start on the monotonic clock and then calls the transport, so the observed
 * gap can trail the reserved 1,000 ms by the hop between the two (larger on a cold first call).
 * Wall-clock time is not used: it can be slewed against the monotonic clock and truncates to whole
 * milliseconds, which once measured the enforced gap as 999 ms in a CI build.
 */
const startHopToleranceMs = 10;
const fcId = "9232097761132958152";
const fc = { operation: "fc", id: fcId } as const;

/** Run one operation with the bundled selectors against a scripted transport and a test gate. */
function once(
  input: ParseRequest,
  transport: NonNullable<RunnerOptions["transport"]>,
  gate: LodestoneGate,
  signal = new AbortController().signal,
) {
  return run(input, bundledFiles(input), signal, {
    region: "na",
    gate,
    fetchTimeoutMs: 15000,
    bodyBytes: 2000000,
    transport,
  });
}
/** The bundled selector files an operation reads, in its merge order. */
function bundledFiles(input: ParseRequest) {
  return new SelectorStore().selectorFiles(pagePlan(input).files);
}

test(
  "request starts are spaced process-wide, and parses beyond the slots wait rather than fail",
  async () => {
    // Spacing: two requests through the real 1,000 ms gate start at least a second apart.
    const starts: number[] = [];
    const spaced = new Lodestone({
      runner: {
        gate: new LodestoneGate(1000),
        transport: async () => {
          starts.push(performance.now());
          return new Response("<div>Controlled invalid page</div>");
        },
      },
    });
    await Promise.all([1, 2].map(() => spaced.request(fc).catch((error: unknown) => error)));
    expect(starts).toHaveLength(2);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(1000 - startHopToleranceMs);
    // Slots: with spacing out of the way, six simultaneous requests never run more than
    // LODESTONE_CONCURRENCY (2) at once, and every one of them runs: none is refused as busy.
    let running = 0;
    let peak = 0;
    let calls = 0;
    const slotted = new Lodestone({
      runner: {
        gate: new LodestoneGate(1),
        transport: async () => {
          calls++;
          peak = Math.max(peak, ++running);
          await Bun.sleep(100);
          running--;
          return new Response("<div>Controlled invalid page</div>");
        },
      },
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => slotted.company(fcId).catch((error: unknown) => error)),
    );
    expect(calls).toBe(6);
    expect(peak).toBe(2);
    // The page has no FC data, so each is an unreadable page, never a capacity failure.
    for (const result of results) expect(result).toMatchObject({ code: "invalid_response" });
    expect(slotted.status()).toMatchObject({ parsing: 0, waiting: 0 });
  },
  workerTestTimeout,
);

test(
  "a request waiting for a parse slot gives up at its deadline",
  async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lodestone = new Lodestone({
      run: async () => {
        await held;
        return { ok: false, code: "invalid_response", retryAfter: 0 };
      },
    });
    // Two requests take both slots; the third waits and its deadline ends it.
    const busy = [lodestone.request(fc), lodestone.request(fc)].map((pending) =>
      pending.catch((error: unknown) => error),
    );
    await Bun.sleep(10);
    expect(lodestone.status()).toMatchObject({ parsing: 2, waiting: 0 });
    const third = lodestone.request(fc, AbortSignal.timeout(100));
    await Bun.sleep(20);
    expect(lodestone.status().waiting).toBe(1);
    await expect(third).rejects.toMatchObject({ code: "unavailable" });
    expect(lodestone.status().waiting).toBe(0);
    release();
    await Promise.all(busy);
    expect(lodestone.status()).toMatchObject({ parsing: 0, waiting: 0 });
  },
  workerTestTimeout,
);

test(
  "cancelling a request aborts the underlying transport",
  async () => {
    // The transport intentionally never resolves normally, so completion proves cancellation.
    const controller = new AbortController();
    let aborted = false;
    let announce = () => {};
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const pending = once(
      fc,
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("Aborted transport"));
            },
            { once: true },
          );
          announce();
        }),
      new LodestoneGate(1),
      controller.signal,
    );
    await started;
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: "unavailable" });
    expect(aborted).toBe(true);
  },
  workerTestTimeout,
);

test(
  "a parse that never finishes is ended by terminating its worker at the deadline",
  async () => {
    // A worker that spins forever stands in for a pathological page.
    const directory = await mkdtemp(`${tmpdir()}/lodestone-worker-`);
    try {
      const spinning = `${directory}/spin.ts`;
      await writeFile(spinning, "self.onmessage = () => { for (;;) {} };\n");
      const started = performance.now();
      const result = await parseInWorker(
        fc,
        "<div></div>",
        [],
        AbortSignal.timeout(200),
        new URL(`file://${spinning}`).href,
      );
      expect(result).toMatchObject({ ok: false, code: "unavailable" });
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  workerTestTimeout,
);

/**
 * The Lodestone's own "Access Restricted" page for a private character profile, trimmed from the
 * page it served on 2026-09-24 (HTTP 403 through CloudFront). The runner keys on the error window
 * markup, not the English heading, so every region's language classifies the same way.
 */
const RESTRICTED = `<!DOCTYPE html><html lang="en-us"><head><title>The Lodestone</title></head>
<body class="error__body"><div class="error__bg"><div class="ldst__window ldst__error">
<h1 class="error__heading">Access Restricted</h1>
<p class="error__text">You do not have permission to view this page.</p>
<a href="/lodestone/" class="btn__color parts__space--reset">Main Site</a></div></div></body></html>`;

test(
  "a character's Access Restricted page is a private profile; any other 403 stays unavailable",
  async () => {
    const gate = new LodestoneGate(1);
    const profile = { operation: "profile", id: "13746792", biography: false } as const;
    expect(
      await once(profile, async () => new Response(RESTRICTED, { status: 403 }), gate),
    ).toMatchObject({ ok: false, code: "private" });
    // An edge or firewall block (DigitalOcean's addresses got one) is not the Lodestone's page.
    expect(
      await once(
        profile,
        async () =>
          new Response("<html><h1>403 ERROR</h1>Request blocked.</html>", { status: 403 }),
        gate,
      ),
    ).toMatchObject({ ok: false, code: "unavailable" });
    // A private-looking page on an FC page is still an outage, not a private character.
    expect(
      await once(fc, async () => new Response(RESTRICTED, { status: 403 }), gate),
    ).toMatchObject({ ok: false, code: "unavailable" });
    // A missing page and a server error keep their categories.
    expect(await once(fc, async () => new Response("", { status: 404 }), gate)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await once(fc, async () => new Response("", { status: 503 }), gate)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  },
  workerTestTimeout,
);

test(
  "a Lodestone 429 closes the gate: later requests are refused without reaching the Lodestone",
  async () => {
    const gate = new LodestoneGate(1);
    let calls = 0;
    const transport = async () => {
      calls++;
      return new Response("Too many requests", { status: 429 });
    };
    // The throttled request itself reports the whole cooldown.
    expect(await once(fc, transport, gate)).toMatchObject({
      ok: false,
      code: "rate_limited",
      retryAfter: 15,
    });
    const second = await once(fc, transport, gate);
    expect(second).toMatchObject({ ok: false, code: "rate_limited" });
    expect(second.ok === false && second.retryAfter).toBeGreaterThan(0);
    expect(calls).toBe(1);
    expect(gate.status().strikes).toBe(1);
  },
  workerTestTimeout,
);

test(
  "a newly activated selector set is what the next parse uses (2.19.0, in memory since 2.21.0)",
  async () => {
    const page = `<div class="ldst__window"><div></div><div><a href="/lodestone/freecompany/${fcId}/"><div></div><div><p>x</p><p>x</p><p>Diabolos [Crystal]</p></div></a></div><section><p class="freecompany__text__name">Woven Souls</p><p class="freecompany__text freecompany__text__tag">Souls</p><p>x</p><p>x</p><p>x</p></section></div>`;
    // A fake GitHub serving the bundled files, with the FC name selector pointing at the tag.
    const files = structuredClone(BUNDLED_SELECTORS.files) as Record<
      string,
      Record<string, unknown>
    >;
    const freecompany = files["freecompany/freecompany.json"];
    if (!freecompany) throw new Error("Missing bundled FC selectors");
    freecompany.NAME = { selector: ".freecompany__text.freecompany__text__tag", type: "string" };
    const store = new SelectorStore(
      BUNDLED_SELECTORS,
      async (url) => new Response(JSON.stringify(files[url.split(/\/[0-9a-f]{40}\//u)[1] ?? ""])),
    );
    const lodestone = new Lodestone({
      selectors: store,
      runner: { gate: new LodestoneGate(1), transport: async () => new Response(page) },
    });
    const name = async () => ((await lodestone.request(fc)) as { Name?: unknown }).Name;
    // The bundled selectors read the name.
    expect(await name()).toBe("Woven Souls");
    await store.activate("3".repeat(40));
    expect(await name()).toBe("Souls");
    expect(lodestone.status().selectors).toMatchObject({
      revision: "3".repeat(40),
      source: "upstream",
    });
  },
  workerTestTimeout,
);
