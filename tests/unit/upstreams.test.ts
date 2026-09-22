/** Upstream tracking must notice selector-only changes and tolerate update-service outages. */
import { expect, test } from "bun:test";
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

test("Bun lockfile revision extraction is strict about Git identities", () => {
  expect(
    lockedRevisions({
      packages: {
        "nodestone-upstream": ["@xivapi/nodestone@github:xivapi/nodestone#abcdef0"],
        "lodestone-css-selectors": [
          "lodestone-css-selectors@github:xivapi/lodestone-css-selectors#123abcd",
        ],
      },
    }),
  ).toEqual({ "nodestone-upstream": "abcdef0", "lodestone-css-selectors": "123abcd" });
  expect(() => lockedRevisions({ packages: {} })).toThrow();
});
