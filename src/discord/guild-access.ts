/** Guild channel provisioning and visibility writes, with fresh reads and explicit bot access. */
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import type { Client, Guild, GuildMember, Role } from "discord.js";
import {
  channelAccessOverwrites,
  sameOverwrites,
  type AccessChannel,
  type AccessOverwrite,
  type AccessRoles,
  type AccessSnapshot,
  type ChannelAudience,
} from "../domain/channel-access.js";
import { Failure, normalized } from "../domain/values.js";
import type {
  GuildAccessPort,
  GuildAccessSession,
  PreparedAccess,
} from "../application/records.js";

/** Immutable identity fences around the Gateway-updated SDK cache for one pass only. */
interface ReconciliationScope {
  guild: Guild;
  channelIds: ReadonlySet<string>;
  communityUpdatesId: string | null;
  communityParentId: string | null;
}

export class DiscordGuildAccess implements GuildAccessPort {
  constructor(private readonly client: Client) {}

  /** Removing the public default must not strand the bot or leave newcomers with management powers. */
  private async management(guildId: string): Promise<{ guild: Guild; bot: GuildMember }> {
    const guild = await this.client.guilds.fetch({ guild: guildId, force: true });
    await guild.roles.fetch();
    const bot = await guild.members.fetchMe({ force: true });
    const required = [
      P.ManageChannels,
      P.ManageRoles,
      P.ViewChannel,
      P.SendMessages,
      P.ReadMessageHistory,
      P.EmbedLinks,
      P.AttachFiles,
    ];
    if (!bot.permissions.has(required))
      throw new Failure(
        "blocked",
        "Give the bot Manage Channels, Manage Roles, View Channel, Send Messages, Read Message History, Embed Links, and Attach Files before securing the server.",
      );
    if (
      guild.roles.everyone.permissions.any(
        [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels],
        false,
      )
    )
      throw new Failure(
        "blocked",
        "Remove server-management permissions from @everyone before enabling onboarding.",
      );
    if (
      !bot.roles.cache.some(
        (role) =>
          role.id !== guildId && role.permissions.any([P.Administrator, P.ViewChannel], false),
      )
    )
      throw new Failure(
        "blocked",
        "Grant View Channel to the bot's own role before removing the @everyone default.",
      );
    return { guild, bot };
  }

  /** Channel provisioning requires current manager authority, independently of bot-only Officer access. */
  async check(guildId: string, actor: string): Promise<void> {
    const { guild } = await this.management(guildId);
    const member = await guild.members.fetch({ user: actor, force: true });
    if (!member.permissions.has([P.ManageGuild, P.ManageRoles, P.ManageChannels]))
      throw new Failure(
        "forbidden",
        "Manage Server, Manage Roles, and Manage Channels are required to enable onboarding.",
      );
  }

  /** All access bindings must remain ordinary roles below the bot, with no server-management powers. */
  private roles(
    guild: Guild,
    bot: GuildMember,
    bindings: AccessRoles,
  ): Record<keyof AccessRoles, Role> {
    const get = (id: string): Role => {
      const role = guild.roles.cache.get(id);
      if (
        !role ||
        role.id === guild.id ||
        role.managed ||
        bot.roles.highest.comparePositionTo(role) <= 0
      )
        throw new Failure(
          "blocked",
          "Onboarding needs existing ordinary roles below the bot. Run /setup to repair the bindings.",
        );
      if (
        role.permissions.any(
          [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels],
          false,
        )
      )
        throw new Failure(
          "blocked",
          "Onboarding access roles must not grant server-management permissions.",
        );
      return role;
    };
    return {
      member: get(bindings.member),
      guest: get(bindings.guest),
      officer: get(bindings.officer),
      leader: get(bindings.leader),
    };
  }

  /** Exclude configured community resources by ID, including a parent whose edits could propagate. */
  private async channelScope(guild: Guild) {
    const channels = [...(await guild.channels.fetch()).values()].filter(
      (channel) => channel !== null,
    );
    const excluded = new Set<string>();
    if (guild.publicUpdatesChannelId) {
      const updates = channels.find((channel) => channel.id === guild.publicUpdatesChannelId);
      if (!updates)
        throw new Failure(
          "blocked",
          "Community-updates metadata is unavailable; cannot determine the protected channel scope.",
        );
      excluded.add(updates.id);
      if (updates.parentId) excluded.add(updates.parentId);
    }
    const preserveEveryoneView = [...excluded].some((id) => {
      const channel = channels.find((channel) => channel.id === id);
      if (!channel)
        throw new Failure("blocked", "The community-updates parent category is unavailable.");
      const everyone = channel.permissionOverwrites.cache.get(guild.id);
      // Without an explicit everyone View override, changing the guild default changes this area too.
      return (
        !everyone || ((everyone.allow.bitfield | everyone.deny.bitfield) & P.ViewChannel) === 0n
      );
    });
    return { channels, excluded, preserveEveryoneView };
  }

  /** Retain only identities; channel objects continue receiving normal Guilds Gateway updates. */
  private retainScope(
    guild: Guild,
    channels: readonly { id: string; parentId: string | null }[],
  ): ReconciliationScope {
    const communityUpdatesId = guild.publicUpdatesChannelId ?? null;
    return {
      guild,
      channelIds: new Set(channels.map((channel) => channel.id)),
      communityUpdatesId,
      communityParentId:
        channels.find((channel) => channel.id === communityUpdatesId)?.parentId ?? null,
    };
  }

  /** Hidden community channels cannot be read individually; require a connected, coherent Gateway cache. */
  private currentScope(scope: ReconciliationScope) {
    const guild = this.client.guilds.cache.get(scope.guild.id);
    if (!this.client.isReady() || guild !== scope.guild || !guild.available)
      throw new Failure(
        "transient",
        "Discord scope is unavailable; retry after the gateway reconnects.",
      );
    if ((guild.publicUpdatesChannelId ?? null) !== scope.communityUpdatesId)
      throw new Failure("superseded", "The community channel scope changed; retry reconciliation.");
    const excluded = new Set<string>();
    if (scope.communityUpdatesId) {
      const updates = guild.channels.cache.get(scope.communityUpdatesId);
      if (!updates || updates.isThread() || updates.parentId !== scope.communityParentId)
        throw new Failure(
          "superseded",
          "The community channel scope changed; retry reconciliation.",
        );
      excluded.add(updates.id);
      if (updates.parentId) excluded.add(updates.parentId);
    }
    const preserveEveryoneView = [...excluded].some((id) => {
      const channel = guild.channels.cache.get(id);
      if (!channel || channel.isThread())
        throw new Failure(
          "superseded",
          "Protected channel metadata changed; retry reconciliation.",
        );
      // Obfuscated overwrites are synthetic; they cannot justify lowering a shared default.
      if (channel.flags.has(1 << 17)) return true;
      const everyone = channel.permissionOverwrites.cache.get(guild.id);
      return (
        !everyone || ((everyone.allow.bitfield | everyone.deny.bitfield) & P.ViewChannel) === 0n
      );
    });
    return { guild, excluded, preserveEveryoneView };
  }

  /** No catalogue request here: scope changes invalidate the pass instead of rescanning per target. */
  private managedChannel(scope: ReconciliationScope, channelId: string) {
    const current = this.currentScope(scope);
    if (current.excluded.has(channelId))
      throw new Failure(
        "blocked",
        "The community-updates channel and its parent category are reserved. Select a separate officer-chat channel.",
      );
    const channel = current.guild.channels.cache.get(channelId);
    if (!scope.channelIds.has(channelId) || !channel || channel.isThread())
      throw new Failure(
        "blocked",
        "An onboarding channel was deleted or is unavailable. Run /setup to repair it.",
      );
    return channel;
  }

  /** Check capabilities only in managed channels; inaccessible community resources are outside scope. */
  async snapshot(guildId: string, bindings: AccessRoles): Promise<AccessSnapshot> {
    return (await this.begin(guildId, bindings)).snapshot;
  }

  /** Fetch the full inventory once and share it through all effects in this reconciliation. */
  async begin(guildId: string, bindings: AccessRoles): Promise<GuildAccessSession> {
    const { guild, bot } = await this.management(guildId);
    const roles = this.roles(guild, bot, bindings);
    const scope = await this.channelScope(guild);
    const channels: AccessChannel[] = [];
    for (const channel of scope.channels) {
      if (scope.excluded.has(channel.id)) continue;
      if (!channel.permissionsFor(bot).has([P.ViewChannel, P.ManageChannels, P.ManageRoles]))
        throw new Failure(
          "blocked",
          `The bot needs View Channel, Manage Channels, and Manage Roles in channel ${channel.id}.`,
        );
      channels.push({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId,
        overwrites: [...channel.permissionOverwrites.cache.values()].map((value) => ({
          id: value.id,
          type: value.type,
          allow: String(value.allow.bitfield),
          deny: String(value.deny.bitfield),
        })),
        everyoneVisible: channel.permissionsFor(guild.roles.everyone).has(P.ViewChannel, false),
        memberVisible: channel.permissionsFor(roles.member).has(P.ViewChannel, false),
        guestVisible: channel.permissionsFor(roles.guest).has(P.ViewChannel, false),
      });
    }
    const snapshot: AccessSnapshot = {
      botId: bot.id,
      everyonePermissions: String(guild.roles.everyone.permissions.bitfield),
      excludedChannelIds: [...scope.excluded].sort(),
      preserveEveryoneView: scope.preserveEveryoneView,
      channels,
    };
    const retained = this.retainScope(guild, scope.channels);
    return {
      snapshot,
      channel: (channel, audience, guard) =>
        this.channelWithin(retained, channel, bindings, audience, guard),
      restrictEveryone: (guard) => this.restrictEveryoneWithin(retained, guard),
    };
  }

  /** Prefer saved IDs, then a unique recognizable room; ambiguity requires an explicit setup option. */
  async prepare(
    guildId: string,
    actor: string,
    roles: AccessRoles,
    lobbyId: string | null,
    officerId: string | null,
  ): Promise<PreparedAccess> {
    const before = await this.snapshot(guildId, roles);
    const guild = await this.client.guilds.fetch(guildId);
    const text = before.channels.filter((channel) => channel.type === ChannelType.GuildText);
    const pick = (
      configured: string | null,
      names: readonly string[],
      candidates: readonly AccessChannel[] = text,
    ): AccessChannel | undefined => {
      if (configured) {
        if (before.excludedChannelIds.includes(configured))
          throw new Failure(
            "input",
            "The community-updates channel and its parent are reserved. Choose a separate officer-chat channel.",
          );
        const known = before.channels.find((channel) => channel.id === configured);
        if (known) {
          if (known.type !== ChannelType.GuildText)
            throw new Failure("input", "Lobby and officer rooms must be guild text channels.");
          return known;
        }
      }
      for (const name of names) {
        const matches = candidates.filter((channel) => normalized(channel.name) === name);
        if (matches.length > 1)
          throw new Failure(
            "conflict",
            `Several channels match ${name}; select one explicitly in /setup.`,
          );
        if (matches[0]) return matches[0];
      }
      return undefined;
    };
    const existingLobby = pick(lobbyId, ["lobby"]);
    const officerNames = ["officer-chat", "officers", "officer", "staff", "staff-chat", "mod-chat"];
    let existingOfficers = pick(officerId, []);
    if (!existingOfficers) {
      const privateRooms = text.filter(
        (channel) =>
          channel.id !== existingLobby?.id &&
          !channel.everyoneVisible &&
          !channel.memberVisible &&
          !channel.guestVisible,
      );
      existingOfficers = pick(null, officerNames, privateRooms);
      if (!existingOfficers && privateRooms.length === 1) existingOfficers = privateRooms[0];
      else if (!existingOfficers && privateRooms.length > 1)
        throw new Failure(
          "conflict",
          "Several private rooms could be the officer channel; select officers in /setup.",
        );
      existingOfficers ??= pick(null, officerNames);
    }
    if (existingLobby && existingLobby.id === existingOfficers?.id)
      throw new Failure("input", "Lobby and officer channels must be different.");
    const ensure = async (
      existing: AccessChannel | undefined,
      name: string,
      audience: ChannelAudience,
    ) => {
      if (existing) return { id: existing.id, created: false };
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        topic:
          audience === "lobby"
            ? "Use /claim and /verify to link your character. Verified FC members receive Member; verified visitors receive Guest. Staff can help with /apply."
            : "Officer coordination and application review.",
        permissionOverwrites: channelAccessOverwrites(
          [],
          guildId,
          before.botId,
          roles,
          audience,
        ).map((overwrite) => ({
          ...overwrite,
          allow: BigInt(overwrite.allow),
          deny: BigInt(overwrite.deny),
        })),
        reason: `TaruBot onboarding setup requested by ${actor}`,
      });
      return { id: channel.id, created: true };
    };
    const lobby = await ensure(existingLobby, "lobby", "lobby");
    const officers = await ensure(existingOfficers, "officer-chat", "officers");
    // Detaching an existing lobby is deferred until its original parent/overwrites are persisted.
    const current = await this.snapshot(guildId, roles);
    const originals = new Map(before.channels.map((item) => [item.id, item]));
    return {
      lobby,
      officers,
      snapshot: {
        ...current,
        channels: current.channels.map((item) => originals.get(item.id) ?? item),
      },
    };
  }

  /** Standalone convenience; guild reconciliation opens one shared session instead. */
  async channel(
    guildId: string,
    channelId: string,
    roles: AccessRoles,
    audience: ChannelAudience,
    guard: () => Promise<void>,
  ): Promise<boolean> {
    return (await this.begin(guildId, roles)).channel(channelId, audience, guard);
  }

  /** Cached no-op detection, targeted reads before writes, and targeted readback avoid N full scans. */
  private async channelWithin(
    scope: ReconciliationScope,
    channelId: string,
    roles: AccessRoles,
    audience: ChannelAudience,
    guard: () => Promise<void>,
  ): Promise<boolean> {
    const guildId = scope.guild.id;
    let channel = this.managedChannel(scope, channelId);
    const freshForWrite = async () => {
      await guard();
      this.managedChannel(scope, channelId);
      // Refresh just this target; Gateway events keep the protected binding/parent cache current.
      const fetched = await this.client.channels.fetch(channelId, { force: true });
      if (!fetched || !("guildId" in fetched) || fetched.guildId !== guildId || fetched.isThread())
        throw new Failure("superseded", "The channel scope changed before mutation.");
      await guard();
      return this.managedChannel(scope, channelId);
    };
    const botId = this.client.user?.id;
    if (!botId) throw new Failure("blocked", "Discord bot identity is unavailable.");
    let moved = false;
    if (audience === "lobby" && channel.type === ChannelType.GuildText && channel.parentId) {
      channel = await freshForWrite();
      if (channel.type !== ChannelType.GuildText)
        throw new Failure("blocked", "The lobby must remain a guild text channel.");
      await channel.setParent(null, {
        lockPermissions: false,
        reason: "Keep the onboarding lobby outside gated categories",
      });
      moved = true;
    }
    const read = (): AccessOverwrite[] =>
      [...channel.permissionOverwrites.cache.values()].map((value) => ({
        id: value.id,
        type: value.type,
        allow: String(value.allow.bitfield),
        deny: String(value.deny.bitfield),
      }));
    let before = read(),
      desired = channelAccessOverwrites(before, guildId, botId, roles, audience);
    if (sameOverwrites(before, desired)) return moved;
    channel = await freshForWrite();
    before = read();
    desired = channelAccessOverwrites(before, guildId, botId, roles, audience);
    if (sameOverwrites(before, desired)) return moved;
    await channel.permissionOverwrites.set(
      desired.map((value) => ({ ...value, allow: BigInt(value.allow), deny: BigInt(value.deny) })),
      "TaruBot onboarding visibility policy",
    );
    const verified = await this.client.channels.fetch(channelId, { force: true });
    if (!verified || !("permissionOverwrites" in verified))
      throw new Failure("blocked", "Channel disappeared during access enforcement.");
    const actual = [...verified.permissionOverwrites.cache.values()].map((value) => ({
      id: value.id,
      type: value.type,
      allow: String(value.allow.bitfield),
      deny: String(value.deny.bitfield),
    }));
    if (!sameOverwrites(actual, channelAccessOverwrites(actual, guildId, botId, roles, audience)))
      throw new Failure(
        "transient",
        "Channel permissions changed during onboarding reconciliation.",
      );
    return true;
  }

  /** Close the default only when excluded community resources have independent View overwrites. */
  async restrictEveryone(guildId: string, guard: () => Promise<void>): Promise<boolean> {
    const { guild } = await this.management(guildId);
    const scope = await this.channelScope(guild);
    return this.restrictEveryoneWithin(this.retainScope(guild, scope.channels), guard);
  }

  /** A shared-default mutation gets one extra authoritative catalogue check, never one per target. */
  private async restrictEveryoneWithin(
    scope: ReconciliationScope,
    guard: () => Promise<void>,
  ): Promise<boolean> {
    const current = this.currentScope(scope);
    let everyone = current.guild.roles.everyone;
    if (current.preserveEveryoneView) return false;
    if (!everyone.permissions.has(P.ViewChannel, false)) return false;
    await guard();
    const guildId = scope.guild.id;
    const { guild } = await this.management(guildId);
    const refreshed = await this.channelScope(guild);
    if (refreshed.preserveEveryoneView) return false;
    everyone = guild.roles.everyone;
    if (!everyone.permissions.has(P.ViewChannel, false)) return false;
    await guard();
    if (this.currentScope(scope).preserveEveryoneView) return false;
    await everyone.setPermissions(
      everyone.permissions.bitfield & ~P.ViewChannel,
      "TaruBot lobby-only newcomer visibility",
    );
    if ((await guild.roles.fetch()).get(guildId)?.permissions.has(P.ViewChannel, false))
      throw new Failure(
        "transient",
        "The @everyone visibility default changed during reconciliation.",
      );
    return true;
  }
}
