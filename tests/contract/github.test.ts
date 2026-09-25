/**
 * GitHub response contracts, signature status, request coalescing, and outage isolation; the issue
 * client's refusals; and the GitHub App sign-in behind /suggest (2.26.0), against local fakes.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { GitHubApp } from "../../src/infrastructure/github/app.js";
import { GitHubHistory } from "../../src/infrastructure/github/client.js";
import { GitHubIssues } from "../../src/infrastructure/github/issues.js";
import { project } from "../../src/config/project.js";
import { Failure } from "../../src/domain/values.js";

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

describe("issue reports client (2.18.0)", () => {
  /** A fake GitHub that records requests and answers from a script, one response per call. */
  function fakeGitHub(script: (() => Response)[]) {
    const seen: { method: string; path: string; auth: string | null; body: unknown }[] = [];
    let call = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        seen.push({
          method: request.method,
          path: url.pathname,
          auth: request.headers.get("authorization"),
          body: request.method === "POST" ? await request.json() : null,
        });
        return (script[Math.min(call++, script.length - 1)] ?? (() => new Response()))();
      },
    });
    const client = new GitHubIssues(
      "test-token",
      "owner/reports",
      fetch,
      `http://localhost:${server.port}`,
    );
    return { server, client, seen };
  }

  test("creates, comments on and reads issues with the token and API version", async () => {
    const { server, client, seen } = fakeGitHub([
      () => Response.json({ number: 7, state: "open" }, { status: 201 }),
      () => Response.json({ id: 1 }, { status: 201 }),
      () => Response.json({ number: 7, state: "closed" }),
    ]);
    try {
      expect(await client.create("Title", "Body", ["tarubot-report"])).toEqual({
        number: 7,
        state: "open",
      });
      await client.comment(7, "Again");
      expect(await client.get(7)).toEqual({ number: 7, state: "closed" });
      expect(seen).toEqual([
        {
          method: "POST",
          path: "/repos/owner/reports/issues",
          auth: "Bearer test-token",
          body: { title: "Title", body: "Body", labels: ["tarubot-report"] },
        },
        {
          method: "POST",
          path: "/repos/owner/reports/issues/7/comments",
          auth: "Bearer test-token",
          body: { body: "Again" },
        },
        {
          method: "GET",
          path: "/repos/owner/reports/issues/7",
          auth: "Bearer test-token",
          body: null,
        },
      ]);
    } finally {
      await server.stop(true);
    }
  });

  test("GitHub's failures become catalog codes the queue handles", async () => {
    const cases: [() => Response, { code: string; retryAfter?: number }][] = [
      // Rate limits wait: Retry-After, or the reset time of an exhausted primary limit.
      [
        () => new Response("", { status: 429, headers: { "retry-after": "42" } }),
        { code: "rate_limited", retryAfter: 42 },
      ],
      [
        () =>
          new Response("", {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120),
            },
          }),
        { code: "rate_limited" },
      ],
      // A secondary rate limit can be a bare 403; its message tells it from a refused token,
      // and GitHub asks for at least a minute's wait (2.18.0 review).
      [
        () =>
          Response.json(
            { message: "You have exceeded a secondary rate limit. Please wait a few minutes." },
            { status: 403 },
          ),
        { code: "rate_limited", retryAfter: 60 },
      ],
      [
        () =>
          Response.json(
            { message: "Resource not accessible by personal access token" },
            { status: 403 },
          ),
        { code: "configuration" },
      ],
      // Outages retry; a refused token or missing repository needs the operator.
      [() => new Response("", { status: 502 }), { code: "unavailable" }],
      [() => new Response("", { status: 401 }), { code: "configuration" }],
      [() => new Response("", { status: 404 }), { code: "configuration" }],
      [() => new Response("", { status: 422 }), { code: "invalid_data" }],
      // An answer without an issue number is unusable.
      [() => Response.json({ state: "open" }, { status: 201 }), { code: "invalid_response" }],
    ];
    for (const [answer, expected] of cases) {
      const { server, client } = fakeGitHub([answer]);
      try {
        await expect(client.create("Title", "Body", [])).rejects.toMatchObject(expected);
      } finally {
        await server.stop(true);
      }
    }
  });
});

describe("issue client settings (2.26.0)", () => {
  /** A client against a local fake that answers every request with `status`. */
  async function refusedWith(status: number, settings?: string) {
    const server = Bun.serve({ port: 0, fetch: () => new Response("", { status }) });
    try {
      const client = new GitHubIssues(
        "secret-token-value",
        "owner/repo",
        fetch,
        `http://localhost:${server.port}`,
        ...(settings === undefined ? [] : [settings]),
      );
      return await client.create("Title", "Body", []).then(
        () => {
          throw new Error("Expected a refusal");
        },
        (error: unknown) => error,
      );
    } finally {
      await server.stop(true);
    }
  }

  test("the reports client keeps its exact messages", async () => {
    expect(await refusedWith(401)).toMatchObject({
      code: "configuration",
      message:
        "GitHub refused the issue report (401); check GITHUB_REPORTS_TOKEN and GITHUB_REPORTS_REPO.",
    });
  });

  test("/suggest's client names the GitHub App's settings, never the token", async () => {
    const settings =
      "the GitHub App (GITHUB_APP_CLIENT_ID, GITHUB_APP_PRIVATE_KEY) and its installation";
    for (const status of [401, 404]) {
      const error = await refusedWith(status, settings);
      expect(error).toMatchObject({
        code: "configuration",
        message: `GitHub refused the issue report (${status}); check ${settings}.`,
      });
      expect(String((error as Error).message)).not.toContain("secret-token-value");
    }
  });
});

describe("GitHub App sign-in (2.26.0)", () => {
  // A throwaway key pair made for this run: no PEM is committed (the repository is public, and
  // secret scanning would flag one). GitHub downloads app keys as PKCS#1, so the test uses it too.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const NOW = Date.parse("2026-09-25T12:00:00Z");

  /** A fake GitHub that records requests and answers from a script, one response per call. */
  function fakeGitHub(script: (() => Response)[], key = pem) {
    const seen: { method: string; path: string; auth: string | null; body: unknown }[] = [];
    let call = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        seen.push({
          method: request.method,
          path: url.pathname,
          auth: request.headers.get("authorization"),
          body: request.method === "POST" ? await request.json() : null,
        });
        return (script[Math.min(call++, script.length - 1)] ?? (() => new Response()))();
      },
    });
    const app = new GitHubApp(
      "Iv23testclientid",
      key,
      "deconfined/tarubot",
      fetch,
      `http://localhost:${server.port}`,
      () => NOW,
    );
    return { server, app, seen };
  }

  /** Decode one base64url JWT segment. */
  const segment = (value: string | undefined) =>
    JSON.parse(Buffer.from(value ?? "", "base64url").toString()) as Record<string, unknown>;

  test("signs an RS256 JWT GitHub accepts: backdated a minute, nine minutes long", () => {
    const { app, server } = fakeGitHub([]);
    try {
      const [header, claims, signature] = app.jwt().split(".");
      expect(segment(header)).toEqual({ alg: "RS256", typ: "JWT" });
      const seconds = Math.floor(NOW / 1000);
      expect(segment(claims)).toEqual({
        iat: seconds - 60,
        exp: seconds + 540,
        iss: "Iv23testclientid",
      });
      expect(
        verify(
          "sha256",
          Buffer.from(`${header}.${claims}`),
          publicKey,
          Buffer.from(signature ?? "", "base64url"),
        ),
      ).toBe(true);
    } finally {
      void server.stop(true);
    }
  });

  test("finds the installation, then mints a token narrowed to this repository's issues", async () => {
    const { app, server, seen } = fakeGitHub([
      () => Response.json({ id: 164885413, account: { login: "deconfined" } }),
      () =>
        Response.json({ token: "ghs_minted", expires_at: "2026-09-25T13:00:00Z" }, { status: 201 }),
    ]);
    try {
      expect(await app.installationToken()).toBe("ghs_minted");
      expect(seen.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
        { method: "GET", path: "/repos/deconfined/tarubot/installation", body: null },
        {
          method: "POST",
          path: "/app/installations/164885413/access_tokens",
          body: { repositories: ["tarubot"], permissions: { issues: "write" } },
        },
      ]);
      // Both calls carry the app's JWT, never a stored token.
      for (const request of seen) expect(request.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u);
    } finally {
      await server.stop(true);
    }
  });

  test("GitHub's failures become catalog codes, never plain errors or secrets", async () => {
    const malformed = () =>
      new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
    const cases: [(() => Response)[], string][] = [
      // A refused JWT, or the app not installed on the repository, needs the operator.
      [[() => new Response("", { status: 401 })], "configuration"],
      [[() => new Response("", { status: 404 })], "configuration"],
      [[() => Response.json({ id: 1 }), () => new Response("", { status: 422 })], "configuration"],
      // Outages are unavailable; an unreadable 2xx is invalid_response.
      [[() => new Response("", { status: 502 })], "unavailable"],
      [[malformed], "invalid_response"],
      [[() => Response.json({ account: "no id" })], "invalid_response"],
      [
        [() => Response.json({ id: 1 }), () => Response.json({ expires_at: "no token" })],
        "invalid_response",
      ],
    ];
    for (const [script, code] of cases) {
      const { app, server } = fakeGitHub(script);
      try {
        const error = await app.installationToken().then(
          () => new Error("Expected a failure"),
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(Failure);
        expect(error).toMatchObject({ code });
        const message = (error as Error).message;
        if (code === "configuration")
          expect(message).toContain(
            "check GITHUB_APP_CLIENT_ID, GITHUB_APP_PRIVATE_KEY and the app's installation on deconfined/tarubot",
          );
        expect(message).not.toContain("PRIVATE KEY-----");
        expect(message).not.toMatch(/eyJ/u);
      } finally {
        await server.stop(true);
      }
    }
  });

  test("a timeout, before or after GitHub answers, is never a plain error", async () => {
    const timeout = () => new DOMException("The operation timed out.", "TimeoutError");
    // No answer at all.
    const silent = new GitHubApp("Iv23x", pem, "deconfined/tarubot", async () => {
      throw timeout();
    });
    await expect(silent.installationToken()).rejects.toMatchObject({ code: "unavailable" });
    // An answer whose body times out while it is read.
    const stalled = new GitHubApp(
      "Iv23x",
      pem,
      "deconfined/tarubot",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(timeout());
            },
          }),
          { status: 200 },
        ),
    );
    await expect(stalled.installationToken()).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("an unreadable or non-RSA key is a configuration failure naming the setting", async () => {
    for (const key of [
      "not a key",
      generateKeyPairSync("ec", { namedCurve: "P-256" })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    ]) {
      const app = new GitHubApp("Iv23x", key, "deconfined/tarubot", async () => {
        throw new Error("No request may be made with a bad key");
      });
      await expect(app.installationToken()).rejects.toMatchObject({
        code: "configuration",
        message: expect.stringContaining("GITHUB_APP_PRIVATE_KEY"),
      });
    }
    // A key pasted on one line with \n escapes still signs.
    const escaped = new GitHubApp("Iv23x", pem.replaceAll("\n", "\\n"), "deconfined/tarubot");
    expect(escaped.jwt().split(".")).toHaveLength(3);
  });
});
