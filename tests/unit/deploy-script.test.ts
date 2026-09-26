/**
 * ops/deploy.sh, the deploy key's forced command on the production host (2.30.0, issue #41;
 * REQUIREMENTS.md "Approved SSH-deploy amendments (2026-09-26)").
 *
 * - Static checks pin the shell properties the key's safety rests on: strict mode, a fixed PATH and
 *   locale, no eval or tracing, stdout only through `say`, and a clean environment for the worker.
 * - The parser table runs the real script with hostile SSH_ORIGINAL_COMMAND values: each prints
 *   the usage line and exits 64 before any run directory, lock, git or Docker call.
 * - The scenarios run the real worker against a throwaway git repository (a bare "origin" with
 *   one commit per release) and simulated `docker`, `curl` and `df` commands on PATH
 *   (tests/fixtures/deploy-stubs), asserting the order of the calls that change something, the
 *   `.env` pin, the clone's commit and the result line: restart, migration, failed migration,
 *   failed health before and after the writer lease, rollback, superseded, the maintenance-window
 *   warning, already-live, and every refusal before anything changes.
 * - The entry tests cover replay, following a busy run, a dead worker, a conflicting request, the
 *   committed v1 run directory and the detached launch.
 *
 * Scenarios need git and jq; the image build (oven/bun, which has neither) skips them, and CI's
 * checks job and the dev VM run them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A repository path, resolved relative to this test. */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const SCRIPT = root("ops/deploy.sh");
const STUBS = root("tests/fixtures/deploy-stubs");
const hasGit = Bun.which("git") !== null;
const hasJq = Bun.which("jq") !== null;
const RUN_ID = "36300000042";
const USAGE =
  "usage: deploy <version> <commit> <digest> <run> | rollback <version> <commit> <digest> <run> <from>";

/** Deterministic hex of a given length, so every release has stable fake digests. */
const hex = (seed: string, length = 64) =>
  createHash("sha256").update(seed).digest("hex").slice(0, length);

const scratch = mkdtempSync(join(tmpdir(), "deploy-script-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** One test's private directories: HOME (with the script's state), the simulation and the stubs. */
interface Sandbox {
  readonly dir: string;
  readonly home: string;
  readonly state: string;
  readonly sim: string;
  readonly bin: string;
}

let sandboxes = 0;
function sandbox(): Sandbox {
  const dir = join(scratch, `s${++sandboxes}`);
  const home = join(dir, "home");
  const sim = join(dir, "sim");
  const bin = join(dir, "bin");
  for (const path of [home, join(sim, "c"), join(sim, "versions"), join(sim, "knob"), bin])
    mkdirSync(path, { recursive: true });
  for (const name of ["docker", "curl", "df"]) {
    cpSync(join(STUBS, name), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(sim, "calls"), "");
  return { dir, home, state: join(home, ".local/state/tarubot-deploy"), sim, bin };
}

/** The environment every driver runs with: the stubs first, a private HOME and git config. */
const environment = (box: Sandbox, extra: Record<string, string> = {}) => ({
  HOME: box.home,
  PATH: `${box.bin}:/usr/local/bin:/usr/bin:/bin`,
  SIM: box.sim,
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  DEPLOY_SCRIPT: SCRIPT,
  DEPLOY_STATE: join(box.home, ".local/state/tarubot-deploy"),
  ...extra,
});

/** Run a command to completion and return its status and output. */
function run(argv: string[], env: Record<string, string>, cwd = scratch) {
  const result = Bun.spawnSync(argv, { env, cwd, stdin: "ignore" });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Run git with an isolated configuration, failing the test on an error. */
function git(cwd: string, ...args: string[]): string {
  const result = run(
    ["git", ...args],
    {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: scratch,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
    cwd,
  );
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------------------------
// Static properties
// ---------------------------------------------------------------------------------------------

describe("the script's shape", () => {
  const text = readFileSync(SCRIPT, "utf8");
  const lines = text.split("\n");
  /** The body of one top-level function, from its `name() {` line to the closing `}`. */
  const body = (name: string) => {
    const start = lines.indexOf(`${name}() {`);
    if (start < 0) throw new Error(`no function ${name}`);
    const end = lines.indexOf("}", start);
    return lines.slice(start + 1, end).join("\n");
  };

  test("is valid bash in strict mode, with a fixed PATH, locale and private files in main", () => {
    expect(run(["bash", "-n", SCRIPT], { PATH: "/usr/bin:/bin" }).code).toBe(0);
    expect(text).toStartWith("#!/usr/bin/env bash\n");
    expect(text).toContain("\nset -Eeuo pipefail\n");
    expect(text).toContain("readonly SAFE_PATH=/usr/local/bin:/usr/bin:/bin\n");
    const main = body("main");
    expect(main).toContain("umask 077");
    expect(main).toContain("export LC_ALL=C PATH=$SAFE_PATH");
    expect(main).toContain('exec 2>>"$STATE/entry.log"');
    // The worker points its stderr at its own log.
    expect(body("worker")).toContain('exec 2>>"$RUN/worker.log"');
  });

  test("keeps only constants and functions at the top level, then the direct-run guard", () => {
    let depth = 0;
    const loose: string[] = [];
    for (const line of lines) {
      if (depth === 0 && /^[a-z_]+\(\) \{$/u.test(line)) depth = 1;
      else if (depth === 1 && line === "}") depth = 0;
      else if (
        depth === 0 &&
        line !== "" &&
        !line.startsWith("#") &&
        !/^readonly [A-Z_]+=/u.test(line) &&
        line !== "set -Eeuo pipefail"
      )
        loose.push(line);
    }
    expect(loose).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the script's shell text.
      'if [[ ${BASH_SOURCE[0]} == "$0" ]]; then',
      '  main "$@"',
      "  exit",
      "fi",
    ]);
  });

  test("never evaluates text, traces, or prints Compose's resolved configuration", () => {
    expect(text).not.toMatch(/\beval\b/u);
    expect(text).not.toMatch(/set -[a-zA-Z]*x/u);
    expect(text).not.toMatch(/\becho\b/u);
    for (const match of text.matchAll(/compose \d+ config[^\n]*/gu))
      expect(match[0]).toContain("config --quiet");
    // Every one-off and exec in the container runs without a TTY.
    const containerCalls = [...text.matchAll(/compose \d+ (run|exec)\b[^\n]*/gu)];
    expect(containerCalls.length).toBeGreaterThanOrEqual(3);
    for (const [call] of containerCalls) expect(call).toContain(" -T ");
  });

  test("the entry writes the client's stdout only through say", () => {
    for (const name of ["entry", "emit_new", "replay", "follow", "worker_died", "prune"])
      for (const line of body(name).split("\n"))
        if (/\bprintf\b/u.test(line))
          expect({ name, line, private: /\$\(printf|>/u.test(line) }).toEqual({
            name,
            line,
            private: true,
          });
    // The worker starts with a clean environment in its own session, its output in its log.
    const launch = body("launch");
    expect(launch).toContain('env -i HOME="$HOME" PATH="$SAFE_PATH" LC_ALL=C');
    expect(launch).toContain('setsid -f "$SELF" __worker');
    expect(launch).toContain('</dev/null >>"$RUN/worker.log" 2>&1');
  });
});

// ---------------------------------------------------------------------------------------------
// The request parser
// ---------------------------------------------------------------------------------------------

describe("the request parser", () => {
  const commit = hex("commit", 40);
  const digest = `sha256:${hex("digest")}`;
  const valid = `deploy 2.30.1 ${commit} ${digest} ${RUN_ID}`;

  /** Run the real script (main) as sshd would, with a request and the caller's locale. */
  function asForcedCommand(request: string, locale = "C.UTF-8") {
    const box = sandbox();
    const result = run(["bash", SCRIPT], {
      HOME: box.home,
      PATH: "/usr/bin:/bin",
      LC_ALL: locale,
      SSH_ORIGINAL_COMMAND: request,
    });
    const runs = existsSync(join(box.state, "runs")) ? readdirSync(join(box.state, "runs")) : [];
    const log = readFileSync(join(box.state, "entry.log"), "utf8");
    return { ...result, runs, log };
  }

  const hostile: [string, string][] = [
    ["empty", ""],
    ["a shell", "bash"],
    ["sftp", "internal-sftp"],
    ["scp", "scp -t ."],
    ["a chained command", `${valid}; id`],
    ["a newline", `${valid}\nid`],
    ["a trailing space", `${valid} `],
    ["a 39-digit commit", `deploy 2.30.1 ${commit.slice(1)} ${digest} ${RUN_ID}`],
    ["uppercase hex", `deploy 2.30.1 ${commit.toUpperCase()} ${digest} ${RUN_ID}`],
    ["a leading zero", `deploy 02.30.1 ${commit} ${digest} ${RUN_ID}`],
    ["a pre-release", `deploy 2.30.1-rc.1 ${commit} ${digest} ${RUN_ID}`],
    ["a status query", "status"],
    ["a rollback without from", `rollback 2.30.0 ${commit} ${digest} ${RUN_ID}`],
    ["a deploy with from", `${valid} 2.30.0`],
    ["run id zero", `deploy 2.30.1 ${commit} ${digest} 0`],
    ["a digest without its algorithm", `deploy 2.30.1 ${commit} ${hex("digest")} ${RUN_ID}`],
    ["201 bytes", `${valid} ${"x".repeat(200 - valid.length)}`],
    ["Arabic-Indic digits", `deploy ٢.٣٠.١ ${commit} ${digest} ${RUN_ID}`],
    ["a quoted field", `deploy '2.30.1' ${commit} ${digest} ${RUN_ID}`],
  ];

  test.each(hostile)("refuses %s with the usage line, before any run or tool", (_, request) => {
    const result = asForcedCommand(request);
    expect(result.code).toBe(64);
    expect(result.stdout).toBe(`${USAGE}\n`);
    expect(result.runs).toEqual([]);
    // The log keeps a sanitized, single-line copy: newlines and anything else unusual become ?.
    const logged = result.log.trim().split("\n");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/refused request:(?: [A-Za-z0-9 ._:?-]{0,200})?$/u);
  });

  test("the 201-byte limit counts bytes, and 200 bytes of padding-free input is the maximum", () => {
    expect(`${valid} ${"x".repeat(200 - valid.length)}`).toHaveLength(201);
    // The longest valid rollback is well inside the limit.
    const longest = `rollback 9999.9999.9999 ${commit} ${digest} ${"9".repeat(20)} 9999.9999.9999`;
    expect(Buffer.byteLength(longest)).toBeLessThanOrEqual(200);
  });

  test("reads the fields from BASH_REMATCH at the pinned indices", () => {
    const box = sandbox();
    const parse = (request: string) =>
      run(["bash", join(STUBS, "call.sh"), "parse", request], environment(box)).stdout.trim();
    expect(parse(valid)).toBe(`deploy|2.30.1|${commit}|${digest}|${RUN_ID}|-`);
    expect(parse(`rollback 2.30.0 ${commit} ${digest} ${RUN_ID} 2.30.1`)).toBe(
      `rollback|2.30.0|${commit}|${digest}|${RUN_ID}|2.30.1`,
    );
    expect(parse(`deploy 9999.0.10 ${commit} ${digest} ${"9".repeat(20)}`)).toBe(
      `deploy|9999.0.10|${commit}|${digest}|${"9".repeat(20)}|-`,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

describe("the helpers", () => {
  /** Call one script function; returns its status and output. */
  const call = (...args: string[]) =>
    run(["bash", join(STUBS, "call.sh"), ...args], environment(sandbox()));

  test("versions compare numerically", () => {
    const older = (a: string, b: string) => call("version_lt", a, b).code === 0;
    expect(older("2.9.0", "2.10.0")).toBe(true);
    expect(older("2.30.0", "2.30.0")).toBe(false);
    expect(older("2.30.1", "2.30.0")).toBe(false);
    expect(older("2.29.2", "2.30.0")).toBe(true);
    expect(older("3.0.0", "2.99.99")).toBe(false);
  });

  test("migration changes classify as none, added or changed", () => {
    const kind = (diff: string) => call("migration_kind", diff).stdout;
    expect(kind("")).toBe("none");
    expect(kind("A\tmigrations/011_x.sql")).toBe("added");
    expect(kind("A\tmigrations/011_x.sql\nA\tmigrations/012_y.sql")).toBe("added");
    expect(kind("M\tmigrations/001_init.sql")).toBe("changed");
    expect(kind("A\tmigrations/011_x.sql\nD\tmigrations/010_old.sql")).toBe("changed");
    expect(kind("T\tmigrations/001_init.sql")).toBe("changed");
  });

  test("the log level must keep info-level lines", () => {
    const ok = (value: string) => call("log_level_ok", value).code === 0;
    for (const value of ["", "info", "debug", "trace", '"info"', "'debug'"])
      expect({ value, ok: ok(value) }).toEqual({ value, ok: true });
    for (const value of ["warn", "error", "fatal", "silent", "INFO", '"warn"'])
      expect({ value, ok: ok(value) }).toEqual({ value, ok: false });
  });

  test("tokens that don't match their pattern print as ?", () => {
    const token = (...args: string[]) => call("token", ...args).stdout;
    expect(token("version", "2.30.0")).toBe("2.30.0");
    expect(token("version", "2.30.0\nx")).toBe("?");
    expect(token("version", "-")).toBe("?");
    expect(token("version", "-", "dash")).toBe("-");
    expect(token("reason", "worker-died")).toBe("worker-died");
    expect(token("reason", "Worker died")).toBe("?");
    expect(token("int", "31")).toBe("31");
    expect(token("int", "123456")).toBe("?");
    expect(token("backup", "daily/tarubot-20260929T193000Z.dump.age")).toBe(
      "daily/tarubot-20260929T193000Z.dump.age",
    );
    expect(token("backup", "daily/../x")).toBe("?");
    expect(token("unknown", "x")).toBe("?");
  });

  test("the restore point is normalized to UTC with microseconds", () => {
    const point = (text: string) => call("restore_point", text).stdout;
    expect(
      point(
        "Migration writer lease acquired at 2026-09-29 19:30:05.123456+00; applied 011_x.sql; committing at 2026-09-29 19:30:06+00.\nSchema ready.",
      ),
    ).toBe("2026-09-29T19:30:05.123456Z");
    expect(
      point("Migration writer lease acquired at 2026-09-29 21:30:05.1+02; applied a; committing"),
    ).toBe("2026-09-29T19:30:05.100000Z");
    expect(point("Schema ready.")).toBe("-");
    expect(point("Migration writer lease acquired at yesterday-ish; applied a")).toBe("-");
  });
});

// ---------------------------------------------------------------------------------------------
// Worker scenarios against a throwaway repository and simulated Docker
// ---------------------------------------------------------------------------------------------

/** One release of the fixture repository and its fake registry identity. */
interface Release {
  readonly version: string;
  readonly commit: string;
  readonly digest: string;
  readonly image: string;
}
const releases = new Map<string, Release>();
let origin = "";

beforeAll(() => {
  if (!hasGit || !hasJq) return;
  origin = join(scratch, "origin.git");
  const work = join(scratch, "work");
  git(scratch, "init", "--quiet", "--bare", "-b", "main", origin);
  git(scratch, "init", "--quiet", "-b", "main", work);
  mkdirSync(join(work, "ops"));
  mkdirSync(join(work, "migrations"));
  cpSync(join(STUBS, "backup.sh"), join(work, "ops/backup.sh"));
  chmodSync(join(work, "ops/backup.sh"), 0o755);
  writeFileSync(join(work, "docker-compose.production.yml"), "services: {}\n");
  writeFileSync(join(work, ".gitignore"), ".env\n.env.*\n");
  writeFileSync(join(work, "migrations/001_init.sql"), "CREATE TABLE t (id int);\n");
  const release = (version: string, message: string) => {
    writeFileSync(join(work, "package.json"), `${JSON.stringify({ version }, null, 2)}\n`);
    git(work, "add", "-A");
    git(work, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message);
    releases.set(version, {
      version,
      commit: git(work, "rev-parse", "HEAD"),
      digest: `sha256:${hex(`digest ${version}`)}`,
      image: `sha256:${hex(`image ${version}`)}`,
    });
  };
  release("2.29.2", "Below the floor");
  release("2.30.0", "The floor");
  release("2.30.1", "A restart release");
  writeFileSync(join(work, "migrations/002_more.sql"), "ALTER TABLE t ADD COLUMN n int;\n");
  release("2.31.0", "A migration release");
  writeFileSync(join(work, "migrations/001_init.sql"), "CREATE TABLE t (id bigint);\n");
  release("2.31.1", "An edited applied migration");
  git(work, "push", "--quiet", origin, "main");
});

/** What a scenario sets up, beyond a healthy live release and an approved dispatch. */
interface Scenario {
  /** The live release. */
  readonly live: string;
  /** "deploy V", "rollback V from F", optionally with "@<commit>" to override the commit. */
  readonly request: string;
  readonly knobs?: Record<string, string>;
  readonly env?: string;
  readonly envMode?: number;
  /** .env is a symlink to a file with the same content. */
  readonly envSymlink?: boolean;
  readonly liveStatus?: string;
  readonly liveHealth?: string;
  readonly run?: Record<string, unknown>;
  readonly approvals?: unknown;
  readonly now?: string;
  readonly dirty?: boolean;
}

/** The fields of a result line. */
type Result = Record<string, string>;

function scenario(s: Scenario) {
  const box = sandbox();
  const repo = join(box.dir, "root");
  git(box.dir, "clone", "--quiet", origin, repo);
  const live = releases.get(s.live);
  if (!live) throw new Error(`no release ${s.live}`);
  git(repo, "reset", "--quiet", "--hard", live.commit);
  if (s.dirty) writeFileSync(join(repo, "docker-compose.production.yml"), "services: {x: 1}\n");
  const envPath = s.envSymlink ? join(box.dir, "real.env") : join(repo, ".env");
  writeFileSync(
    envPath,
    s.env ??
      `TARUBOT_IMAGE_TAG=${s.live}\nDATABASE_URL=postgresql://x\nDATABASE_CA_CERT="-----BEGIN CERTIFICATE-----\nMIIBCgKCAQEAinsideAquotedValue=\n-----END CERTIFICATE-----"\n`,
  );
  chmodSync(envPath, s.envMode ?? 0o600);
  if (s.envSymlink) symlinkSync(envPath, join(repo, ".env"));
  for (const r of releases.values())
    writeFileSync(join(box.sim, "versions", r.version), `${r.commit} ${r.digest} ${r.image}\n`);
  // The live container: healthy unless the scenario says otherwise, with the lease in its logs.
  const cid = "c0ffee000000";
  writeFileSync(
    join(box.sim, "c", `${cid}.json`),
    JSON.stringify([
      {
        Id: cid,
        Image: live.image,
        RestartCount: 0,
        State: { Status: s.liveStatus ?? "running", Health: { Status: s.liveHealth ?? "healthy" } },
        Config: {
          Labels: {
            "org.opencontainers.image.version": live.version,
            "org.opencontainers.image.revision": live.commit,
            "com.docker.compose.project": "tarubot",
          },
        },
      },
    ]),
  );
  writeFileSync(join(box.sim, "c", `${cid}.logs`), '{"msg":"Database writer lease acquired"}\n');
  writeFileSync(join(box.sim, "current"), `${cid}\n`);
  for (const [name, value] of Object.entries(s.knobs ?? {}))
    writeFileSync(join(box.sim, "knob", name), value);
  // The request, and GitHub's answer for an approved dispatch of it.
  const [, action, version, from, override] =
    /^(deploy|rollback) (\S+)(?: from (\S+))?(?: @(\S+))?$/u.exec(s.request) ?? [];
  if (!action || !version) throw new Error(`bad request ${s.request}`);
  const target = releases.get(version);
  const commit = override ?? target?.commit ?? hex(`commit ${version}`, 40);
  const digest = target?.digest ?? `sha256:${hex(`digest ${version}`)}`;
  const request = `${action} ${version} ${commit} ${digest} ${RUN_ID}${from ? ` ${from}` : ""}`;
  const title = from ? `Deploy ${version} rollback from ${from}` : `Deploy ${version}`;
  writeFileSync(
    join(box.sim, "run.json"),
    JSON.stringify({
      id: Number(RUN_ID),
      path: ".github/workflows/deploy.yml",
      event: "workflow_dispatch",
      head_branch: "main",
      head_repository: { full_name: "deconfined/tarubot" },
      status: "in_progress",
      run_attempt: 1,
      display_title: title,
      ...s.run,
    }),
  );
  // A string is written as it is (an answer that isn't JSON).
  writeFileSync(
    join(box.sim, "approvals.json"),
    typeof s.approvals === "string"
      ? s.approvals
      : JSON.stringify(
          s.approvals ?? [
            {
              state: "approved",
              comment: "",
              user: { login: "deconfined" },
              environments: [{ name: "production" }],
            },
          ],
        ),
  );
  const outcome = run(
    ["bash", join(STUBS, "run-worker.sh")],
    environment(box, { DEPLOY_ROOT: repo, REQUEST: request, SIM_NOW: s.now ?? "4 12" }),
  );
  const runDir = join(box.state, "runs", RUN_ID);
  const publicLines = readFileSync(join(runDir, "public.log"), "utf8").trim().split("\n");
  const resultLine = publicLines.at(-1) ?? "";
  const result: Result = Object.fromEntries(
    resultLine
      .replace(/^result /u, "")
      .split(" ")
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
  const envFile = readFileSync(join(repo, ".env"), "utf8");
  return {
    ...outcome,
    result,
    resultLine,
    publicLines,
    resultFile: readFileSync(join(runDir, "result"), "utf8").trim(),
    calls: readFileSync(join(box.sim, "calls"), "utf8").trim().split("\n").filter(Boolean),
    apiCalls: existsSync(join(box.sim, "api-calls"))
      ? readFileSync(join(box.sim, "api-calls"), "utf8").trim().split("\n")
      : [],
    pin: /^TARUBOT_IMAGE_TAG=(.*)$/mu.exec(envFile)?.[1],
    envFile,
    envMode: Bun.spawnSync(["stat", "-c", "%a", join(repo, ".env")])
      .stdout.toString()
      .trim(),
    head: git(repo, "rev-parse", "HEAD"),
    branch: git(repo, "symbolic-ref", "--short", "HEAD"),
    worker: readFileSync(join(runDir, "worker.log"), "utf8"),
  };
}

/** The commit of a fixture release. */
const commitOf = (version: string): string => {
  const release = releases.get(version);
  if (!release) throw new Error(`no release ${version}`);
  return release.commit;
};
/** A pattern the whole result line must match: ops/deploy.sh's own RESULT_FORM. */
const RESULT_FORM = new RegExp(
  /readonly RESULT_FORM='([^']+)'/u.exec(readFileSync(SCRIPT, "utf8"))?.[1] ?? "^$",
  "u",
);

describe.skipIf(!hasGit || !hasJq)("worker scenarios", () => {
  const slow = 30_000;

  test(
    "a release without migration files restarts, then pins, registers and reads back",
    () => {
      const s = scenario({ live: "2.30.0", request: "deploy 2.30.1" });
      expect(s.resultLine).toMatch(RESULT_FORM);
      expect(s.result).toMatchObject({
        outcome: "deployed",
        version: "2.30.1",
        previous: "2.30.0",
        path: "plain",
        commands: "registered",
        backup: "-",
        restore_point: "-",
        reason: "-",
      });
      expect(s.result.downtime).toMatch(/^\d+$/u);
      expect(s.calls).toEqual([
        "compose pull tag=2.30.1",
        "compose config tag=2.30.1",
        "compose up tag=2.30.1 pin=2.30.0 orphans",
        "exec register",
        "exec list",
      ]);
      expect(s.publicLines).toEqual([
        "step preflight",
        "step pull",
        "step up",
        "step commands",
        s.resultLine,
      ]);
      expect(s.resultFile).toBe("deployed");
      // .env pins the new release (mode 600, the quoted CA untouched); the clone sits at its commit.
      expect(s.pin).toBe("2.30.1");
      expect(s.envMode).toBe("600");
      expect(s.envFile).toContain("MIIBCgKCAQEAinsideAquotedValue=\n-----END CERTIFICATE-----");
      expect(s.head).toBe(commitOf("2.30.1"));
      expect(s.branch).toBe("main");
      // Only two anonymous API calls: the run and its approvals.
      expect(s.apiCalls).toEqual([
        `https://api.github.com/repos/deconfined/tarubot/actions/runs/${RUN_ID}`,
        `https://api.github.com/repos/deconfined/tarubot/actions/runs/${RUN_ID}/approvals`,
      ]);
    },
    slow,
  );

  test(
    "added migration files: stop, back up, migrate in the new image, pin, then start",
    () => {
      const s = scenario({ live: "2.30.1", request: "deploy 2.31.0" });
      expect(s.resultLine).toMatch(RESULT_FORM);
      expect(s.result).toMatchObject({
        outcome: "deployed",
        version: "2.31.0",
        previous: "2.30.1",
        path: "migration",
        commands: "registered",
        backup: "daily/tarubot-20260929T193000Z.dump.age",
        restore_point: "2026-09-29T19:30:05.123456Z",
        reason: "-",
      });
      // The migration runs in the new image while .env still pins the old release; the pin moves
      // before the start.
      expect(s.calls).toEqual([
        "compose pull tag=2.31.0",
        "compose config tag=2.31.0",
        "compose stop",
        "backup",
        "compose run tag=2.31.0 pin=2.30.1",
        "compose up tag=- pin=2.31.0 orphans",
        "exec register",
        "exec list",
      ]);
      expect(s.publicLines.slice(0, -1)).toEqual([
        "step preflight",
        "step pull",
        "step stop",
        "step backup",
        "step migrate",
        "step migrated",
        "step up",
        "step commands",
      ]);
      expect(s.pin).toBe("2.31.0");
      expect(s.head).toBe(commitOf("2.31.0"));
    },
    slow,
  );

  test(
    "a migration in the Tuesday maintenance window warns and still runs",
    () => {
      const inWindow = scenario({ live: "2.30.1", request: "deploy 2.31.0", now: "2 20" });
      expect(inWindow.result.outcome).toBe("deployed");
      expect(inWindow.publicLines).toContain("warning db-maintenance-window");
      expect(inWindow.publicLines.indexOf("warning db-maintenance-window")).toBeLessThan(
        inWindow.publicLines.indexOf("step stop"),
      );
      // After 23:00, on another day, or for a restart: no warning.
      for (const [live, request, now] of [
        ["2.30.1", "deploy 2.31.0", "2 23"],
        ["2.30.1", "deploy 2.31.0", "3 20"],
        ["2.30.0", "deploy 2.30.1", "2 20"],
      ] as const) {
        const s = scenario({ live, request, now });
        expect({
          now,
          request,
          lines: s.publicLines.filter((l) => l.startsWith("warning")),
        }).toEqual({ now, request, lines: [] });
      }
    },
    slow,
  );

  test(
    "a failed backup puts the previous release back with the unchanged .env",
    () => {
      const s = scenario({ live: "2.30.1", request: "deploy 2.31.0", knobs: { backup: "fail" } });
      expect(s.result).toMatchObject({
        outcome: "recovered",
        previous: "2.30.1",
        path: "migration",
        backup: "-",
        reason: "backup-failed",
      });
      expect(s.calls).toEqual([
        "compose pull tag=2.31.0",
        "compose config tag=2.31.0",
        "compose stop",
        "backup",
        "compose up tag=- pin=2.30.1",
      ]);
      expect(s.pin).toBe("2.30.1");
      expect(s.head).toBe(commitOf("2.30.1"));
    },
    slow,
  );

  test(
    "a failed migration stops its one-off container, then the previous release returns",
    () => {
      const s = scenario({
        live: "2.30.1",
        request: "deploy 2.31.0",
        knobs: { migrate: "fail", oneoff: "1" },
      });
      expect(s.result).toMatchObject({
        outcome: "recovered",
        reason: "migration-failed",
        backup: "daily/tarubot-20260929T193000Z.dump.age",
        restore_point: "-",
      });
      expect(s.calls).toEqual([
        "compose pull tag=2.31.0",
        "compose config tag=2.31.0",
        "compose stop",
        "backup",
        "compose run tag=2.31.0 pin=2.30.1",
        "stop-oneoff",
        "compose up tag=- pin=2.30.1",
      ]);
      expect(s.pin).toBe("2.30.1");
      expect(s.head).toBe(commitOf("2.30.1"));
    },
    slow,
  );

  test(
    "a failed migration whose previous release won't start asks for the owner",
    () => {
      const s = scenario({
        live: "2.30.1",
        request: "deploy 2.31.0",
        knobs: { migrate: "fail", "up.2.30.1": "fail-before-lease" },
      });
      expect(s.result).toMatchObject({
        outcome: "needs-you",
        reason: "migration-may-have-committed",
      });
      expect(s.pin).toBe("2.30.1");
    },
    slow,
  );

  test(
    "a new release that fails after its migration committed stays, pinned, for the owner",
    () => {
      const s = scenario({
        live: "2.30.1",
        request: "deploy 2.31.0",
        knobs: { "up.2.31.0": "fail-after-lease" },
      });
      expect(s.result).toMatchObject({
        outcome: "needs-you",
        reason: "new-release-failed",
        backup: "daily/tarubot-20260929T193000Z.dump.age",
        restore_point: "2026-09-29T19:30:05.123456Z",
        commands: "skipped",
      });
      expect(s.calls.at(-1)).toBe("compose up tag=- pin=2.31.0 orphans");
      expect(s.pin).toBe("2.31.0");
    },
    slow,
  );

  test(
    "health fails before the writer lease: stop, count again, put the previous release back",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "fail-before-lease" },
      });
      expect(s.result).toMatchObject({
        outcome: "recovered",
        previous: "2.30.0",
        path: "plain",
        reason: "did-not-start",
      });
      expect(s.calls).toEqual([
        "compose pull tag=2.30.1",
        "compose config tag=2.30.1",
        "compose up tag=2.30.1 pin=2.30.0 orphans",
        "compose stop",
        "compose up tag=- pin=2.30.0",
      ]);
      expect(s.pin).toBe("2.30.0");
      expect(s.head).toBe(commitOf("2.30.0"));
    },
    slow,
  );

  test(
    "a new container that never appeared: the previous release is put back",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "fail-no-container" },
      });
      expect(s.result).toMatchObject({ outcome: "recovered", reason: "did-not-start" });
      expect(s.calls).not.toContain("compose stop");
      expect(s.pin).toBe("2.30.0");
    },
    slow,
  );

  test(
    "health fails after the writer lease: no stop, no reset, and .env pins the new release",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "fail-after-lease" },
      });
      expect(s.result).toMatchObject({ outcome: "needs-you", reason: "new-release-took-lease" });
      expect(s.calls).toEqual([
        "compose pull tag=2.30.1",
        "compose config tag=2.30.1",
        "compose up tag=2.30.1 pin=2.30.0 orphans",
      ]);
      expect(s.pin).toBe("2.30.1");
      expect(s.head).toBe(commitOf("2.30.1"));
    },
    slow,
  );

  test(
    "logs without 'Modules loaded' are incomplete evidence: treated like the lease",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "fail-no-modules" },
      });
      expect(s.result).toMatchObject({ outcome: "needs-you", reason: "lease-evidence-incomplete" });
      expect(s.calls).not.toContain("compose stop");
      expect(s.pin).toBe("2.30.1");
    },
    slow,
  );

  test(
    "a lease that appears by the stop keeps the new release",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "fail-before-lease", lease_after_stop: "1" },
      });
      expect(s.result).toMatchObject({ outcome: "needs-you", reason: "new-release-took-lease" });
      expect(s.calls.slice(-2)).toEqual(["compose stop", "compose up tag=2.30.1 pin=2.30.0"]);
      expect(s.pin).toBe("2.30.1");
    },
    slow,
  );

  test(
    "a release that restarts within the stability minute is pinned and reported",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { "up.2.30.1": "unstable" },
      });
      expect(s.result).toMatchObject({ outcome: "needs-you", reason: "unstable" });
      expect(s.calls).not.toContain("exec register");
      expect(s.pin).toBe("2.30.1");
    },
    slow,
  );

  test(
    "a failed registration leaves the release live and asks for a retry",
    () => {
      const s = scenario({ live: "2.30.0", request: "deploy 2.30.1", knobs: { register: "fail" } });
      expect(s.result).toMatchObject({
        outcome: "needs-you",
        reason: "commands-failed",
        commands: "failed",
      });
      expect(s.calls.at(-1)).toBe("exec register");
      expect(s.pin).toBe("2.30.1");
    },
    slow,
  );

  test(
    "a rollback on the same schema restarts onto the older release",
    () => {
      const s = scenario({ live: "2.30.1", request: "rollback 2.30.0 from 2.30.1" });
      expect(s.resultLine).toMatch(RESULT_FORM);
      expect(s.result).toMatchObject({
        outcome: "deployed",
        version: "2.30.0",
        previous: "2.30.1",
        path: "rollback",
      });
      expect(s.calls).toEqual([
        "compose pull tag=2.30.0",
        "compose config tag=2.30.0",
        "compose up tag=2.30.0 pin=2.30.1 orphans",
        "exec register",
        "exec list",
      ]);
      expect(s.pin).toBe("2.30.0");
      expect(s.head).toBe(commitOf("2.30.0"));
    },
    slow,
  );

  test(
    "rollbacks across a migration, from a version that isn't live, or forward are refused",
    () => {
      for (const [live, request, reason] of [
        ["2.31.0", "rollback 2.30.1 from 2.31.0", "rollback-across-migration"],
        ["2.30.1", "rollback 2.30.0 from 2.31.0", "live-changed"],
        ["2.30.0", "rollback 2.30.1 from 2.30.0", "rollback-not-older"],
      ] as const) {
        const s = scenario({ live, request });
        expect({
          request,
          result: s.result.outcome,
          reason: s.result.reason,
          calls: s.calls,
        }).toEqual({ request, result: "refused", reason, calls: [] });
        expect(s.pin).toBe(live);
      }
    },
    slow,
  );

  test(
    "an older release than the live one is superseded, with nothing changed",
    () => {
      const s = scenario({ live: "2.31.0", request: "deploy 2.30.1" });
      expect(s.resultLine).toMatch(RESULT_FORM);
      expect(s.result).toMatchObject({
        outcome: "superseded",
        version: "2.30.1",
        previous: "2.31.0",
        path: "none",
        commands: "skipped",
      });
      expect(s.calls).toEqual([]);
      expect(s.resultFile).toBe("superseded");
    },
    slow,
  );

  test(
    "the live release is verified and its commands registered, with no pull or restart",
    () => {
      const s = scenario({ live: "2.30.1", request: "deploy 2.30.1" });
      expect(s.result).toMatchObject({
        outcome: "already-live",
        previous: "2.30.1",
        path: "none",
        commands: "registered",
        downtime: "-",
      });
      expect(s.calls).toEqual(["exec register", "exec list"]);
      const unhealthy = scenario({
        live: "2.30.1",
        request: "deploy 2.30.1",
        liveHealth: "unhealthy",
      });
      expect(unhealthy.result).toMatchObject({ outcome: "needs-you", reason: "live-unhealthy" });
      expect(unhealthy.calls).toEqual([]);
      const failing = scenario({
        live: "2.30.1",
        request: "deploy 2.30.1",
        knobs: { list: "fail" },
      });
      expect(failing.result).toMatchObject({ outcome: "needs-you", reason: "commands-failed" });
    },
    slow,
  );

  test("refusals before anything changes leave the pin, the clone and the containers alone", () => {
    const cases: [string, Scenario, string][] = [
      [
        "an edited applied migration",
        { live: "2.31.0", request: "deploy 2.31.1" },
        "applied-migration-changed",
      ],
      [
        "a manual change",
        { live: "2.30.0", request: "deploy 2.30.1", env: "TARUBOT_IMAGE_TAG=2.30.1\n" },
        "manual-change-in-progress",
      ],
      [
        "a stopped bot",
        { live: "2.30.0", request: "deploy 2.30.1", liveStatus: "exited" },
        "bot-not-running",
      ],
      [
        "a warn log level",
        {
          live: "2.30.0",
          request: "deploy 2.30.1",
          env: "TARUBOT_IMAGE_TAG=2.30.0\nLOG_LEVEL=warn\n",
        },
        "log-level",
      ],
      [
        "two pins",
        {
          live: "2.30.0",
          request: "deploy 2.30.1",
          env: "TARUBOT_IMAGE_TAG=2.30.0\nTARUBOT_IMAGE_TAG=2.30.0\n",
        },
        "env-file",
      ],
      [
        "an image override",
        {
          live: "2.30.0",
          request: "deploy 2.30.1",
          env: "TARUBOT_IMAGE_TAG=2.30.0\nTARUBOT_IMAGE=evil/image\n",
        },
        "env-file",
      ],
      ["a readable .env", { live: "2.30.0", request: "deploy 2.30.1", envMode: 0o644 }, "env-file"],
      [
        "a symlinked .env",
        { live: "2.30.0", request: "deploy 2.30.1", envSymlink: true },
        "env-file",
      ],
      [
        "a changed clone",
        { live: "2.30.0", request: "deploy 2.30.1", dirty: true },
        "clone-not-clean",
      ],
      [
        "a commit not on main",
        { live: "2.30.0", request: `deploy 2.32.0 @${"f".repeat(40)}` },
        "not-on-main",
      ],
      [
        "a version the commit doesn't carry",
        { live: "2.30.0", request: `deploy 2.30.2 @${commitOf("2.30.1")}` },
        "version-mismatch",
      ],
      ["a release below the floor", { live: "2.30.0", request: "deploy 2.29.2" }, "below-floor"],
      [
        "a backup that keeps running",
        { live: "2.30.0", request: "deploy 2.30.1", knobs: { backup_running: "100" } },
        "busy",
      ],
      [
        "an image that won't pull",
        { live: "2.30.0", request: "deploy 2.30.1", knobs: { pull: "fail" } },
        "pull-failed",
      ],
      [
        "another digest",
        { live: "2.30.0", request: "deploy 2.30.1", knobs: { "digest.2.30.1": "wrong" } },
        "digest-mismatch",
      ],
      [
        "a Compose file the .env can't satisfy",
        { live: "2.30.0", request: "deploy 2.30.1", knobs: { config: "fail" } },
        "compose-config",
      ],
    ];
    for (const [what, setup, reason] of cases) {
      const s = scenario(setup);
      expect({ what, outcome: s.result.outcome, reason: s.result.reason }).toEqual({
        what,
        outcome: "refused",
        reason,
      });
      expect({ what, changes: s.calls.filter((c) => !/^compose (pull|config)/u.test(c)) }).toEqual({
        what,
        changes: [],
      });
      expect({ what, head: s.head }).toEqual({ what, head: commitOf(setup.live) });
      expect(s.resultLine).toMatch(RESULT_FORM);
    }
  }, 120_000);

  test(
    "a backup that finishes within the wait lets the deploy go ahead",
    () => {
      const s = scenario({
        live: "2.30.0",
        request: "deploy 2.30.1",
        knobs: { backup_running: "2" },
      });
      expect(s.result.outcome).toBe("deployed");
    },
    slow,
  );

  test("the host checks the approval with GitHub and fails closed", () => {
    const approved = {
      state: "approved",
      user: { login: "deconfined" },
      environments: [{ name: "production" }],
    };
    const cases: [string, Partial<Scenario>, string][] = [
      [
        "another reviewer",
        { approvals: [{ ...approved, user: { login: "someone" } }] },
        "not-approved",
      ],
      ["a rejection", { approvals: [{ ...approved, state: "rejected" }] }, "not-approved"],
      [
        "another environment",
        { approvals: [{ ...approved, environments: [{ name: "notify" }] }] },
        "not-approved",
      ],
      ["no approval", { approvals: [] }, "not-approved"],
      ["a finished run", { run: { status: "completed" } }, "not-approved"],
      ["a re-run", { run: { run_attempt: 2 } }, "not-approved"],
      ["another workflow", { run: { path: ".github/workflows/ci.yml" } }, "not-approved"],
      ["another branch", { run: { head_branch: "feature" } }, "not-approved"],
      ["a fork", { run: { head_repository: { full_name: "someone/tarubot" } } }, "not-approved"],
      ["another target in the title", { run: { display_title: "Deploy 2.30.0" } }, "not-approved"],
      ["a pull-request event", { run: { event: "pull_request" } }, "not-approved"],
      ["an unreachable API", { knobs: { curl: "1" } }, "approval-unverified"],
      [
        "an answer that isn't JSON",
        { approvals: "<html>rate limited</html>" },
        "approval-unverified",
      ],
    ];
    for (const [what, setup, reason] of cases) {
      const s = scenario({ live: "2.30.0", request: "deploy 2.30.1", ...setup });
      expect({ what, outcome: s.result.outcome, reason: s.result.reason, calls: s.calls }).toEqual({
        what,
        outcome: "refused",
        reason,
        calls: [],
      });
    }
    // An automatic run is titled with the commit and can only deploy, never roll back.
    const automatic = (request: string, title: string) =>
      scenario({
        live: "2.30.0",
        request,
        run: { event: "workflow_run", display_title: title },
      }).result;
    expect(automatic("deploy 2.30.1", `Deploy ${commitOf("2.30.1")}`).outcome).toBe("deployed");
    expect(automatic("deploy 2.30.1", "Deploy 2.30.1").reason).toBe("not-approved");
    const rollback = scenario({
      live: "2.30.1",
      request: "rollback 2.30.0 from 2.30.1",
      run: { event: "workflow_run", display_title: `Deploy ${commitOf("2.30.0")}` },
    });
    expect(rollback.result.reason).toBe("not-approved");
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// The entry: attach, replay, a dead worker, and the detached launch
// ---------------------------------------------------------------------------------------------

describe("the entry", () => {
  const commit = hex("entry commit", 40);
  const digest = `sha256:${hex("entry digest")}`;
  const request = `deploy 2.30.1 ${commit} ${digest} ${RUN_ID}`;
  const result = (outcome: string, reason = "-") =>
    `result outcome=${outcome} version=2.30.1 previous=2.30.0 path=plain downtime=4 commands=registered backup=- restore_point=- reason=${reason}`;

  /** A run directory with the given files. */
  function runDir(box: Sandbox, files: Record<string, string>) {
    const dir = join(box.state, "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  const entry = (box: Sandbox, command = request, self = join(box.bin, "worker")) =>
    run(
      ["bash", join(STUBS, "run-entry.sh")],
      environment(box, { SSH_ORIGINAL_COMMAND: command, DEPLOY_SELF: self }),
    );

  test("a finished run replays its public lines only, and exits by its outcome", () => {
    const box = sandbox();
    runDir(box, {
      request: `${request}\n`,
      "public.log": `step preflight\nstep up\n::error::not a public line\nstep commands\n${result("deployed")}\n`,
      result: "deployed\n",
    });
    const replay = entry(box);
    expect(replay.code).toBe(0);
    expect(replay.stdout).toBe(`step preflight\nstep up\nstep commands\n${result("deployed")}\n`);
    const refusedBox = sandbox();
    runDir(refusedBox, {
      request: `${request}\n`,
      "public.log": `${result("refused", "busy")}\n`,
      result: "refused\n",
    });
    expect(entry(refusedBox).code).toBe(1);
  });

  test("the committed v1 run directory still replays", () => {
    const box = sandbox();
    const fixture = root("tests/fixtures/deploy-runs/v1/36300000001");
    const dir = join(box.state, "runs", "36300000001");
    mkdirSync(dir, { recursive: true });
    // public.log is stored as public.log.fixture: .gitignore and .dockerignore leave out *.log.
    cpSync(join(fixture, "request"), join(dir, "request"));
    cpSync(join(fixture, "result"), join(dir, "result"));
    cpSync(join(fixture, "public.log.fixture"), join(dir, "public.log"));
    const replay = entry(box, readFileSync(join(fixture, "request"), "utf8").trim());
    expect(replay.code).toBe(0);
    expect(replay.stdout).toBe(readFileSync(join(fixture, "public.log.fixture"), "utf8"));
    // Its result line is what the workflow parses.
    expect(replay.stdout.trim().split("\n").at(-1)).toMatch(RESULT_FORM);
  });

  test("a different request under the same run id is refused", () => {
    const box = sandbox();
    runDir(box, { request: `deploy 2.30.2 ${commit} ${digest} ${RUN_ID}\n` });
    const attempt = entry(box);
    expect(attempt.code).toBe(64);
    expect(attempt.stdout).toBe(`${USAGE}\n`);
  });

  test("a free run lock with a step and no result reports the dead worker", () => {
    const box = sandbox();
    const dir = runDir(box, {
      request: `${request}\n`,
      step: "up\n",
      "public.log": "step preflight\nstep pull\nstep up\n",
    });
    const died = entry(box);
    expect(died.code).toBe(1);
    const line =
      "result outcome=needs-you version=2.30.1 previous=- path=none downtime=- commands=skipped backup=- restore_point=- reason=worker-died";
    expect(died.stdout).toBe(`step preflight\nstep pull\nstep up\nstep up\n${line}\n`);
    expect(line).toMatch(RESULT_FORM);
    expect(readFileSync(join(dir, "result"), "utf8")).toBe("needs-you\n");
  });

  test("a busy run lock is followed until the worker's result", async () => {
    const box = sandbox();
    const dir = runDir(box, { request: `${request}\n`, "public.log": "step preflight\n" });
    // A stand-in worker holds the run lock, writes two more lines and the result, then exits.
    const holder = Bun.spawn(
      [
        "flock",
        join(dir, "lock"),
        "bash",
        "-c",
        'touch "$1/held"; sleep 0.4; printf "step up\\n" >>"$1/public.log"; sleep 0.4; printf "%s\\n" "$2" >>"$1/public.log"; printf "deployed\\n" >"$1/result"',
        "holder",
        dir,
        result("deployed"),
      ],
      { env: { PATH: "/usr/bin:/bin" } },
    );
    for (let i = 0; i < 100 && !existsSync(join(dir, "held")); i++) await Bun.sleep(20);
    const followed = entry(box);
    await holder.exited;
    expect(followed.code).toBe(0);
    expect(followed.stdout).toBe(`step preflight\nstep up\n${result("deployed")}\n`);
  }, 20_000);

  test("a new run launches the worker and, if it never starts, says nothing changed", () => {
    const box = sandbox();
    // A worker that exits at once without writing a step.
    const quiet = join(box.bin, "quiet-worker");
    writeFileSync(quiet, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(quiet, 0o755);
    const attempt = entry(box, request, quiet);
    expect(attempt.code).toBe(1);
    const line =
      "result outcome=refused version=2.30.1 previous=- path=none downtime=- commands=skipped backup=- restore_point=- reason=worker-not-started";
    expect(attempt.stdout).toBe(`${line}\n`);
    expect(readFileSync(join(box.state, "runs", RUN_ID, "request"), "utf8")).toBe(`${request}\n`);
  }, 20_000);

  test("the worker survives the SSH session's hangup, with a clean environment and the run lock", async () => {
    const box = sandbox();
    const self = join(box.bin, "worker");
    cpSync(join(STUBS, "worker"), self);
    chmodSync(self, 0o755);
    const launched = Bun.spawn(["setsid", "-w", "bash", join(STUBS, "run-launch.sh")], {
      env: environment(box, {
        DEPLOY_SELF: self,
        REQUEST: request,
        SSH_ORIGINAL_COMMAND: request,
        // What sshd could pass on, and what Compose would read: none of it reaches the worker.
        DOCKER_HOST: "tcp://attacker.invalid:2375",
        TARUBOT_IMAGE_TAG: "9.9.9",
        DEPLOY_TEST_SECRET: "must-not-reach-the-worker",
      }),
      stdin: "ignore",
    });
    await launched.exited;
    const lock = join(box.state, "runs", RUN_ID, "lock");
    const wait = async (name: string) => {
      for (let i = 0; i < 300 && !existsSync(join(box.home, name)); i++) await Bun.sleep(100);
      return existsSync(join(box.home, name));
    };
    expect(await wait("stub-started")).toBe(true);
    // While the worker runs, it holds the run lock the entry took.
    expect(run(["flock", "-n", lock, "true"], { PATH: "/usr/bin:/bin" }).code).toBe(1);
    expect(await wait("stub-done")).toBe(true);
    await Bun.sleep(200);
    expect(run(["flock", "-n", lock, "true"], { PATH: "/usr/bin:/bin" }).code).toBe(0);
    expect(readFileSync(join(box.home, "stub-args"), "utf8").trim().split("\n")).toEqual([
      "__worker",
      "deploy",
      "2.30.1",
      commit,
      digest,
      RUN_ID,
      "-",
    ]);
    expect(readFileSync(join(box.home, "stub-fd8"), "utf8")).toBe("open\n");
    // env -i: only HOME, the fixed PATH and the C locale, plus what bash itself sets.
    const names = readFileSync(join(box.home, "stub-env"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")))
      .filter((name) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(name))
      .sort();
    expect(names).toEqual(["HOME", "LC_ALL", "PATH"]);
    const env = readFileSync(join(box.home, "stub-env"), "utf8");
    expect(env).toContain("PATH=/usr/local/bin:/usr/bin:/bin\n");
    expect(env).toContain("LC_ALL=C\n");
  }, 40_000);
});
