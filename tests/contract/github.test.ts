/** GitHub response contracts, signature status, request coalescing, and outage isolation. */
import { expect, test } from "bun:test";
import { GitHubHistory } from "../../src/infrastructure/github/client.js";
import { project } from "../../src/config/project.js";

/** Commit bodies and untrusted response URLs must not leak into rendered titles/links. */
const fixture = (
  index: number,
  verification?: { verified: boolean; reason: string; signature: string | null },
) => ({
  sha: String(index).repeat(40),
  html_url: "https://unrelated.example/not-the-commit",
  commit: {
    message: `Commit ${index}\n\nA longer body`,
    ...(verification ? { verification } : {}),
  },
});

test("commit history marks only signed and GitHub-verified commits and constructs canonical links", async () => {
  const client = new GitHubHistory(async (url, init) => {
    expect(url).toBe(
      "https://api.github.com/repos/deconfined/tarubot/commits?sha=main&per_page=10",
    );
    expect(new Headers(init.headers).get("user-agent")).toBe(`TaruBot/${project.version}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return Response.json([
      fixture(1, { verified: true, reason: "valid", signature: "signed payload" }),
      fixture(2, { verified: false, reason: "bad_email", signature: "signed payload" }),
      fixture(3, { verified: false, reason: "unsigned", signature: null }),
      fixture(4),
      fixture(5, { verified: true, reason: "valid", signature: null }),
    ]);
  });
  const history = await client.recent(5);
  expect(history.warning).toBeNull();
  expect(history.commits.map((commit) => commit.verified)).toEqual([
    true,
    false,
    false,
    false,
    false,
  ]);
  expect(history.commits[0]).toEqual({
    sha: "1".repeat(40),
    title: "Commit 1",
    url: `${project.url}/commit/${"1".repeat(40)}`,
    verified: true,
  });
});

test("different requested counts share an in-flight request and a bounded history cache", async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  let now = Date.parse("2026-09-22T18:00:00Z");
  const client = new GitHubHistory(
    async () => {
      calls++;
      await gate.promise;
      return Response.json(Array.from({ length: 10 }, (_, index) => fixture(index)));
    },
    () => now,
  );
  const one = client.recent(1),
    ten = client.recent(10);
  expect(calls).toBe(1);
  gate.resolve();
  expect((await one).commits).toHaveLength(1);
  expect((await ten).commits).toHaveLength(10);
  now += 299999;
  expect((await client.recent()).commits).toHaveLength(5);
  expect(calls).toBe(1);
  now += 2;
  await client.recent();
  expect(calls).toBe(2);
});

test("rate limits are explained and failure caching avoids a request storm", async () => {
  let calls = 0,
    now = 0;
  const client = new GitHubHistory(
    async () => {
      calls++;
      return new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    },
    () => now,
  );
  expect((await client.recent()).warning).toContain("rate-limiting");
  await client.recent();
  expect(calls).toBe(1);
  now += 60001;
  await client.recent();
  expect(calls).toBe(2);
});

test("transport, HTTP, and malformed-response failures return safe unavailable history", async () => {
  const responses = [new Response(null, { status: 503 }), Response.json({ unexpected: true })];
  for (const response of responses) {
    const history = await new GitHubHistory(async () => response).recent();
    expect(history.commits).toEqual([]);
    expect(history.warning).toContain("temporarily unavailable");
  }
  const history = await new GitHubHistory(async () => {
    throw new Error("private transport details");
  }).recent();
  expect(history.warning).not.toContain("private transport details");
  expect(history.commits).toEqual([]);
});

test("invalid commit counts fail before network access", async () => {
  let calls = 0;
  const client = new GitHubHistory(async () => {
    calls++;
    return Response.json([]);
  });
  for (const count of [0, -1, 11, 1.5, NaN]) await expect(client.recent(count)).rejects.toThrow();
  expect(calls).toBe(0);
});
