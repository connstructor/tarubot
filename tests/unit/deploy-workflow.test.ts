/**
 * The "Deploy production" workflow (.github/workflows/deploy.yml, 2.30.0, issue #41) and what the
 * other workflows must not do around it.
 *
 * - Shape: the triggers, the first-attempt rule on every job, least permissions, no action and no
 *   checkout, every ${{ }} through env:, no concurrency group, and which job may see which
 *   environment, secret and variable.
 * - The command contract and the result line are the same patterns as ops/deploy.sh's.
 * - The repository names no host: the workflow and ops/deploy.sh carry no host name beyond
 *   GitHub's, the registry's and Pushover's.
 * - Behavior: the plan, SSH and notify scripts run here with simulated gh, docker, ssh and curl
 *   (tests/fixtures/deploy-workflow) to check the runtime-change rule, the gates, the SSH retry
 *   rules and the messages.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { z } from "zod";

/** A repository path, resolved relative to this test. */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");
const STUBS = root("tests/fixtures/deploy-workflow");
const hasJq = Bun.which("jq") !== null;

const step = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    if: z.string().optional(),
    uses: z.string().optional(),
    run: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
const job = z
  .object({
    name: z.string(),
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    if: z.string(),
    "runs-on": z.string(),
    "timeout-minutes": z.number(),
    environment: z.string().optional(),
    permissions: z.record(z.string(), z.string()),
    outputs: z.record(z.string(), z.string()).optional(),
    steps: z.array(step),
  })
  .strict();
const workflow = z
  .object({
    name: z.literal("Deploy production"),
    "run-name": z.string(),
    on: z.object({
      workflow_run: z.object({
        workflows: z.array(z.string()),
        types: z.array(z.string()),
        branches: z.array(z.string()),
      }),
      workflow_dispatch: z.object({
        inputs: z.record(
          z.string(),
          z.object({
            description: z.string(),
            required: z.boolean().optional(),
            type: z.string(),
            default: z.union([z.string(), z.boolean()]).optional(),
          }),
        ),
      }),
    }),
    permissions: z.record(z.string(), z.string()),
    defaults: z.object({ run: z.object({ shell: z.literal("bash") }) }),
    jobs: z.object({ plan: job, deploy: job, notify: job }).strict(),
  })
  .strict();

const text = read(".github/workflows/deploy.yml");
const deploy = workflow.parse(YAML.parse(text));
const script = read("ops/deploy.sh");
/** One step's script, by its id or name. */
const runOf = (jobName: "plan" | "deploy" | "notify", key: string) => {
  const found = deploy.jobs[jobName].steps.find((s) => s.id === key || s.name === key);
  if (!found?.run) throw new Error(`no step ${key} in ${jobName}`);
  return found.run;
};

describe("the workflow's shape", () => {
  test("runs after a successful publish of main, or by hand from main", () => {
    const publish = z
      .object({ name: z.string() })
      .passthrough()
      .parse(YAML.parse(read(".github/workflows/publish.yml")));
    expect(deploy.on.workflow_run).toEqual({
      workflows: [publish.name],
      types: ["completed"],
      branches: ["main"],
    });
    expect(deploy.on.workflow_dispatch.inputs).toEqual({
      version: expect.objectContaining({ required: true, type: "string" }),
      rollback: expect.objectContaining({ type: "boolean", default: false }),
      from: expect.objectContaining({ type: "string", default: "" }),
    });
    const plan = deploy.jobs.plan.if;
    for (const term of [
      "vars.DEPLOY_ENABLED == 'true'",
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.path == '.github/workflows/publish.yml'",
      "github.event.workflow_run.head_repository.full_name == github.repository",
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    ])
      expect({ term, present: plan.includes(term) }).toEqual({ term, present: true });
  });

  test("refuses re-runs: every job requires the first attempt", () => {
    for (const [name, j] of Object.entries(deploy.jobs))
      expect({ name, first: j.if.trim().startsWith("github.run_attempt == '1' &&") }).toEqual({
        name,
        first: true,
      });
    expect(deploy.jobs.deploy.if).toContain("needs.plan.outputs.deploy == 'true'");
    expect(deploy.jobs.notify.if).toContain("always() && needs.plan.result != 'skipped'");
  });

  test("titles each run with its target, as ops/deploy.sh expects", () => {
    const title = deploy["run-name"];
    expect(title).toContain("format('Deploy {0}{1}', inputs.version,");
    expect(title).toContain("inputs.rollback && format(' rollback from {0}', inputs.from) || ''");
    expect(title).toContain("format('Deploy {0}', github.event.workflow_run.head_sha)");
    // The host builds the same three titles.
    expect(script).toContain('title="Deploy $V rollback from $F"');
    expect(script).toContain('title="Deploy $V"');
    expect(script).toContain('.display_title == ("Deploy " + $commit)');
  });

  test("holds least permissions: nothing at the top, read-only for the plan", () => {
    expect(deploy.permissions).toEqual({});
    expect(deploy.jobs.plan.permissions).toEqual({ contents: "read", actions: "read" });
    expect(deploy.jobs.deploy.permissions).toEqual({});
    expect(deploy.jobs.notify.permissions).toEqual({});
  });

  test("uses no action, no checkout, no expression inside a script, no tracing, no concurrency", () => {
    for (const j of Object.values(deploy.jobs))
      for (const s of j.steps) {
        expect(s.uses).toBeUndefined();
        expect(s.run ?? "").not.toContain("${{");
        expect(s.run ?? "").not.toMatch(/set -[a-zA-Z]*x/u);
      }
    expect(text).not.toMatch(/^\s*concurrency:/mu);
    expect(text).not.toContain("actions/checkout");
  });

  test("keeps secrets and variables in the jobs and environments that need them", () => {
    const refs = (value: unknown, kind: "secrets" | "vars") =>
      [...JSON.stringify(value).matchAll(new RegExp(`${kind}\\.([A-Z_]+)`, "gu"))]
        .map((m) => m[1])
        .sort();
    const { plan, deploy: run, notify } = deploy.jobs;
    expect(plan.environment).toBeUndefined();
    expect(refs(plan, "secrets")).toEqual([]);
    expect(refs(plan, "vars")).toEqual(["DEPLOY_ENABLED"]);
    expect(run.environment).toBe("production");
    expect(refs(run, "secrets")).toEqual(["DEPLOY_SSH_KEY"]);
    expect(refs(run, "vars")).toEqual(["DEPLOY_ENABLED", "DEPLOY_HOST", "DEPLOY_KNOWN_HOSTS"]);
    expect(notify.environment).toBe("notify");
    expect(refs(notify, "secrets")).toEqual(["PUSHOVER_TOKEN", "PUSHOVER_USER"]);
    expect(refs(notify, "vars")).toEqual([]);
    // The key's file is removed even when the deploy fails or is cancelled.
    const cleanup = run.steps.at(-1);
    expect(cleanup).toEqual({
      name: "Remove the key",
      if: "always()",
      run: 'rm -rf "$RUNNER_TEMP/ssh"',
    });
  });

  test("pins the host key and uses only the deploy key", () => {
    const ssh = runOf("deploy", "ssh");
    for (const option of [
      "-F /dev/null",
      "-o IdentitiesOnly=yes",
      "-o IdentityAgent=none",
      "-o BatchMode=yes",
      "-o StrictHostKeyChecking=yes",
      '-o UserKnownHostsFile="$dir/kh"',
      "-o GlobalKnownHostsFile=/dev/null",
      "-o UpdateHostKeys=no",
      "-o HostKeyAlgorithms=ssh-ed25519",
    ])
      expect({ option, present: ssh.includes(option) }).toEqual({ option, present: true });
    expect(ssh).not.toMatch(/accept-new|StrictHostKeyChecking=no|VerifyHostKeyDNS/u);
    expect(ssh).toContain("unset DEPLOY_SSH_KEY");
    expect(ssh).toContain("KNOWN_HOST='^([^ ]+) ssh-ed25519 [A-Za-z0-9+/]+={0,2}$'");
    expect(ssh).toContain('"tarubot@$DEPLOY_HOST" "$CMD"');
  });
});

describe("the contract with ops/deploy.sh", () => {
  /** A single-quoted pattern assignment, NAME='…', from a script. */
  const pattern = (source: string, name: string) => {
    const found = new RegExp(`${name}='([^']+)'`, "u").exec(source)?.[1];
    if (!found) throw new Error(`no ${name}`);
    return found;
  };

  test("the command forms and the result line are the same patterns on both sides", () => {
    const ssh = runOf("deploy", "ssh");
    for (const name of ["DEPLOY_FORM", "ROLLBACK_FORM", "RESULT_FORM", "STEP_LINE", "WARNING_LINE"])
      expect({ name, same: pattern(ssh, name) }).toEqual({ name, same: pattern(script, name) });
  });

  test("the forms accept what the workflow builds and nothing looser", () => {
    const deployForm = new RegExp(pattern(script, "DEPLOY_FORM"), "u");
    const rollbackForm = new RegExp(pattern(script, "ROLLBACK_FORM"), "u");
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const digest = `sha256:${"ab".repeat(32)}`;
    expect(deployForm.exec(`deploy 2.30.1 ${commit} ${digest} 36300000042`)?.slice(1)).toEqual([
      "2.30.1",
      "2",
      "30",
      "1",
      commit,
      digest,
      "36300000042",
    ]);
    expect(rollbackForm.exec(`rollback 2.30.0 ${commit} ${digest} 1 2.30.1`)?.[8]).toBe("2.30.1");
    for (const bad of [
      `deploy 2.30.1 ${commit} ${digest} 36300000042 2.30.0`,
      `deploy 2.30.01 ${commit} ${digest} 1`,
      `deploy 2.30.1 ${commit.toUpperCase()} ${digest} 1`,
      `rollback 2.30.0 ${commit} ${digest} 1`,
    ])
      expect({ bad, ok: deployForm.test(bad) || rollbackForm.test(bad) }).toEqual({
        bad,
        ok: false,
      });
  });

  test("the plan and the host agree on the version pattern", () => {
    expect(pattern(runOf("plan", "plan"), "VER")).toBe(pattern(script, "readonly VERSION"));
  });
});

describe("no host in the repository", () => {
  /**
   * Every host name ending in a common top-level domain, whatever surrounds it (not .sh, which
   * would take the scripts' own file names).
   */
  const hostNames = (source: string) =>
    [
      ...source.matchAll(
        /((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cloud|co|me|xyz|site|tech))(?:$|[^a-z0-9-])/gimu,
      ),
    ].map((m) => (m[1] ?? "").toLowerCase());
  const allowed = new Set(["github.com", "api.github.com", "ghcr.io", "api.pushover.net"]);

  test("the workflow and ops/deploy.sh name no host beyond GitHub, GHCR and Pushover", () => {
    for (const [file, source] of [
      [".github/workflows/deploy.yml", text],
      ["ops/deploy.sh", script],
    ] as const) {
      const hosts = [...new Set(hostNames(source))].filter((host) => !allowed.has(host));
      expect({ file, hosts }).toEqual({ file, hosts: [] });
      // No address literal either.
      expect({ file, ip: /\b\d{1,3}(?:\.\d{1,3}){3}\b/u.test(source) }).toEqual({
        file,
        ip: false,
      });
    }
    // The host comes from the production environment's variable.
    expect(runOf("deploy", "ssh")).toContain("[[ $DEPLOY_HOST =~ $HOST_NAME ]]");
  });

  test("the host check catches what it must", () => {
    const samples = [
      "ssh to deploy.example.com.",
      "deploy.example.net ssh-ed25519 AAAA",
      "`tarubot@bot.example.org`",
      "https://host.example.io/health",
      "HOST.EXAMPLE.COM",
    ];
    for (const sample of samples)
      expect({ sample, caught: hostNames(sample).some((h) => !allowed.has(h)) }).toEqual({
        sample,
        caught: true,
      });
    expect(hostNames("https://api.github.com/repos and ghcr.io/deconfined/tarubot")).toEqual([
      "api.github.com",
      "ghcr.io",
    ]);
  });
});

describe("the other workflows", () => {
  const files = readdirSync(root(".github/workflows")).filter((f) => /\.ya?ml$/u.test(f));

  test("only deploy.yml names the deploy environments, key, host and Pushover secrets", () => {
    for (const file of files) {
      const source = read(`.github/workflows/${file}`);
      const named =
        /environment:\s*(?:production|notify)\b|DEPLOY_SSH_KEY|DEPLOY_KNOWN_HOSTS|DEPLOY_HOST|PUSHOVER_/u.test(
          source,
        );
      expect({ file, named }).toEqual({ file, named: file === "deploy.yml" });
      // No workflow runs untrusted pull-request code with the repository's secrets.
      expect({ file, target: source.includes("pull_request_target") }).toEqual({
        file,
        target: false,
      });
    }
  });

  test("publish.yml builds from main only: no tag trigger", () => {
    const publish = z
      .object({
        on: z.object({ push: z.object({ branches: z.array(z.string()) }).strict() }).passthrough(),
        jobs: z.object({ publish: z.object({ if: z.string() }).passthrough() }).passthrough(),
      })
      .passthrough()
      .parse(YAML.parse(read(".github/workflows/publish.yml")));
    expect(publish.on.push).toEqual({ branches: ["main"] });
    expect(publish.jobs.publish.if).toBe("github.ref == 'refs/heads/main'");
  });

  test("CI checks the host scripts with ShellCheck", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("shellcheck -S warning ops/*.sh");
  });
});

// ---------------------------------------------------------------------------------------------
// The scripts, run with simulated tools
// ---------------------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "deploy-workflow-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let boxes = 0;

/** A directory with the stubs on a PATH, a GITHUB_OUTPUT and a summary file. */
function box() {
  const dir = join(scratch, `b${++boxes}`);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of readdirSync(STUBS)) {
    cpSync(join(STUBS, name), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(dir, "output"), "");
  writeFileSync(join(dir, "summary"), "");
  return { dir, bin };
}

/** Run one workflow script with the given environment; returns status, stdout and outputs. */
function runScript(
  source: string,
  where: { dir: string; bin: string },
  env: Record<string, string>,
) {
  const result = Bun.spawnSync(["bash", "-c", source], {
    env: {
      PATH: `${where.bin}:/usr/bin:/bin`,
      HOME: where.dir,
      STUB: where.dir,
      GITHUB_OUTPUT: join(where.dir, "output"),
      GITHUB_STEP_SUMMARY: join(where.dir, "summary"),
      GITHUB_REPOSITORY: "deconfined/tarubot",
      GITHUB_RUN_ID: "36300000042",
      GITHUB_SERVER_URL: "https://github.com",
      RUNNER_TEMP: where.dir,
      ...env,
    },
    stdin: "ignore",
  });
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(join(where.dir, "output"), "utf8").split("\n"))
    if (line.includes("="))
      outputs[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1);
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    outputs,
    summary: readFileSync(join(where.dir, "summary"), "utf8"),
  };
}

describe("the SSH step", () => {
  const host = "deploy.example.invalid";
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const digest = `sha256:${"ab".repeat(32)}`;
  const base = {
    DEPLOY_SSH_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
    DEPLOY_HOST: host,
    DEPLOY_KNOWN_HOSTS: `${host} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBx9`,
    ACTION: "deploy",
    VERSION: "2.30.1",
    COMMIT: commit,
    DIGEST: digest,
    FROM: "-",
  };

  /** Run the step with ssh behaviors, one per connection attempt. */
  function ssh(behaviors: string[], env: Record<string, string> = {}) {
    const where = box();
    writeFileSync(join(where.dir, "plan"), `${behaviors.join("\n")}\n`);
    const result = runScript(runOf("deploy", "ssh"), where, { ...base, ...env });
    const calls = existsSync(join(where.dir, "ssh-calls"))
      ? readFileSync(join(where.dir, "ssh-calls"), "utf8")
      : "";
    const sleeps = existsSync(join(where.dir, "sleeps"))
      ? readFileSync(join(where.dir, "sleeps"), "utf8").trim().split("\n")
      : [];
    return {
      ...result,
      dir: where.dir,
      calls,
      attempts: (calls.match(/^call /gmu) ?? []).length,
      sleeps,
    };
  }

  test("sends the contract command once, echoes only fixed lines, and reports the result", () => {
    const s = ssh(["ok"]);
    expect(s.code).toBe(0);
    expect(s.stdout).toBe(
      "step preflight\nstep up\nresult outcome=deployed version=2.30.1 previous=2.30.0 path=plain downtime=4 commands=registered backup=- restore_point=- reason=-\n",
    );
    expect(s.outputs).toMatchObject({
      connected: "true",
      outcome: "deployed",
      previous: "2.30.0",
      path: "plain",
      downtime: "4",
      commands: "registered",
      reason: "-",
    });
    // The key's variable is gone before ssh runs; the command is the last argument.
    expect(s.calls).toContain("key-variable=\n");
    expect(s.calls).toContain(`tarubot@${host}\ndeploy 2.30.1 ${commit} ${digest} 36300000042\n`);
    expect(readFileSync(join(s.dir, "ssh", "kh"), "utf8")).toBe(`${base.DEPLOY_KNOWN_HOSTS}\n`);
  });

  test("a rollback carries the live version it leaves", () => {
    const s = ssh(["ok"], { ACTION: "rollback", VERSION: "2.30.0", FROM: "2.30.1" });
    expect(s.calls).toContain(`rollback 2.30.0 ${commit} ${digest} 36300000042 2.30.1\n`);
  });

  test("retries a dropped connection with the same command, and stops on a result", () => {
    const s = ssh(["partial", "drop", "ok"]);
    expect(s.code).toBe(0);
    expect(s.attempts).toBe(3);
    expect(s.sleeps).toEqual(["20", "20"]);
    expect(s.outputs.outcome).toBe("deployed");
  });

  test("a host that needs the owner fails the job with its outcome and reason", () => {
    const s = ssh(["needs-you"]);
    expect(s.code).toBe(1);
    expect(s.outputs).toMatchObject({ outcome: "needs-you", reason: "new-release-took-lease" });
  });

  test("passes the maintenance-window warning on as an annotation and an output", () => {
    const s = ssh(["warning"]);
    expect(s.code).toBe(0);
    expect(s.stdout).toContain("::warning::The host reports: db-maintenance-window\n");
    expect(s.outputs.warnings).toBe("db-maintenance-window");
  });

  test("never retries a changed host key or a rejected key", () => {
    const changed = ssh(["hostkey", "ok"]);
    expect(changed.code).toBe(1);
    expect(changed.attempts).toBe(1);
    expect(changed.outputs.reason).toBe("host-key");
    const rejected = ssh(["denied", "ok"]);
    expect(rejected.attempts).toBe(1);
    expect(rejected.outputs.reason).toBe("key-rejected");
    // ssh's own messages stay private.
    expect(changed.stdout + changed.stderr).not.toContain("Host key verification failed");
  });

  test("tells a refused format, a lost host and a host never reached apart", () => {
    expect(ssh(["usage"]).outputs).toMatchObject({ reason: "bad-request", connected: "true" });
    expect(ssh(["partial", "quiet"]).outputs).toMatchObject({
      reason: "outcome-unknown",
      connected: "true",
    });
    expect(ssh(["drop", "quiet"]).outputs).toMatchObject({
      reason: "unreachable",
      connected: "false",
    });
  });

  test("refuses host settings that aren't one pinned ed25519 key for DEPLOY_HOST", () => {
    for (const env of [
      { DEPLOY_HOST: "Deploy.Example.Invalid" },
      { DEPLOY_HOST: `${host} -oProxyCommand=x` },
      { DEPLOY_HOST: "" },
      { DEPLOY_KNOWN_HOSTS: `other.example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5` },
      { DEPLOY_KNOWN_HOSTS: `${host} ssh-rsa AAAAB3NzaC1yc2E=` },
      { DEPLOY_KNOWN_HOSTS: `${host} ssh-ed25519 AAAA\n${host} ssh-ed25519 BBBB` },
      { DEPLOY_KNOWN_HOSTS: `${host},1.2.3.4 ssh-ed25519 AAAA` },
    ]) {
      const s = ssh(["ok"], env);
      expect({ env, code: s.code, reason: s.outputs.reason, attempts: s.attempts }).toEqual({
        env,
        code: 1,
        reason: "known-hosts",
        attempts: 0,
      });
    }
    expect(ssh(["ok"], { DEPLOY_SSH_KEY: "" }).outputs.reason).toBe("no-key");
    // A trailing newline in the variable is tolerated.
    expect(ssh(["ok"], { DEPLOY_KNOWN_HOSTS: `${base.DEPLOY_KNOWN_HOSTS}\n` }).code).toBe(0);
  });

  test("refuses plan fields that don't fit the contract", () => {
    const s = ssh(["ok"], { VERSION: "2.30.1; id" });
    expect(s.outputs.reason).toBe("bad-request");
    expect(s.attempts).toBe(0);
  });
});

describe("the notify step", () => {
  /** Run the step and return the message, priority and what curl received. */
  function notify(env: Record<string, string>) {
    const where = box();
    const result = runScript(runOf("notify", "Send one Pushover message"), where, {
      PUSHOVER_TOKEN: "app-token",
      PUSHOVER_USER: "user-key",
      PLAN_RESULT: "success",
      PLAN_DEPLOY: "true",
      PLAN_VERSION: "2.30.1",
      PLAN_REASON: "-",
      PLAN_ACTION: "deploy",
      DEPLOY_RESULT: "success",
      STARTED: "true",
      OUTCOME: "",
      REASON: "",
      PREVIOUS: "2.30.0",
      DEPLOY_PATH: "plain",
      DOWNTIME: "4",
      COMMANDS: "registered",
      BACKUP: "-",
      RESTORE_POINT: "-",
      WARNINGS: "",
      ...env,
    });
    const args = existsSync(join(where.dir, "curl-args"))
      ? readFileSync(join(where.dir, "curl-args"), "utf8").split("\n")
      : [];
    const field = (name: string) =>
      args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
    return {
      ...result,
      args,
      message: field("message"),
      priority: field("priority"),
      config: existsSync(join(where.dir, "curl-config"))
        ? readFileSync(join(where.dir, "curl-config"), "utf8")
        : "",
    };
  }

  test("reports each outcome with its priority", () => {
    const cases: [Record<string, string>, string, string][] = [
      [{ OUTCOME: "deployed" }, "2.30.1 deployed (restart, down 4s; commands registered)", "0"],
      [
        {
          OUTCOME: "deployed",
          DEPLOY_PATH: "migration",
          DOWNTIME: "31",
          WARNINGS: "db-maintenance-window",
        },
        "2.30.1 deployed (migration, down 31s; commands registered) The migration ran during the database maintenance window.",
        "0",
      ],
      [{ OUTCOME: "already-live" }, "2.30.1 is live and verified; commands registered", "-1"],
      [
        { OUTCOME: "superseded", PREVIOUS: "2.31.0" },
        "2.30.1 skipped: newer release 2.31.0 is live",
        "-1",
      ],
      [{ OUTCOME: "refused", REASON: "busy" }, "2.30.1 not deployed, nothing changed: busy", "0"],
      [
        { OUTCOME: "refused", REASON: "paused" },
        "2.30.1 not deployed: deploys were paused after the request (nothing changed)",
        "-1",
      ],
      [
        { OUTCOME: "recovered", REASON: "did-not-start", DOWNTIME: "40" },
        "2.30.1 not deployed; 2.30.0 is back (down 40s): did-not-start",
        "1",
      ],
      [
        {
          OUTCOME: "needs-you",
          REASON: "new-release-failed",
          BACKUP: "daily/tarubot-20260929T193000Z.dump.age",
          RESTORE_POINT: "2026-09-29T19:30:05.123456Z",
        },
        "NEEDS YOU: 2.30.1 new-release-failed; restore point 2026-09-29T19:30:05.123456Z; backup daily/tarubot-20260929T193000Z.dump.age",
        "1",
      ],
      [
        { OUTCOME: "needs-you", REASON: "new-release-took-lease" },
        "NEEDS YOU: 2.30.1 new-release-took-lease. To go back, run Deploy production with version=2.30.0 rollback=true from=2.30.1.",
        "1",
      ],
      [
        { OUTCOME: "needs-you", REASON: "commands-failed" },
        "2.30.1 is live, but command registration failed; run Deploy production with 2.30.1 to retry",
        "1",
      ],
      [
        { REASON: "host-key" },
        "2.30.1 not deployed: the host key changed. Check the host before updating DEPLOY_KNOWN_HOSTS.",
        "1",
      ],
      [{ REASON: "key-rejected" }, "2.30.1 not deployed: the host refused the deploy key", "1"],
      [{ REASON: "unreachable" }, "2.30.1 not deployed: host unreachable, nothing started", "1"],
      [
        { REASON: "outcome-unknown" },
        "2.30.1: outcome unknown; the host continues on its own (run 36300000042)",
        "1",
      ],
      [
        { STARTED: "", DEPLOY_RESULT: "failure" },
        "2.30.1 not approved (rejected or expired)",
        "-1",
      ],
      [
        { PLAN_DEPLOY: "false" },
        "2.30.1: no runtime change in this merge. If an earlier release wasn't deployed, run Deploy production with the newest version.",
        "-1",
      ],
      [
        { PLAN_RESULT: "failure", PLAN_REASON: "digest-mismatch" },
        "2.30.1 not deployable: digest-mismatch (see the run)",
        "0",
      ],
      [
        { PLAN_RESULT: "failure", PLAN_VERSION: "", PLAN_REASON: "" },
        "? not deployable: ? (see the run)",
        "0",
      ],
    ];
    for (const [env, message, priority] of cases) {
      const n = notify(env);
      expect({ env, message: n.message, priority: n.priority }).toEqual({ env, message, priority });
    }
  });

  test("a rollback's message says what to requeue", () => {
    const n = notify({
      OUTCOME: "deployed",
      DEPLOY_PATH: "rollback",
      PLAN_ACTION: "rollback",
      PREVIOUS: "2.30.2",
    });
    expect(n.message).toBe(
      "2.30.1 deployed (rollback, down 4s; commands registered). Work only 2.30.2 understood fails as invalid_job: check /sync status and requeue it with retry.js.",
    );
  });

  test("the credentials reach curl on stdin, never in its arguments", () => {
    const n = notify({ OUTCOME: "deployed" });
    expect(n.config).toBe('form-string = "token=app-token"\nform-string = "user=user-key"\n');
    expect(n.args.join(" ")).not.toMatch(/app-token|user-key/u);
    expect(n.args).toContain("https://api.pushover.net/1/messages.json");
    expect(n.args).toContain("url=https://github.com/deconfined/tarubot/actions/runs/36300000042");
  });

  test("values that don't match their pattern never reach the message", () => {
    const n = notify({ OUTCOME: "refused", REASON: "busy; rm -rf /", PLAN_VERSION: "2.30.1\nx" });
    expect(n.message).toBe("? not deployed, nothing changed: ?");
  });

  test("without Pushover set up, it sends nothing and succeeds", () => {
    const n = notify({ OUTCOME: "deployed", PUSHOVER_TOKEN: "" });
    expect(n.code).toBe(0);
    expect(n.args).toEqual([]);
  });
});

describe.skipIf(!hasJq)("the plan step", () => {
  const R = "repos/deconfined/tarubot";
  const sha = (seed: string) => new Bun.CryptoHasher("sha1").update(seed).digest("hex");
  const C = sha("release");
  const P = sha("previous");
  const D = `sha256:${"cd".repeat(32)}`;
  /** A file of the simulated API, named as the gh stub looks it up. */
  const api = (dir: string, path: string, body: unknown) => {
    mkdirSync(join(dir, "api"), { recursive: true });
    writeFileSync(
      join(dir, "api", path.replaceAll(/[/?=]/gu, "_")),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  };
  const production = {
    can_admins_bypass: false,
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    protection_rules: [
      { type: "branch_policy" },
      {
        type: "required_reviewers",
        prevent_self_review: false,
        reviewers: [{ type: "User", reviewer: { login: "deconfined" } }],
      },
    ],
  };
  const mainOnly = { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] };

  interface File {
    filename: string;
    status: string;
    patch?: string;
    previous_filename?: string;
  }

  /** Run the plan for an automatic run of release 2.30.1 whose merge changed `files`. */
  function plan(files: File[], overrides: { production?: unknown; shaDigest?: string } = {}) {
    const where = box();
    api(where.dir, `${R}/environments/production`, overrides.production ?? production);
    api(where.dir, `${R}/environments/notify`, {
      ...production,
      can_admins_bypass: true,
      protection_rules: [],
    });
    api(where.dir, `${R}/environments/production/deployment-branch-policies`, mainOnly);
    api(where.dir, `${R}/environments/notify/deployment-branch-policies`, mainOnly);
    api(where.dir, `${R}/contents/package.json?ref=${C}`, { version: "2.30.1" });
    api(where.dir, `${R}/contents/package.json?ref=${P}`, { version: "2.30.0" });
    api(
      where.dir,
      `${R}/contents/CHANGELOG.md?ref=${C}`,
      "# Version history\n\n## 2.30.1 — A fix\n\nFixed.\n\n## 2.30.0 — Older\n",
    );
    api(where.dir, `${R}/contents/migrations?ref=${C}`, [
      { name: "001_init.sql" },
      { name: "010_status_notices.sql" },
    ]);
    api(where.dir, `${R}/compare/${C}...main`, { status: "identical" });
    api(where.dir, `${R}/commits/${C}`, { parents: [{ sha: P }] });
    api(where.dir, `${R}/compare/${P}...${C}`, { files });
    mkdirSync(join(where.dir, "images"));
    writeFileSync(join(where.dir, "images", "2.30.1"), `${D} ${C}\n`);
    writeFileSync(join(where.dir, "images", `sha-${C}`), `${overrides.shaDigest ?? D} ${C}\n`);
    return runScript(runOf("plan", "plan"), where, {
      GH_TOKEN: "unused",
      EVENT: "workflow_run",
      HEAD_SHA: C,
      INPUT_VERSION: "",
      INPUT_ROLLBACK: "",
      INPUT_FROM: "",
    });
  }
  const version = {
    filename: "package.json",
    status: "modified",
    patch: '@@ -1 +1 @@\n-  "version": "2.30.0",\n+  "version": "2.30.1",',
  };

  test("a merge of documentation, tests and CI asks for nothing", () => {
    const p = plan([
      { filename: "docs/HOSTING.md", status: "modified" },
      { filename: "CHANGELOG.md", status: "modified" },
      { filename: "tests/unit/x.test.ts", status: "added" },
      { filename: ".github/workflows/ci.yml", status: "modified" },
      { filename: "site/src/content/docs/index.md", status: "modified" },
      version,
    ]);
    expect(p.code).toBe(0);
    expect(p.outputs).toMatchObject({
      deploy: "false",
      reason: "no-runtime-change",
      version: "2.30.1",
    });
    expect(p.summary).toContain("nothing to deploy");
  });

  test("source, a dependency change, publish.yml or a host file asks for approval", () => {
    for (const files of [
      [{ filename: "src/main.ts", status: "modified" }],
      [{ ...version, patch: '@@ -1 +1 @@\n-  "zod": "4.1.0",\n+  "zod": "4.2.0",' }],
      [{ filename: "package.json", status: "modified" }],
      [{ filename: ".github/workflows/publish.yml", status: "modified" }],
      [{ filename: "ops/deploy.sh", status: "modified" }],
      [{ filename: "docs/moved.ts", status: "renamed", previous_filename: "src/moved.ts" }],
      Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md`, status: "added" })),
    ]) {
      const p = plan(files as File[]);
      expect({ files: files.length, code: p.code, deploy: p.outputs.deploy }).toEqual({
        files: files.length,
        code: 0,
        deploy: "true",
      });
      expect(p.outputs).toMatchObject({
        action: "deploy",
        commit: C,
        digest: D,
        from: "-",
        reason: "-",
      });
    }
  });

  test("the plan lists added migrations and host-side changes, and names the approval", () => {
    const p = plan([
      { filename: "migrations/011_more.sql", status: "added" },
      { filename: "docker-compose.production.yml", status: "modified" },
      { filename: "ops/deploy.sh", status: "modified" },
    ]);
    expect(p.outputs.deploy).toBe("true");
    expect(p.summary).toContain("**Migration files added in this merge:** migrations/011_more.sql");
    expect(p.summary).toContain("- `ops/deploy.sh`");
    expect(p.summary).toContain("check the host's .env first");
    expect(p.summary).toContain("**Approving** runs Deploy 2.30.1");
    expect(p.summary).toContain("## 2.30.1 — A fix");
    expect(p.summary).not.toContain("## 2.30.0 — Older");
    expect(p.summary).toContain("| Newest migration at this commit | `010_status_notices.sql` |");
  });

  test("an edited applied migration, another image behind the commit tag or a weak gate fails", () => {
    const edited = plan([{ filename: "migrations/001_init.sql", status: "modified" }]);
    expect(edited.code).toBe(1);
    expect(edited.outputs.reason).toBe("applied-migration-changed");
    const moved = plan([{ filename: "src/main.ts", status: "modified" }], {
      shaDigest: `sha256:${"ef".repeat(32)}`,
    });
    expect(moved.outputs.reason).toBe("digest-mismatch");
    for (const weak of [
      { ...production, can_admins_bypass: true },
      {
        ...production,
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: true,
            reviewers: [{ type: "User", reviewer: { login: "deconfined" } }],
          },
        ],
      },
      { ...production, protection_rules: [] },
      { ...production, deployment_branch_policy: null },
    ]) {
      const p = plan([{ filename: "src/main.ts", status: "modified" }], { production: weak });
      expect({ code: p.code, reason: p.outputs.reason }).toEqual({ code: 1, reason: "gate" });
    }
  });
});

describe("the runtime-change rule", () => {
  const source = runOf("plan", "plan");
  const grab = (name: string) =>
    new RegExp(new RegExp(`${name}='([^']+)'`, "u").exec(source)?.[1] ?? "^$", "u");
  const nonRuntime = grab("NON_RUNTIME");
  const alwaysRuntime = grab("ALWAYS_RUNTIME");
  const runtime = (path: string) => alwaysRuntime.test(path) || !nonRuntime.test(path);

  test("sorts paths into what runs in production and what doesn't", () => {
    const table: [string, boolean][] = [
      ["docs/HOSTING.md", false],
      ["site/src/content/docs/index.md", false],
      ["tests/unit/deploy-script.test.ts", false],
      ["test-plans/current.json", false],
      ["CHANGELOG.md", false],
      ["README.md", false],
      [".github/workflows/ci.yml", false],
      [".github/workflows/deploy.yml", false],
      ["docker-compose.yml", false],
      ["docker-compose.devbot.yml", false],
      ["docker-compose.build.yml", false],
      ["docker-compose.tools.yml", false],
      [".env.example", false],
      ["production.env.example", false],
      ["biome.json", false],
      [".github/workflows/publish.yml", true],
      ["src/main.ts", true],
      ["scripts/migrate.ts", true],
      ["migrations/011_x.sql", true],
      ["ops/deploy.sh", true],
      ["ops/backup.sh", true],
      ["docker-compose.production.yml", true],
      ["Dockerfile", true],
      [".dockerignore", true],
      ["bun.lock", true],
      ["bunfig.toml", true],
      ["tsconfig.json", true],
      ["tsconfig.build.json", true],
      ["package.json", true],
      ["src/docs/notes.md", true],
      ["docs.ts", true],
    ];
    for (const [path, expected] of table)
      expect({ path, runtime: runtime(path) }).toEqual({ path, runtime: expected });
  });
});
