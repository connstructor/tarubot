/** Composition root: create capabilities once, discover modules, then connect the bot. */
import { pino } from "pino";
import { GuildEvents } from "./application/guild-events.js";
import { GuildAccess } from "./application/guild-access.js";
import { DiscordGuildAccess } from "./discord/guild-access.js";
import {
  applicationKey,
  databaseKey,
  gatewayKey,
  guildEventsKey,
  lifecycleKey,
  synchronizationKey,
  roleAdministrationKey,
  versionInformationKey,
} from "./application/keys.js";
import { ApplicationLifecycle } from "./application/lifecycle.js";
import { createReporter } from "./application/reporting.js";
import { Service } from "./application/service.js";
import { Synchronization } from "./application/synchronization.js";
import { RoleAdministration } from "./application/role-administration.js";
import { VersionInformation } from "./application/version-information.js";
import { GitHubHistory } from "./infrastructure/github/client.js";
import type { BotContext } from "./bot/context.js";
import { bindEvents, loadCommands, loadComponents, loadEvents } from "./bot/discovery.js";
import { InteractionRouter, interactionRouterKey } from "./bot/router.js";
import { Services } from "./bot/services.js";
import { configuration } from "./config/env.js";
import { DiscordGateway } from "./discord/gateway.js";
import { Nodestone } from "./infrastructure/nodestone/client.js";
import { Database } from "./infrastructure/postgres/database.js";
import { dispatcher } from "./jobs/dispatch.js";
import { Queue } from "./jobs/queue.js";

const config = configuration();
const log = pino({
  level: config.LOG_LEVEL,
  redact: ["token", "biography", "authorization", "password", "interaction.token"],
});
// Error objects may contain transport credentials or page bodies; the reporter logs only the
// catalog code, error class and approved Failure messages. Interactions pass their classified
// level; lifecycle, gateway-event, queue-worker and shutdown reports keep the error default.
const report = createReporter(log);

// Discovery is independent of login, database connections, and feature construction.
const [commands, components, events] = await Promise.all([
  loadCommands(),
  loadComponents(),
  loadEvents(),
]);
const db = new Database(config.DATABASE_URL);
const gateway = new DiscordGateway();
const app = new Service(db, gateway, new Nodestone(config.NODESTONE_URL), config);
const sync = new Synchronization(app);
const access = new GuildAccess(app, new DiscordGuildAccess(gateway.client));
const queue = new Queue(db, dispatcher(app, sync, access), (event) => {
  if (event.type === "worker") return report(event.error, event.job?.id ?? "queue");
  // Classified attempts log at their own level: expected waits stay at debug unless they stall.
  // Only identifiers, codes, approved diagnostics and timings are logged, never payloads or tokens.
  const { job, outcome } = event;
  log[outcome.level](
    {
      operation: job.id,
      kind: job.kind,
      generation: job.generation,
      attempts: job.attempts,
      code: outcome.code,
      status: outcome.status,
      category: outcome.category,
      source: outcome.source,
      diagnostic: outcome.diagnostic,
      delaySeconds: Math.ceil(outcome.delaySeconds),
      durationMs: event.durationMs,
      waitMs: event.waitMs,
      ageMs: event.ageMs,
    },
    "Job attempt outcome classified; inspect scoped work status.",
  );
});
const lifecycle = new ApplicationLifecycle(config, db, gateway, app, sync, queue, log, report);
const services = new Services()
  .provide(applicationKey, app)
  .provide(synchronizationKey, sync)
  .provide(databaseKey, db)
  .provide(gatewayKey, gateway)
  .provide(roleAdministrationKey, new RoleAdministration(app, gateway, access))
  .provide(versionInformationKey, new VersionInformation(new GitHubHistory()))
  .provide(guildEventsKey, new GuildEvents(db))
  .provide(lifecycleKey, lifecycle);
const context: BotContext = {
  client: gateway.client,
  services,
  report,
  allowsGuild: (guildId) => lifecycle.allowsGuild(guildId),
  isStopping: () => lifecycle.isStopping(),
  publicResponseGuildId:
    config.PUBLIC_TEST_RESPONSES && config.TEST_GUILD_ID ? config.TEST_GUILD_ID : undefined,
  resolveActor: async (guildId, userId) => app.enrichActor(await gateway.actor(guildId, userId)),
  enrichActor: (actor) => app.enrichActor(actor),
};
services.provide(interactionRouterKey, new InteractionRouter(context, commands, components));
const unbind = bindEvents(events, context);
log.info(
  { commands: commands.size, components: components.size, events: events.size },
  "Modules loaded",
);

// OS signals are process housekeeping; all Discord gateway subscriptions are discovered.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void lifecycle
      .stop()
      .then(() => {
        unbind();
        process.exit(0);
      })
      .catch((error: unknown) => {
        report(error, "shutdown");
        process.exit(1);
      });
  });
try {
  await lifecycle.prepare();
  await Promise.all([gateway.client.login(config.DISCORD_TOKEN), lifecycle.whenReady()]);
} catch (error) {
  unbind();
  await lifecycle.stop();
  throw error;
}
