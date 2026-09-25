/**
 * The healthchecks.io heartbeat (2.22.0): it pings only while the bot is ready, at most every five
 * minutes, retries a failed ping after a minute, logs a failure streak once, never throws, and
 * never lets its URL reach an issue report.
 */
import { expect, test } from "bun:test";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_RETRY_MS,
  Heartbeat,
  type HeartbeatStatus,
  heartbeatSummary,
} from "../../src/application/heartbeat.js";
import { redact } from "../../src/domain/reports.js";

const URL = "https://hc-ping.com/0f6a2c47-6d7e-4f61-9d4c-1c2b3a4d5e6f";
const READY: HeartbeatStatus = {
  ready: true,
  capabilities: { pending: 2, blocked: 0, degraded_fcs: 0 },
  lodestone: { cooldownSeconds: 0, selectors: { revision: "a".repeat(40), source: "upstream" } },
};

/** A heartbeat over a fake clock and a scripted healthchecks.io that records each ping. */
function harness(answer: () => Promise<Response> = async () => new Response("OK")) {
  let now = 1_000_000;
  let status: HeartbeatStatus = READY;
  const pings: { url: string; init: RequestInit }[] = [];
  const logs: string[] = [];
  const heartbeat = new Heartbeat(
    URL,
    "production",
    (level, _fields, message) => logs.push(`${level}: ${message}`),
    async (url, init) => {
      pings.push({ url, init });
      return answer();
    },
    () => now,
  );
  heartbeat.useStatus(() => status);
  return {
    heartbeat,
    pings,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
    setStatus: (next: HeartbeatStatus) => {
      status = next;
    },
  };
}

test("a ready bot pings at once, then every five minutes, with a one-line status", async () => {
  const { heartbeat, pings, advance } = harness();
  await heartbeat.tick();
  expect(pings).toHaveLength(1);
  expect(pings[0]?.url).toBe(URL);
  expect(pings[0]?.init.method).toBe("POST");
  expect(pings[0]?.init.signal).toBeInstanceOf(AbortSignal);
  const body = String(pings[0]?.init.body);
  expect(body).toContain("(production) ready");
  expect(body).toContain("pending 2, blocked 0");
  expect(body).toContain("selectors aaaaaaa (upstream)");
  expect(body).not.toContain("\n");
  // Scheduler passes every 30 s don't ping again until the interval has passed.
  for (let pass = 0; pass < 9; pass++) {
    advance(30_000);
    await heartbeat.tick();
  }
  expect(pings).toHaveLength(1);
  advance(HEARTBEAT_INTERVAL_MS - 9 * 30_000);
  await heartbeat.tick();
  expect(pings).toHaveLength(2);
});

test("an unready bot stays silent instead of sending a failure ping", async () => {
  const { heartbeat, pings, advance, setStatus } = harness();
  setStatus({ ready: false });
  await heartbeat.tick();
  advance(HEARTBEAT_INTERVAL_MS);
  await heartbeat.tick();
  expect(pings).toHaveLength(0);
  // Readiness returning pings at once.
  setStatus(READY);
  await heartbeat.tick();
  expect(pings).toHaveLength(1);
  expect(pings[0]?.url).not.toContain("/fail");
});

test("a failed ping is retried after a minute, logged once per streak, and never throws", async () => {
  let fail: "network" | "http" | false = "network";
  const { heartbeat, pings, logs, advance } = harness(async () => {
    if (fail === "network") throw new TypeError("fetch failed");
    return fail === "http" ? new Response("not found", { status: 404 }) : new Response("OK");
  });
  await heartbeat.tick();
  expect(logs).toEqual(["warn: Heartbeat ping failed; retrying every minute"]);
  // Not before the retry delay.
  advance(HEARTBEAT_RETRY_MS - 1);
  await heartbeat.tick();
  expect(pings).toHaveLength(1);
  advance(1);
  fail = "http";
  await heartbeat.tick();
  expect(pings).toHaveLength(2);
  // Still one warning for the whole streak.
  expect(logs).toHaveLength(1);
  advance(HEARTBEAT_RETRY_MS);
  fail = false;
  await heartbeat.tick();
  expect(pings).toHaveLength(3);
  expect(logs.at(-1)).toBe("info: Heartbeat pings are reaching healthchecks.io again");
  // Back on the normal interval.
  advance(HEARTBEAT_RETRY_MS);
  await heartbeat.tick();
  expect(pings).toHaveLength(3);
});

test("without a URL the heartbeat is off", async () => {
  let calls = 0;
  const heartbeat = new Heartbeat(
    "",
    "devbot",
    () => {},
    async () => {
      calls++;
      return new Response("OK");
    },
  );
  heartbeat.useStatus(() => READY);
  expect(heartbeat.enabled).toBe(false);
  await heartbeat.tick();
  expect(calls).toBe(0);
});

test("the summary tolerates missing metrics and never carries the URL", () => {
  expect(heartbeatSummary("devbot", { ready: true })).toContain("pending ?, blocked ?");
  expect(heartbeatSummary("devbot", { ready: true })).toContain("Lodestone state unknown");
  expect(heartbeatSummary("production", READY)).not.toContain("hc-ping");
});

test("issue reports redact healthchecks.io ping URLs wherever they appear", () => {
  expect(redact(`pinging ${URL} failed`)).toBe(
    "pinging https://hc-ping.com/[ping URL redacted] failed",
  );
  expect(redact(`"url":"${URL}/fail"`)).toBe('"url":"https://hc-ping.com/[ping URL redacted]"');
  // The configured value is also passed as one of the deployment's own secrets.
  expect(redact(`x ${URL} y`, [URL])).toBe("x [secret redacted] y");
});
