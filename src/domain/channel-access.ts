/** Pure channel-visibility policy; Discord permission aggregation is tested against the SDK. */
import { OverwriteType, PermissionFlagsBits as P } from "discord.js";
import { Failure } from "./values.js";

export type ChannelAudience = "lobby" | "members" | "officers";
export interface AccessRoles {
  member: string;
  guest: string;
  officer: string;
  leader: string;
}
export interface AccessOverwrite {
  id: string;
  type: OverwriteType;
  allow: string;
  deny: string;
}
export interface AccessChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  overwrites: AccessOverwrite[];
  everyoneVisible: boolean;
  memberVisible: boolean;
  guestVisible: boolean;
}
export interface AccessSnapshot {
  botId: string;
  everyonePermissions: string;
  /** Discord's community-updates channel and its parent remain outside onboarding ownership. */
  excludedChannelIds: string[];
  /** Preserve the guild default if changing it could affect an excluded channel's visibility. */
  preserveEveryoneView: boolean;
  channels: AccessChannel[];
}

/** An enabled gate needs all four bindings; deleted Discord resources are checked by the adapter. */
export function accessRoles(bindings: {
  member_role_id: string | null;
  guest_role_id: string | null;
  officer_role_id: string | null;
  leader_role_id: string | null;
}): AccessRoles {
  if (
    !bindings.member_role_id ||
    !bindings.guest_role_id ||
    !bindings.officer_role_id ||
    !bindings.leader_role_id
  )
    throw new Failure(
      "blocked",
      "Onboarding requires all four access roles. Run /setup to repair them.",
    );
  const roles = {
    member: bindings.member_role_id,
    guest: bindings.guest_role_id,
    officer: bindings.officer_role_id,
    leader: bindings.leader_role_id,
  };
  if (new Set(Object.values(roles)).size !== 4)
    throw new Failure("blocked", "Onboarding roles must be distinct.");
  return roles;
}

/** New plain channels start closed after @everyone loses View Channel; that alone is not staff-only. */
export function initiallyStaffOnly(
  channel: AccessChannel,
  alreadyEnabled: boolean,
  staffParent: boolean,
): boolean {
  if (staffParent) return true;
  if (channel.memberVisible || channel.guestVisible || channel.everyoneVisible) return false;
  return (
    !alreadyEnabled ||
    // Any explicit visibility exception is privacy evidence, regardless of overwrite target.
    channel.overwrites.some(
      (overwrite) => ((BigInt(overwrite.allow) | BigInt(overwrite.deny)) & P.ViewChannel) !== 0n,
    )
  );
}

/** Normalize only visibility grants; retain unrelated permission bits and remove empty overwrites. */
export function channelAccessOverwrites(
  current: readonly AccessOverwrite[],
  guild: string,
  bot: string,
  roles: AccessRoles,
  audience: ChannelAudience,
): AccessOverwrite[] {
  const values = new Map(
    current.map((overwrite) => [
      overwrite.id,
      {
        id: overwrite.id,
        type: overwrite.type,
        allow: BigInt(overwrite.allow) & ~P.ViewChannel,
        deny: BigInt(overwrite.deny) & ~P.ViewChannel,
      },
    ]),
  );
  const set = (id: string, type: OverwriteType, allow: bigint, deny: bigint): void => {
    const before = values.get(id) ?? { id, type, allow: 0n, deny: 0n };
    values.set(id, {
      ...before,
      type,
      allow: (before.allow & ~deny) | allow,
      deny: (before.deny & ~allow) | deny,
    });
  };
  const lobbyChat =
    P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.UseApplicationCommands;
  const threadCreation = P.CreatePublicThreads | P.CreatePrivateThreads;
  set(
    guild,
    OverwriteType.Role,
    audience === "lobby" ? lobbyChat : 0n,
    audience === "lobby" ? threadCreation : P.ViewChannel,
  );
  for (const id of [roles.member, roles.guest])
    set(
      id,
      OverwriteType.Role,
      audience === "members" ? P.ViewChannel : 0n,
      audience === "members" ? 0n : P.ViewChannel,
    );
  // Role allows take precedence over role denies: an Officer who also holds Member can see the lobby.
  for (const id of [roles.officer, roles.leader])
    set(id, OverwriteType.Role, audience === "members" ? P.ViewChannel : lobbyChat, 0n);
  set(
    bot,
    OverwriteType.Member,
    P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.EmbedLinks | P.AttachFiles,
    0n,
  );
  return [...values.values()]
    .filter((value) => value.allow !== 0n || value.deny !== 0n)
    .map((value) => ({ ...value, allow: String(value.allow), deny: String(value.deny) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Ignore API ordering and empty entries when deciding whether another write is necessary. */
export function sameOverwrites(
  left: readonly AccessOverwrite[],
  right: readonly AccessOverwrite[],
): boolean {
  const canonical = (items: readonly AccessOverwrite[]) =>
    JSON.stringify(
      items
        .filter((item) => BigInt(item.allow) !== 0n || BigInt(item.deny) !== 0n)
        .map((item) => ({
          id: item.id,
          type: item.type,
          allow: String(BigInt(item.allow)),
          deny: String(BigInt(item.deny)),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  return canonical(left) === canonical(right);
}
