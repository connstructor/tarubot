/** Check cross-component deployment invariants that a provider's structural schema cannot enforce. */
import { expect, test } from "bun:test";
import { YAML } from "bun";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };

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
          production: z.boolean(),
          cluster_name: z.string().optional(),
        })
        .passthrough(),
    ),
    workers: z.array(component),
    services: z.array(component),
    jobs: z.array(component.extend({ kind: z.string() })),
  })
  .passthrough()
  .parse(YAML.parse(await Bun.file(new URL("../../.do/app.yaml", import.meta.url)).text()));

test("App Platform creates its database and keeps parser traffic and secrets component-scoped", () => {
  expect(spec.databases).toHaveLength(1);
  const database = spec.databases[0];
  if (!database) throw new Error("Missing database component");
  expect(database.engine).toBe("PG");
  expect(database.production).toBe(false);
  expect(database.cluster_name).toBeUndefined();
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
