/** Full acceptance harness using a uniquely named disposable PostgreSQL project and container. */
import { randomUUID } from "node:crypto";

const project = `tarubot-check-${randomUUID().slice(0, 8)}`;
const container = `${project}-tests`;
const compose = ["docker", "compose", "--project-name", project, "--env-file", ".env.example"];
/** Argument arrays avoid shell interpolation; only known development credentials enter this stack. */
async function run(command: string[], capture = false): Promise<string> {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, POSTGRES_PASSWORD: "local-development-password" },
  });
  const output = await new Response(child.stdout).text();
  const exit = await child.exited;
  if (!capture && output) process.stdout.write(output);
  if (exit !== 0) throw new Error(`${command[0]} ${command[1]} failed (${exit})`);
  return output.trim();
}
const fixture = process.env.LEGACY_FIXTURE_PATH ?? "tarubot_backup.sql";
if (!(await Bun.file(fixture).exists()))
  throw new Error(
    "Provide tarubot_backup.sql, or generate test:fixture and set LEGACY_FIXTURE_PATH=.cache/ci/legacy.sql.",
  );
try {
  await run(["docker", "build", "--target", "test", "-t", "tarubot-test:local", "."]);
  await run([...compose, "up", "-d", "--wait", "postgres"]);
  await run([
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "tarubot",
    "-d",
    "postgres",
    "-c",
    "CREATE DATABASE tarubot_test",
  ]);
  await run([
    "docker",
    "create",
    "--name",
    container,
    "--network",
    `${project}_default`,
    "-e",
    "TEST_DATABASE_URL=postgresql://tarubot:local-development-password@postgres:5432/tarubot_test",
    "tarubot-test:local",
    "bun",
    "test",
    "tests",
  ]);
  await run(["docker", "cp", fixture, `${container}:/app/tarubot_backup.sql`]);
  await run(["docker", "start", "-a", container]);
  const exit = await run(["docker", "inspect", "--format", "{{.State.ExitCode}}", container], true);
  if (exit !== "0") throw new Error(`Container tests failed (${exit})`);
} finally {
  // These names were created by this run, so cleanup cannot remove the user's normal stack.
  await run(["docker", "rm", "-f", container]).catch(() => {});
  await run([...compose, "down", "--volumes", "--remove-orphans"]);
}
