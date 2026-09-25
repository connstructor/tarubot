/** Verify concurrency/spacing at actual transport start and cancellation below the HTTP wrapper. */
import { expect, test } from "bun:test";
import { LodestoneGate } from "../../sidecar/gate.js";
import { execute, serve } from "../../sidecar/server.js";
import { responseSchema } from "../../src/infrastructure/nodestone/protocol.js";

const workerURL = new URL("../../dist/sidecar/worker.js", import.meta.url).href;
// Keep transport assertions intact while allowing emulated worker startup to complete.
const workerTestTimeout = 30000;
/**
 * The sidecar reserves each start on the monotonic clock and then calls the transport, so the
 * observed gap can trail the reserved 1,000 ms by the in-process hop between the two (larger on a
 * cold first call). Wall-clock time is not used: it can be slewed against the monotonic clock and
 * truncates to whole milliseconds, which once measured the enforced gap as 999 ms in a CI build.
 */
const startHopToleranceMs = 10;
test(
  "simultaneous requests obey sidecar concurrency and actual transport start spacing",
  async () => {
    // Requests race through body parsing; only two may reserve parser capacity.
    const starts: number[] = [];
    const server = serve(0, {
      workerURL,
      async transport() {
        starts.push(performance.now());
        await Bun.sleep(50);
        return new Response("<div>Controlled invalid page</div>");
      },
    });
    try {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          fetch(`http://localhost:${server.port}/v1/parse`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operation: "fc", id: "9232097761132958152" }),
          }),
        ),
      );
      const refused = responses.filter((response) => response.status === 429);
      expect(refused).toHaveLength(6);
      // A full sidecar says `busy` (2.17.0), never the Lodestone's `rate_limited`.
      for (const response of refused)
        expect(responseSchema.parse(await response.json())).toMatchObject({
          ok: false,
          code: "busy",
          retryAfter: 1,
        });
      expect(starts).toHaveLength(2);
      // Unspaced starts would land within a few milliseconds of each other.
      expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(
        1000 - startHopToleranceMs,
      );
      for (const response of responses) if (!response.bodyUsed) await response.arrayBuffer();
    } finally {
      await server.stop(true);
    }
  },
  workerTestTimeout,
);
test(
  "cancelling parser work aborts the underlying transport and terminates its worker",
  async () => {
    // The transport intentionally never resolves normally, so completion proves cancellation.
    const controller = new AbortController();
    let aborted = false;
    let announce = () => {};
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const pending = execute({ operation: "fc", id: "9232097761132958152" }, controller.signal, {
      workerURL,
      transport: async (_url, options) =>
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
    });
    await started;
    controller.abort();
    const result = responseSchema.parse(await pending);
    expect(result.ok).toBe(false);
    expect(aborted).toBe(true);
  },
  workerTestTimeout,
);

/**
 * The Lodestone's own "Access Restricted" page for a private character profile, trimmed from the
 * page it served on 2026-09-24 (HTTP 403 through CloudFront). The sidecar keys on the error window
 * markup, not the English heading, so every region's language classifies the same way.
 */
const RESTRICTED = `<!DOCTYPE html><html lang="en-us"><head><title>The Lodestone</title></head>
<body class="error__body"><div class="error__bg"><div class="ldst__window ldst__error">
<h1 class="error__heading">Access Restricted</h1>
<p class="error__text">You do not have permission to view this page.</p>
<a href="/lodestone/" class="btn__color parts__space--reset">Main Site</a></div></div></body></html>`;

/** Run one parser operation against a scripted transport and a test-owned gate. */
async function once(
  input: Parameters<typeof execute>[0],
  transport: (url: URL) => Promise<Response>,
  gate: LodestoneGate,
) {
  return responseSchema.parse(
    await execute(input, new AbortController().signal, { workerURL, transport, gate }),
  );
}

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
      await once(
        { operation: "fc", id: "9232097761132958152" },
        async () => new Response(RESTRICTED, { status: 403 }),
        gate,
      ),
    ).toMatchObject({ ok: false, code: "unavailable" });
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
    const fc = { operation: "fc", id: "9232097761132958152" } as const;
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
