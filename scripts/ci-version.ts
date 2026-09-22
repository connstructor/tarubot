/** Enforce version/changelog discipline for PRs, merged commits, and release-tag publication. */
import { appendFile } from "node:fs/promises";
import { z } from "zod";

/** SemVer syntax includes prereleases/build metadata and rejects numeric leading zeroes. */
export function validateVersion(value: string): string {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part)))
    throw new Error("package.json must contain a valid SemVer version.");
  return value;
}

/** Compare against the PR base/push predecessor and keep release tags tied to their image version. */
export function checkRelease(
  version: string,
  previous: string | null,
  ref: string,
  changelog: string,
): string {
  validateVersion(version);
  if (previous !== null && Bun.semver.order(version, validateVersion(previous)) <= 0)
    throw new Error("Every change set must increment package.json above its base version.");
  if (ref.startsWith("refs/tags/") && ref !== `refs/tags/v${version}`)
    throw new Error("Release tag must match package.json as vMAJOR.MINOR.PATCH.");
  if (
    !changelog
      .split(/\r?\n/)
      .some((line) => line === `## ${version}` || line.startsWith(`## ${version} `))
  )
    throw new Error("CHANGELOG.md needs an entry for the current version.");
  return version;
}

if (import.meta.main) {
  const manifest = z.object({ version: z.string() }).parse(await Bun.file("package.json").json());
  const base = process.env.CI_BASE_SHA ?? "";
  let previous: string | null = null;
  if (base && !/^0+$/.test(base)) {
    if (!/^[0-9a-f]{40,64}$/.test(base)) throw new Error("Invalid CI base revision.");
    const child = Bun.spawn(["git", "show", `${base}:package.json`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(child.stdout).text();
    if ((await child.exited) !== 0)
      throw new Error("CI could not read its base manifest; fetch complete history.");
    previous = z.object({ version: z.string() }).parse(JSON.parse(text)).version;
  }
  const version = checkRelease(
    manifest.version,
    previous,
    process.env.GITHUB_REF ?? "",
    await Bun.file("CHANGELOG.md").text(),
  );
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(`Validated release version ${version}${previous ? ` above ${previous}` : ""}.`);
}
