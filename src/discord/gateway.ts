/** Discord.js adapter: current permission checks, complete observations, and scoped effects. */
import { createHash } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  DiscordAPIError,
  GatewayIntentBits,
  PermissionFlagsBits,
} from "discord.js";
import type { GuildMember } from "discord.js";
import { Failure, normalized } from "../domain/values.js";
import type { Actor } from "../domain/policy.js";
import type { ApplicationRecord, DiscordPort, MemberView } from "../application/records.js";
import { rolePositionChanges } from "../domain/role-layout.js";
import { existingRoleId } from "../domain/role-selection.js";

/** Exposes a reusable Discord client plus application-owned projections of SDK state. */
export class DiscordGateway implements DiscordPort {
  // Add intents here deliberately when new event modules require them; enable privileged ones in the portal.
  readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    allowedMentions: { parse: [] },
    rest: { timeout: 15000, retries: 3 },
  });
  /** Copy mutable SDK state into the small snapshot consumed by application policy. */
  private view(member: GuildMember): MemberView {
    if (!member.joinedAt) throw new Failure("incomplete", "Guild join context is unavailable.");
    return {
      id: member.id,
      guildId: member.guild.id,
      joinedAt: member.joinedAt,
      nickname: member.nickname,
      roles: [...member.roles.cache.keys()],
      bot: member.user.bot,
    };
  }
  /** Refresh role definitions and membership so cached permissions cannot authorize a new action. */
  async actor(guildId: string, userId: string): Promise<Actor> {
    const guild = await this.client.guilds.fetch({ guild: guildId, force: true });
    await guild.roles.fetch();
    const member = await guild.members.fetch({ user: userId, force: true });
    if (member.user.bot)
      throw new Failure("forbidden", "Bot accounts cannot invoke these operations.");
    return {
      guildId,
      userId,
      officer: member.permissions.has(PermissionFlagsBits.ManageGuild),
      manageRoles: member.permissions.has(PermissionFlagsBits.ManageRoles),
      serverManager: member.permissions.has(PermissionFlagsBits.ManageGuild),
      roleIds: [...member.roles.cache.keys()],
    };
  }
  /** Only explicit unknown-member/user responses mean departure; network failures propagate. */
  async member(guildId: string, userId: string): Promise<MemberView | null> {
    const guild = await this.client.guilds.fetch(guildId);
    try {
      return this.view(await guild.members.fetch({ user: userId, force: true }));
    } catch (error) {
      if (error instanceof DiscordAPIError && [10007, 10013].includes(Number(error.code)))
        return null;
      throw error;
    }
  }
  /** Require complete, count-consistent enumeration before snapshot or guild-wide reconciliation. */
  async members(guildId: string): Promise<MemberView[]> {
    const guild = await this.client.guilds.fetch(guildId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const count = guild.memberCount;
      const members = await guild.members.fetch({ time: 60000 });
      if (members.size === count && count === guild.memberCount)
        return [...members.values()].map((member) => this.view(member));
    }
    throw new Failure(
      "incomplete",
      "Discord member enumeration changed or did not complete. Retry the snapshot.",
    );
  }
  /** Access roles must be assignable, nonadministrative, and below the applicable hierarchies. */
  async validateRole(guildId: string, roleId: string, actorId?: string): Promise<void> {
    const guild = await this.client.guilds.fetch({ guild: guildId, force: true });
    const role = (await guild.roles.fetch()).get(roleId);
    const bot = await guild.members.fetchMe({ force: true });
    if (
      !role ||
      role.guild.id !== guildId ||
      role.id === guild.id ||
      role.managed ||
      bot.roles.botRole?.id === role.id
    )
      throw new Failure("blocked", "Select an existing, ordinary guild access role.");
    if (
      role.permissions.has(PermissionFlagsBits.Administrator, false) ||
      role.permissions.has(PermissionFlagsBits.ManageGuild, false) ||
      role.permissions.has(PermissionFlagsBits.ManageRoles, false)
    )
      throw new Failure(
        "blocked",
        "Access roles must not grant Administrator, Manage Server, or Manage Roles.",
      );
    if (
      !bot.permissions.has(PermissionFlagsBits.ManageRoles) ||
      bot.roles.highest.comparePositionTo(role) <= 0
    )
      throw new Failure(
        "blocked",
        "Give the bot Manage Roles and place its role above the configured access role.",
      );
    if (actorId) {
      const actor = await guild.members.fetch({ user: actorId, force: true });
      if (
        !actor.permissions.has(PermissionFlagsBits.ManageRoles) ||
        (guild.ownerId !== actorId && actor.roles.highest.comparePositionTo(role) <= 0)
      )
        throw new Failure(
          "forbidden",
          "Your highest role must be above the selected role, and Manage Roles is required.",
        );
    }
  }
  /** Setup adopts a configured/exact-name role or creates a zero-permission role below the bot. */
  async ensureRole(
    guildId: string,
    name: string,
    actorId: string,
    configured: string | null,
    canonicalName: string,
  ): Promise<{ id: string; created: boolean }> {
    const guild = await this.client.guilds.fetch(guildId);
    const roles = await guild.roles.fetch();
    const existing = existingRoleId([...roles.values()], name, canonicalName, configured);
    let role = existing ? roles.get(existing) : undefined;
    let created = false;
    if (!role) {
      role = await guild.roles.create({
        name,
        permissions: 0n,
        hoist: true,
        reason: `TaruBot setup requested by ${actorId}`,
      });
      created = true;
    }
    await this.validateRole(guildId, role.id, actorId);
    // Adopt the requested prefix without replacing the existing ID, permissions, or holders.
    if (role.name !== name && normalized(role.name) === normalized(canonicalName))
      await role.setName(name, `TaruBot setup role reuse requested by ${actorId}`);
    return { id: role.id, created };
  }
  /** Keep managed role headings visible and ordered while preserving unrelated hierarchy slots. */
  async layoutRoles(
    guildId: string,
    priority: readonly string[],
    guard: () => Promise<void>,
  ): Promise<unknown> {
    if (!priority.length) return { order: [], hoisted: [], positions: [] };
    const guild = await this.client.guilds.fetch(guildId);
    for (const roleId of priority) await this.validateRole(guildId, roleId);
    let roles = await guild.roles.fetch();
    const hoisted: string[] = [];
    for (const roleId of priority) {
      const role = roles.get(roleId);
      if (!role) throw new Failure("blocked", "A configured role was deleted before layout.");
      if (!role.hoist) {
        await guard();
        await role.setHoist(true, "TaruBot managed-role member-list grouping");
        hoisted.push(roleId);
      }
    }
    roles = await guild.roles.fetch();
    // Discord can give new roles identical raw positions; SDK comparison resolves their ID ties.
    const ascending = [...roles.values()]
      .sort((left, right) => left.comparePositionTo(right))
      .map((role) => role.id);
    const positions = rolePositionChanges(ascending, priority);
    if (positions.length) {
      await guard();
      await guild.roles.setPositions(positions);
    }
    const verified = await guild.roles.fetch();
    const actual = [...verified.values()]
      .sort((left, right) => left.comparePositionTo(right))
      .map((role) => role.id);
    const expected = positions.length ? positions.map((entry) => entry.role) : ascending;
    if (
      actual.join(":") !== expected.join(":") ||
      rolePositionChanges(actual, priority).length > 0 ||
      priority.some((role) => !verified.get(role)?.hoist)
    ) {
      throw new Failure(
        "transient",
        "Discord role layout changed while it was being applied; retrying current policy.",
      );
    }
    return { order: [...priority], hoisted, positions };
  }
  /** Fetch the channel globally, then explicitly check guild ownership and current overwrites. */
  async validateChannel(guildId: string, channelId: string): Promise<void> {
    const guild = await this.client.guilds.fetch(guildId);
    await guild.roles.fetch();
    const channel = await this.client.channels
      .fetch(channelId, { force: true })
      .catch((error: unknown) => {
        if (error instanceof DiscordAPIError && [10003, 50001].includes(Number(error.code)))
          return null;
        throw error;
      });
    const bot = await guild.members.fetchMe({ force: true });
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.guildId !== guildId ||
      !channel
        .permissionsFor(bot)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
        ])
    )
      throw new Failure(
        "blocked",
        "Choose a text channel in this guild where the bot can view, send, embed links, and read message history.",
      );
  }
  /** REST deltas touch only requested role IDs; retry observes any partially applied transition. */
  async roles(guildId: string, userId: string, add: string[], remove: string[]): Promise<void> {
    if (!add.length && !remove.length) return;
    const guild = await this.client.guilds.fetch(guildId);
    const member = await guild.members.fetch({ user: userId, force: true });
    await guild.roles.fetch();
    // Individual deltas preserve unrelated roles and make partial transitions retryable.
    for (const roleId of remove) {
      const role = await guild.roles.fetch(roleId);
      if (!role) continue;
      const bot = await guild.members.fetchMe();
      if (
        !bot.permissions.has(PermissionFlagsBits.ManageRoles) ||
        bot.roles.highest.comparePositionTo(role) <= 0
      )
        throw new Failure("blocked", "A current or retired access role is above the bot's role.");
      await member.roles.remove(roleId, "TaruBot access reconciliation");
    }
    for (const roleId of add) {
      await this.validateRole(guildId, roleId);
      await member.roles.add(roleId, "TaruBot access reconciliation");
    }
  }
  /** Recheck the expected nickname immediately before writing to respect intervening manual edits. */
  async nickname(
    guildId: string,
    userId: string,
    value: string | null,
    expected: string | null,
  ): Promise<boolean> {
    const guild = await this.client.guilds.fetch({ guild: guildId, force: true });
    await guild.roles.fetch();
    const bot = await guild.members.fetchMe({ force: true });
    const member = await guild.members.fetch({ user: userId, force: true });
    if (member.nickname !== expected) return false;
    if (!bot.permissions.has(PermissionFlagsBits.ManageNicknames) || !member.manageable)
      throw new Failure(
        "blocked",
        "Nickname update requires Manage Nicknames and a manageable member below the bot, excluding the guild owner.",
      );
    await member.setNickname(value, "TaruBot character nickname");
    return true;
  }
  /** Use stable recent-message deduplication and explicit mention policy for outbox delivery. */
  async send(
    guildId: string,
    channelId: string,
    content: string,
    key: string,
    application?: ApplicationRecord,
  ): Promise<string> {
    await this.validateChannel(guildId, channelId);
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText)
      throw new Failure("blocked", "Text channel unavailable.");
    const components = application ? [this.controls(application)] : [];
    const nonce = BigInt(
      // A short decimal nonce fits Discord's limit while identifying the same durable effect.
      `0x${createHash("sha256").update(key).digest("hex").slice(0, 15)}`,
    ).toString();
    return (
      await channel.send({
        content: content.slice(0, 1950),
        allowedMentions: { parse: [] },
        nonce,
        enforceNonce: true,
        components,
      })
    ).id;
  }
  /** Custom IDs route through the discovered guest component and durable application identity. */
  private controls(application: ApplicationRecord): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`guest:approve:${application.id}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success)
        .setDisabled(application.state !== "pending"),
      new ButtonBuilder()
        .setCustomId(`guest:deny:${application.id}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(application.state !== "pending"),
    );
  }
  /** Update completed controls, or recreate an explicitly missing review message. */
  async editReview(application: ApplicationRecord, content: string): Promise<string> {
    await this.validateChannel(application.guild_id, application.channel_id);
    const channel = await this.client.channels.fetch(application.channel_id);
    if (!channel || channel.type !== ChannelType.GuildText)
      throw new Failure("blocked", "Review channel unavailable.");
    if (application.message_id) {
      try {
        const message = await channel.messages.fetch(application.message_id);
        await message.edit({
          content: content.slice(0, 1950),
          allowedMentions: { parse: [] },
          components: [this.controls(application)],
        });
        return message.id;
      } catch (error) {
        if (!(error instanceof DiscordAPIError && Number(error.code) === 10008)) throw error;
      }
    }
    return this.send(
      application.guild_id,
      application.channel_id,
      content,
      `review:${application.id}`,
      application,
    );
  }
  /** A disabled inbox is a terminal delivery result, never a rollback of the guest decision. */
  async dm(user: string, content: string): Promise<void> {
    try {
      await (await this.client.users.fetch(user)).send({
        content: content.slice(0, 1950),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      if (error instanceof DiscordAPIError && Number(error.code) === 50007)
        throw new Failure("dm_blocked", "The recipient has disabled DMs.");
      throw error;
    }
  }
}
