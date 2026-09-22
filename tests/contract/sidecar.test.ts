/** Verify concurrency/spacing at actual transport start and cancellation below the HTTP wrapper. */
import { expect, test } from "bun:test";
import { execute, serve } from "../../sidecar/server.js";
import { responseSchema } from "../../src/infrastructure/nodestone/protocol.js";

const workerURL = new URL("../../dist/sidecar/worker.js", import.meta.url).href;
// Keep transport assertions intact while allowing emulated worker startup to complete.
const workerTestTimeout = 30000;
test(
  "simultaneous requests obey sidecar concurrency and actual transport start spacing",
  async () => {
    // Requests race through body parsing; only two may reserve parser capacity.
    const starts: number[] = [];
    const server = serve(0, {
      workerURL,
      async transport() {
        starts.push(Date.now());
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
      expect(responses.filter((response) => response.status === 429)).toHaveLength(6);
      expect(starts).toHaveLength(2);
      expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(1000);
      for (const response of responses) await response.arrayBuffer();
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
