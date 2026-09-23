/**
 * App Platform phase derivation: the worker-free foundation and maintenance phases start no bot
 * writer and never detach the managed cluster, `full` accepts only a filled single-worker spec, and
 * the CLI writes private files, refuses in-place derivation and never prints values.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { componentSummary, deriveSpec, run, type SpecPhase } from "../../scripts/app-spec.js";

const TEMPLATE_PATH = new URL("../../.do/app.yaml", import.meta.url);
/** A fresh parse of the committed template for every use, so no case can leak into another. */
const template = async (): Promise<Record<string, unknown>> =>
  YAML.parse(await Bun.file(TEMPLATE_PATH).text()) as Record<string, unknown>;

/** Loosely typed access to a component's env list in a parsed spec. */
type Env = { key: string; value?: string; type?: string };
type Component = { name: string; envs?: Env[]; instance_count?: number; autoscaling?: unknown };
const components = (spec: Record<string, unknown>, list: string) => spec[list] as Component[];
const envOf = (component: Component | undefined, key: string): Env => {
  const found = component?.envs?.find((env) => env.key === key);
  if (!found) throw new Error(`fixture lacks ${key}`);
  return found;
};

/** The shape of an exported, filled production spec: the token is App Platform's encrypted form. */
const ENCRYPTED_TOKEN = "EV[1:fixture:fixture]";
async function filled(): Promise<Record<string, unknown>> {
  const spec = await template();
  envOf(components(spec, "workers")[0], "DISCORD_TOKEN").value = ENCRYPTED_TOKEN;
  return spec;
}

const scratch = await mkdtemp(join(tmpdir(), "tarubot-app-spec-"));
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("foundation phase starts no bot writer and keeps the database, parser, and migration job", async () => {
  const input = await template();
  const foundation = deriveSpec(input, "foundation");
  expect(foundation.workers).toBeUndefined();
  for (const key of ["name", "region", "alerts", "databases", "services", "jobs"])
    expect(foundation[key]).toEqual(input[key]);
  // No Discord credential (or its placeholder) survives into the phase that creates the app.
  expect(JSON.stringify(foundation)).not.toContain("DISCORD_TOKEN");
  expect(JSON.stringify(foundation)).not.toContain("REPLACE_WITH_");
  // The input is never mutated.
  expect(components(input, "workers")).toHaveLength(1);
});

test("maintenance phase removes the writer and the pre-deploy job but never detaches the cluster", async () => {
  const input = await template();
  const maintenance = deriveSpec(input, "maintenance");
  expect(maintenance.workers).toBeUndefined();
  expect(maintenance.jobs).toBeUndefined();
  for (const key of ["name", "region", "alerts", "databases", "services"])
    expect(maintenance[key]).toEqual(input[key]);
});

test("the full phase accepts a filled single-worker spec unchanged, and encrypted values survive YAML", async () => {
  const spec = await filled();
  const full = deriveSpec(spec, "full");
  expect(full).toEqual(spec);
  // Every phase is written as YAML; the encrypted token and bindings round-trip exactly.
  const reparsed = YAML.parse(YAML.stringify(full, null, 2)) as Record<string, unknown>;
  expect(reparsed).toEqual(full);
  expect(envOf(components(reparsed, "workers")[0], "DISCORD_TOKEN").value).toBe(ENCRYPTED_TOKEN);
  const maintenance = deriveSpec(spec, "maintenance");
  expect(YAML.parse(YAML.stringify(maintenance, null, 2))).toEqual(maintenance);
});

test("an exported spec's encrypted SECRET database binding passes through the worker-free phases", async () => {
  // App Platform encrypts SECRET values on first submission, so a live export can hide the binding.
  const spec = await filled();
  const job = components(spec, "jobs")[0];
  envOf(job, "DATABASE_URL").value = "EV[1:exported:binding]";
  const foundation = deriveSpec(spec, "foundation");
  const reparsed = YAML.parse(YAML.stringify(foundation, null, 2)) as Record<string, unknown>;
  expect(envOf(components(reparsed, "jobs")[0], "DATABASE_URL").value).toBe(
    "EV[1:exported:binding]",
  );
  // The opaque form is accepted only for a SECRET-typed DATABASE_URL.
  delete envOf(job, "DATABASE_URL").type;
  expect(() => deriveSpec(spec, "foundation")).toThrow("DATABASE_URL must be");
});

/** Mutate a fresh filled spec, then expect every phase to refuse it with `message`. */
async function refusedEverywhere(
  mutate: (spec: Record<string, unknown>) => void,
  message: string,
): Promise<void> {
  for (const phase of ["foundation", "maintenance", "full"] as SpecPhase[]) {
    const spec = await filled();
    mutate(spec);
    expect(() => deriveSpec(spec, phase)).toThrow(message);
  }
}

test("phase derivation refuses unsafe database attachments in every phase", async () => {
  const database = (spec: Record<string, unknown>) =>
    components(spec, "databases")[0] as unknown as Record<string, unknown>;
  // The pre-2.13 inline dev database would provision a new database instead of attaching.
  await refusedEverywhere((spec) => {
    database(spec).production = false;
    delete database(spec).cluster_name;
  }, "production: true");
  await refusedEverywhere((spec) => {
    delete database(spec).cluster_name;
  }, "cluster_name");
  await refusedEverywhere((spec) => {
    database(spec).db_user = "";
  }, "db_user");
  await refusedEverywhere((spec) => {
    database(spec).db_user = "doadmin";
  }, "application user");
  await refusedEverywhere((spec) => {
    database(spec).db_name = "defaultdb";
  }, "application database");
  await refusedEverywhere((spec) => {
    spec.databases = [database(spec), { ...database(spec), name: "second" }];
  }, "found 2");
  await refusedEverywhere((spec) => {
    spec.databases = [];
  }, "found 0");
  await refusedEverywhere((spec) => {
    delete spec.databases;
  }, "found 0");
  await refusedEverywhere((spec) => {
    delete spec.services;
  }, "at least one service");
});

test("phase derivation refuses pools, private URLs, literal URLs and unverified TLS", async () => {
  const worker = (spec: Record<string, unknown>) => components(spec, "workers")[0];
  const job = (spec: Record<string, unknown>) => components(spec, "jobs")[0];
  await refusedEverywhere((spec) => {
    envOf(worker(spec), "DATABASE_URL").value = `\${db.pool.DATABASE_URL}`;
  }, "connection pool");
  await refusedEverywhere((spec) => {
    envOf(job(spec), "DATABASE_URL").value = `\${db.DATABASE_PRIVATE_URL}`;
  }, "DATABASE_PRIVATE_URL");
  await refusedEverywhere((spec) => {
    envOf(job(spec), "DATABASE_URL").value = "postgresql://tarubot:secret@host:25060/tarubot";
  }, "DATABASE_URL must be");
  await refusedEverywhere((spec) => {
    envOf(job(spec), "DATABASE_CA_CERT").value = "";
  }, "DATABASE_CA_CERT must be");
  await refusedEverywhere((spec) => {
    const target = job(spec);
    if (target?.envs) target.envs = target.envs.filter((env) => env.key !== "DATABASE_CA_CERT");
  }, "without DATABASE_CA_CERT");
  // A refusal names the component and key, never the offending value.
  const spec = await filled();
  envOf(job(spec), "DATABASE_URL").value = "postgresql://tarubot:sentinel-7f3a@host:25060/tarubot";
  expect(() => deriveSpec(spec, "foundation")).toThrow("jobs migrate DATABASE_URL");
  try {
    deriveSpec(spec, "foundation");
  } catch (error) {
    expect(String(error)).not.toContain("sentinel-7f3a");
  }
});

test("the full phase requires one filled, non-autoscaled worker", async () => {
  // The committed template still carries the token placeholder.
  const committed = await template();
  expect(() => deriveSpec(committed, "full")).toThrow("REPLACE_WITH_");
  const scaled = await filled();
  const [worker] = components(scaled, "workers");
  if (!worker) throw new Error("fixture lacks the worker");
  worker.instance_count = 2;
  expect(() => deriveSpec(scaled, "full")).toThrow("exactly one instance");
  const autoscaled = await filled();
  const [elastic] = components(autoscaled, "workers");
  if (!elastic) throw new Error("fixture lacks the worker");
  elastic.autoscaling = { min_instance_count: 1, max_instance_count: 2 };
  expect(() => deriveSpec(autoscaled, "full")).toThrow("must not autoscale");
  const pair = await filled();
  const [first] = components(pair, "workers");
  pair.workers = [first, { ...first, name: "second" }];
  expect(() => deriveSpec(pair, "full")).toThrow("found 2");
  const none = await filled();
  delete none.workers;
  expect(() => deriveSpec(none, "full")).toThrow("found 0");
});

test("worker-free phases refuse to hand any remaining component a Discord login", async () => {
  for (const phase of ["foundation", "maintenance"] as SpecPhase[]) {
    const spec = await filled();
    spec.envs = [{ key: "DISCORD_TOKEN", scope: "RUN_TIME", type: "SECRET", value: "EV[1:a:b]" }];
    expect(() => deriveSpec(spec, phase)).toThrow("DISCORD_TOKEN");
  }
  // A job that could log in survives foundation (maintenance drops jobs entirely).
  const spec = await filled();
  components(spec, "jobs")[0]?.envs?.push({ key: "DISCORD_TOKEN", value: "EV[1:a:b]" });
  expect(() => deriveSpec(spec, "foundation")).toThrow("jobs migrate would still receive");
  expect(deriveSpec(spec, "maintenance").jobs).toBeUndefined();
});

test("the CLI writes a private file, prints component names only and refuses in-place derivation", async () => {
  const input = join(scratch, "live.yaml");
  await writeFile(input, YAML.stringify(await filled(), null, 2));
  const output = join(scratch, "foundation.yaml");
  // An older, world-readable file at the destination is replaced by a private one.
  await writeFile(output, "stale", { mode: 0o644 });
  const summary = await run(["foundation", input, output]);
  expect(summary).toBe(
    "Wrote the foundation phase (mode 0600): databases db; services nodestone; workers none; jobs migrate.",
  );
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  expect(YAML.parse(await Bun.file(output).text())).toEqual(
    deriveSpec(YAML.parse(await Bun.file(input).text()), "foundation"),
  );
  expect(componentSummary(await filled())).toBe(
    "databases db; services nodestone; workers tarubot; jobs migrate",
  );
  // The full phase's summary names the worker but never its encrypted token.
  const full = await run(["full", input, join(scratch, "full.yaml")]);
  expect(full).toContain("workers tarubot");
  expect(full).not.toContain("EV[");
  await expect(run(["foundation", input, input])).rejects.toThrow("different file");
  await expect(run(["staging", input, output])).rejects.toThrow("Usage");
  await expect(run(["foundation", input])).rejects.toThrow("Usage");
  const broken = join(scratch, "broken.yaml");
  await writeFile(broken, "workers: [\n  sentinel-4c2d: {");
  const failure = run(["foundation", broken, join(scratch, "never.yaml")]);
  await expect(failure).rejects.toThrow("not a readable YAML app spec");
  await failure.catch((error: unknown) => expect(String(error)).not.toContain("sentinel-4c2d"));
  expect(await Bun.file(join(scratch, "never.yaml")).exists()).toBe(false);
});
