/**
 * The maintenance-tool deployment guard: profile inference, identity and test-scope rules, guild
 * ownership, database endpoints per profile, the env-file launch check, and the tracked production
 * env template. Every refusal is checked to be a configuration Failure that never echoes a secret.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  assertAuthenticatedApplication,
  assertToolScope,
  AUTOLOADED_ENV_FILES,
  databaseIdentity,
  deployments,
  type Environment,
  type Launch,
  localDatabaseHost,
  resolveDeployment,
  restoreCertificate,
  type ToolScope,
} from "../../src/config/deployment.js";
import { Failure } from "../../src/domain/values.js";
import { SCHEMA_VERSION } from "../../src/infrastructure/postgres/database.js";
import { activateToolScope, parseActivateArguments } from "../../scripts/activate.js";
import { restoreArguments, restoreToolScope } from "../../scripts/check-restore.js";
import { migrateArguments, migrateToolScope } from "../../scripts/migrate.js";
import { parsePreviewArguments, previewToolScope } from "../../scripts/preview.js";
import { registerToolScope, registrationScope } from "../../scripts/register.js";

const PRODUCTION_APP = deployments.production.applicationId;
const PRODUCTION_GUILD = deployments.production.guilds[0];
const DEVBOT_APP = deployments.devbot.applicationId;
const DEV_GUILD = deployments.devbot.guilds[0];
/** Sentinels stand in for credentials; no refusal may contain them. */
const PASSWORD = "sentinel-password-5b0f";
const TOKEN = "sentinel-token-9c1e";
const CA = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
const MANAGED = "db-postgresql-nyc3-00000-do-user-0-0.k.db.ondigitalocean.com";
const FORK = "db-postgresql-nyc3-11111-do-user-0-0.k.db.ondigitalocean.com";
const managedUrl = (name: string, host = MANAGED, user = "tarubot", port = 25060) =>
  `postgresql://${user}:${PASSWORD}@${host}:${port}/${name}?sslmode=require`;
const localUrl = (name: string, host = "localhost") =>
  `postgresql://tarubot:${PASSWORD}@${host}:5432/${name}`;

/** The shape of DevBot's local .env once its DATABASE_URL names tarubot_dev. */
const devbotEnv = (overrides: Environment = {}): Environment => ({
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: DEVBOT_APP,
  TEST_GUILD_ID: DEV_GUILD,
  PUBLIC_TEST_RESPONSES: "true",
  DATABASE_URL: localUrl("tarubot_dev"),
  DATABASE_CA_CERT: "",
  ...overrides,
});
/** A filled-in production.env. */
const productionEnv = (overrides: Environment = {}): Environment => ({
  TARUBOT_ENVIRONMENT: "production",
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: PRODUCTION_APP,
  TEST_GUILD_ID: "",
  PUBLIC_TEST_RESPONSES: "false",
  TEST_PLAN_CHANNEL_ID: "",
  DATABASE_URL: managedUrl("tarubot"),
  DATABASE_CA_CERT: CA,
  ...overrides,
});
/** The production file with the rehearsal overrides given on the command line. */
const rehearsalEnv = (overrides: Environment = {}): Environment =>
  productionEnv({
    TARUBOT_ENVIRONMENT: "rehearsal",
    DATABASE_URL: localUrl("tarubot_rehearsal"),
    DATABASE_CA_CERT: "",
    ...overrides,
  });

/** Launched as the runbook says: bun --env-file=PATH dist/scripts/<tool>.js, from a checkout. */
const direct: Launch = {
  execArgv: ["--env-file=/home/operator/production.env"],
  envFiles: [".env"],
};

/**
 * Each tool's scope exactly as the script declares it: its exported builder over its real argument
 * parser, so a drifting declaration (a dropped registerScope, a wrong Discord level, a missing
 * database) fails these tests. import.js runs its guard at top level and cannot be imported, so its
 * scope is the one copy kept by hand.
 */
const scope = {
  preview: (guild: string): ToolScope => previewToolScope(parsePreviewArguments([guild])),
  /** preview.js --late-joiners reads only PostgreSQL. */
  lateJoiners: (guild: string): ToolScope =>
    previewToolScope(parsePreviewArguments([guild, "--late-joiners"])),
  activate: (guild: string): ToolScope => activateToolScope(parseActivateArguments([guild])),
  import: (guild: string): ToolScope => ({
    tool: "import",
    guilds: [guild],
    discord: "none",
    databases: ["DATABASE_URL"],
  }),
  migrate: migrateToolScope(migrateArguments([])),
  /** migrate.js --restore-rehearsal. */
  rehearseMigration: migrateToolScope(migrateArguments(["--restore-rehearsal"])),
  /** register.js --guild GUILD or, without a guild, --global. */
  register: (guild?: string): ToolScope =>
    registerToolScope(registrationScope(guild ? ["--guild", guild] : ["--global"], {})),
  restore: restoreToolScope(),
} satisfies Record<string, ToolScope | ((guild: string) => ToolScope)>;

/** Assert a configuration refusal whose message contains `fragment` and no credential. */
function refused(action: () => unknown, fragment: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Failure);
  if (!(caught instanceof Failure)) return;
  expect(caught.code).toBe("configuration");
  expect(caught.message).toContain(fragment);
  expect(caught.message).not.toContain(PASSWORD);
  expect(caught.message).not.toContain(TOKEN);
  expect(caught.message).not.toContain("postgresql://");
}

describe("profiles", () => {
  test("(a) a DevBot .env infers devbot and may preview the dev guild", () => {
    expect(resolveDeployment(devbotEnv()).name).toBe("devbot");
    const deployment = assertToolScope(devbotEnv(), scope.preview(DEV_GUILD), direct);
    expect(deployment).toMatchObject({
      name: "devbot",
      applicationId: DEVBOT_APP,
      registrationScope: DEV_GUILD,
    });
  });

  test("(b) the DevBot .env cannot touch the production guild", () => {
    for (const tool of [
      scope.preview(PRODUCTION_GUILD),
      scope.lateJoiners(PRODUCTION_GUILD),
      scope.activate(PRODUCTION_GUILD),
      scope.import(PRODUCTION_GUILD),
    ])
      refused(() => assertToolScope(devbotEnv(), tool, direct), `guild ${PRODUCTION_GUILD}`);
  });

  test("(c) production credentials need an explicit marker", () => {
    const env = productionEnv({ TARUBOT_ENVIRONMENT: "" });
    refused(() => resolveDeployment(env), "TARUBOT_ENVIRONMENT=production or rehearsal");
    refused(() => assertToolScope(env, scope.migrate, direct), "TARUBOT_ENVIRONMENT");
    refused(
      () => resolveDeployment({ ...env, TARUBOT_ENVIRONMENT: "staging" }),
      "TARUBOT_ENVIRONMENT",
    );
  });

  test("(d) production refuses leaked development scoping", () => {
    for (const [key, value] of [
      ["TEST_GUILD_ID", DEV_GUILD],
      ["PUBLIC_TEST_RESPONSES", "true"],
      ["TEST_PLAN_CHANNEL_ID", "1040379370931507252"],
    ] as const)
      refused(() => assertToolScope(productionEnv({ [key]: value }), scope.migrate, direct), key);
    expect(assertToolScope(productionEnv(), scope.migrate, direct).name).toBe("production");
  });

  test("(f) crossed applications and guilds are refused in both directions", () => {
    refused(
      () =>
        assertToolScope(
          productionEnv({ DISCORD_APPLICATION_ID: DEVBOT_APP }),
          scope.migrate,
          direct,
        ),
      `production application ${PRODUCTION_APP}`,
    );
    refused(
      () => assertToolScope(productionEnv(), scope.preview(DEV_GUILD), direct),
      `guild ${DEV_GUILD}`,
    );
    refused(
      () =>
        assertToolScope(
          devbotEnv({ TARUBOT_ENVIRONMENT: "devbot", DISCORD_APPLICATION_ID: PRODUCTION_APP }),
          scope.preview(DEV_GUILD),
          direct,
        ),
      `DevBot's application ${DEVBOT_APP}`,
    );
    // Discord use under the production profile needs the application ID to be configured.
    refused(
      () =>
        assertToolScope(
          productionEnv({ DISCORD_APPLICATION_ID: "" }),
          scope.preview(PRODUCTION_GUILD),
          direct,
        ),
      "DISCORD_APPLICATION_ID",
    );
    refused(
      () => assertToolScope(devbotEnv({ TEST_GUILD_ID: "" }), scope.migrate, direct),
      "TEST_GUILD_ID",
    );
  });

  test("(j) unmanaged environments (CI, other developers) may not touch a known guild", () => {
    const env: Environment = {
      DISCORD_APPLICATION_ID: "123",
      DATABASE_URL: localUrl("tarubot"),
    };
    expect(resolveDeployment(env).name).toBe("unmanaged");
    for (const guild of [PRODUCTION_GUILD, DEV_GUILD])
      refused(() => assertToolScope(env, scope.preview(guild), direct), "managed deployment");
    expect(assertToolScope(env, scope.preview("4242"), direct).name).toBe("unmanaged");
    // A DB-only environment (no marker, no application ID) is unmanaged even against a managed URL.
    // The App Platform pre-deploy job sets TARUBOT_ENVIRONMENT=production; app-platform.test.ts
    // covers that job's production profile.
    expect(
      assertToolScope({ DATABASE_URL: managedUrl("tarubot") }, scope.migrate, {
        execArgv: [],
        envFiles: [],
      }).name,
    ).toBe("unmanaged");
  });

  test("(k) DevBot never registers global commands", () => {
    refused(
      () => assertToolScope(devbotEnv(), scope.register(), direct),
      "global command registration",
    );
    expect(assertToolScope(devbotEnv(), scope.register(DEV_GUILD), direct).name).toBe("devbot");
  });

  test("(o) production registers only globally; unmanaged may register any unmanaged scope", () => {
    // A production guild-scope registration would show every command twice beside the global set.
    refused(
      () => assertToolScope(productionEnv(), scope.register(PRODUCTION_GUILD), direct),
      "only in the global scope (--global)",
    );
    expect(assertToolScope(productionEnv(), scope.register(), direct).name).toBe("production");
    const unmanaged: Environment = { DISCORD_APPLICATION_ID: "123" };
    expect(assertToolScope(unmanaged, scope.register("4242"), direct).name).toBe("unmanaged");
    expect(assertToolScope(unmanaged, scope.register(), direct).name).toBe("unmanaged");
  });
});

describe("databases", () => {
  test("(e) production uses the managed cluster over verified TLS", () => {
    expect(assertToolScope(productionEnv(), scope.import(PRODUCTION_GUILD), direct).name).toBe(
      "production",
    );
    for (const [url, fragment] of [
      [localUrl("tarubot"), "is local"],
      [localUrl("tarubot", "127.0.0.1"), "is local"],
      [localUrl("tarubot", "postgres"), "is local"],
      [managedUrl("tarubot_dev"), "not a production database"],
      [managedUrl("tarubot_restore_test"), "not a production database"],
      [managedUrl("tarubot_rehearsal"), "not a production database"],
    ] as const)
      refused(
        () =>
          assertToolScope(
            productionEnv({ DATABASE_URL: url }),
            scope.import(PRODUCTION_GUILD),
            direct,
          ),
        fragment,
      );
    refused(
      () => assertToolScope(productionEnv({ DATABASE_CA_CERT: "" }), scope.migrate, direct),
      "DATABASE_CA_CERT",
    );
    refused(
      () => assertToolScope(productionEnv({ DATABASE_CA_CERT: "  " }), scope.migrate, direct),
      "DATABASE_CA_CERT",
    );
  });

  test("(C6b) managed endpoints need the direct port and the tarubot application user", () => {
    // Production runs on Linode managed PostgreSQL (direct port 27520) since 2026-09-24.
    expect(
      assertToolScope(
        productionEnv({ DATABASE_URL: managedUrl("tarubot", MANAGED, "tarubot", 27520) }),
        scope.migrate,
        direct,
      ).name,
    ).toBe("production");
    for (const [url, fragment] of [
      [managedUrl("tarubot", MANAGED, "tarubot", 25061), "direct port (27520 or 25060)"],
      [`postgresql://tarubot:${PASSWORD}@${MANAGED}/tarubot`, "direct port (27520 or 25060)"],
      [managedUrl("tarubot", MANAGED, "doadmin"), "not an administrator"],
      // Linode's administrator login and its connection-pool port are refused the same way.
      [managedUrl("tarubot", MANAGED, "akmadmin"), "not an administrator"],
      [managedUrl("tarubot", MANAGED, "tarubot", 27521), "direct port (27520 or 25060)"],
      [managedUrl("tarubot", MANAGED, "someone"), "tarubot user"],
      [`postgresql://${MANAGED}:25060/tarubot`, "not an administrator"],
    ] as const)
      refused(
        () => assertToolScope(productionEnv({ DATABASE_URL: url }), scope.migrate, direct),
        fragment,
      );
    // A rehearsal on the managed cluster: any application user, never doadmin, direct port.
    expect(
      assertToolScope(
        rehearsalEnv({
          DATABASE_URL: managedUrl("tarubot_rehearsal", MANAGED, "rehearser"),
          DATABASE_CA_CERT: CA,
        }),
        scope.migrate,
        direct,
      ).name,
    ).toBe("rehearsal");
    refused(
      () =>
        assertToolScope(
          rehearsalEnv({
            DATABASE_URL: managedUrl("tarubot_rehearsal", MANAGED, "doadmin"),
            DATABASE_CA_CERT: CA,
          }),
          scope.migrate,
          direct,
        ),
      "not an administrator",
    );
  });

  test("(g) a rehearsal uses a disposable *_rehearsal database and is read-only on Discord", () => {
    // Preview, the late-joiner report and activation only read Discord, so a rehearsal may run them.
    for (const tool of [
      scope.preview(PRODUCTION_GUILD),
      scope.lateJoiners(PRODUCTION_GUILD),
      scope.activate(PRODUCTION_GUILD),
    ])
      expect(assertToolScope(rehearsalEnv(), tool, direct).name).toBe("rehearsal");
    expect(
      assertToolScope(
        rehearsalEnv({ DATABASE_URL: managedUrl("tarubot_rehearsal"), DATABASE_CA_CERT: CA }),
        scope.preview(PRODUCTION_GUILD),
        direct,
      ).name,
    ).toBe("rehearsal");
    for (const [overrides, fragment] of [
      [{ DATABASE_URL: localUrl("tarubot_dev") }, "*_rehearsal"],
      [{ DATABASE_URL: managedUrl("tarubot"), DATABASE_CA_CERT: CA }, "*_rehearsal"],
      [{ DATABASE_URL: managedUrl("tarubot_rehearsal") }, "CA certificate"],
    ] as const)
      refused(
        () => assertToolScope(rehearsalEnv(overrides), scope.preview(PRODUCTION_GUILD), direct),
        fragment,
      );
    refused(
      () => assertToolScope(rehearsalEnv(), scope.register(), direct),
      "global command registration",
    );
    refused(
      () => assertToolScope(rehearsalEnv(), scope.register(PRODUCTION_GUILD), direct),
      "read-only on Discord",
    );
  });

  test("(C5) DevBot's tools use exactly tarubot_dev on this machine or the Compose service", () => {
    // The owner's current .env shape (…/tarubot) is refused until it names tarubot_dev.
    refused(
      () =>
        assertToolScope(devbotEnv({ DATABASE_URL: localUrl("tarubot") }), scope.migrate, direct),
      "tarubot_dev",
    );
    expect(assertToolScope(devbotEnv(), scope.migrate, direct).name).toBe("devbot");
    // docker-compose.devbot.yml's container environment.
    expect(
      assertToolScope(
        devbotEnv({ DATABASE_URL: localUrl("tarubot_dev", "postgres") }),
        scope.migrate,
        direct,
      ).name,
    ).toBe("devbot");
    // The base Compose file (no DevBot overlay) with DevBot's credentials migrates `tarubot`.
    refused(
      () =>
        assertToolScope(
          devbotEnv({ DATABASE_URL: localUrl("tarubot", "postgres") }),
          scope.migrate,
          direct,
        ),
      "tarubot_dev",
    );
    refused(
      () =>
        assertToolScope(
          devbotEnv({ DATABASE_URL: managedUrl("tarubot_dev") }),
          scope.migrate,
          direct,
        ),
      "DevBot's local database",
    );
    refused(
      () => assertToolScope(devbotEnv({ DATABASE_CA_CERT: CA }), scope.migrate, direct),
      "must be empty",
    );
  });

  test("(C5) only migrate --restore-rehearsal may target DevBot's *_restore_test copy", () => {
    const copy = devbotEnv({ DATABASE_URL: localUrl("tarubot_dev_restore_test", "postgres") });
    // Without the flag, DevBot's primary is exactly tarubot_dev.
    refused(() => assertToolScope(copy, scope.migrate, direct), "tarubot_dev");
    expect(assertToolScope(copy, scope.rehearseMigration, direct).name).toBe("devbot");
    // The flag never reaches a live database, and guild tools still require tarubot_dev.
    for (const name of ["tarubot_dev", "tarubot"])
      refused(
        () =>
          assertToolScope(
            devbotEnv({ DATABASE_URL: localUrl(name, "postgres") }),
            scope.rehearseMigration,
            direct,
          ),
        "*_restore_test copy with --restore-rehearsal",
      );
    refused(() => assertToolScope(copy, scope.import(DEV_GUILD), direct), "tarubot_dev");
    // The production application rehearses migrations in *_rehearsal instead.
    for (const env of [
      productionEnv({ DATABASE_URL: managedUrl("tarubot_restore_test") }),
      rehearsalEnv({ DATABASE_URL: localUrl("tarubot_restore_test") }),
    ])
      refused(() => assertToolScope(env, scope.rehearseMigration, direct), "--restore-rehearsal");
    // migrate.js accepts only this one flag, before any I/O.
    expect(migrateArguments([])).toEqual({ restoreRehearsal: false });
    expect(migrateArguments(["--restore-rehearsal"])).toEqual({ restoreRehearsal: true });
    for (const argv of [["--restore-rehearsal", "--restore-rehearsal"], ["--global"], ["x"]])
      expect(() => migrateArguments(argv)).toThrow(Failure);
  });

  test("(i, C6c) check-restore validates both URLs and each profile's restore targets", () => {
    const production = (restore: string, overrides: Environment = {}) =>
      productionEnv({ RESTORE_DATABASE_URL: restore, ...overrides });
    // A PITR fork is another cluster holding `tarubot`; a same-cluster restore is tarubot_restore.
    expect(
      assertToolScope(production(managedUrl("tarubot", FORK)), scope.restore, direct).name,
    ).toBe("production");
    expect(
      assertToolScope(production(managedUrl("tarubot_restore")), scope.restore, direct).name,
    ).toBe("production");
    expect(
      assertToolScope(
        production(managedUrl("tarubot", FORK), { RESTORE_DATABASE_CA_CERT: "fork-ca" }),
        scope.restore,
        direct,
      ).name,
    ).toBe("production");
    for (const [restore, fragment] of [
      [managedUrl("tarubot"), "different database"],
      [managedUrl("tarubot_restore_test"), "tarubot_restore on the primary's host"],
      [managedUrl("tarubot_restore", FORK), "tarubot on a PITR fork"],
      [managedUrl("tarubot", FORK, "doadmin"), "not an administrator"],
      [localUrl("tarubot_restore"), "is local"],
    ] as const)
      refused(() => assertToolScope(production(restore), scope.restore, direct), fragment);
    refused(() => assertToolScope(productionEnv(), scope.restore, direct), "RESTORE_DATABASE_URL");

    expect(
      assertToolScope(
        rehearsalEnv({ RESTORE_DATABASE_URL: localUrl("tarubot_restore_test") }),
        scope.restore,
        direct,
      ).name,
    ).toBe("rehearsal");
    refused(
      () =>
        assertToolScope(
          rehearsalEnv({ RESTORE_DATABASE_URL: localUrl("tarubot_restore") }),
          scope.restore,
          direct,
        ),
      "*_restore_test",
    );
    expect(
      assertToolScope(
        devbotEnv({ RESTORE_DATABASE_URL: localUrl("tarubot_dev_restore_test") }),
        scope.restore,
        direct,
      ).name,
    ).toBe("devbot");
    refused(
      () =>
        assertToolScope(
          devbotEnv({ RESTORE_DATABASE_URL: localUrl("tarubot") }),
          scope.restore,
          direct,
        ),
      "*_restore_test",
    );
  });

  test("an empty restore CA line falls back to DATABASE_CA_CERT", () => {
    expect(restoreCertificate({ DATABASE_CA_CERT: CA })).toBe(CA);
    expect(restoreCertificate({ DATABASE_CA_CERT: CA, RESTORE_DATABASE_CA_CERT: "" })).toBe(CA);
    expect(restoreCertificate({ DATABASE_CA_CERT: CA, RESTORE_DATABASE_CA_CERT: " \n" })).toBe(CA);
    expect(restoreCertificate({ DATABASE_CA_CERT: CA, RESTORE_DATABASE_CA_CERT: "fork" })).toBe(
      "fork",
    );
    expect(restoreCertificate({})).toBeUndefined();
  });

  test("database identities never carry the password and refuse redirecting parameters", () => {
    expect(databaseIdentity(managedUrl("tarubot"))).toEqual({
      host: MANAGED,
      port: 25060,
      name: "tarubot",
      user: "tarubot",
    });
    expect(databaseIdentity("postgresql://u:p@LOCALHOST/tarubot_dev")).toMatchObject({
      host: "localhost",
      port: 5432,
    });
    expect(databaseIdentity("postgres://u@[::1]:5433/db").host).toBe("::1");
    for (const url of [
      `postgresql://tarubot:${PASSWORD}@[broken/tarubot`,
      `mysql://tarubot:${PASSWORD}@${MANAGED}:25060/tarubot`,
      `postgresql://tarubot:${PASSWORD}@${MANAGED}:25060/`,
      `postgresql://tarubot:${PASSWORD}@${MANAGED}:25060/tarubot?host=localhost`,
      `postgresql://tarubot:${PASSWORD}@${MANAGED}:25060/tarubot?port=5432`,
      `postgresql://tarubot:${PASSWORD}@${MANAGED}:25060/tarubot?user=doadmin`,
    ])
      refused(() => databaseIdentity(url), "DATABASE_URL");
    for (const host of ["localhost", "127.0.0.1", "127.8.9.10", "::1", "postgres", "db.localhost"])
      expect(localDatabaseHost(host)).toBe(true);
    for (const host of [MANAGED, "10.0.0.5", "postgres.example"])
      expect(localDatabaseHost(host)).toBe(false);
  });
});

describe("launch and identity", () => {
  test("(h, C6a) production and rehearsal refuse auto-loaded env files without --env-file", () => {
    const plain = (envFiles: readonly string[]): Launch => ({ execArgv: [], envFiles });
    for (const file of AUTOLOADED_ENV_FILES)
      for (const env of [productionEnv(), rehearsalEnv()])
        refused(() => assertToolScope(env, scope.migrate, plain([file])), file);
    for (const execArgv of [["--env-file=/x"], ["--env-file", "/x"], ["--no-env-file"]])
      expect(
        assertToolScope(productionEnv(), scope.migrate, { execArgv, envFiles: [".env"] }).name,
      ).toBe("production");
    // Containers and the App Platform console have no env files in their working directory.
    expect(assertToolScope(productionEnv(), scope.migrate, plain([])).name).toBe("production");
    // DevBot and unmanaged tools are expected to read the checkout's .env.
    expect(assertToolScope(devbotEnv(), scope.migrate, plain([".env"])).name).toBe("devbot");
  });

  test("(l) refusals name settings only, even for unparseable settings", () => {
    refused(
      () =>
        assertToolScope({ ...devbotEnv(), DISCORD_APPLICATION_ID: TOKEN }, scope.migrate, direct),
      "DISCORD_APPLICATION_ID",
    );
    refused(
      () =>
        assertToolScope(
          productionEnv({ DATABASE_URL: `postgresql://tarubot:${PASSWORD}@${MANAGED}:bad/x` }),
          scope.migrate,
          direct,
        ),
      "DATABASE_URL",
    );
  });

  test("(m) the authenticated application must be the profile's", () => {
    const production = assertToolScope(productionEnv(), scope.preview(PRODUCTION_GUILD), direct);
    expect(() => assertAuthenticatedApplication(production, PRODUCTION_APP)).not.toThrow();
    refused(() => assertAuthenticatedApplication(production, DEVBOT_APP), PRODUCTION_APP);
    refused(() => assertAuthenticatedApplication(production, undefined), "did not report");
    // An unmanaged env cannot use a managed deployment's token, even without an application ID.
    const unmanaged = resolveDeployment({});
    expect(() => assertAuthenticatedApplication(unmanaged, "4242")).not.toThrow();
    for (const known of [PRODUCTION_APP, DEVBOT_APP])
      refused(() => assertAuthenticatedApplication(unmanaged, known), "managed application");
  });

  test("(C7) command-scope clearing allows the application's guilds except its own registration", () => {
    const clear = (guild: string): ToolScope => ({
      tool: "commands clear-guild",
      guilds: [],
      commandGuilds: [guild],
      discord: "write",
      databases: [],
    });
    // Production's commands are global, so leftovers in DevBot's guild may be cleared.
    expect(assertToolScope(productionEnv(), clear(DEV_GUILD), direct).name).toBe("production");
    refused(
      () => assertToolScope(devbotEnv(), clear(DEV_GUILD), direct),
      "own command registration",
    );
    refused(() => assertToolScope(rehearsalEnv(), clear(DEV_GUILD), direct), "read-only");
    refused(
      () => assertToolScope({ DISCORD_APPLICATION_ID: "123" }, clear(PRODUCTION_GUILD), direct),
      "managed deployment",
    );
  });
});

describe("templates", () => {
  const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
  const keys = (text: string) =>
    [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? "");

  test("(n) production.env.example lists every key and loads as a passing production env", async () => {
    const template = await Bun.file(root("production.env.example")).text();
    const developmentKeys = keys(await Bun.file(root(".env.example")).text());
    // .env.example is the reference: every key present means a stray .env can never fill a gap.
    expect(developmentKeys).toContain("TARUBOT_ENVIRONMENT");
    expect(developmentKeys).toContain("RESTORE_DATABASE_CA_CERT");
    for (const key of developmentKeys) expect(keys(template)).toContain(key);

    // Load it exactly as the runbook does, with Bun's own parser (multi-line PEM included).
    const child = Bun.spawnSync(
      [
        process.execPath,
        `--env-file=${root("production.env.example")}`,
        "-e",
        "console.log(JSON.stringify(process.env))",
      ],
      { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } },
    );
    expect(child.exitCode).toBe(0);
    const env: Record<string, string> = JSON.parse(child.stdout.toString());
    expect(env).toMatchObject({
      TARUBOT_ENVIRONMENT: "production",
      DISCORD_APPLICATION_ID: PRODUCTION_APP,
      TEST_GUILD_ID: "",
      PUBLIC_TEST_RESPONSES: "false",
      TEST_PLAN_CHANNEL_ID: "",
      ENABLE_EFFECTS: "false",
      NODESTONE_URL: "http://127.0.0.1:18080",
      DISCORD_TOKEN: "",
      RESTORE_DATABASE_CA_CERT: "",
    });
    // Placeholders only: no real password, CA or token is tracked.
    expect(env.DATABASE_URL).toContain("REPLACE_WITH_");
    expect(env.DATABASE_CA_CERT).toStartWith("-----BEGIN CERTIFICATE-----\nREPLACE_WITH_");
    expect(env.DATABASE_CA_CERT).toEndWith("\n-----END CERTIFICATE-----");
    // Production's Linode cluster, on its direct port rather than the 27521 pool.
    expect(databaseIdentity(env.DATABASE_URL ?? "")).toMatchObject({
      port: 27520,
      name: "tarubot",
      user: "tarubot",
    });
    const launch: Launch = { execArgv: ["--env-file=production.env"], envFiles: [".env"] };
    expect(assertToolScope(env, scope.import(PRODUCTION_GUILD), launch).name).toBe("production");
    expect(assertToolScope(env, scope.register(), launch).name).toBe("production");
  });

  test("(n, C4) operator env files stay out of Git and images; the templates stay in both", async () => {
    const gitignore = (await Bun.file(root(".gitignore")).text()).split("\n");
    const dockerignore = (await Bun.file(root(".dockerignore")).text()).split("\n");
    expect(gitignore).toContain("*.env");
    expect(gitignore).toContain("!.env.example");
    expect(dockerignore).toContain("*.env");
    // The build stage runs these unit tests, so the non-secret template must reach it.
    expect(dockerignore).toContain("!.env.example");
    expect(dockerignore.indexOf("!.env.example")).toBeGreaterThan(dockerignore.indexOf(".env.*"));
  });
});

describe("check-restore arguments (C13)", () => {
  test("the build's schema version is the default; --schema-version names an earlier one", () => {
    expect(restoreArguments([])).toEqual({ schemaVersion: SCHEMA_VERSION });
    expect(restoreArguments(["--schema-version", "004_guest_application_form.sql"])).toEqual({
      schemaVersion: "004_guest_application_form.sql",
    });
    for (const argv of [
      ["--schema-version"],
      ["--schema-version", "../004_guest_application_form.sql"],
      ["--schema-version", "004_guest_application_form"],
      ["--schema-version", "004_guest_application_form.sql", "extra"],
      ["--other", "004_guest_application_form.sql"],
    ])
      expect(() => restoreArguments(argv)).toThrow(Failure);
  });
});
