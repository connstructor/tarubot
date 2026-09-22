/** Compile lockfile-resolved upstream HEAD sources into a traceable isolated Bun ESM worker. */
import { transform } from "../sidecar/transforms.js";
import { fileURLToPath } from "node:url";
import { lockedRevisions, revisionsSchema, upstreams } from "../sidecar/upstreams.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const revisions = revisionsSchema.parse(
  await Bun.file(`${root}sidecar/upstream-revisions.json`).json(),
);
const locked = lockedRevisions(Bun.JSONC.parse(await Bun.file(`${root}bun.lock`).text()));
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
          path: `${root}node_modules/nodestone-upstream/src/index.ts`,
        }));
        build.onResolve({ filter: /^axios$/ }, () => ({ path: Bun.resolveSync("axios", root) }));
        build.onLoad({ filter: /nodestone-upstream\/src\/.*\.ts$/ }, async ({ path }) => ({
          contents: transform(path, await Bun.file(path).text()),
          loader: "ts",
        }));
      },
    },
  ],
});
if (!result.success) throw new AggregateError(result.logs, "Sidecar compilation failed");
await Bun.write(
  `${root}dist/sidecar/upstream-revisions.json`,
  `${JSON.stringify(revisions, null, 2)}\n`,
);
console.log("Compiled Nodestone parsers and selectors with verified upstream revision metadata.");
