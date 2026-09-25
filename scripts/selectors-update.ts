/**
 * The bundled selector fallback (2.20.0). The running sidecar follows xivapi/lodestone-css-selectors
 * HEAD live, so this only refreshes the copy baked into the image: `--check` compares bun.lock's
 * commit with upstream HEAD (nonzero when behind); `--update` advances the lockfile, records the
 * commit in sidecar/upstream-revisions.json, and rebuilds and tests; `--deploy` also rebuilds and
 * restarts the local sidecar through the Compose build override.
 */
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { latestRevision, lockedRevisions } from "../sidecar/upstreams.js";
import { json } from "../src/domain/values.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--check") === args.includes("--update"))
  throw new Error("Choose --check or --update; --deploy may accompany --update.");
if (args.includes("--deploy") && !args.includes("--update"))
  throw new Error("--deploy requires --update.");

/** Run only explicit project-local tooling; inherited credentials are never printed. */
async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      TMPDIR: `${root}.cache/tmp`,
      BUN_INSTALL_CACHE_DIR: `${root}.cache/bun`,
    },
  });
  if ((await child.exited) !== 0)
    throw new Error(`Selector update failed during ${command[0]} ${command[1]}.`);
}

const repository = "xivapi/lodestone-css-selectors";
if (args.includes("--update")) {
  await Promise.all(
    ["tmp", "bun"].map((name) => mkdir(`${root}.cache/${name}`, { recursive: true })),
  );
  await run([process.execPath, "update", "--no-cache", "lodestone-css-selectors"]);
}
const locked = lockedRevisions(
  Bun.JSONC.parse(await Bun.file(new URL("../bun.lock", import.meta.url)).text()),
)["lodestone-css-selectors"];
const latest = await latestRevision(repository, AbortSignal.timeout(30000));
const current = locked !== undefined && latest.startsWith(locked);
console.log(json({ checkedAt: new Date().toISOString(), repository, locked, latest, current }, 2));
if (!current) {
  process.exitCode = 1;
  if (args.includes("--update"))
    throw new Error("The selector lockfile did not resolve upstream HEAD. Retry before deploying.");
} else if (args.includes("--update")) {
  await Bun.write(
    new URL("../sidecar/upstream-revisions.json", import.meta.url),
    `${json({ "lodestone-css-selectors": { repository, revision: latest } }, 2)}\n`,
  );
  await run([process.execPath, "run", "build"]);
  await run([process.execPath, "run", "typecheck"]);
  await run([process.execPath, "run", "test:unit"]);
  await run([process.execPath, "run", "test:contract"]);
  if (args.includes("--deploy")) {
    const compose = [
      "docker",
      "compose",
      "-f",
      "docker-compose.yml",
      "-f",
      "docker-compose.build.yml",
    ];
    await run([...compose, "build", "nodestone"]);
    await run([...compose, "up", "-d", "--no-deps", "--wait", "nodestone"]);
  }
}
