/** Read-only live preflight: verify DevBot identity and report test-guild capabilities safely. */
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { z } from "zod";
import { configuration } from "../src/config/env.js";
import { idSchema, json } from "../src/domain/values.js";

const config = configuration();
if (!config.TEST_GUILD_ID)
  throw new Error("TEST_GUILD_ID is required for live development checks.");

/** Call only Discord's API and keep the token and raw error objects out of diagnostics. */
async function get(path: string): Promise<unknown> {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { authorization: `Bot ${config.DISCORD_TOKEN}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Discord inspection failed (${response.status}) for ${path}.`);
  return response.json();
}

// Application identity is checked before guild inspection or any later deployment operation.
const self = z
  .object({ id: idSchema, username: z.string(), bot: z.literal(true) })
  .parse(await get("/users/@me"));
const application = z
  .object({ id: idSchema, name: z.string(), flags: z.number().optional() })
  .parse(await get("/oauth2/applications/@me"));
if (application.id !== config.DISCORD_APPLICATION_ID || self.id !== config.DISCORD_APPLICATION_ID) {
  throw new Error("The configured application ID does not match the authenticated bot.");
}
if (self.username.toLowerCase() !== "devbot" && application.name.toLowerCase() !== "devbot") {
  throw new Error(
    "The authenticated application is not named DevBot; check the development credentials.",
  );
}

const guildId = config.TEST_GUILD_ID;
const guild = z
  .object({ id: idSchema, name: z.string(), owner_id: idSchema })
  .parse(await get(`/guilds/${guildId}`));
const member = z
  .object({ roles: z.array(idSchema) })
  .parse(await get(`/guilds/${guildId}/members/${self.id}`));
const roles = z
  .array(
    z.object({
      id: idSchema,
      name: z.string(),
      permissions: z.string(),
      position: z.number(),
      managed: z.boolean(),
    }),
  )
  .parse(await get(`/guilds/${guildId}/roles`));
const channels = z
  .array(z.object({ id: idSchema, name: z.string().optional(), type: z.number() }))
  .parse(await get(`/guilds/${guildId}/channels`));

// Guild-level permissions are useful preflight evidence; channel overwrites are validated later.
const held = roles.filter((role) => role.id === guildId || member.roles.includes(role.id));
const permissions = new PermissionsBitField(
  held.reduce((bits, role) => bits | BigInt(role.permissions), 0n),
);
const database = new URL(config.DATABASE_URL);
console.log(
  json(
    {
      bot: self,
      application,
      guild: { id: guild.id, name: guild.name },
      permissions: permissions.toArray(),
      administrator: permissions.has(PermissionFlagsBits.Administrator, false),
      heldRoles: held.map(({ id, name, position, managed }) => ({ id, name, position, managed })),
      roles: roles.map(({ id, name, position, managed }) => ({ id, name, position, managed })),
      textChannels: channels.filter((channel) => channel.type === 0),
      configuration: {
        effectsEnabled: config.ENABLE_EFFECTS,
        databaseHost: database.hostname,
        databasePort: database.port,
        databaseName: database.pathname.slice(1),
      },
    },
    2,
  ),
);
