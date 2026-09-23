/** Pure queue outcome classification: expected waits stay quiet; stalls and terminal failures surface. */
import { expect, test } from "bun:test";
import { DiscordAPIError } from "discord.js";
import { Failure } from "../../src/domain/values.js";
import { jobOutcome, STALE_WAIT_MS } from "../../src/jobs/queue.js";

/** Build the SDK's own error type, as a real REST rejection would, without any Discord request. */
const discordError = (code: number, status: number): DiscordAPIError =>
  new DiscordAPIError(
    { code, message: "Raw SDK message that must never be persisted" },
    code,
    status,
    "GET",
    "/guilds/100/members/200",
    { body: undefined, files: undefined },
  );

test("expected waits stay queued at debug level without consuming attempts", () => {
  for (const code of ["ordered", "busy", "cooldown", "superseded"]) {
    // Even at the attempt limit a wait is not a failed delivery, and perform returns its attempt.
    expect(jobOutcome(new Failure(code, "Waiting fixture."), 8)).toMatchObject({
      code,
      status: "queued",
      waiting: true,
      category: "wait",
      level: "debug",
      delaySeconds: 1,
      diagnostic: `${code}: Waiting fixture.`,
    });
  }
  // An explicit retryAfter still spaces out ordered notifications.
  expect(jobOutcome(new Failure("ordered", "Earlier entry pending.", 30), 1).delaySeconds).toBe(30);
});

test("a continuous wait streak beyond the stale threshold escalates to warn", () => {
  for (const code of ["ordered", "busy", "cooldown", "superseded"]) {
    const wait = new Failure(code, "Still waiting.");
    // The third argument is how long this row has kept waiting, not the row's age.
    expect(jobOutcome(wait, 1, STALE_WAIT_MS).level).toBe("debug");
    // The stuck row still waits (no attempt consumed); only its visibility changes.
    expect(jobOutcome(wait, 1, STALE_WAIT_MS + 1)).toMatchObject({
      status: "queued",
      waiting: true,
      category: "wait",
      level: "warn",
    });
  }
});

test("a lost lease always warns and writes nothing, since another worker owns the row", () => {
  expect(jobOutcome(new Failure("lease_lost", "Reclaimed."), 3)).toMatchObject({
    code: "lease_lost",
    // No status write and no delay: claim() reclaims the expired row itself.
    status: "unchanged",
    delaySeconds: 0,
    waiting: true,
    category: "lease",
    level: "warn",
  });
});

test("blocked and disabled work warns and keeps an actionable status", () => {
  expect(jobOutcome(new Failure("blocked", "Configure a ledger channel."), 1)).toMatchObject({
    status: "blocked",
    waiting: false,
    category: "blocked",
    level: "warn",
    diagnostic: "blocked: Configure a ledger channel.",
  });
  expect(jobOutcome(new Failure("disabled", "Effects are disabled."), 1)).toMatchObject({
    status: "disabled",
    category: "disabled",
    level: "warn",
  });
  // Discord permission rejections get fixed guidance instead of the SDK's message.
  expect(jobOutcome(discordError(50013, 403), 1)).toMatchObject({
    code: "blocked",
    status: "blocked",
    level: "warn",
    source: "DiscordAPIError[50013]",
    diagnostic:
      "blocked: Recheck Discord roles, channel permissions, and bot hierarchy with /config validate.",
  });
});

test("an unknown Discord member is gone work, recorded at info", () => {
  expect(jobOutcome(discordError(10007, 404), 2)).toEqual({
    code: "gone",
    status: "succeeded",
    waiting: false,
    delaySeconds: expect.any(Number),
    diagnostic: "gone",
    category: "gone",
    source: "DiscordAPIError[10007]",
    level: "info",
  });
});

test("ordinary errors retry at warn until the attempt limit, then fail at error", () => {
  const retry = jobOutcome(new Error("socket hang up"), 3);
  expect(retry).toMatchObject({
    code: "transient",
    status: "queued",
    waiting: false,
    category: "retry",
    level: "warn",
    source: "Error",
    diagnostic: "transient",
  });
  // Exponential backoff with bounded jitter: 2^3 seconds plus at most five.
  expect(retry.delaySeconds).toBeGreaterThanOrEqual(8);
  expect(retry.delaySeconds).toBeLessThan(13);
  expect(jobOutcome(new Error("socket hang up"), 8)).toMatchObject({
    code: "transient",
    status: "failed",
    category: "failed",
    level: "error",
  });
  expect(jobOutcome(new Failure("invalid_job", "Unknown job kind."), 1)).toMatchObject({
    status: "failed",
    level: "error",
  });
});

test("a recipient with DMs disabled ends failed but only at info", () => {
  expect(jobOutcome(new Failure("dm_blocked", "The recipient has disabled DMs."), 1)).toMatchObject(
    { code: "dm_blocked", status: "failed", category: "failed", level: "info" },
  );
});
