/** Refresh both upstream HEAD dependencies, verify their contracts, and optionally redeploy. */
import { fileURLToPath } from "node:url";
import { latestRevision, lockedRevisions, upstreams } from "../sidecar/upstreams.js";
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
    throw new Error(`Update workflow failed during ${command[0]} ${command[1]}.`);
}

if (args.includes("--update")) {
  // Floating manifest references are advanced explicitly; normal builds install their tested lock.
  await run([
    process.execPath,
    "update",
    "--no-cache",
    ...upstreams.map((upstream) => upstream.package),
  ]);
}
const locked = lockedRevisions(
  Bun.JSONC.parse(await Bun.file(new URL("../bun.lock", import.meta.url)).text()),
);
const results = await Promise.all(
  upstreams.map(async (upstream) => {
    const latest = await latestRevision(upstream.repository, AbortSignal.timeout(30000));
    const revision = locked[upstream.package];
    return {
      ...upstream,
      locked: revision,
      latest,
      current: revision !== undefined && latest.startsWith(revision),
    };
  }),
);
console.log(json({ checkedAt: new Date().toISOString(), upstreams: results }, 2));
if (results.some((result) => !result.current)) {
  process.exitCode = 1;
  if (args.includes("--update"))
    throw new Error(
      "The lockfile did not resolve current upstream HEAD. Retry the update before deployment.",
    );
} else if (args.includes("--update")) {
  // Full revisions identify exactly what a deployed sidecar contains, without freezing its source policy.
  await Bun.write(
    new URL("../sidecar/upstream-revisions.json", import.meta.url),
    `${json(Object.fromEntries(results.map((result) => [result.package, { repository: result.repository, revision: result.latest }])), 2)}\n`,
  );
  await run([process.execPath, "run", "build"]);
  await run([process.execPath, "run", "typecheck"]);
  await run([process.execPath, "run", "test:unit"]);
  await run([process.execPath, "run", "test:contract"]);
  if (args.includes("--deploy")) {
    // The sidecar has a stable HTTP contract, so parser updates do not restart the Discord client.
    await run(["docker", "compose", "build", "nodestone"]);
    await run(["docker", "compose", "up", "-d", "--no-deps", "--wait", "nodestone"]);
  }
}
