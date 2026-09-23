/**
 * Command-scope maintenance (scripts/commands.ts) and registration hardening (scripts/register.ts)
 * against an in-memory Discord REST fake that records every request, so each test can assert which
 * routes were read, which were written, and that refusals happen before any request.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { ApplicationCommandOptionType } from "discord.js";
import { loadCommands } from "../../src/bot/discovery.js";
import { deployments, type Launch } from "../../src/config/deployment.js";
import { commandPaths } from "../../src/discord/inspection.js";
import { Failure } from "../../src/domain/values.js";
import {
  type ClearResult,
  clearGuildCommands,
  type CommandRest,
  type DeclaredCommand,
  type InventoryReport,
  inspectInventory,
  parseArguments,
  type Registered,
  run,
  scopeFingerprint,
} from "../../scripts/commands.js";
import { registerCommands, registrationScope } from "../../scripts/register.js";

// Widened to string so helpers accept any application or guild, not only these literals.
const APP: string = deployments.production.applicationId;
const PRODUCTION_GUILD: string = deployments.production.guilds[0];
const DEVBOT_APP: string = deployments.devbot.applicationId;
const DEV_GUILD: string = deployments.devbot.guilds[0];
const OTHER_GUILD: string = "1111111111111111111";

interface Call {
  verb: "GET" | "PUT";
  route: string;
  body?: unknown;
}

/**
 * Routes map to GET responses. A PUT replaces the route's commands with the body (as Discord's bulk
 * overwrite does) unless `stickyPut` simulates a scope that did not clear. `forbidden` routes 403.
 */
class FakeRest implements CommandRest {
  readonly calls: Call[] = [];
  stickyPut = false;
  constructor(
    readonly routes: Record<string, unknown>,
    readonly forbidden: ReadonlySet<string> = new Set(),
  ) {}
  async get(route: `/${string}`): Promise<unknown> {
    this.calls.push({ verb: "GET", route });
    if (this.forbidden.has(route))
      throw Object.assign(new Error("Missing Access"), { status: 403 });
    if (!(route in this.routes)) throw new Error(`Unexpected GET ${route}`);
    return structuredClone(this.routes[route]);
  }
  async put(route: `/${string}`, options: { body: unknown[] }): Promise<unknown> {
    this.calls.push({ verb: "PUT", route, body: options.body });
    if (!this.stickyPut) this.routes[route] = options.body;
    return options.body;
  }
  get puts(): Call[] {
    return this.calls.filter((call) => call.verb === "PUT");
  }
}

const routes = {
  application: "/applications/@me",
  guilds: "/users/@me/guilds",
  global: (app = APP) => `/applications/${app}/commands`,
  guild: (guild: string, app = APP) => `/applications/${app}/guilds/${guild}/commands`,
};

let snowflake = 5_000_000_000_000_000n;
/** Unique Discord-style IDs for registered commands and their versions. */
const nextId = (): string => String(snowflake++);

/** Declared commands as Discord would return them after registration in one scope. */
function registered(commands: readonly DeclaredCommand[], app = APP, guild?: string): Registered[] {
  return commands.map((command) => ({
    id: nextId(),
    application_id: app,
    ...(guild ? { guild_id: guild } : {}),
    name: command.name,
    type: 1,
    version: nextId(),
    default_member_permissions: command.default_member_permissions ?? null,
    options: structuredClone(command.options ?? []) as Registered["options"],
  }));
}

/** Legacy nextcord commands: flat roots, some sharing names with the declared set. */
const legacyNames = ["config", "ledger", "ping", "channel", "assign", "claim", "refresh", "apply"];
const legacy = (app = APP, guild?: string) =>
  registered(
    legacyNames.map((name) => ({ name })),
    app,
    guild,
  );

let declared: DeclaredCommand[] = [];
beforeAll(async () => {
  declared = [...(await loadCommands()).values()].map((command) => command.toJSON());
});

/** A production application in the production and dev guilds, globally registered as declared. */
function productionRest(overrides: Record<string, unknown> = {}): FakeRest {
  return new FakeRest({
    [routes.application]: { id: APP, name: "TaruBot", flags: 1 << 14 },
    [routes.guilds]: [
      { id: PRODUCTION_GUILD, name: "Production" },
      { id: DEV_GUILD, name: "TaruBot Development" },
    ],
    [routes.global()]: registered(declared),
    [routes.guild(PRODUCTION_GUILD)]: [],
    [routes.guild(DEV_GUILD)]: [],
    ...overrides,
  });
}

/** Expect a Failure with a message fragment. */
async function rejects(action: Promise<unknown>, fragment: string): Promise<void> {
  const error = await action.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Failure);
  expect(error instanceof Error ? error.message : "").toContain(fragment);
}

describe("arguments", () => {
  test("list and clear-guild parse strictly", () => {
    expect(parseArguments(["list"])).toEqual({
      kind: "list",
      guilds: "joined",
      declaredScope: null,
    });
    expect(
      parseArguments(["list", "--guild", DEV_GUILD, "--guild", OTHER_GUILD, "--guild", DEV_GUILD]),
    ).toEqual({ kind: "list", guilds: [DEV_GUILD, OTHER_GUILD], declaredScope: null });
    expect(parseArguments(["list", "--declared-scope", "global"])).toMatchObject({
      declaredScope: "global",
    });
    expect(parseArguments(["list", "--declared-scope", DEV_GUILD])).toMatchObject({
      declaredScope: DEV_GUILD,
    });
    expect(parseArguments(["clear-guild", DEV_GUILD, "--application", APP])).toEqual({
      kind: "clear-guild",
      guild: DEV_GUILD,
      application: APP,
      confirm: null,
    });
    expect(
      parseArguments([
        "clear-guild",
        DEV_GUILD,
        "--confirm",
        "0123456789abcdef",
        "--application",
        APP,
      ]),
    ).toMatchObject({ confirm: "0123456789abcdef" });
    for (const argv of [
      [],
      ["remove"],
      ["list", "--guild"],
      ["list", "--guild", "--declared-scope"],
      ["list", "--guild", "12ab"],
      ["list", "--declared-scope", "everywhere"],
      ["list", "--declared-scope", "global", "--declared-scope", "global"],
      ["list", "--confirm", "0123456789abcdef"],
      ["list", "clear-guild"],
      ["clear-guild"],
      ["clear-guild", DEV_GUILD],
      ["clear-guild", DEV_GUILD, "--application"],
      ["clear-guild", DEV_GUILD, "--application", "abc"],
      ["clear-guild", DEV_GUILD, "--application", APP, "--confirm", "XYZ"],
      ["clear-guild", DEV_GUILD, "--application", APP, "--global"],
      ["clear-guild", "--application", APP],
    ])
      expect(() => parseArguments(argv)).toThrow(Failure);
  });
});

describe("inventory", () => {
  test("commandPaths flattens discovered commands exactly like the inventory test", () => {
    // The independent flattening from commands.test.ts, over the same discovery.
    const inventory: string[] = [];
    interface Option {
      type: number;
      name: string;
      options?: readonly Option[] | undefined;
    }
    const visit = (prefix: string, options: readonly Option[]): void => {
      const nested = options.filter(
        (option) =>
          option.type === ApplicationCommandOptionType.Subcommand ||
          option.type === ApplicationCommandOptionType.SubcommandGroup,
      );
      if (!nested.length) inventory.push(prefix);
      for (const option of nested) visit(`${prefix} ${option.name}`, option.options ?? []);
    };
    for (const command of declared) visit(command.name, command.options ?? []);
    const paths = declared.flatMap((command) => commandPaths(command.name, command.options));
    expect(paths.sort()).toEqual(inventory.sort());
    expect(paths).toContain("config role_layout");
    expect(paths).toContain("guest grant");
  });

  test("scope fingerprints ignore order and change with any id or version", () => {
    const first = { id: "1", name: "a", version: "10" };
    const second = { id: "2", name: "b", version: "20" };
    const fingerprint = scopeFingerprint([first, second]);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(scopeFingerprint([second, first])).toBe(fingerprint);
    expect(scopeFingerprint([first, { ...second, version: "21" }])).not.toBe(fingerprint);
    expect(scopeFingerprint([{ ...first, id: "3" }, second])).not.toBe(fingerprint);
    expect(scopeFingerprint([first])).not.toBe(fingerprint);
  });

  test("a clean production inventory: declared globally, every guild scope empty", async () => {
    const rest = productionRest();
    const report = await inspectInventory(rest, APP, declared, {
      guilds: "joined",
      declaredScope: "global",
    });
    expect(report.clean).toBe(true);
    expect(report.membersIntent).toBe(true);
    expect(report.guilds.map((guild) => guild.id)).toEqual([PRODUCTION_GUILD, DEV_GUILD]);
    expect(report.scopes.map((scope) => [scope.scope, scope.expected, scope.count])).toEqual([
      ["global", "declared", declared.length],
      [`guild:${PRODUCTION_GUILD}`, "empty", 0],
      [`guild:${DEV_GUILD}`, "empty", 0],
    ]);
    for (const scope of report.scopes) {
      expect(scope.missing).toEqual([]);
      expect(scope.unexpected).toEqual([]);
      expect(scope.permissionMismatches).toEqual([]);
    }
    // Read-only: identity, guild list, then one GET per scope.
    expect(rest.calls.map((call) => `${call.verb} ${call.route}`)).toEqual([
      `GET ${routes.application}`,
      `GET ${routes.guilds}`,
      `GET ${routes.global()}`,
      `GET ${routes.guild(PRODUCTION_GUILD)}`,
      `GET ${routes.guild(DEV_GUILD)}`,
    ]);
    // Limited (unverified-app) intent also counts.
    const limited = productionRest({
      [routes.application]: { id: APP, name: "T", flags: 1 << 15 },
    });
    expect(
      (
        await inspectInventory(limited, APP, declared, {
          guilds: "joined",
          declaredScope: "global",
        })
      ).membersIntent,
    ).toBe(true);
    const none = productionRest({ [routes.application]: { id: APP, name: "T", flags: 0 } });
    expect(
      (await inspectInventory(none, APP, declared, { guilds: "joined", declaredScope: "global" }))
        .membersIntent,
    ).toBe(false);
  });

  test("legacy global commands and guild-scoped copies make the inventory unclean", async () => {
    const rest = productionRest({
      [routes.global()]: legacy(),
      [routes.guild(PRODUCTION_GUILD)]: legacy(APP, PRODUCTION_GUILD),
    });
    const report = await inspectInventory(rest, APP, declared, {
      guilds: "joined",
      declaredScope: "global",
    });
    expect(report.clean).toBe(false);
    const [global, production, dev] = report.scopes;
    expect(global?.missing).toContain("config fc link");
    expect(global?.unexpected).toEqual(["config", "ledger"]);
    expect(production?.unexpected).toEqual([...legacyNames].sort());
    expect(production?.shadowsGlobal).toEqual([...legacyNames].sort());
    expect(production?.fingerprint).toBe(scopeFingerprint(production?.commands ?? []));
    expect(dev?.unexpected).toEqual([]);
    expect(rest.puts).toEqual([]);
  });

  test("changed default permissions are reported as mismatches", async () => {
    const drifted = registered(declared).map((command) =>
      command.name === "ping" ? { ...command, default_member_permissions: "8" } : command,
    );
    const report = await inspectInventory(
      productionRest({ [routes.global()]: drifted }),
      APP,
      declared,
      { guilds: "joined", declaredScope: "global" },
    );
    expect(report.clean).toBe(false);
    expect(report.scopes[0]?.permissionMismatches).toEqual(["ping"]);
  });

  test("an application mismatch stops after the single identity read", async () => {
    const rest = productionRest({ [routes.application]: { id: DEVBOT_APP, name: "DevBot" } });
    await rejects(
      inspectInventory(rest, APP, declared, { guilds: "joined", declaredScope: "global" }),
      `not DISCORD_APPLICATION_ID ${APP}`,
    );
    expect(rest.calls).toEqual([{ verb: "GET", route: routes.application }]);
  });

  test("a full 200-guild page is refused in favor of explicit --guild", async () => {
    const page = Array.from({ length: 200 }, (_, index) => ({
      id: String(2_000_000_000_000_000n + BigInt(index)),
      name: `guild ${index}`,
    }));
    const rest = productionRest({ [routes.guilds]: page });
    await rejects(
      inspectInventory(rest, APP, declared, { guilds: "joined", declaredScope: "global" }),
      "pass --guild",
    );
    expect(rest.calls.map((call) => call.route)).toEqual([routes.application, routes.guilds]);
  });

  test("explicit guilds, a guild declared scope, and unreadable scopes", async () => {
    // DevBot shape: declared in its guild, nothing global; the declared guild is always read.
    const rest = new FakeRest(
      {
        [routes.application]: { id: DEVBOT_APP, name: "DevBot" },
        [routes.global(DEVBOT_APP)]: [],
        [routes.guild(DEV_GUILD, DEVBOT_APP)]: registered(declared, DEVBOT_APP, DEV_GUILD),
      },
      new Set([routes.guild(OTHER_GUILD, DEVBOT_APP)]),
    );
    const report = await inspectInventory(rest, DEVBOT_APP, declared, {
      guilds: [OTHER_GUILD],
      declaredScope: DEV_GUILD,
    });
    expect(rest.calls.map((call) => call.route)).not.toContain(routes.guilds);
    expect(report.scopes.map((scope) => [scope.scope, scope.expected, scope.status])).toEqual([
      ["global", "empty", "read"],
      [`guild:${OTHER_GUILD}`, "empty", "unavailable"],
      [`guild:${DEV_GUILD}`, "declared", "read"],
    ]);
    // An unreadable scope cannot be proven empty.
    expect(report.clean).toBe(false);
  });
});

describe("clear-guild", () => {
  const mode = (confirm: string | null = null, guild = PRODUCTION_GUILD, application = APP) => ({
    guild,
    application,
    confirm,
  });
  const withLeftovers = () =>
    productionRest({ [routes.guild(PRODUCTION_GUILD)]: legacy(APP, PRODUCTION_GUILD) });

  test("a dry run lists the commands and their fingerprint and writes nothing", async () => {
    const rest = withLeftovers();
    const result = await clearGuildCommands(rest, APP, mode());
    expect(result.status).toBe("dry_run");
    if (result.status !== "dry_run") return;
    expect(result.commands.map((command) => command.name)).toEqual(legacyNames);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(result.confirm).toBe(
      `clear-guild ${PRODUCTION_GUILD} --application ${APP} --confirm ${result.fingerprint}`,
    );
    expect(rest.puts).toEqual([]);
  });

  test("a confirmed clear makes exactly one PUT of [] to that guild scope and re-reads it", async () => {
    const rest = withLeftovers();
    const dry = await clearGuildCommands(rest, APP, mode());
    if (dry.status !== "dry_run") throw new Error("Expected a dry run");
    rest.calls.length = 0;
    const result = await clearGuildCommands(rest, APP, mode(dry.fingerprint));
    expect(result).toEqual({
      status: "cleared",
      guild: PRODUCTION_GUILD,
      removed: legacyNames.length,
      fingerprint: dry.fingerprint,
    } satisfies ClearResult);
    expect(rest.calls.map((call) => `${call.verb} ${call.route}`)).toEqual([
      `GET ${routes.application}`,
      `GET ${routes.guilds}`,
      `GET ${routes.guild(PRODUCTION_GUILD)}`,
      `PUT ${routes.guild(PRODUCTION_GUILD)}`,
      `GET ${routes.guild(PRODUCTION_GUILD)}`,
    ]);
    expect(rest.puts).toEqual([{ verb: "PUT", route: routes.guild(PRODUCTION_GUILD), body: [] }]);
    // The global scope is never touched.
    expect(rest.calls.map((call) => call.route)).not.toContain(routes.global());
  });

  test("a stale confirmation is refused without writing", async () => {
    const rest = withLeftovers();
    const dry = await clearGuildCommands(rest, APP, mode());
    if (dry.status !== "dry_run") throw new Error("Expected a dry run");
    // Someone edited one command after the review: Discord bumps its version.
    const scope = rest.routes[routes.guild(PRODUCTION_GUILD)] as Registered[];
    const [first] = scope;
    if (first) first.version = nextId();
    await rejects(clearGuildCommands(rest, APP, mode(dry.fingerprint)), "changed since review");
    expect(rest.puts).toEqual([]);
  });

  test("a scope that is still populated after the PUT is an error", async () => {
    const rest = withLeftovers();
    const dry = await clearGuildCommands(rest, APP, mode());
    if (dry.status !== "dry_run") throw new Error("Expected a dry run");
    rest.stickyPut = true;
    await rejects(clearGuildCommands(rest, APP, mode(dry.fingerprint)), "still has");
    expect(rest.puts).toHaveLength(1);
  });

  test("an empty scope is already clean, even with a confirmation", async () => {
    const rest = productionRest();
    expect(await clearGuildCommands(rest, APP, mode("0123456789abcdef"))).toEqual({
      status: "already_empty",
      guild: PRODUCTION_GUILD,
    });
    expect(rest.puts).toEqual([]);
  });

  test("application mismatches are refused before any guild read", async () => {
    const argument = withLeftovers();
    await rejects(
      clearGuildCommands(argument, APP, mode(null, PRODUCTION_GUILD, DEVBOT_APP)),
      "--application",
    );
    expect(argument.calls).toEqual([]);
    const token = withLeftovers();
    token.routes[routes.application] = { id: DEVBOT_APP, name: "DevBot" };
    await rejects(clearGuildCommands(token, APP, mode()), "token belongs to application");
    expect(token.calls).toEqual([{ verb: "GET", route: routes.application }]);
  });

  test("only guilds the application belongs to can be cleared", async () => {
    const rest = productionRest({ [routes.guild(OTHER_GUILD)]: legacy(APP, OTHER_GUILD) });
    await rejects(clearGuildCommands(rest, APP, mode(null, OTHER_GUILD)), "not in guild");
    expect(rest.calls.map((call) => call.route)).toEqual([routes.application, routes.guilds]);
  });
});

describe("deployment guard wiring (C7)", () => {
  /** Launched as the runbook says, from a checkout that has a development .env. */
  const direct: Launch = {
    execArgv: ["--env-file=/home/operator/production.env"],
    envFiles: [".env"],
  };
  const productionEnv = {
    TARUBOT_ENVIRONMENT: "production",
    DISCORD_TOKEN: "sentinel-token",
    DISCORD_APPLICATION_ID: APP,
    TEST_GUILD_ID: "",
    PUBLIC_TEST_RESPONSES: "false",
  };
  const devbotEnv = {
    DISCORD_TOKEN: "sentinel-token",
    DISCORD_APPLICATION_ID: DEVBOT_APP,
    TEST_GUILD_ID: DEV_GUILD,
  };
  /** A REST factory that records whether the tool got as far as creating a client. */
  const factory = (rest: FakeRest) => {
    const opened: string[] = [];
    return {
      opened,
      connect: (token: string) => {
        opened.push(token);
        return rest;
      },
    };
  };

  test("list reads under the production profile and defaults to its global declaration", async () => {
    const rest = productionRest();
    const { connect, opened } = factory(rest);
    const outcome = await run(["list"], productionEnv, connect, direct);
    expect(outcome.deployment.name).toBe("production");
    expect(outcome.exitCode).toBe(0);
    expect((outcome.result as InventoryReport).declaredScope).toBe("global");
    expect(opened).toEqual(["sentinel-token"]);
    expect(rest.puts).toEqual([]);
  });

  test("list under DevBot declares its guild scope and exits 2 on leftovers", async () => {
    const rest = new FakeRest({
      [routes.application]: { id: DEVBOT_APP, name: "DevBot" },
      [routes.guilds]: [{ id: DEV_GUILD, name: "TaruBot Development" }],
      [routes.global(DEVBOT_APP)]: legacy(DEVBOT_APP),
      [routes.guild(DEV_GUILD, DEVBOT_APP)]: registered(declared, DEVBOT_APP, DEV_GUILD),
    });
    const outcome = await run(["list"], devbotEnv, factory(rest).connect, direct);
    const report = outcome.result as InventoryReport;
    expect(report.declaredScope).toBe(DEV_GUILD);
    expect(report.scopes.find((scope) => scope.scope === `guild:${DEV_GUILD}`)?.expected).toBe(
      "declared",
    );
    expect(outcome.exitCode).toBe(2);
  });

  test("production may clear leftovers in DevBot's guild, where its app is installed", async () => {
    const rest = productionRest({ [routes.guild(DEV_GUILD)]: legacy(APP, DEV_GUILD) });
    const { connect } = factory(rest);
    const dry = await run(
      ["clear-guild", DEV_GUILD, "--application", APP],
      productionEnv,
      connect,
      direct,
    );
    const result = dry.result as ClearResult;
    if (result.status !== "dry_run") throw new Error("Expected a dry run");
    const done = await run(
      ["clear-guild", DEV_GUILD, "--application", APP, "--confirm", result.fingerprint],
      productionEnv,
      connect,
      direct,
    );
    expect(done.result).toMatchObject({ status: "cleared", removed: legacyNames.length });
    expect(rest.puts.map((call) => call.route)).toEqual([routes.guild(DEV_GUILD)]);
  });

  test("refusals happen before any REST client exists", async () => {
    const cases: [string[], Record<string, string>, Launch, string][] = [
      // DevBot's own registration scope is replaced by register.js, never cleared.
      [["clear-guild", DEV_GUILD, "--application", DEVBOT_APP], devbotEnv, direct, "own command"],
      // A rehearsal never writes to Discord.
      [
        ["clear-guild", DEV_GUILD, "--application", APP],
        { ...productionEnv, TARUBOT_ENVIRONMENT: "rehearsal" },
        direct,
        "read-only",
      ],
      // The production file must be passed with --env-file when a checkout .env exists.
      [["list"], productionEnv, { execArgv: [], envFiles: [".env"] }, ".env"],
      // Production credentials need the explicit marker.
      [["list"], { ...productionEnv, TARUBOT_ENVIRONMENT: "" }, direct, "TARUBOT_ENVIRONMENT"],
    ];
    for (const [argv, env, launch, fragment] of cases) {
      const rest = productionRest();
      const { connect, opened } = factory(rest);
      await rejects(run(argv, env, connect, launch), fragment);
      expect(opened).toEqual([]);
      expect(rest.calls).toEqual([]);
    }
  });
});

describe("register", () => {
  test("registration scope is exactly one of --guild or --global", () => {
    expect(registrationScope(["--guild", DEV_GUILD], { TEST_GUILD_ID: DEV_GUILD })).toEqual({
      kind: "guild",
      guild: DEV_GUILD,
    });
    expect(registrationScope(["--global"], { TEST_GUILD_ID: "" })).toEqual({ kind: "global" });
    expect(registrationScope(["--global"], {})).toEqual({ kind: "global" });
    for (const argv of [
      [],
      ["--guild", DEV_GUILD, "--global"],
      ["--guild"],
      ["--guild", "abc"],
      ["--global", "--global"],
      ["--global", "--clear"],
    ])
      expect(() => registrationScope(argv, {})).toThrow(Failure);
    // A development env can never replace an application's global set.
    expect(() => registrationScope(["--global"], { TEST_GUILD_ID: DEV_GUILD })).toThrow(
      "TEST_GUILD_ID",
    );
  });

  test("the token's application is confirmed before the single bulk PUT", async () => {
    const rest = productionRest();
    const result = await registerCommands(rest, APP, { kind: "global" }, declared);
    expect(result).toEqual({
      application: APP,
      scope: "global",
      roots: declared.length,
      paths: declared.flatMap((command) => commandPaths(command.name, command.options)).length,
    });
    expect(rest.calls.map((call) => `${call.verb} ${call.route}`)).toEqual([
      `GET ${routes.application}`,
      `PUT ${routes.global()}`,
    ]);
    const guild = productionRest();
    await registerCommands(guild, APP, { kind: "guild", guild: PRODUCTION_GUILD }, declared);
    expect(guild.puts.map((call) => call.route)).toEqual([routes.guild(PRODUCTION_GUILD)]);

    const mismatch = productionRest({ [routes.application]: { id: DEVBOT_APP, name: "DevBot" } });
    await rejects(
      registerCommands(mismatch, APP, { kind: "global" }, declared),
      "token belongs to application",
    );
    expect(mismatch.puts).toEqual([]);
  });
});
