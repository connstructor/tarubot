/**
 * Derive the reviewed App Platform phase specs from `.do/app.yaml` or an exported live spec, so no
 * phase can start an unintended bot writer or detach the managed cluster (DEPLOY-DO-01).
 *
 * - `foundation` creates the app: no worker, so no Discord gateway session and no writer. Nodestone,
 *   the PRE_DEPLOY migrate job, the database and alerts prove the binding, verified TLS, the
 *   public-schema grants and trusted sources before activation.
 * - `maintenance` stops the writer: no worker and no jobs, with the database left attached.
 * - `full` is the spec itself, accepted only with exactly one non-autoscaled worker and no
 *   `REPLACE_WITH_` placeholder left (the Discord token is filled in an untracked copy).
 *
 * App Platform cannot scale a worker to zero, so the worker is simply absent from the worker-free
 * phases. Every phase checks the same database invariants and passes values (including encrypted
 * `EV[...]` secrets) through unchanged. Generating or validating a phase creates nothing in the cloud.
 *
 * CLI: `bun dist/scripts/app-spec.js PHASE INPUT OUTPUT`. The output is written with mode 0600
 * because exported specs carry encrypted secrets, and only component names are printed.
 */
import { randomUUID } from "node:crypto";
import { rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { YAML } from "bun";
import { z } from "zod";

/** The deployment phases, in the order a cutover uses them. */
export const SPEC_PHASES = ["foundation", "maintenance", "full"] as const;
export type SpecPhase = (typeof SPEC_PHASES)[number];

/** Every App Platform component list; each component may carry its own envs. */
const COMPONENT_LISTS = ["services", "workers", "jobs", "functions", "static_sites"] as const;

/** Only the fields the checks read are typed; loose objects keep every other field as given. */
const envSchema = z.looseObject({
  key: z.string().min(1),
  value: z.string().optional(),
  type: z.string().optional(),
});
const componentSchema = z.looseObject({
  name: z.string().min(1),
  envs: z.array(envSchema).optional(),
  instance_count: z.number().optional(),
  autoscaling: z.unknown().optional(),
});
const databaseSchema = z.looseObject({
  name: z.string().min(1),
  engine: z.string().optional(),
  production: z.boolean().optional(),
  cluster_name: z.string().optional(),
  db_name: z.string().optional(),
  db_user: z.string().optional(),
});
const specSchema = z.looseObject({
  name: z.string().min(1),
  databases: z.array(databaseSchema).optional(),
  envs: z.array(envSchema).optional(),
  services: z.array(componentSchema).optional(),
  workers: z.array(componentSchema).optional(),
  jobs: z.array(componentSchema).optional(),
  functions: z.array(componentSchema).optional(),
  static_sites: z.array(componentSchema).optional(),
});
type Spec = z.infer<typeof specSchema>;
type Env = z.infer<typeof envSchema>;

/** Refusals name components, keys and paths only, never values (exports hold encrypted secrets). */
function refuse(reason: string): never {
  throw new Error(`App Platform spec refused: ${reason}`);
}

/** A present, non-blank string. */
const filled = (value: string | undefined): value is string => (value ?? "").trim() !== "";

/**
 * App Platform encrypts a SECRET env value on first submission, so an exported live spec may show
 * the database binding as `EV[...]`. That opaque form is accepted for DATABASE_URL only when the
 * env is typed SECRET; the committed template must keep the readable binding (app-platform.test.ts).
 */
const encrypted = (env: Env): boolean =>
  env.type === "SECRET" && /^EV\[[^\]\s]+\]$/.test(env.value ?? "");

/** Every env list in the spec, labelled for messages: app-level first, then each component's. */
function envLists(spec: Spec): { owner: string; envs: Env[] }[] {
  const lists = [{ owner: "app-level envs", envs: spec.envs ?? [] }];
  for (const list of COMPONENT_LISTS)
    for (const component of spec[list] ?? [])
      lists.push({ owner: `${list} ${component.name}`, envs: component.envs ?? [] });
  return lists;
}

/** Invariants every phase shares: one attached managed cluster, bound directly with verified TLS. */
function checkShared(spec: Spec): void {
  const databases = spec.databases ?? [];
  if (databases.length !== 1)
    refuse(`exactly one database component is required, found ${databases.length}.`);
  const [database] = databases;
  if (!database) refuse("the database component is missing.");
  const db = database.name;
  if (database.engine !== "PG") refuse(`database ${db} must use engine PG.`);
  // production: true attaches the owner's existing cluster; false would provision a dev database.
  if (database.production !== true)
    refuse(`database ${db} must attach the managed cluster (production: true).`);
  for (const field of ["cluster_name", "db_name", "db_user"] as const)
    if (!filled(database[field])) refuse(`database ${db} must name its ${field}.`);
  // The admin login and default database would create tables the application user cannot use.
  if (database.db_user === "doadmin") refuse(`database ${db} must bind the application user.`);
  if (database.db_name === "defaultdb")
    refuse(`database ${db} must bind the application database.`);
  if (!(spec.services ?? []).length) refuse("at least one service is required.");

  // Pools (three-part bindings) break session advisory locks and the writer lease; the private URL
  // needs a VPC and an unproven TLS hostname, so neither is bound at launch.
  const pool = new RegExp(`\\$\\{${db.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[^.}]+\\.[^}]+\\}`);
  for (const { owner, envs } of envLists(spec)) {
    for (const env of envs) {
      const value = env.value ?? "";
      if (value.includes("DATABASE_PRIVATE_URL"))
        refuse(`${owner} ${env.key} binds DATABASE_PRIVATE_URL; bind the direct connection.`);
      if (pool.test(value)) refuse(`${owner} ${env.key} binds a connection pool.`);
      if (env.key === "DATABASE_URL" && value !== `\${${db}.DATABASE_URL}` && !encrypted(env))
        refuse(`${owner} DATABASE_URL must be the \${${db}.DATABASE_URL} binding.`);
      if (env.key === "DATABASE_CA_CERT" && value !== `\${${db}.CA_CERT}`)
        refuse(`${owner} DATABASE_CA_CERT must be the \${${db}.CA_CERT} binding.`);
    }
    // Verified TLS is mandatory wherever the database is reachable.
    if (
      envs.some((env) => env.key === "DATABASE_URL") &&
      !envs.some((env) => env.key === "DATABASE_CA_CERT")
    )
      refuse(`${owner} binds DATABASE_URL without DATABASE_CA_CERT.`);
  }
}

/** Worker-free phases must not hand any remaining component a Discord login either. */
function checkNoDiscordLogin(spec: Spec): void {
  for (const { owner, envs } of envLists(spec))
    if (envs.some((env) => env.key === "DISCORD_TOKEN"))
      refuse(`${owner} would still receive DISCORD_TOKEN in a worker-free phase.`);
}

/** The path of the first string containing `needle`, or null. */
function findString(value: unknown, needle: string, path = ""): string | null {
  if (typeof value === "string") return value.includes(needle) ? path || "(root)" : null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findString(item, needle, path ? `${path}.${index}` : String(index));
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      const found = findString(item, needle, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  return null;
}

/** Validate a parsed spec, reporting paths only (a zod message never includes the input value). */
function parseSpec(input: unknown): Spec {
  const result = specSchema.safeParse(input);
  if (!result.success)
    refuse(
      `invalid structure at ${[...new Set(result.error.issues.map((issue) => issue.path.join(".") || "(root)"))].join(", ")}.`,
    );
  return result.data;
}

/**
 * Derive one phase from a parsed spec. The input is never mutated; the result is a plain JSON tree
 * holding exactly the input's fields minus the phase's removed lists, so YAML aliases shared
 * between components (the template's `*bot-image`) are written out in full.
 */
export function deriveSpec(input: unknown, phase: SpecPhase): Record<string, unknown> {
  if (!SPEC_PHASES.includes(phase)) refuse(`unknown phase; use ${SPEC_PHASES.join(", ")}.`);
  let tree: Record<string, unknown>;
  try {
    tree = JSON.parse(JSON.stringify(input ?? null));
  } catch {
    refuse("the spec is not a plain data tree (cyclic YAML aliases?).");
  }
  checkShared(parseSpec(tree));
  switch (phase) {
    case "foundation":
      delete tree.workers;
      checkNoDiscordLogin(parseSpec(tree));
      break;
    case "maintenance":
      delete tree.workers;
      delete tree.jobs;
      checkNoDiscordLogin(parseSpec(tree));
      break;
    case "full": {
      const workers = parseSpec(tree).workers ?? [];
      if (workers.length !== 1)
        refuse(`the full phase needs exactly one bot worker, found ${workers.length}.`);
      const [worker] = workers;
      // instance_count is not a lock, but a second instance would be a second gateway writer.
      if (worker?.instance_count !== 1)
        refuse(`worker ${worker?.name} must run exactly one instance.`);
      if (worker.autoscaling !== undefined) refuse(`worker ${worker.name} must not autoscale.`);
      const placeholder = findString(tree, "REPLACE_WITH_");
      if (placeholder)
        refuse(
          `a REPLACE_WITH_ placeholder remains at ${placeholder}. Fill the Discord placeholders in an untracked copy.`,
        );
      break;
    }
  }
  return tree;
}

/** Component names per list for the CLI summary; values are never printed. */
export function componentSummary(spec: Record<string, unknown>): string {
  const names = z.array(z.looseObject({ name: z.string() })).optional();
  return (["databases", ...COMPONENT_LISTS] as const)
    .flatMap((list) => {
      const present = names.parse(spec[list])?.map((component) => component.name) ?? [];
      // Functions and static sites are listed only when present; the rest always are.
      if (!present.length && (list === "functions" || list === "static_sites")) return [];
      return [`${list} ${present.length ? present.join(", ") : "none"}`];
    })
    .join("; ");
}

/**
 * Write the derived text next to its destination with mode 0600 and rename it into place, so the
 * file is never readable by others even when it replaces an older, more permissive one.
 */
async function writePrivate(output: string, text: string): Promise<void> {
  const temporary = join(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** True when both paths name the same existing file (including through links). */
async function sameFile(first: string, second: string): Promise<boolean> {
  if (resolve(first) === resolve(second)) return true;
  try {
    const [a, b] = await Promise.all([stat(first), stat(second)]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/**
 * The CLI body: derive PHASE from the INPUT file and write it to OUTPUT, returning the printable
 * summary. Deriving in place is refused because it would overwrite the exported live spec that the
 * `full` phase is later restored from.
 */
export async function run(args: readonly string[]): Promise<string> {
  const [phase, input, output, ...extra] = args;
  if (!phase || !input || !output || extra.length || !SPEC_PHASES.some((name) => name === phase))
    throw new Error(`Usage: bun dist/scripts/app-spec.js ${SPEC_PHASES.join("|")} INPUT OUTPUT`);
  if (await sameFile(input, output)) throw new Error("OUTPUT must be a different file from INPUT.");
  let parsed: unknown;
  try {
    parsed = YAML.parse(await Bun.file(input).text());
  } catch {
    // Parser diagnostics can quote the input, which may hold encrypted secrets.
    throw new Error("INPUT is not a readable YAML app spec.");
  }
  const derived = deriveSpec(parsed, phase as SpecPhase);
  await writePrivate(
    output,
    `# Derived ${phase} phase (scripts/app-spec.ts); keep untracked, it may carry encrypted secrets.\n${YAML.stringify(derived, null, 2)}`,
  );
  return `Wrote the ${phase} phase (mode 0600): ${componentSummary(derived)}.`;
}

if (import.meta.main) {
  try {
    console.log(await run(process.argv.slice(2)));
  } catch (error) {
    // Messages name phases, components, keys and paths only.
    console.error(error instanceof Error ? error.message : "App Platform spec derivation failed.");
    process.exitCode = 1;
  }
}
