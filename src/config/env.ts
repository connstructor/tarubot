/** Validate process configuration before startup creates any externally visible work. */
import { z } from "zod";
import { idSchema } from "../domain/values.js";

const schema = z.object({
  // Secrets are validated for presence/format but are never included in diagnostics.
  DATABASE_URL: z.string().url(),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: idSchema,
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  ENABLE_EFFECTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Empty means production scope; a value confines interaction/event adapters to a test guild.
  TEST_GUILD_ID: z.union([idSchema, z.literal("")]).default(""),
  // Development observers may see all new replies without changing other guilds' privacy defaults.
  PUBLIC_TEST_RESPONSES: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ROSTER_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(21600),
  // Display freshness is independent from roster authority and ownership verification.
  PROFILE_INTERVAL_SECONDS: z.coerce.number().int().min(300).default(86400),
  VERIFICATION_SECONDS: z.coerce.number().int().min(60).max(86400).default(1800),
  GUEST_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(86400),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Issue reports (2.18.0): a fine-grained token limited to the reports repository's issues. Empty
  // keeps reports in the database, unsent, until a token is configured and the bot restarts.
  GITHUB_REPORTS_TOKEN: z.string().default(""),
  GITHUB_REPORTS_REPO: z
    .string()
    .regex(/^[A-Za-z\d-]+\/[A-Za-z\d._-]+$/u, "owner/repository")
    .default("deconfined/tarubot-reports"),
  // Heartbeat (2.22.0): a healthchecks.io ping URL, pinged every five minutes while the bot is ready
  // so an outside check alerts when the pings stop. Empty turns it off (DevBot, CI).
  HEALTHCHECKS_PING_URL: z
    .union([z.literal(""), z.string().url().startsWith("https://")])
    .default(""),
});
export type Configuration = z.infer<typeof schema>;
/** Report setting names and expected formats while avoiding raw environment values. */
export function configuration(): Configuration {
  const result = schema.safeParse(process.env);
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return result.data;
}
