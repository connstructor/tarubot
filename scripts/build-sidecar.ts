/** Compile the pinned submodule and lockfile-resolved selectors into an isolated Bun ESM worker. */
import { selectorImports, transform } from "../sidecar/transforms.js";
import { fileURLToPath } from "node:url";
import { lockedRevisions, revisionsSchema, upstreams } from "../sidecar/upstreams.js";
import { nodestoneDirectory, nodestoneRevision, nodestoneSourceHash } from "./nodestone-source.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const revisions = revisionsSchema.parse(
  await Bun.file(`${root}sidecar/upstream-revisions.json`).json(),
);
const locked = lockedRevisions(Bun.JSONC.parse(await Bun.file(`${root}bun.lock`).text()));
const parser = revisions["nodestone-upstream"];
if (!parser || parser.sourceHash !== (await nodestoneSourceHash(root)))
  throw new Error(
    "Nodestone source differs from the tested metadata. Run bun run nodestone:update.",
  );
// Git is available in a checkout; image builds instead validate the exact source fingerprint.
if (
  (await Bun.file(`${root}${nodestoneDirectory}/.git`).exists()) &&
  parser.revision !== (await nodestoneRevision(root))
)
  throw new Error(
    "Nodestone submodule revision differs from its metadata. Run bun run nodestone:update.",
  );
locked["nodestone-upstream"] = parser.revision;
for (const upstream of upstreams) {
  const revision = revisions[upstream.package];
  const lock = locked[upstream.package];
  if (
    !revision ||
    revision.repository !== upstream.repository ||
    !lock ||
    !revision.revision.startsWith(lock)
  ) {
    throw new Error("Upstream metadata differs from bun.lock. Run bun run nodestone:update.");
  }
}
const result = await Bun.build({
  entrypoints: [`${root}sidecar/worker.ts`],
  outdir: `${root}dist/sidecar`,
  target: "bun",
  format: "esm",
  sourcemap: "external",
  plugins: [
    {
      name: "pinned-nodestone-compatibility",
      setup(build) {
        // Both imports must share one Axios instance so the bounded transport adapter is effective.
        build.onResolve({ filter: /^nodestone-upstream$/ }, () => ({
          path: `${root}${nodestoneDirectory}/src/index.ts`,
        }));
        build.onResolve({ filter: /^axios$/ }, () => ({ path: Bun.resolveSync("axios", root) }));
        build.onLoad({ filter: /vendor\/nodestone\/src\/.*\.ts$/ }, async ({ path }) => ({
          contents: transform(path, await Bun.file(path).text()),
          loader: "ts",
        }));
      },
    },
  ],
});
if (!result.success) throw new AggregateError(result.logs, "Sidecar compilation failed");
// Every selector file Nodestone references must load at runtime (2.19.0): a reference the rewrite
// missed would be bundled statically and never follow upstream.
const referenced = new Set<string>();
for await (const path of new Bun.Glob("src/**/*.ts").scan({ cwd: `${root}${nodestoneDirectory}` }))
  for (const match of (await Bun.file(`${root}${nodestoneDirectory}/${path}`).text()).matchAll(
    /lodestone-css-selectors\/([\w/-]+\.json)/gu,
  ))
    if (match[1]) referenced.add(match[1]);
const loaded = [...selectorImports].sort();
if (!loaded.length || JSON.stringify(loaded) !== JSON.stringify([...referenced].sort()))
  throw new Error(
    "Some Nodestone selector imports weren't rewritten to load at runtime; update sidecar/transforms.ts.",
  );
// The bundled fallback: the lockfile's selectors, the files the parsers load, and their commit.
const selectors = revisions["lodestone-css-selectors"];
if (!selectors) throw new Error("Missing lodestone-css-selectors revision metadata.");
const files: Record<string, unknown> = {};
for (const path of loaded)
  files[path] = await Bun.file(`${root}node_modules/lodestone-css-selectors/${path}`).json();
await Bun.write(
  `${root}dist/sidecar/selectors-baseline.json`,
  `${JSON.stringify({ repository: selectors.repository, revision: selectors.revision, files })}\n`,
);
await Bun.write(
  `${root}dist/sidecar/upstream-revisions.json`,
  `${JSON.stringify(revisions, null, 2)}\n`,
);
console.log(
  `Compiled Nodestone parsers with ${loaded.length} runtime-loaded selector files and verified upstream revision metadata.`,
);
