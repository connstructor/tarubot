/**
 * Upstream tracking (2.20.0: the selector repository only, since the parser is TaruBot's own) must
 * notice a new HEAD and tolerate update-service outages.
 */
import { expect, test } from "bun:test";
import revisions from "../../src/infrastructure/lodestone/upstream-revisions.json" with {
  type: "json",
};
import {
  lockedRevisions,
  UpstreamMonitor,
  upstreams,
} from "../../src/infrastructure/lodestone/upstreams.js";

const deployed = {
  "lodestone-css-selectors": {
    repository: "xivapi/lodestone-css-selectors",
    revision: "b".repeat(40),
  },
};

test("only the selector repository is followed; a new HEAD without live activation is an update", async () => {
  expect(upstreams.map((upstream) => upstream.repository)).toEqual([
    "xivapi/lodestone-css-selectors",
  ]);
  const monitor = new UpstreamMonitor(deployed, async () => "c".repeat(40));
  await monitor.check();
  expect(monitor.status().status).toBe("update_available");
  expect(monitor.status().components.map((component) => component.current)).toEqual([false]);
  monitor.stop();
});

test("matching revisions are current and failed checks do not claim freshness", async () => {
  let unavailable = false;
  const monitor = new UpstreamMonitor(deployed, async () => {
    if (unavailable) throw new Error("Fixture outage");
    return "b".repeat(40);
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
    async () => selectorHead,
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
  expect(monitor.status().components[0]).toMatchObject({ deployed: selectorHead, current: true });
  accept = false;
  await monitor.check();
  expect(monitor.status().status).toBe("update_available");
  expect(monitor.status().components[0]).toMatchObject({
    deployed: "b".repeat(40),
    current: false,
  });
  monitor.stop();
});

test("bun.lock's selector commit is read from its Git resolution", () => {
  expect(
    lockedRevisions({
      packages: {
        "lodestone-css-selectors": [
          "lodestone-css-selectors@github:xivapi/lodestone-css-selectors#123abcd",
        ],
      },
    }),
  ).toEqual({ "lodestone-css-selectors": "123abcd" });
  expect(() => lockedRevisions({ packages: {} })).toThrow();
  expect(() =>
    lockedRevisions({ packages: { "lodestone-css-selectors": ["lodestone-css-selectors@1.0.0"] } }),
  ).toThrow("Missing Git revision");
});

test("the recorded bundled commit is the one bun.lock resolved (2.21.0: formerly a build step)", async () => {
  // A mismatch would mislabel the bundled set in /health/ready and issue reports.
  const locked = lockedRevisions(
    Bun.JSONC.parse(await Bun.file(new URL("../../bun.lock", import.meta.url)).text()),
  )["lodestone-css-selectors"];
  const recorded = revisions["lodestone-css-selectors"];
  expect(recorded.repository).toBe("xivapi/lodestone-css-selectors");
  expect(locked).toBeDefined();
  expect(recorded.revision.startsWith(locked ?? "-")).toBe(true);
});
