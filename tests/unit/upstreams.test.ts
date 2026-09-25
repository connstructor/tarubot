/** Upstream tracking must notice selector-only changes and tolerate update-service outages. */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { nodestoneSourceHash } from "../../scripts/nodestone-source.js";
import { lockedRevisions, UpstreamMonitor } from "../../sidecar/upstreams.js";

const deployed = {
  "nodestone-upstream": { repository: "xivapi/nodestone", revision: "a".repeat(40) },
  "lodestone-css-selectors": {
    repository: "xivapi/lodestone-css-selectors",
    revision: "b".repeat(40),
  },
};

test("selector HEAD can advance independently of the parser repository", async () => {
  const monitor = new UpstreamMonitor(deployed, async (repository) =>
    repository.endsWith("/nodestone") ? "a".repeat(40) : "c".repeat(40),
  );
  await monitor.check();
  expect(monitor.status().status).toBe("update_available");
  expect(monitor.status().components.map((component) => component.current)).toEqual([true, false]);
  monitor.stop();
});

test("matching revisions are current and failed checks do not claim freshness", async () => {
  let unavailable = false;
  const monitor = new UpstreamMonitor(deployed, async (repository) => {
    if (unavailable) throw new Error("Fixture outage");
    return repository.endsWith("/nodestone") ? "a".repeat(40) : "b".repeat(40);
  });
  await monitor.check();
  expect(monitor.status().status).toBe("current");
  unavailable = true;
  await monitor.check();
  expect(monitor.status().status).toBe("unavailable");
  monitor.stop();
});

test("a live upstream is brought to HEAD, and reports what actually runs (2.19.0)", async () => {
  const selectorHead = "c".repeat(40);
  const activated: string[] = [];
  let accept = true;
  const monitor = new UpstreamMonitor(
    deployed,
    async (repository) => (repository.endsWith("/nodestone") ? "a".repeat(40) : selectorHead),
    () => {},
    {
      package: "lodestone-css-selectors",
      async activate(latest) {
        activated.push(latest);
        // A rejected HEAD leaves the previous revision running.
        return accept ? latest : "b".repeat(40);
      },
    },
  );
  await monitor.check();
  expect(activated).toEqual([selectorHead]);
  expect(monitor.status().status).toBe("current");
  expect(monitor.status().components[1]).toMatchObject({ deployed: selectorHead, current: true });
  accept = false;
  await monitor.check();
  expect(monitor.status().status).toBe("update_available");
  expect(monitor.status().components[1]).toMatchObject({
    deployed: "b".repeat(40),
    current: false,
  });
  monitor.stop();
});

test("Bun locks the local parser path and an independent Git selector revision", () => {
  expect(
    lockedRevisions({
      packages: {
        "nodestone-upstream": ["@xivapi/nodestone@file:vendor/nodestone"],
        "lodestone-css-selectors": [
          "lodestone-css-selectors@github:xivapi/lodestone-css-selectors#123abcd",
        ],
      },
    }),
  ).toEqual({ "lodestone-css-selectors": "123abcd" });
  expect(() => lockedRevisions({ packages: {} })).toThrow();
  expect(() =>
    lockedRevisions({
      packages: {
        "nodestone-upstream": ["@xivapi/nodestone@github:xivapi/nodestone#abcdef0"],
      },
    }),
  ).toThrow("submodule");
});

test("submodule fingerprints cover parser sources and manifests without requiring Git metadata", async () => {
  // A Git-free fixture exercises the same source validation used by Docker's build context.
  const cache = fileURLToPath(new URL("../../.cache/", import.meta.url));
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(`${cache}upstream-source-`);
  try {
    await expect(nodestoneSourceHash(root)).rejects.toThrow("submodule update --init");
    await Bun.write(`${root}/vendor/nodestone/src/index.ts`, "export const parser = 1;\n");
    await Bun.write(`${root}/vendor/nodestone/package.json`, '{"name":"fixture","version":"1"}\n');
    const initial = await nodestoneSourceHash(root);
    expect(initial).toMatch(/^[0-9a-f]{64}$/);
    await Bun.write(`${root}/vendor/nodestone/README.md`, "Documentation only\n");
    expect(await nodestoneSourceHash(root)).toBe(initial);
    await Bun.write(`${root}/vendor/nodestone/src/index.ts`, "export const parser = 2;\n");
    const sourceChanged = await nodestoneSourceHash(root);
    expect(sourceChanged).not.toBe(initial);
    await Bun.write(`${root}/vendor/nodestone/package.json`, '{"name":"fixture","version":"2"}\n');
    expect(await nodestoneSourceHash(root)).not.toBe(sourceChanged);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
