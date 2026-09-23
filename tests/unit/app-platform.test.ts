/** Check cross-component deployment invariants that a provider's structural schema cannot enforce. */
import { expect, test } from "bun:test";
import { YAML } from "bun";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };
import { assertToolScope, deployments, type Environment } from "../../src/config/deployment.js";

const env = z.object({
  key: z.string(),
  value: z.string(),
  scope: z.string(),
  type: z.string().optional(),
});
const component = z
  .object({
    name: z.string(),
    image: z.object({
      registry_type: z.string(),
      registry: z.string(),
      repository: z.string(),
      tag: z.string(),
    }),
    instance_count: z.number(),
    run_command: z.string(),
    envs: z.array(env),
    internal_ports: z.array(z.number()).optional(),
    http_port: z.number().optional(),
  })
  .passthrough();
const spec = z
  .object({
    databases: z.array(
      z
        .object({
          name: z.string(),
          engine: z.string(),
          version: z.string(),
          production: z.boolean(),
          cluster_name: z.string().optional(),
          db_name: z.string().optional(),
          db_user: z.string().optional(),
        })
        .passthrough(),
    ),
    workers: z.array(component),
    services: z.array(component),
    jobs: z.array(component.extend({ kind: z.string() })),
  })
  .passthrough()
  .parse(YAML.parse(await Bun.file(new URL("../../.do/app.yaml", import.meta.url)).text()));

/** One component's env values by key. */
const values = (consumer: { envs: { key: string; value: string }[] }) =>
  Object.fromEntries(consumer.envs.map((value) => [value.key, value.value]));

test("App Platform attaches the owner-provisioned managed cluster with a dedicated non-admin login", async () => {
  expect(spec.databases).toHaveLength(1);
  const database = spec.databases[0];
  if (!database) throw new Error("Missing database component");
  expect(database.engine).toBe("PG");
  // production: true attaches the existing cluster; App Platform never provisions a database here.
  expect(database.production).toBe(true);
  expect(database.cluster_name).toBe("tarubot-pg");
  expect(database.db_name).toBe("tarubot");
  expect(database.db_user).toBe("tarubot");
  // The admin login and default database would own tables the application user cannot use.
  expect(database.db_user).not.toBe("doadmin");
  expect(database.db_name).not.toBe("defaultdb");
  // The cluster runs the PostgreSQL major version that Compose deploys and CI tests against.
  const compose = z
    .object({ services: z.object({ postgres: z.object({ image: z.string() }) }) })
    .parse(YAML.parse(await Bun.file(new URL("../../docker-compose.yml", import.meta.url)).text()));
  const major = /^postgres:(\d+)\./.exec(compose.services.postgres.image)?.[1];
  expect(major).toBeDefined();
  expect(database.version).toBe(major ?? "");
});

test("parser traffic and secrets stay component-scoped", () => {
  const database = spec.databases[0];
  if (!database) throw new Error("Missing database component");
  expect(spec.services).toHaveLength(1);
  const parser = spec.services[0];
  if (!parser) throw new Error("Missing parser service");
  expect(parser.internal_ports).toEqual([8080]);
  expect(parser.http_port).toBeUndefined();
  expect(parser.routes).toBeUndefined();
  expect(spec.ingress).toBeUndefined();
  expect(spec.envs).toBeUndefined();
  expect(
    parser.envs.some((value) =>
      ["DATABASE_URL", "DATABASE_CA_CERT", "DISCORD_TOKEN"].includes(value.key),
    ),
  ).toBe(false);
  for (const consumer of [...spec.workers, ...spec.jobs]) {
    expect(consumer.envs.find((value) => value.key === "DATABASE_URL")).toMatchObject({
      value: `\${${database.name}.DATABASE_URL}`,
      scope: "RUN_TIME",
      type: "SECRET",
    });
    expect(consumer.envs.find((value) => value.key === "DATABASE_CA_CERT")?.value).toBe(
      `\${${database.name}.CA_CERT}`,
    );
  }
  expect(spec.jobs.every((job) => !job.envs.some((value) => value.key === "DISCORD_TOKEN"))).toBe(
    true,
  );
});

test("every component binds the direct connection with verified TLS, never a pool or private URL", () => {
  for (const consumer of [...spec.workers, ...spec.services, ...spec.jobs]) {
    for (const value of consumer.envs) {
      // `${db.<pool>.DATABASE_URL}` is a PgBouncer pool, which breaks session advisory locks.
      expect(value.value).not.toMatch(/\$\{db\.[^.}]+\.DATABASE_URL\}/);
      expect(value.value).not.toContain("DATABASE_PRIVATE_URL");
    }
    const keys = consumer.envs.map((value) => value.key);
    if (keys.includes("DATABASE_URL")) expect(keys).toContain("DATABASE_CA_CERT");
  }
});

test("the production worker starts as the sole effect-enabled writer", () => {
  expect(spec.workers).toHaveLength(1);
  const bot = spec.workers[0],
    migration = spec.jobs[0];
  if (!bot || !migration) throw new Error("Missing deployment component");
  const settings = values(bot);
  // The worker exists only from activation onward, so it is added with effects already on.
  expect(settings.ENABLE_EFFECTS).toBe("true");
  expect(settings.TEST_GUILD_ID).toBe("");
  expect(settings.PUBLIC_TEST_RESPONSES).toBe("false");
  expect(Object.keys(settings)).not.toContain("TEST_PLAN_CHANNEL_ID");
  expect(settings.DISCORD_APPLICATION_ID).toBe("965294750741692416");
  expect(settings.DISCORD_APPLICATION_ID).toBe(deployments.production.applicationId);
  expect(settings.TARUBOT_ENVIRONMENT).toBe("production");
  expect(values(migration).TARUBOT_ENVIRONMENT).toBe("production");
});

test("the migration job and console tools in the worker pass the production tool guard", () => {
  const database = spec.databases[0];
  if (!database) throw new Error("Missing database component");
  // Stand-ins for what App Platform binds: the cluster's direct URL for db_user/db_name and its CA.
  const bindings: Record<string, string> = {
    [`\${${database.name}.DATABASE_URL}`]: `postgresql://${database.db_user}:fixture-password@tarubot-pg-do-user-0-0.k.db.ondigitalocean.com:25060/${database.db_name}?sslmode=require`,
    [`\${${database.name}.CA_CERT}`]:
      "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----",
  };
  const bound = (consumer: { envs: { key: string; value: string }[] }): Environment =>
    Object.fromEntries(
      consumer.envs.map((value) => [value.key, bindings[value.value] ?? value.value]),
    );
  // Containers carry no auto-loaded env files and run tools without --env-file.
  const launch = { execArgv: [], envFiles: [] };
  const migration = spec.jobs[0],
    bot = spec.workers[0];
  if (!migration || !bot) throw new Error("Missing deployment component");
  const scope = { guilds: [], discord: "none", databases: ["DATABASE_URL"] } as const;
  expect(assertToolScope(bound(migration), { tool: "migrate", ...scope }, launch).name).toBe(
    "production",
  );
  // A console tool such as jobs:retry sees the worker's env, including the production application.
  const consoleTool = { tool: "retry", ...scope, guilds: deployments.production.guilds };
  expect(assertToolScope(bound(bot), consoleTool, launch).name).toBe("production");
  // Without the marker that production application ID is refused outright.
  const { TARUBOT_ENVIRONMENT: _marker, ...unmarked } = bound(bot);
  expect(() => assertToolScope(unmarked, consoleTool, launch)).toThrow("TARUBOT_ENVIRONMENT");
});

test("one bot, its migration job, and the internal parser use the current release together", () => {
  expect(spec.workers).toHaveLength(1);
  expect(spec.jobs).toHaveLength(1);
  const bot = spec.workers[0],
    migration = spec.jobs[0],
    parser = spec.services[0];
  if (!bot || !migration || !parser) throw new Error("Missing deployment component");
  expect(bot.instance_count).toBe(1);
  expect(bot.autoscaling).toBeUndefined();
  expect(migration.kind).toBe("PRE_DEPLOY");
  expect(migration.run_command).toBe("bun dist/scripts/migrate.js");
  expect(migration.image).toEqual(bot.image);
  expect(bot.envs.find((value) => value.key === "NODESTONE_URL")?.value).toBe(
    `http://${parser.name}:8080`,
  );
  expect(bot.envs.find((value) => value.key === "DISCORD_TOKEN")).toMatchObject({
    scope: "RUN_TIME",
    type: "SECRET",
  });
  for (const value of [bot, migration, parser]) {
    expect(value.image.tag).toBe(manifest.version);
    expect(value.image.registry_type).toBe("GHCR");
  }
});
