/** Controlled channel effects for PostgreSQL policy/recovery scenarios; SDK permissions are tested separately. */
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import type { GuildAccessPort, PreparedAccess } from "../../src/application/records.js";
import {
  channelAccessOverwrites,
  sameOverwrites,
  type AccessChannel,
  type AccessRoles,
  type AccessSnapshot,
  type ChannelAudience,
} from "../../src/domain/channel-access.js";

/** Mutable remote state and effect hooks model restarts, edits and partial failures without Discord credentials. */
export class FakeGuildAccess implements GuildAccessPort {
  readonly guilds = new Map<string, AccessSnapshot>();
  readonly writes: string[] = [];
  beforeWrite: ((channel: string) => Promise<void>) | undefined;
  afterWrite: ((channel: string) => Promise<void>) | undefined;
  private next = 800000;

  async check(): Promise<void> {}
  /** Existing rooms are reused by ID; snapshots retain the pre-enforcement state. */
  async prepare(
    guild: string,
    _actor: string,
    roles: AccessRoles,
    lobbyId: string | null,
    officerId: string | null,
  ): Promise<PreparedAccess> {
    const snapshot = this.state(guild);
    const room = (id: string | null, name: string, audience: ChannelAudience) => {
      const existing = snapshot.channels.find((channel) => channel.id === id);
      if (existing) return { id: existing.id, created: false };
      const channel: AccessChannel = {
        id: String(++this.next),
        name,
        type: ChannelType.GuildText,
        parentId: null,
        overwrites: channelAccessOverwrites([], guild, snapshot.botId, roles, audience),
        everyoneVisible: audience === "lobby",
        memberVisible: false,
        guestVisible: false,
      };
      snapshot.channels.push(channel);
      return { id: channel.id, created: true };
    };
    const lobby = room(lobbyId, "lobby", "lobby"),
      officers = room(officerId, "officer-chat", "officers");
    return { lobby, officers, snapshot: structuredClone(snapshot) };
  }
  /** Tests may seed any non-thread channel types, including staff-only categories. */
  state(guild: string): AccessSnapshot {
    let snapshot = this.guilds.get(guild);
    if (!snapshot) {
      snapshot = {
        botId: "800",
        everyonePermissions: String(P.ViewChannel | P.SendMessages),
        excludedChannelIds: [],
        preserveEveryoneView: false,
        channels: [],
      };
      this.guilds.set(guild, snapshot);
    }
    return snapshot;
  }
  async snapshot(guild: string): Promise<AccessSnapshot> {
    return structuredClone(this.state(guild));
  }
  async channel(
    guild: string,
    id: string,
    roles: AccessRoles,
    audience: ChannelAudience,
    guard: () => Promise<void>,
  ): Promise<boolean> {
    const snapshot = this.state(guild),
      channel = snapshot.channels.find((value) => value.id === id);
    if (snapshot.excludedChannelIds.includes(id))
      throw new Error("Attempted mutation of excluded channel");
    if (!channel) throw new Error("Missing fake channel");
    const desired = channelAccessOverwrites(
      channel.overwrites,
      guild,
      snapshot.botId,
      roles,
      audience,
    );
    if (
      sameOverwrites(channel.overwrites, desired) &&
      (audience !== "lobby" || channel.parentId === null)
    )
      return false;
    await this.beforeWrite?.(id);
    await guard();
    channel.overwrites = desired;
    if (audience === "lobby") channel.parentId = null;
    this.writes.push(id);
    await this.afterWrite?.(id);
    return true;
  }
  async restrictEveryone(guild: string, guard: () => Promise<void>): Promise<boolean> {
    const snapshot = this.state(guild);
    if (snapshot.preserveEveryoneView) return false;
    if ((BigInt(snapshot.everyonePermissions) & P.ViewChannel) === 0n) return false;
    await this.beforeWrite?.("everyone");
    await guard();
    snapshot.everyonePermissions = String(BigInt(snapshot.everyonePermissions) & ~P.ViewChannel);
    this.writes.push("everyone");
    await this.afterWrite?.("everyone");
    return true;
  }
}
