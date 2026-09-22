/** Feature capability tokens. Add new services here or alongside a new feature package. */
import { ServiceKey } from "../bot/services.js";
import { DiscordGateway } from "../discord/gateway.js";
import { Database } from "../infrastructure/postgres/database.js";
import { GuildEvents } from "./guild-events.js";
import { ApplicationLifecycle } from "./lifecycle.js";
import { Service } from "./service.js";
import { Synchronization } from "./synchronization.js";
import { RoleAdministration } from "./role-administration.js";

/** Runtime guards keep dependency retrieval safe even for dynamically imported modules. */
export const applicationKey = new ServiceKey(
  "tarubot application",
  (value): value is Service => value instanceof Service,
);
export const synchronizationKey = new ServiceKey(
  "membership synchronization",
  (value): value is Synchronization => value instanceof Synchronization,
);
export const guildEventsKey = new ServiceKey(
  "guild observations",
  (value): value is GuildEvents => value instanceof GuildEvents,
);
export const lifecycleKey = new ServiceKey(
  "application lifecycle",
  (value): value is ApplicationLifecycle => value instanceof ApplicationLifecycle,
);
export const databaseKey = new ServiceKey(
  "postgres database",
  (value): value is Database => value instanceof Database,
);
export const gatewayKey = new ServiceKey(
  "discord gateway",
  (value): value is DiscordGateway => value instanceof DiscordGateway,
);
/** Provisioning is independently injectable from normal Discord effect delivery. */
export const roleAdministrationKey = new ServiceKey(
  "role administration",
  (value): value is RoleAdministration => value instanceof RoleAdministration,
);
