/** Identify the submodule and fingerprint build inputs even when Docker excludes Git metadata. */
export const nodestoneDirectory = "vendor/nodestone";

/** Read-only Git queries never print credentials or change the submodule's worktree. */
async function gitOutput(root: string, args: string[]): Promise<string> {
  if (!(await Bun.file(`${root}/${nodestoneDirectory}/.git`).exists()))
    throw new Error("Initialize Nodestone with git submodule update --init --recursive.");
  const child = Bun.spawn(["git", "-C", `${root}/${nodestoneDirectory}`, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error("Unable to inspect the Nodestone submodule.");
  return output.trim();
}

/** The Git checkout, rather than a second remote package resolution, identifies parser code. */
export async function nodestoneRevision(root: string): Promise<string> {
  const revision = await gitOutput(root, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Invalid Nodestone submodule revision.");
  return revision;
}

/** Updating upstream must not discard local parser edits or untracked work. */
export async function requireCleanNodestone(root: string): Promise<void> {
  if (await gitOutput(root, ["status", "--porcelain", "--untracked-files=normal"]))
    throw new Error("Nodestone has local changes; commit or save them before updating upstream.");
}

/** Hash every parser source/asset plus its manifest; Docker verifies the same bytes without Git. */
export async function nodestoneSourceHash(root: string): Promise<string> {
  const directory = `${root}/${nodestoneDirectory}`;
  if (!(await Bun.file(`${directory}/src/index.ts`).exists()))
    throw new Error(
      "Initialize Nodestone with git submodule update --init --recursive before building.",
    );
  const files = ["package.json"];
  for await (const path of new Bun.Glob("src/**/*").scan({ cwd: directory, onlyFiles: true }))
    files.push(path);
  const hash = new Bun.CryptoHasher("sha256");
  for (const path of files.sort()) {
    hash.update(`${path}\0`);
    hash.update(await Bun.file(`${directory}/${path}`).arrayBuffer());
    hash.update("\0");
  }
  return hash.digest("hex");
}
