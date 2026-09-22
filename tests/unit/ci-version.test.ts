/** Release checks reject stale versions and mismatched tags before image publication. */
import { expect, test } from "bun:test";
import { checkRelease, validateVersion } from "../../scripts/ci-version.js";

test("release validation accepts SemVer and rejects invalid numeric prerelease identifiers", () => {
  for (const version of ["2.8.0", "2.8.0-rc.1", "2.8.0+build.5"])
    expect(validateVersion(version)).toBe(version);
  for (const version of ["2.8", "02.8.0", "2.8.0-01", "2.8.0-", "2.8.0+", "latest"])
    expect(() => validateVersion(version)).toThrow("SemVer");
});

test("a change must advance the version and include its changelog entry", () => {
  expect(checkRelease("2.8.0", "2.7.1", "refs/heads/main", "## 2.8.0 — CI/CD\n")).toBe("2.8.0");
  for (const previous of ["2.8.0", "2.9.0"])
    expect(() => checkRelease("2.8.0", previous, "", "## 2.8.0\n")).toThrow("increment");
  expect(() => checkRelease("2.8.0", "2.7.1", "", "## 2.7.1\n")).toThrow("CHANGELOG");
});

test("tag publication requires the exact manifest version", () => {
  expect(checkRelease("2.8.0", null, "refs/tags/v2.8.0", "## 2.8.0\n")).toBe("2.8.0");
  expect(() => checkRelease("2.8.0", null, "refs/tags/v2.7.1", "## 2.8.0\n")).toThrow(
    "Release tag",
  );
});
