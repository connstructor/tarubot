/**
 * Guard against JSON replies: the officer details path (presenters/reply.ts and the details
 * component) is the only place allowed to send a result as JSON. Modules still on the pre-2.14.0
 * dataReply dump are listed in PENDING, a ratchet each group workstream shrinks as it migrates;
 * the test fails when a listed module stops using it (remove the entry) or an unlisted one starts.
 */
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Where dataReply belongs for good: its definition and the officer details component. */
const ALLOWED = new Set(["src/discord/presenters/reply.ts", "src/components/details.component.ts"]);

/** Modules that still dump results as JSON through src/discord/replies.ts, until they migrate. */
const PENDING = new Set([
  // The legacy dump itself: nothing imports it any more, and WS10 deletes it.
  "src/discord/replies.ts",
]);

/** Every first-party source file, keyed by its repository-relative path. */
async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const path of new Bun.Glob("src/**/*.ts").scan({ cwd: ROOT }))
    files.set(path, await Bun.file(`${ROOT}${path}`).text());
  return files;
}

/** Names a file imports from the domain values module, type-only imports included. */
function valuesImports(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"[^"]*\/domain\/values\.js"/gu,
  ))
    for (const specifier of (match[1] ?? "").split(","))
      names.push(
        specifier
          .trim()
          .replace(/^type\s+/u, "")
          .split(/\s+as\s+/u)[0] ?? "",
      );
  return names;
}

test("dataReply is used only by the details path and the modules still migrating", async () => {
  const files = await sources();
  const users = [...files].filter(([, text]) => /\bdataReply\b/u.test(text)).map(([path]) => path);
  // A new JSON reply outside the details path (or a module missing from PENDING).
  expect(users.filter((path) => !ALLOWED.has(path) && !PENDING.has(path))).toEqual([]);
  // A migrated module still listed in PENDING: remove it so the ratchet only tightens.
  expect([...PENDING].filter((path) => !users.includes(path))).toEqual([]);
});

test("no source builds an inline JSON code block", async () => {
  for (const [path, text] of await sources()) {
    expect({ path, fenced: text.includes("```json") }).toEqual({ path, fenced: false });
    // The escaped template form the legacy dump uses is allowed only until it is deleted.
    if (!PENDING.has(path))
      expect({ path, escaped: text.includes("\\`\\`\\`json") }).toEqual({ path, escaped: false });
  }
});

test("commands and components never serialize results with json()", async () => {
  for (const [path, text] of await sources())
    if (path.startsWith("src/commands/") || path.startsWith("src/components/"))
      expect({ path, json: valuesImports(text).includes("json") }).toEqual({ path, json: false });
});

test("presenters import application data as types only and never reach persistence", async () => {
  for (const [path, text] of await sources()) {
    if (!path.startsWith("src/discord/presenters/")) continue;
    // Runtime imports of the application layer, Drizzle or infrastructure would let a presenter
    // read or write state; presenters format typed results and nothing else.
    const runtime = [...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s*"([^"]+)"/gmu)].map(
      (match) => match[1] ?? "",
    );
    expect({
      path,
      forbidden: runtime.filter((from) =>
        /\/application\/|\/infrastructure\/|drizzle-orm|\/jobs\//u.test(from),
      ),
    }).toEqual({ path, forbidden: [] });
  }
});
