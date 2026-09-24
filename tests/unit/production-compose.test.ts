/**
 * The production host's Compose file (docker-compose.production.yml): the bot and its sidecar only,
 * pinned to an explicit release, against the external managed PostgreSQL, with production scoping
 * and bounded logs. Its settings must not drift from the registry deployment's docker-compose.yml.
 */
import { expect, test } from "bun:test";
import { YAML } from "bun";
import { z } from "zod";

/** Read a repository file relative to this test. */
const read = (path: string) => Bun.file(new URL(`../../${path}`, import.meta.url)).text();

const service = z
  .object({
    image: z.string(),
    environment: z.record(z.string(), z.string()),
    restart: z.string().optional(),
    logging: z.object({ driver: z.string(), options: z.record(z.string(), z.string()) }).optional(),
  })
  .passthrough();
const composeFile = z.object({ services: z.record(z.string(), service) }).passthrough();

test("production runs only the bot and Nodestone, pinned to an explicit release", async () => {
  const production = composeFile.parse(YAML.parse(await read("docker-compose.production.yml")));
  // No bundled PostgreSQL: production data lives in the managed cluster.
  expect(Object.keys(production.services).sort()).toEqual(["nodestone", "tarubot"]);
  for (const { image, restart, logging } of Object.values(production.services)) {
    // `latest` is never deployed: an unset tag refuses to interpolate.
    expect(image).toContain("${TARUBOT_IMAGE_TAG:?");
    expect(image).not.toContain(":-latest");
    expect(restart).toBe("unless-stopped");
    // Bounded json-file logs so a busy day can't fill the host's disk.
    expect(logging?.driver).toBe("json-file");
    expect(logging?.options).toMatchObject({
      "max-size": expect.any(String),
      "max-file": expect.any(String),
    });
  }
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
    NODESTONE_URL: "http://nodestone:8080",
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
  for (const name of ["tarubot", "nodestone"]) {
    const missing = Object.keys(base[name]?.environment ?? {}).filter(
      // The startup plan is development-only; production has no test guild to post it in.
      (key) => key !== "TEST_PLAN_FILE" && !(key in (production[name]?.environment ?? {})),
    );
    expect(missing, name).toEqual([]);
  }
});
