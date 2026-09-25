/**
 * The production host's Compose file (docker-compose.production.yml): the bot only (2.21.0: the
 * Lodestone parser runs inside it), pinned to an explicit release, against the external managed
 * PostgreSQL, with production scoping and bounded logs. Its settings must not drift from the
 * registry deployment's docker-compose.yml.
 */
import { expect, test } from "bun:test";
import { YAML } from "bun";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };

/** Read a repository file relative to this test. */
const read = (path: string) => Bun.file(new URL(`../../${path}`, import.meta.url)).text();

const service = z
  .object({
    image: z.string(),
    environment: z.record(z.string(), z.string()),
    restart: z.string().optional(),
    logging: z
      .object({ driver: z.string(), options: z.record(z.string(), z.string()).optional() })
      .optional(),
  })
  .passthrough();
const composeFile = z.object({ services: z.record(z.string(), service) }).passthrough();

test("production runs only the bot, pinned to an explicit release", async () => {
  const production = composeFile.parse(YAML.parse(await read("docker-compose.production.yml")));
  // No bundled PostgreSQL (production data lives in the managed cluster), and no parser sidecar.
  // The backup service (2.24.0) is a one-off behind a profile, which `up` never starts
  // (tests/unit/backup-job.test.ts).
  expect(Object.keys(production.services).sort()).toEqual(["backup", "tarubot"]);
  const bot = production.services.tarubot;
  // `latest` is never deployed: an unset tag refuses to interpolate.
  expect(bot?.image).toContain("${TARUBOT_IMAGE_TAG:?");
  expect(bot?.image).not.toContain(":-latest");
  expect(bot?.restart).toBe("unless-stopped");
  // Bounded json-file logs so a busy day can't fill the host's disk. (The backup service logs
  // nothing at all: its output is the dump; tests/unit/backup-job.test.ts.)
  expect(bot?.logging?.driver).toBe("json-file");
  expect(bot?.logging?.options).toMatchObject({
    "max-size": expect.any(String),
    "max-file": expect.any(String),
  });
});

test("the production bot uses the managed database, production scoping, and effects", async () => {
  const bot = composeFile.parse(YAML.parse(await read("docker-compose.production.yml"))).services
    .tarubot;
  const env = bot?.environment ?? {};
  // Required, never defaulted: a missing value stops `docker compose` before anything starts.
  expect(env.DATABASE_URL).toStartWith("${DATABASE_URL:?");
  expect(env.DATABASE_CA_CERT).toStartWith("${DATABASE_CA_CERT:?");
  expect(env.DISCORD_TOKEN).toStartWith("${DISCORD_TOKEN:?");
  expect(env).toMatchObject({
    DISCORD_APPLICATION_ID: "965294750741692416",
    TARUBOT_ENVIRONMENT: "production",
    ENABLE_EFFECTS: "true",
    TEST_GUILD_ID: "",
    PUBLIC_TEST_RESPONSES: "false",
    TEST_PLAN_CHANNEL_ID: "",
  });
});

test("the production file carries every setting the registry deployment passes", async () => {
  // A setting added to docker-compose.yml must reach production too (or be deliberately fixed).
  const base = composeFile.parse(YAML.parse(await read("docker-compose.yml"))).services;
  const production = composeFile.parse(
    YAML.parse(await read("docker-compose.production.yml")),
  ).services;
  const missing = Object.keys(base.tarubot?.environment ?? {}).filter(
    // The startup plan is development-only; production has no test guild to post it in.
    (key) => key !== "TEST_PLAN_FILE" && !(key in (production.tarubot?.environment ?? {})),
  );
  expect(missing).toEqual([]);
});

test("the GitHub App settings reach production only (2.26.0)", async () => {
  // /suggest posts publicly as the TaruBot GitHub App in production; DevBot previews into the
  // private reports repository and never holds the app's key.
  const production = composeFile.parse(YAML.parse(await read("docker-compose.production.yml")));
  const base = composeFile.parse(YAML.parse(await read("docker-compose.yml")));
  const devbot = await read("docker-compose.devbot.yml");
  expect(production.services.tarubot?.environment).toMatchObject({
    // Compose interpolation, written escaped so it isn't a template placeholder here.
    GITHUB_APP_CLIENT_ID: `\${GITHUB_APP_CLIENT_ID:-}`,
    GITHUB_APP_PRIVATE_KEY: `\${GITHUB_APP_PRIVATE_KEY:-}`,
  });
  // The daily dump never needs them.
  expect(production.services.backup?.environment).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY");
  expect(base.services.tarubot?.environment).not.toHaveProperty("GITHUB_APP_CLIENT_ID");
  expect(base.services.tarubot?.environment).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY");
  expect(devbot).not.toContain("GITHUB_APP_");
});

test("no deployment file keeps the retired sidecar or its settings (2.21.0)", async () => {
  for (const path of [
    "docker-compose.yml",
    "docker-compose.production.yml",
    "docker-compose.build.yml",
    "docker-compose.tools.yml",
    "docker-compose.devbot.yml",
    ".env.example",
    "production.env.example",
    "Dockerfile",
  ]) {
    const text = await read(path);
    // The parser's settings are LODESTONE_*; NODESTONE_* and PAGE_REGION were the sidecar's.
    expect(text, path).not.toMatch(/nodestone|PAGE_REGION/iu);
  }
});

test("Compose pulls the image this repository publishes", async () => {
  // publish.yml pushes ghcr.io/${GITHUB_REPOSITORY,,}. GHCR paths follow the GitHub account and
  // never redirect after a rename (the account was renamed from connstructor on 2026-09-24), so the
  // pull sites must agree with package.json's repository.
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/.exec(manifest.repository.url);
  if (!match?.[1] || !match[2]) throw new Error("package.json repository.url is not a GitHub URL");
  const [owner, name] = [match[1].toLowerCase(), match[2].toLowerCase()];
  // Under GitHub Actions the running repository is authoritative: a rename or transfer leaves
  // package.json and Compose stale together, which the agreement checks cannot see.
  const running = process.env.GITHUB_REPOSITORY;
  if (running) expect(`${owner}/${name}`).toBe(running.toLowerCase());
  const base = composeFile.parse(YAML.parse(await read("docker-compose.yml"))).services;
  expect(base.tarubot?.image).toBe(
    `\${TARUBOT_IMAGE:-ghcr.io/${owner}/${name}:\${TARUBOT_IMAGE_TAG:-latest}}`,
  );
  const production = composeFile.parse(
    YAML.parse(await read("docker-compose.production.yml")),
  ).services;
  expect(production.tarubot?.image).toStartWith(`\${TARUBOT_IMAGE:-ghcr.io/${owner}/${name}:`);
  // One published image: the workflow no longer builds a -nodestone sibling.
  expect(await read(".github/workflows/publish.yml")).not.toContain("-nodestone");
});
