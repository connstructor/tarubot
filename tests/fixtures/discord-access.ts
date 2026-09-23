/** Real Discord.js permission resolution with controlled REST state; no gateway login or credentials. */
import { spyOn } from "bun:test";
import {
  ChannelType,
  Client,
  ClientUser,
  OverwriteType,
  PermissionFlagsBits as P,
} from "discord.js";
import { z } from "zod";
import { DiscordGuildAccess } from "../../src/discord/guild-access.js";
import type { AccessRoles } from "../../src/domain/channel-access.js";

const overwrite = z.object({
  id: z.string(),
  type: z.nativeEnum(OverwriteType),
  allow: z.string(),
  deny: z.string(),
});
export interface ChannelFixture {
  id: string;
  guild_id: string;
  name: string;
  type: ChannelType;
  parent_id: string | null;
  permission_overwrites: z.infer<typeof overwrite>[];
}
/** Expose the protected SDK constructor only to supply a controlled logged-in identity in tests. */
class FixtureClientUser extends ClientUser {
  constructor(client: Client<true>) {
    super(client, { id: "900", username: "bot", discriminator: "0", avatar: null, bot: true });
  }
}
/** SDK objects are built from API-shaped observations rather than duplicating permission precedence in tests. */
export function discordAccessFixture() {
  const client = new Client<true>({ intents: [] });
  client.user = new FixtureClientUser(client);
  const ready = spyOn(client, "isReady").mockReturnValue(true);
  const bindings: AccessRoles = { member: "201", guest: "202", officer: "203", leader: "204" };
  const base =
    P.ViewChannel |
    P.SendMessages |
    P.ReadMessageHistory |
    P.UseApplicationCommands |
    P.Connect |
    P.Speak |
    P.CreatePublicThreads |
    P.CreatePrivateThreads;
  const manager = P.ManageGuild | P.ManageRoles | P.ManageChannels;
  const roles = [
    { id: "100", name: "@everyone", position: 0, permissions: String(base) },
    ...Object.entries(bindings).map(([name, id], index) => ({
      id,
      name,
      position: index + 1,
      permissions: "0",
    })),
    { id: "500", name: "Unrelated", position: 5, permissions: String(P.ViewChannel) },
    {
      id: "600",
      name: "Bot",
      position: 6,
      permissions: String(base | manager | P.EmbedLinks | P.AttachFiles),
    },
    { id: "700", name: "Manager", position: 7, permissions: String(base | manager) },
    { id: "701", name: "Administrator", position: 8, permissions: String(P.Administrator) },
  ];
  const people = new Map<string, string[]>([
    ["900", ["600"]],
    ["300", []],
    ["301", ["700"]],
    ["400", []],
    ["401", ["201"]],
    ["402", ["202"]],
    ["403", ["201", "203"]],
    ["404", ["202", "204"]],
    ["405", ["500"]],
    ["406", ["701"]],
  ]);
  const channels: ChannelFixture[] = [];
  const community: { updatesChannelId: string | null } = { updatesChannelId: null };
  const writes: string[] = [];
  const reads: string[] = [];
  let serial = 1000;
  const add = (
    name: string,
    type = ChannelType.GuildText,
    permission_overwrites: ChannelFixture["permission_overwrites"] = [],
    parent_id: string | null = null,
  ): ChannelFixture => {
    const channel = {
      id: String(++serial),
      guild_id: "100",
      name,
      type,
      permission_overwrites,
      parent_id,
    };
    channels.push(channel);
    return channel;
  };
  const get = spyOn(client.rest, "get").mockImplementation(async (route) => {
    reads.push(route);
    if (route === "/guilds/100")
      return {
        id: "100",
        name: "Access fixture",
        owner_id: "300",
        public_updates_channel_id: community.updatesChannelId,
        // Model the available guild/channel cache normally populated by GUILD_CREATE.
        unavailable: false,
        channels: structuredClone(channels),
        roles: structuredClone(roles),
      };
    if (route === "/guilds/100/roles") return structuredClone(roles);
    if (route === "/guilds/100/channels") return structuredClone(channels);
    const person = [...people].find(([id]) => route === `/guilds/100/members/${id}`);
    if (person)
      return {
        user: {
          id: person[0],
          username: person[0],
          discriminator: "0",
          avatar: null,
          bot: person[0] === "900",
        },
        roles: person[1],
        joined_at: "2026-01-01T00:00:00Z",
        flags: 0,
      };
    const channel = channels.find((channel) => route === `/channels/${channel.id}`);
    if (channel) return structuredClone(channel);
    throw new Error(`Unexpected fixture read ${route}`);
  });
  const patch = spyOn(client.rest, "patch").mockImplementation(async (route, options) => {
    // REST serializes SDK bitfield objects through toJSON before sending the request body.
    const body: unknown = JSON.parse(JSON.stringify(options?.body));
    writes.push(route);
    const role = roles.find((role) => route === `/guilds/100/roles/${role.id}`);
    if (role) {
      role.permissions = z.object({ permissions: z.string() }).parse(body).permissions;
      return structuredClone(role);
    }
    const channel = channels.find((channel) => route === `/channels/${channel.id}`);
    if (!channel) throw new Error(`Unexpected fixture write ${route}`);
    const change = z
      .object({
        parent_id: z.string().nullable().optional(),
        permission_overwrites: z.array(overwrite).optional(),
      })
      .parse(body);
    if (change.parent_id !== undefined) channel.parent_id = change.parent_id;
    if (change.permission_overwrites !== undefined)
      channel.permission_overwrites = change.permission_overwrites;
    return structuredClone(channel);
  });
  const post = spyOn(client.rest, "post").mockImplementation(async (route, options) => {
    if (route !== "/guilds/100/channels") throw new Error(`Unexpected fixture creation ${route}`);
    const input = z
      .object({
        name: z.string(),
        type: z.nativeEnum(ChannelType),
        permission_overwrites: z.array(overwrite),
      })
      .parse(options?.body);
    writes.push(route);
    return structuredClone(add(input.name, input.type, input.permission_overwrites));
  });
  return {
    client,
    bindings,
    roles,
    people,
    channels,
    community,
    writes,
    reads,
    ready,
    add,
    port: new DiscordGuildAccess(client),
    async close() {
      get.mockRestore();
      patch.mockRestore();
      post.mockRestore();
      ready.mockRestore();
      await client.destroy();
    },
  };
}
