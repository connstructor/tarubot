/**
 * Compile the Lodestone sidecar's parser worker (2.20.0: TaruBot's own parser, no Nodestone) and write
 * the bundled selector fallback: the lockfile's lodestone-css-selectors files the parser reads, with
 * their commit. The running sidecar replaces them live with upstream HEAD (sidecar/selectors.ts).
 */
import { fileURLToPath } from "node:url";
import { SELECTOR_FILES } from "../sidecar/pages.js";
import { lockedRevisions, revisionsSchema } from "../sidecar/upstreams.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const revisions = revisionsSchema.parse(
  await Bun.file(`${root}sidecar/upstream-revisions.json`).json(),
);
const selectors = revisions["lodestone-css-selectors"];
const locked = lockedRevisions(Bun.JSONC.parse(await Bun.file(`${root}bun.lock`).text()));
// The recorded commit must be the one bun.lock resolved, or the fallback would be mislabeled.
const lockedRevision = locked["lodestone-css-selectors"];
if (
  selectors?.repository !== "xivapi/lodestone-css-selectors" ||
  !lockedRevision ||
  !selectors.revision.startsWith(lockedRevision)
)
  throw new Error("Selector metadata differs from bun.lock. Run bun run selectors:update.");
const result = await Bun.build({
  entrypoints: [`${root}sidecar/worker.ts`],
  outdir: `${root}dist/sidecar`,
  target: "bun",
  format: "esm",
  sourcemap: "external",
});
if (!result.success) throw new AggregateError(result.logs, "Sidecar compilation failed");
const files: Record<string, unknown> = {};
for (const path of SELECTOR_FILES)
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
  `Compiled the Lodestone parser worker with ${SELECTOR_FILES.length} bundled selector files at ${selectors.revision.slice(0, 7)}.`,
);
