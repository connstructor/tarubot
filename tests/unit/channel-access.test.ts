/** Effective SDK permissions, not overwrite shape alone, define the onboarding access contract. */
import { expect, test } from "bun:test";
import { ChannelType, OverwriteType, PermissionFlagsBits as P } from "discord.js";
import {
  accessRoles,
  channelAccessOverwrites,
  initiallyStaffOnly,
  sameOverwrites,
  type AccessChannel,
} from "../../src/domain/channel-access.js";
import { discordAccessFixture } from "../fixtures/discord-access.js";

test("all non-thread channel types enforce the newcomer, member, guest, staff and bot visibility matrix", async () => {
  const fixture = discordAccessFixture();
  try {
    const guild = await fixture.client.guilds.fetch("100");
    const viewers = await Promise.all(
      [...fixture.people.keys()].map((user) => guild.members.fetch(user)),
    );
    for (const type of [
      ChannelType.GuildText,
      ChannelType.GuildVoice,
      ChannelType.GuildCategory,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildStageVoice,
      ChannelType.GuildForum,
      ChannelType.GuildMedia,
    ]) {
      for (const audience of ["lobby", "members", "officers"] as const) {
        // Both an unrelated role and a direct user overwrite previously leaked View Channel.
        const current = [
          {
            id: "500",
            type: OverwriteType.Role,
            allow: String(P.ViewChannel | P.ManageMessages),
            deny: "0",
          },
          { id: "400", type: OverwriteType.Member, allow: String(P.ViewChannel), deny: "0" },
          { id: "403", type: OverwriteType.Member, allow: "0", deny: String(P.ViewChannel) },
        ];
        const planned = channelAccessOverwrites(current, "100", "900", fixture.bindings, audience);
        const raw = fixture.add(`${audience}-${type}`, type, planned);
        const channel = await guild.channels.fetch(raw.id);
        if (!channel || channel.isThread()) throw new Error("Missing channel fixture");
        for (const member of viewers) {
          const staff = ["403", "404", "900"].includes(member.id);
          // Manage Guild/Channels alone does not bypass overwrites; Administrator does.
          const expected =
            ["300", "406"].includes(member.id) ||
            staff ||
            (audience === "lobby"
              ? !["401", "402"].includes(member.id)
              : audience === "members" && ["401", "402"].includes(member.id));
          expect({
            type,
            audience,
            user: member.id,
            visible: channel.permissionsFor(member).has(P.ViewChannel),
          }).toEqual({ type, audience, user: member.id, visible: expected });
        }
        expect(planned.find((overwrite) => overwrite.id === "500")?.allow).toBe(
          String(P.ManageMessages),
        );
        expect(
          sameOverwrites(
            planned,
            channelAccessOverwrites(planned, "100", "900", fixture.bindings, audience),
          ),
        ).toBe(true);
      }
    }
  } finally {
    await fixture.close();
  }
});

test("lobby permits onboarding commands and chat, blocks newcomers creating threads, and hides parent threads with member access", async () => {
  const fixture = discordAccessFixture();
  try {
    const guild = await fixture.client.guilds.fetch("100");
    const raw = fixture.add(
      "lobby",
      ChannelType.GuildText,
      channelAccessOverwrites([], "100", "900", fixture.bindings, "lobby"),
    );
    const channel = await guild.channels.fetch(raw.id);
    const newcomer = await guild.members.fetch("400"),
      member = await guild.members.fetch("401");
    if (!channel) throw new Error("Missing lobby");
    expect(
      channel
        .permissionsFor(newcomer)
        .has([P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.UseApplicationCommands]),
    ).toBe(true);
    expect(
      channel.permissionsFor(newcomer).any([P.CreatePrivateThreads, P.CreatePublicThreads]),
    ).toBe(false);
    expect(channel.permissionsFor(member).has(P.ViewChannel)).toBe(false);
    // Discord.js resolves a thread through its parent's overwrites, including explicitly joined users.
    const thread = {
      id: "2000",
      guild_id: "100",
      parent_id: raw.id,
      name: "thread",
      type: ChannelType.PublicThread,
      permission_overwrites: [],
      thread_metadata: {
        archived: false,
        auto_archive_duration: 60,
        archive_timestamp: "2026-01-01T00:00:00Z",
        locked: false,
      },
    };
    fixture.channels.push(thread);
    const observed = await fixture.client.channels.fetch(thread.id);
    if (!observed?.isThread()) throw new Error("Missing thread");
    expect(observed.permissionsFor(member).has(P.ViewChannel)).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("channel setup reuses private officer rooms and retains original lobby parent until durable enforcement", async () => {
  const fixture = discordAccessFixture();
  try {
    const category = fixture.add("public", ChannelType.GuildCategory);
    const lobby = fixture.add("lobby", ChannelType.GuildText, [], category.id);
    fixture.add("staff");
    const officers = fixture.add("officer-chat", ChannelType.GuildText, [
      { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
      { id: "600", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
    ]);
    await fixture.port.check("100", "301");
    const prepared = await fixture.port.prepare("100", "301", fixture.bindings, null, null);
    expect(prepared.lobby).toEqual({ id: lobby.id, created: false });
    expect(prepared.officers).toEqual({ id: officers.id, created: false });
    expect(prepared.snapshot.channels.find((channel) => channel.id === lobby.id)?.parentId).toBe(
      category.id,
    );
    expect(fixture.writes).toHaveLength(0);
    expect(
      await fixture.port.channel("100", lobby.id, fixture.bindings, "lobby", async () => {}),
    ).toBe(true);
    expect(lobby.parent_id).toBeNull();
    expect(await fixture.port.restrictEveryone("100", async () => {})).toBe(true);
    const writes = fixture.writes.length;
    expect(
      await fixture.port.channel("100", lobby.id, fixture.bindings, "lobby", async () => {}),
    ).toBe(false);
    expect(await fixture.port.restrictEveryone("100", async () => {})).toBe(false);
    expect(fixture.writes).toHaveLength(writes);
    const guild = await fixture.client.guilds.fetch("100");
    const fresh = fixture.add("new-default");
    const channel = await guild.channels.fetch(fresh.id);
    const newcomer = await guild.members.fetch("400");
    expect(channel?.permissionsFor(newcomer).has(P.ViewChannel)).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("missing rooms are created with their final privacy policy and repeated setup reuses bindings", async () => {
  const fixture = discordAccessFixture();
  try {
    const prepared = await fixture.port.prepare("100", "301", fixture.bindings, null, null);
    expect(prepared.lobby.created).toBe(true);
    expect(prepared.officers.created).toBe(true);
    const again = await fixture.port.prepare(
      "100",
      "301",
      fixture.bindings,
      prepared.lobby.id,
      prepared.officers.id,
    );
    expect(again.lobby).toEqual({ id: prepared.lobby.id, created: false });
    expect(again.officers).toEqual({ id: prepared.officers.id, created: false });
    expect(fixture.channels).toHaveLength(2);
    const guild = await fixture.client.guilds.fetch("100");
    const member = await guild.members.fetch("401"),
      officer = await guild.members.fetch("403");
    const room = await guild.channels.fetch(prepared.officers.id);
    expect(room?.permissionsFor(member).has(P.ViewChannel)).toBe(false);
    expect(room?.permissionsFor(officer).has(P.ViewChannel)).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("ambiguous rooms, insufficient authority, dangerous roles and superseded writes fail before effects", async () => {
  const fixture = discordAccessFixture();
  try {
    const lobby = fixture.add("lobby");
    const twin = fixture.add("lobby");
    // Same-named rooms are ambiguous, and the detail lists both so the reply can name them.
    await expect(
      fixture.port.prepare("100", "301", fixture.bindings, null, null),
    ).rejects.toMatchObject({
      code: "ambiguous",
      detail: { kind: "matches", resource: "channel", name: "lobby", ids: [lobby.id, twin.id] },
    });
    await expect(fixture.port.check("100", "400")).rejects.toMatchObject({
      code: "forbidden",
      detail: { kind: "scope", scope: "manager" },
    });
    const role = fixture.roles.find((role) => role.id === "201");
    if (!role) throw new Error("Missing member role");
    role.permissions = String(P.ManageChannels);
    await expect(fixture.port.snapshot("100", fixture.bindings)).rejects.toMatchObject({
      code: "blocked",
      detail: { kind: "resource", resource: "role", id: "201" },
    });
    role.permissions = "0";
    await expect(
      fixture.port.channel("100", lobby.id, fixture.bindings, "lobby", async () => {
        throw new Error("superseded");
      }),
    ).rejects.toThrow("superseded");
    expect(fixture.writes).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("explicit visibility denies keep new default-closed channels staff-only", async () => {
  const fixture = discordAccessFixture();
  try {
    await fixture.port.restrictEveryone("100", async () => {});
    const guild = await fixture.client.guilds.fetch("100");
    const member = await guild.members.fetch("401"),
      guest = await guild.members.fetch("402"),
      officer = await guild.members.fetch("403");
    for (const denied of [
      { id: fixture.bindings.member, type: OverwriteType.Role },
      { id: fixture.bindings.guest, type: OverwriteType.Role },
      { id: "500", type: OverwriteType.Role },
      { id: "400", type: OverwriteType.Member },
    ]) {
      // A real SDK snapshot distinguishes explicit privacy from the removed everyone default.
      const raw = fixture.add(`private-${denied.id}`, ChannelType.GuildText, [
        { ...denied, allow: "0", deny: String(P.ViewChannel) },
      ]);
      const snapshot = await fixture.port.snapshot("100", fixture.bindings);
      const observed = snapshot.channels.find((channel) => channel.id === raw.id);
      if (!observed) throw new Error("Missing private channel observation");
      expect(observed).toMatchObject({
        everyoneVisible: false,
        memberVisible: false,
        guestVisible: false,
      });
      const audience = initiallyStaffOnly(observed, true, false) ? "officers" : "members";
      await fixture.port.channel("100", raw.id, fixture.bindings, audience, async () => {});
      const channel = await guild.channels.fetch(raw.id);
      if (!channel) throw new Error("Missing enforced private channel");
      expect({
        denied,
        member: channel.permissionsFor(member).has(P.ViewChannel),
        guest: channel.permissionsFor(guest).has(P.ViewChannel),
        officer: channel.permissionsFor(officer).has(P.ViewChannel),
      }).toEqual({ denied, member: false, guest: false, officer: true });
    }
  } finally {
    await fixture.close();
  }
});

test("community updates and its category stay outside provisioning even when the bot cannot view them", async () => {
  const fixture = discordAccessFixture();
  try {
    const closed = [
      { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
    ];
    const parent = fixture.add("Admin", ChannelType.GuildCategory, structuredClone(closed));
    // An inviting name must never override the authoritative Discord community binding.
    const updates = fixture.add(
      "officer-chat",
      ChannelType.GuildText,
      structuredClone(closed),
      parent.id,
    );
    fixture.community.updatesChannelId = updates.id;
    const original = structuredClone([parent, updates]);
    const snapshot = await fixture.port.snapshot("100", fixture.bindings);
    expect(snapshot.excludedChannelIds.sort()).toEqual([parent.id, updates.id].sort());
    expect(snapshot.channels).toEqual([]);
    expect(snapshot.preserveEveryoneView).toBe(false);
    const prepared = await fixture.port.prepare("100", "301", fixture.bindings, null, null);
    expect(prepared.officers.created).toBe(true);
    expect(prepared.officers.id).not.toBe(updates.id);
    expect(fixture.channels.find((channel) => channel.id === prepared.officers.id)?.name).toBe(
      "officer-chat",
    );
    expect(
      prepared.snapshot.channels.some((channel) =>
        snapshot.excludedChannelIds.includes(channel.id),
      ),
    ).toBe(false);
    for (const id of snapshot.excludedChannelIds)
      await expect(
        fixture.port.channel("100", id, fixture.bindings, "officers", async () => {}),
      ).rejects.toThrow("reserved");
    expect(await fixture.port.restrictEveryone("100", async () => {})).toBe(true);
    expect([parent, updates]).toEqual(original);
    expect(
      fixture.writes.filter(
        (route) => route === `/channels/${parent.id}` || route === `/channels/${updates.id}`,
      ),
    ).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("reserved bindings and mid-write community reconfiguration cannot redirect onboarding into protected channels", async () => {
  const fixture = discordAccessFixture();
  try {
    const updates = fixture.add("updates");
    await expect(
      fixture.port.channel("100", updates.id, fixture.bindings, "officers", async () => {
        fixture.community.updatesChannelId = updates.id;
        // The Gateway applies this setting to the cached guild before dispatching GuildUpdate.
        const guild = fixture.client.guilds.cache.get("100");
        if (!guild) throw new Error("Missing cached guild");
        guild.publicUpdatesChannelId = updates.id;
      }),
    ).rejects.toMatchObject({ code: "superseded" });
    const parent = fixture.add("new-parent", ChannelType.GuildCategory);
    await expect(
      fixture.port.channel("100", parent.id, fixture.bindings, "members", async () => {
        updates.parent_id = parent.id;
        // Hidden channels still receive parent metadata through Guilds Gateway updates.
        const cached = fixture.client.guilds.cache.get("100")?.channels.cache.get(updates.id);
        if (!cached || cached.isThread()) throw new Error("Missing cached community channel");
        cached.parentId = parent.id;
      }),
    ).rejects.toMatchObject({ code: "superseded" });
    await expect(
      fixture.port.prepare("100", "301", fixture.bindings, null, updates.id),
    ).rejects.toThrow("reserved");
    await expect(
      fixture.port.prepare("100", "301", fixture.bindings, updates.id, null),
    ).rejects.toThrow("reserved");
    expect(fixture.writes).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("protected areas that inherit visibility retain the guild default while ordinary channels are gated", async () => {
  for (const withParent of [false, true]) {
    const fixture = discordAccessFixture();
    try {
      const parent = withParent ? fixture.add("Admin", ChannelType.GuildCategory) : undefined;
      const updates = fixture.add(
        "community-updates",
        ChannelType.GuildText,
        withParent
          ? [{ id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) }]
          : [],
        parent?.id ?? null,
      );
      fixture.community.updatesChannelId = updates.id;
      const before = structuredClone([updates, parent]);
      expect((await fixture.port.snapshot("100", fixture.bindings)).preserveEveryoneView).toBe(
        true,
      );
      expect(await fixture.port.restrictEveryone("100", async () => {})).toBe(false);
      expect(
        BigInt(fixture.roles.find((role) => role.id === "100")?.permissions ?? "0") & P.ViewChannel,
      ).toBe(P.ViewChannel);
      const ordinary = fixture.add("ordinary");
      await fixture.port.channel("100", ordinary.id, fixture.bindings, "members", async () => {});
      const guild = await fixture.client.guilds.fetch("100");
      const newcomer = await guild.members.fetch("400"),
        member = await guild.members.fetch("401");
      const channel = await guild.channels.fetch(ordinary.id);
      expect(channel?.permissionsFor(newcomer).has(P.ViewChannel)).toBe(false);
      expect(channel?.permissionsFor(member).has(P.ViewChannel)).toBe(true);
      expect([updates, parent]).toEqual(before);
      expect(fixture.writes).toEqual([`/channels/${ordinary.id}`]);
    } finally {
      await fixture.close();
    }
  }
});

test("missing community metadata blocks changes instead of guessing a protected parent", async () => {
  const fixture = discordAccessFixture();
  try {
    fixture.community.updatesChannelId = "9999";
    // Blocked, naming the community channel Discord did not return.
    const missing = {
      code: "blocked",
      detail: { kind: "resource", resource: "channel", id: "9999" },
    };
    await expect(
      fixture.port.prepare("100", "301", fixture.bindings, null, null),
    ).rejects.toMatchObject(missing);
    await expect(fixture.port.restrictEveryone("100", async () => {})).rejects.toMatchObject(
      missing,
    );
    expect(fixture.writes).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("a scoped pass stops on a disconnected gateway or missing protected metadata", async () => {
  const fixture = discordAccessFixture();
  try {
    const closed = [
      { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
    ];
    const parent = fixture.add("Admin", ChannelType.GuildCategory, structuredClone(closed));
    const updates = fixture.add(
      "updates",
      ChannelType.GuildText,
      structuredClone(closed),
      parent.id,
    );
    fixture.community.updatesChannelId = updates.id;
    const target = fixture.add("ordinary");
    const session = await fixture.port.begin("100", fixture.bindings);
    fixture.ready.mockReturnValue(false);
    await expect(session.channel(target.id, "members", async () => {})).rejects.toMatchObject({
      code: "transient",
    });
    fixture.ready.mockReturnValue(true);
    fixture.client.guilds.cache.get("100")?.channels.cache.delete(parent.id);
    await expect(session.restrictEveryone(async () => {})).rejects.toMatchObject({
      code: "superseded",
    });
    expect(fixture.writes).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("privacy classification separates newly closed defaults from explicit private areas", () => {
  const channel: AccessChannel = {
    id: "200",
    name: "room",
    type: ChannelType.GuildText,
    parentId: null,
    overwrites: [],
    everyoneVisible: false,
    memberVisible: false,
    guestVisible: false,
  };
  expect(initiallyStaffOnly(channel, false, false)).toBe(true);
  expect(initiallyStaffOnly(channel, true, false)).toBe(false);
  expect(initiallyStaffOnly(channel, true, true)).toBe(true);
  expect(
    initiallyStaffOnly(
      {
        ...channel,
        overwrites: [
          { id: "203", type: OverwriteType.Role, allow: String(P.ViewChannel), deny: "0" },
        ],
      },
      true,
      false,
    ),
  ).toBe(true);
  expect(() =>
    accessRoles({
      member_role_id: "1",
      guest_role_id: "1",
      officer_role_id: "2",
      leader_role_id: "3",
    }),
  ).toThrow("distinct");
});
