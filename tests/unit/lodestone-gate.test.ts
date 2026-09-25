/**
 * The sidecar's Lodestone gate (2.17.0): start spacing, and one shared cooldown after a Lodestone
 * 429 that refuses every start locally until it runs out, doubling on consecutive 429s.
 */
import { expect, test } from "bun:test";
import {
  COOLDOWN_BASE_MS,
  COOLDOWN_MAX_MS,
  LodestoneGate,
  RETRY_AFTER_MAX_MS,
} from "../../sidecar/gate.js";

/** A controllable monotonic clock whose sleeps advance time instead of waiting. */
function manualClock() {
  let now = 1_000_000;
  return {
    clock: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const open = new AbortController().signal;

test("starts are spaced by the configured interval", async () => {
  const time = manualClock();
  const gate = new LodestoneGate(1000, time.clock, time.sleep);
  const first = time.clock();
  expect(await gate.admit(open)).toBe(0);
  expect(await gate.admit(open)).toBe(0);
  // The second start waited out the spacing on the injected clock.
  expect(time.clock() - first).toBeGreaterThanOrEqual(1000);
});

test("a Lodestone 429 refuses every start locally until the cooldown ends", async () => {
  const time = manualClock();
  const gate = new LodestoneGate(1000, time.clock, time.sleep);
  expect(gate.throttled(0)).toBe(COOLDOWN_BASE_MS / 1000);
  // Refused with the remaining cooldown, without reserving a start.
  expect(await gate.admit(open)).toBe(15);
  time.advance(10_000);
  expect(await gate.admit(open)).toBe(5);
  time.advance(5_000);
  expect(await gate.admit(open)).toBe(0);
  expect(gate.status()).toEqual({ cooldownSeconds: 0, strikes: 1 });
});

test("consecutive 429s double the cooldown up to the ceiling; any other answer resets it", () => {
  const time = manualClock();
  const gate = new LodestoneGate(1000, time.clock, time.sleep);
  const seen: number[] = [];
  for (let strike = 0; strike < 7; strike++) {
    seen.push(gate.throttled(0));
    // Let each cooldown run out so the next one is measured on its own.
    time.advance(COOLDOWN_MAX_MS);
  }
  expect(seen).toEqual([15, 30, 60, 120, 240, 300, 300]);
  gate.answered();
  expect(gate.throttled(0)).toBe(15);
});

test("a longer Retry-After wins, within its own bound", () => {
  const time = manualClock();
  const gate = new LodestoneGate(1000, time.clock, time.sleep);
  expect(gate.throttled(120)).toBe(120);
  time.advance(RETRY_AFTER_MAX_MS);
  // An absurd Retry-After is capped rather than parking the sidecar indefinitely.
  expect(gate.throttled(86_400)).toBe(RETRY_AFTER_MAX_MS / 1000);
});

test("a cooldown that begins while a request waits for its slot still refuses it", async () => {
  const time = manualClock();
  // The sleep hook models another request's 429 landing during the spacing wait.
  const gate: LodestoneGate = new LodestoneGate(1000, time.clock, async (ms) => {
    time.advance(ms);
    gate.throttled(0);
  });
  expect(await gate.admit(open)).toBe(0);
  expect(await gate.admit(open)).toBe(15);
});

test("an aborted wait throws instead of starting", async () => {
  const time = manualClock();
  const gate = new LodestoneGate(1000, time.clock, time.sleep);
  const controller = new AbortController();
  expect(await gate.admit(controller.signal)).toBe(0);
  controller.abort();
  await expect(gate.admit(controller.signal)).rejects.toThrow();
});
