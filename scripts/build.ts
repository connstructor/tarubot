/** Clean compilation prevents removed modules lingering in dynamically discovered output. */
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// dist is generated exclusively by this build; source, fixtures, and import inputs live elsewhere.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
const compiler = Bun.spawn(
  [process.execPath, `${root}node_modules/typescript/bin/tsc`, "-p", "tsconfig.build.json"],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  },
);
if ((await compiler.exited) !== 0) throw new Error("TypeScript compilation failed.");
// The sidecar's pinned third-party source is bundled after first-party compilation.
await import("./build-sidecar.js");
