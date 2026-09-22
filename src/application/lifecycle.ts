/** TaruBot's application lifecycle is separate from module discovery and gateway wiring. */
import type { Logger } from "pino";
import type { Configuration } from "../config/env.js";
import type { DiscordGateway } from "../discord/gateway.js";
import { Failure } from "../domain/values.js";
import { orm, type Database } from "../infrastructure/postgres/database.js";
import { and, eq, notInArray } from "drizzle-orm";
import * as t from "../infrastructure/postgres/schema.js";
import { enqueue, layoutGuildRoles, type Queue } from "../jobs/queue.js";
import type { Service } from "./service.js";
import type { Synchronization } from "./synchronization.js";
import { capabilityMetrics } from "./metrics.js";

/** Owns readiness, application scheduling, and graceful release of durable work resources. */
export class ApplicationLifecycle {
  private readonly initialized = Promise.withResolvers<void>();
  private readonly health: Bun.Server<undefined>;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private stopPromise: Promise<void> | undefined;
  private ready = false;
  private databaseReady = false;
  private stopping = false;
  private capabilities: unknown = { synchronization: "initializing" };

  constructor(
    private readonly config: Configuration,
    private readonly db: Database,
    private readonly gateway: DiscordGateway,
    private readonly app: Service,
    private readonly sync: Synchronization,
    private readonly queue: Queue,
    private readonly log: Logger,
    private readonly report: (error: unknown, operation: string) => void,
  ) {
    // Probes depend on local readiness, never on a live Lodestone acquisition.
    this.health = Bun.serve<undefined>({
      port: config.HEALTH_PORT,
      fetch: (request) => this.probe(request),
    });
  }

  /** Shared scope gate for every installed feature's guild-specific event handling. */
  allowsGuild(guildId: string): boolean {
    return !this.config.TEST_GUILD_ID || guildId === this.config.TEST_GUILD_ID;
  }

  /** Module listeners consult this before admitting work during termination. */
  isStopping(): boolean {
    return this.stopping;
  }

  /** Check migrations before login can deliver any persisted guild observations. */
  async prepare(): Promise<void> {
    await this.db.schema();
    this.databaseReady = true;
  }

  /** Main awaits the dynamically installed ready handler rather than registering its own. */
  whenReady(): Promise<void> {
    return this.initialized.promise;
  }

  /** Called once by client-ready.event: reconcile presence, then start application workers. */
  async start(): Promise<void> {
    try {
      if (this.gateway.client.application?.id !== this.config.DISCORD_APPLICATION_ID) {
        throw new Failure(
          "configuration",
          "DISCORD_APPLICATION_ID does not match the logged-in bot application.",
        );
      }
      await this.db.transaction(async (client) => {
        const db = orm(client);
        const present = [...this.gateway.client.guilds.cache.keys()].filter((guild) =>
          this.allowsGuild(guild),
        );
        await db
          .update(t.guilds)
          .set({ active: false })
          .where(
            and(
              notInArray(t.guilds.id, present),
              this.config.TEST_GUILD_ID ? eq(t.guilds.id, this.config.TEST_GUILD_ID) : undefined,
            ),
          );
        for (const guild of present) {
          const configured = await db
            .update(t.guilds)
            .set({ active: true })
            .where(eq(t.guilds.id, guild))
            .returning({ id: t.guilds.id });
          if (configured.length) {
            await enqueue(client, "reconcile.guild", `guild:${guild}`, {}, guild);
            await layoutGuildRoles(client, guild);
          }
        }
      });
      this.queue.start();
      this.monitor = setInterval(() => {
        void this.observe().catch((error: unknown) => this.report(error, "scheduler"));
      }, 30000);
      await this.sync.schedule();
      this.ready = true;
      this.log.info({ runtime: Bun.version }, "TaruBot ready");
      this.initialized.resolve();
    } catch (error) {
      // Propagate startup failure both to the event diagnostic and the waiting bootstrap.
      this.initialized.reject(error);
      throw error;
    }
  }

  /** Refresh cheap capability metrics separately from upstream availability. */
  private async observe(): Promise<void> {
    try {
      await this.db.query("SELECT 1");
      this.databaseReady = true;
      await this.sync.schedule();
      this.capabilities = await capabilityMetrics(this.db.orm);
      this.log.info({ metrics: this.capabilities }, "Capability status");
    } catch (error) {
      this.databaseReady = false;
      throw error;
    }
  }

  /** Report application readiness without turning a Lodestone outage into a process failure. */
  private probe(request: Request): Response {
    const liveness = new URL(request.url).pathname === "/health/live";
    const available =
      !this.stopping &&
      this.ready &&
      this.databaseReady &&
      this.db.healthy &&
      this.gateway.client.isReady();
    return Response.json(
      {
        live: !this.stopping,
        ready: available,
        database: this.databaseReady && this.db.healthy,
        discord: this.gateway.client.isReady(),
        effects: this.config.ENABLE_EFFECTS,
        publicTestResponses:
          Boolean(this.config.TEST_GUILD_ID) && this.config.PUBLIC_TEST_RESPONSES,
        capabilities: this.capabilities,
      },
      { status: liveness || available ? 200 : 503 },
    );
  }

  /** Stop admission once, cancel upstream work, and leave uncompleted leases recoverable. */
  stop(): Promise<void> {
    this.stopPromise ??= this.close();
    return this.stopPromise;
  }

  /** Cleanup is shared by startup failures and process signals. */
  private async close(): Promise<void> {
    const hardStop = setTimeout(() => process.exit(0), 27000);
    this.stopping = true;
    this.ready = false;
    if (this.monitor) clearInterval(this.monitor);
    this.app.lodestone.stop();
    await Promise.race([this.queue.stop(), Bun.sleep(20000)]);
    await this.gateway.client.destroy();
    await this.health.stop(true);
    await this.db.close();
    clearTimeout(hardStop);
  }
}
