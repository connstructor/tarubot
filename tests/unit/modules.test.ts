/** Behavior tests for the generic extension mechanism, independent of Discord credentials. */
import { expect, test } from "bun:test";
import { Client, Events, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "../../src/bot/command.js";
import type { BotContext } from "../../src/bot/context.js";
import { bindEvents, loadCommands, loadComponents, loadEvents } from "../../src/bot/discovery.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { ServiceKey, Services } from "../../src/bot/services.js";

/** Real EventEmitter behavior needs no login, sockets, or game-service mocks. */
function context(client: Client, services = new Services()): BotContext {
  return {
    client,
    services,
    allowsGuild: () => true,
    isStopping: () => false,
    resolveActor: async (guildId, userId) => ({
      guildId,
      userId,
      officer: false,
      manageRoles: false,
    }),
    report: () => {},
  };
}
const fixtures = new URL("../fixtures/modules/", import.meta.url);

test("new nested modules populate definitions and handlers without central registration", async () => {
  const loaded = await loadCommands(new URL("valid/", fixtures));
  expect([...loaded.keys()]).toEqual(["fixture-hello", "fixture-second"]);
  const hello = loaded.get("fixture-hello");
  expect(hello?.toJSON().name).toBe("fixture-hello");
  expect(typeof hello?.execute).toBe("function");
  expect(typeof hello?.autocomplete).toBe("function");
  expect(hello?.ephemeral).toBe(true);
  const copy = hello?.toJSON();
  if (copy) copy.name = "edited-copy";
  expect(hello?.name).toBe("fixture-hello");
  expect(hello?.toJSON().name).toBe("fixture-hello");
});

test("duplicate routes and malformed exports fail discovery with useful diagnostics", async () => {
  await expect(loadCommands(new URL("duplicates/", fixtures))).rejects.toThrow(
    "Duplicate command: duplicate",
  );
  await expect(loadCommands(new URL("invalid/", fixtures))).rejects.toThrow("broken.command.ts");
});

test("service dependencies are checked before a router can accept interactions", () => {
  const key = new ServiceKey(
    "positive number",
    (value): value is number => typeof value === "number" && value > 0,
  );
  const services = new Services();
  expect(() => services.provide(key, -1)).toThrow("Invalid provider");
  const module = defineCommand({
    data: new SlashCommandBuilder()
      .setName("requires-service")
      .setDescription("Dependency fixture"),
    requires: [key],
    execute: () => ({ content: "ready" }),
  });
  const client = new Client({ intents: [] });
  try {
    expect(
      () =>
        new InteractionRouter(
          context(client, services),
          new Map([[module.name, module]]),
          new Map(),
        ),
    ).toThrow("Missing or invalid service");
    services.provide(key, 1);
    expect(services.get(key)).toBe(1);
    expect(() => services.provide(key, 2)).toThrow("Duplicate service");
    expect(
      () =>
        new InteractionRouter(
          context(client, services),
          new Map([[module.name, module]]),
          new Map(),
        ),
    ).not.toThrow();
  } finally {
    void client.destroy();
  }
});

test("events support multiple subscribers, once semantics, failure containment and cleanup", async () => {
  const client = new Client({ intents: [] });
  const observations: { operation: string; message: string }[] = [];
  let stopping = false;
  const runtime = {
    ...context(client),
    isStopping: () => stopping,
    report: (error: unknown, operation: string) =>
      observations.push({ operation, message: error instanceof Error ? error.message : "unknown" }),
  };
  const loaded = await loadEvents(new URL("events/", fixtures));
  const cleanup = bindEvents(loaded, runtime);
  try {
    client.emit(Events.Debug, "one");
    client.emit(Events.Debug, "two");
    expect(observations.map((item) => item.message)).toEqual([
      "first:one",
      "once:one",
      "first:two",
    ]);
    client.emit(Events.Warn, "handler failed");
    await Bun.sleep(0);
    expect(observations.at(-1)).toEqual({
      operation: "event:fixture-failure",
      message: "handler failed",
    });
    stopping = true;
    client.emit(Events.Debug, "stopping");
    expect(observations).toHaveLength(4);
    cleanup();
    stopping = false;
    client.emit(Events.Debug, "removed");
    expect(observations).toHaveLength(4);
    expect(client.listenerCount(Events.Debug)).toBe(0);
  } finally {
    cleanup();
    await client.destroy();
  }
});

test("component discovery owns custom-ID namespaces independently", async () => {
  const components = await loadComponents(new URL("components/", fixtures));
  expect([...components.keys()]).toEqual(["fixture"]);
  expect(components.get("fixture")?.access).toBe("user");
});

test("removing the final module permits an empty feature directory after clean compilation", async () => {
  const missing = new URL("intentionally-absent/", fixtures);
  expect((await loadCommands(missing)).size).toBe(0);
  expect((await loadEvents(missing)).size).toBe(0);
  expect((await loadComponents(missing)).size).toBe(0);
});

test("compiled output discovers the same module inventory as source", async () => {
  const source = await loadCommands();
  // A subprocess imports compiled JS, avoiding mixed source/output class identities.
  // Its cold startup needs bounded headroom when image tests run under CPU emulation.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {loadCommands,loadEvents,loadComponents} from './dist/src/bot/discovery.js';console.log(JSON.stringify({commands:[...(await loadCommands()).keys()],events:(await loadEvents()).size,components:[...(await loadComponents()).keys()]}));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(errors).toBe("");
  expect(JSON.parse(output)).toEqual({
    commands: [...source.keys()],
    events: 15,
    components: ["guest"],
  });
}, 30000);
