/** Real PostgreSQL invariants/recovery with supplied or synthetic SQL and controlled external effects. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ChannelType,
  InteractionResponseType,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits as P,
} from "discord.js";
import type { AccessChannel } from "../../src/domain/channel-access.js";
import { channelAccessOverwrites } from "../../src/domain/channel-access.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as t from "../../src/infrastructure/postgres/schema.js";
import { capabilityMetrics } from "../../src/application/metrics.js";
import { Service } from "../../src/application/service.js";
import { GuildEvents } from "../../src/application/guild-events.js";
import {
  RoleAdministration,
  type RoleProvisioner,
} from "../../src/application/role-administration.js";
import { rankAccess, desiredRankRole } from "../../src/application/rank-policy.js";
import { Synchronization } from "../../src/application/synchronization.js";
import type {
  ApplicationRecord,
  DirectMessage,
  DiscordPort,
  MemberView,
  PostMessage,
} from "../../src/application/records.js";
import type { Configuration } from "../../src/config/env.js";
import type { Actor } from "../../src/domain/policy.js";
import { desiredAccess } from "../../src/domain/policy.js";
import { Failure, json } from "../../src/domain/values.js";
import { audit, Database, ensureUser, orm } from "../../src/infrastructure/postgres/database.js";
import { Nodestone } from "../../src/infrastructure/nodestone/client.js";
import type { Roster } from "../../src/infrastructure/nodestone/client.js";
import { readDump } from "../../src/import/dump.js";
import { importLegacy, mappings, type Snapshot } from "../../src/import/importer.js";
import {
  enqueue,
  layoutGuildRoles,
  Queue,
  reconcileUser,
  STALE_WAIT_MS,
  type Job,
  type QueueEvent,
} from "../../src/jobs/queue.js";
import { dispatcher } from "../../src/jobs/dispatch.js";
import { GuildAccess } from "../../src/application/guild-access.js";
import { FakeGuildAccess } from "../fixtures/guild-access.js";
import { discordAccessFixture } from "../fixtures/discord-access.js";
import { interactionFixture } from "../fixtures/interactions.js";
import { applicationKey } from "../../src/application/keys.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { Services } from "../../src/bot/services.js";
import applyCommand from "../../src/commands/guests/apply.command.js";
import applyComponent from "../../src/components/guest-application.component.js";
import reviewComponent from "../../src/components/guest-review.component.js";
import { guestApplicationModal } from "../../src/discord/guest-application.js";
import { ledgerPost } from "../../src/discord/presenters/ledger.js";
import { GUEST_APPLICATIONS_CLOSED } from "../../src/domain/guest-application.js";
import {
  activateGuild,
  assertFreshRoster,
  GrandfatherPlanMismatch,
} from "../../src/application/activation.js";
import {
  lateJoiners,
  pendingDepartures,
  planGrandfathering,
} from "../../src/application/grandfathering.js";
import { grandfatherReport, reviewedPlan } from "../../src/domain/grandfathering.js";

const url = process.env.TEST_DATABASE_URL;
// These tests deliberately recreate a disposable schema; production connections are rejected below.
const sourceText = url
  ? await Bun.file(
      process.env.LEGACY_FIXTURE_PATH ?? new URL("../../tarubot_backup.sql", import.meta.url),
    ).text()
  : "";
describe.skipIf(!url)("PostgreSQL invariants and selected migration fixture", () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must point to a disposable database ending in _test.");
  const db = new Database(url);
  const members = new Map<string, MemberView>();
  const absent = new Set<string>();
  let proof = "";
  let sendBlocked = false;
  let nicknameBlocked = false;
  let nicknameRace = false;
  /** Posts and DMs the dispatcher handed over, so tests can check the data (not text) it passes. */
  const sent: { guild: string; channel: string; message: PostMessage; key: string }[] = [];
  const dms: { user: string; message: DirectMessage }[] = [];
  const discord: DiscordPort = {
    // Mutable observations and injected delivery failures model Discord races without credentials.
    async member(guild, user) {
      if (absent.has(user)) return null;
      const current = members.get(user);
      if (current) return current;
      const member = {
        id: user,
        guildId: guild,
        joinedAt: new Date("2026-01-01T00:00:00Z"),
        nickname: "Before",
        roles: [],
        bot: false,
      };
      members.set(user, member);
      return member;
    },
    async members() {
      return [...members.values()];
    },
    async validateRole() {},
    async validateChannel() {},
    /** Simulate role metadata independently from membership deltas in persistence scenarios. */
    async layoutRoles(_guild, priority, guard) {
      await guard();
      return { order: [...priority], hoisted: [...priority] };
    },
    async roles(_guild, user, add, remove) {
      const member = members.get(user);
      if (member)
        member.roles = [
          ...new Set([...member.roles.filter((role) => !remove.includes(role)), ...add]),
        ];
    },
    async nickname(_guild, user, value, expected) {
      if (nicknameBlocked) throw new Failure("blocked", "Test nickname hierarchy blocked.");
      const member = members.get(user);
      if (member && nicknameRace) {
        nicknameRace = false;
        member.nickname = "Race override";
      }
      if (!member || member.nickname !== expected) return false;
      member.nickname = value;
      return true;
    },
    async send(guild, channel, message, key) {
      if (sendBlocked) throw new Failure("blocked", "Test channel delivery blocked.");
      sent.push({ guild, channel, message, key });
      return "123456789";
    },
    async editReview(_application: ApplicationRecord) {
      return "123456789";
    },
    async dm(user, message) {
      dms.push({ user, message });
    },
  };
  class FakeNodestone extends Nodestone {
    // Explicit observation timestamps advance departure evidence without waiting a real minute.
    rosterValue: Roster | null = null;
    rosterFailure = false;
    /** Setup validates public FC identity without making a live request in persistence tests. */
    override async company(fcId: string) {
      return {
        id: fcId,
        name: "Setup FC",
        tag: "TEST",
        world: "Diabolos",
        dc: "Crystal",
        count: 0,
      };
    }
    override async profile(characterId: string) {
      return {
        id: characterId,
        name: "Verified Character",
        world: "Diabolos",
        dc: "Crystal",
        fcId: null,
        biography: proof,
      };
    }
    override async roster(): Promise<Roster> {
      if (this.rosterFailure) throw new Failure("incomplete", "Test incomplete observation");
      if (!this.rosterValue) throw new Error("Configure roster fixture");
      return this.rosterValue;
    }
  }
  const source = readDump(sourceText);
  const legacyGuild = source.guilds[0];
  if (!legacyGuild) throw new Error("Missing fixture guild");
  const guild = legacyGuild.guild_id;
  const fc = legacyGuild.fc;
  if (!fc) throw new Error("Missing fixture FC");
  const historical = source.characters.find((row) => row.owner && row.fc === fc);
  if (!historical?.owner) throw new Error("Missing owned FC member fixture");
  const historicalOwner = historical.owner;
  const snapshot: Snapshot = {
    // Synthetic humans test grandfathering; this artifact is never used for production cutover.
    capturedAt: "2026-09-21T00:00:00Z",
    guilds: [
      {
        id: guild,
        complete: true,
        expectedCount: 2,
        enumeratedCount: 2,
        members: [
          {
            id: "987654321012345678",
            roles: [legacyGuild.guest_role_id ?? "1"],
            nickname: "Preserved Nickname",
            joinedAt: "2020-01-01T00:00:00Z",
          },
          {
            id: historicalOwner,
            roles: [legacyGuild.member_role_id ?? "2"],
            nickname: "Imported nickname",
            joinedAt: "2020-01-01T00:00:00Z",
          },
        ],
      },
    ],
  };
  const config: Configuration = {
    DATABASE_URL: url,
    DISCORD_TOKEN: "test-only",
    DISCORD_APPLICATION_ID: "123",
    NODESTONE_URL: "http://unused",
    LOG_LEVEL: "error",
    ENABLE_EFFECTS: true,
    TEST_GUILD_ID: "",
    PUBLIC_TEST_RESPONSES: false,
    ROSTER_INTERVAL_SECONDS: 21600,
    PROFILE_INTERVAL_SECONDS: 86400,
    VERIFICATION_SECONDS: 1800,
    GUEST_COOLDOWN_SECONDS: 86400,
    HEALTH_PORT: 3000,
  };
  const nodestone = new FakeNodestone("http://unused");
  const service = new Service(db, discord, nodestone, config);
  /** Existing decision scenarios now submit the same bounded form contract as Discord visitors. */
  async function applicationInput(applicant: Actor) {
    const member = await discord.member(applicant.guildId, applicant.userId);
    if (!member) throw new Error("Missing application fixture member");
    return {
      joinedAt: new Date(member.joinedAt),
      introduction: "I enjoy playing games with friends.",
      interest: "A friend invited me to meet your community.",
    };
  }
  const sync = new Synchronization(service);
  const accessPort = new FakeGuildAccess();
  const access = new GuildAccess(service, accessPort);
  const actor: Actor = {
    guildId: guild,
    userId: "999999999999999990",
    officer: true,
    manageRoles: true,
  };
  beforeAll(async () => {
    // A fresh schema verifies migration installation as well as import publication.
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await db.migrate();
    await db.schema();
    await importLegacy(db, source, snapshot, mappings(source));
    // Imports now leave guest applications closed (owner decision 2026-09-23), so the form
    // scenarios below opt in to the legacy review channel explicitly. A dedicated test covers the
    // closed state.
    await db.orm
      .update(t.guilds)
      .set({ guest_application_channel_id: legacyGuild.guest_application_channel_id })
      .where(eq(t.guilds.id, guild));
    for (const member of snapshot.guilds[0]?.members ?? [])
      members.set(member.id, {
        ...member,
        guildId: guild,
        joinedAt: new Date(member.joinedAt),
        bot: false,
      });
  }, 30000);
  afterAll(async () => {
    await db.close();
  });
  test("selected dump reconciles counts, opening states and exact configured balance", async () => {
    const row = (
      await db.query<{
        fc: bigint;
        characters: bigint;
        users: bigint;
        links: bigint;
        accounts: bigint;
        entries: bigint;
        unknown: bigint;
      }>(
        "SELECT (SELECT count(*) FROM free_companies) AS fc,(SELECT count(*) FROM characters) AS characters,(SELECT count(*) FROM users) AS users,(SELECT count(*) FROM links) AS links,(SELECT count(*) FROM ledger_accounts) AS accounts,(SELECT count(*) FROM ledger_entries) AS entries,(SELECT count(*) FROM ledger_accounts WHERE balance IS NULL) AS unknown",
      )
    )[0];
    expect(row).toEqual({
      fc: 40n,
      characters: 4251n,
      users: 242n,
      links: 161n,
      accounts: 40n,
      entries: 36n,
      unknown: 4n,
    });
    expect(
      (
        await db.query<{ balance: bigint }>(
          "SELECT balance FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
          [guild, fc],
        )
      )[0]?.balance,
    ).toBe(349279945n);
    expect(
      (
        await db.query<{ count: bigint }>(
          "SELECT count(*) FROM guild_users WHERE nickname_enabled OR primary_character_id IS NOT NULL",
        )
      )[0]?.count,
    ).toBe(0n);
    expect(
      (await db.query<{ provenance: string }>("SELECT provenance FROM guest_grants"))[0]
        ?.provenance,
    ).toBe("imported_guest");
    // Launch defaults: the imported layout stays untouched and one grandfathering run is owed.
    const [launch] = await db.orm
      .select({
        layout: t.guilds.role_layout_enabled,
        grandfather: t.guilds.guest_grandfather,
        grandfatheredAt: t.guilds.guest_grandfathered_at,
      })
      .from(t.guilds)
      .where(eq(t.guilds.id, guild));
    expect(launch).toEqual({ layout: false, grandfather: "pending", grandfatheredAt: null });
    // Until activation, every queued Discord change of the imported guild is held.
    expect((await service.validate(actor)).effectsMode).toBe("awaiting_activation");
    // Applications were imported closed (beforeAll reopens them); the audit and the stored
    // report keep the legacy review channel for a later explicit /config choice.
    const closed = {
      state: "closed",
      legacyChannelId: legacyGuild.guest_application_channel_id,
    };
    const [imported] = await db.orm
      .select({ details: t.auditEvents.details })
      .from(t.auditEvents)
      .where(and(eq(t.auditEvents.guild_id, guild), eq(t.auditEvents.action, "migration.import")));
    expect(imported?.details).toMatchObject({
      guestApplications: closed,
      roleLayout: false,
      guestGrandfather: "pending",
    });
    const [stored] = await db.orm
      .select({ report: t.imports.report })
      .from(t.imports)
      .where(eq(t.imports.fingerprint, source.fingerprint));
    expect(stored?.report).toMatchObject({
      guildSettings: [
        {
          guildId: guild,
          ledgerChannelId: legacyGuild.ledger_channel_id,
          officerNotificationsChannelId: legacyGuild.officer_notifications_channel_id,
          guestApplications: closed,
        },
      ],
      bootstrap: {
        guestApplications: "closed",
        roleLayout: "disabled",
        guestGrandfathering: "pending_first_activation",
      },
    });
  });
  test("competing withdrawals retain funds and repeated interactions mutate once", async () => {
    const outcomes = await Promise.allSettled([
      service.ledger(actor, "withdraw", 349279945, "Concurrency test", randomUUID()),
      service.ledger(actor, "withdraw", 349279945, "Concurrency test", randomUUID()),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const key = randomUUID();
    await Promise.all([
      service.ledger(actor, "deposit", 17, "Retry test", key),
      service.ledger(actor, "deposit", 17, "Retry test", key),
    ]);
    expect(
      (
        await db.query<{ balance: bigint }>(
          "SELECT balance FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
          [guild, fc],
        )
      )[0]?.balance,
    ).toBe(17n);
    expect(
      (
        await db.query<{ count: bigint }>(
          "SELECT count(*) FROM ledger_entries WHERE idempotency_key=$1",
          [key],
        )
      )[0]?.count,
    ).toBe(1n);
    await expect(
      db.query("UPDATE ledger_entries SET note='changed' WHERE idempotency_key=$1", [key]),
    ).rejects.toThrow("immutable");
  });
  test("only one competing owner succeeds and wrong-owner removal fails", async () => {
    const identity = {
      id: "77777777",
      name: "Concurrent Character",
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    };
    const results = await Promise.allSettled([
      service.assign(actor, "90001", identity, "Assignment A"),
      service.assign(actor, "90002", identity, "Assignment B"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.query<{ count: bigint }>(
          "SELECT count(*) FROM links WHERE guild_id=$1 AND character_id=$2 AND active",
          [guild, identity.id],
        )
      )[0]?.count,
    ).toBe(1n);
    await expect(service.unclaim(actor, "90003", identity.id, "Wrong owner")).rejects.toMatchObject(
      { code: "not_found", detail: { kind: "resource", resource: "link", id: identity.id } },
    );
  });
  test("hash-only verification survives a new service instance and concurrent completion", async () => {
    const self = { ...actor, userId: "90004", officer: false, manageRoles: false };
    const identity = {
      id: "77777778",
      name: "Verified Character",
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    };
    const claim = z.object({ token: z.string() }).parse(await service.claim(self, identity));
    proof = claim.token;
    const persisted = (
      await db.query<{ token_hash: string }>(
        "SELECT token_hash FROM challenges WHERE character_id=$1",
        [identity.id],
      )
    )[0];
    expect(persisted?.token_hash).not.toBe(proof);
    const restarted = new Service(db, discord, new FakeNodestone("http://unused"), config);
    await Promise.all([restarted.verify(self, identity.id), service.verify(self, identity.id)]);
    expect(
      (
        await db.query<{ count: bigint }>(
          "SELECT count(*) FROM links WHERE guild_id=$1 AND character_id=$2 AND active",
          [guild, identity.id],
        )
      )[0]?.count,
    ).toBe(1n);
    await service.unclaim(self, self.userId, identity.id);
    expect(
      (
        await db.query<{ active: boolean }>("SELECT active FROM links WHERE character_id=$1", [
          identity.id,
        ])
      )[0]?.active,
    ).toBe(false);
  });
  test("concurrent applications and opposing decisions have one durable outcome", async () => {
    const applicant = { ...actor, userId: "90005", officer: false, manageRoles: false };
    const input = await applicationInput(applicant);
    const applications = await Promise.all([
      service.apply(applicant, input),
      service.apply(applicant, input),
    ]);
    const first = z.object({ id: z.string() }).parse(applications[0]);
    expect(z.object({ id: z.string() }).parse(applications[1]).id).toBe(first.id);
    await Promise.all([
      service.decide(actor, first.id, true),
      service.decide(actor, first.id, false),
    ]);
    const row = (
      await db.query<{ state: string }>("SELECT state FROM guest_applications WHERE id=$1", [
        first.id,
      ])
    )[0];
    expect(row?.state === "approved" || row?.state === "denied").toBe(true);
    await service.guestAction(actor, applicant.userId, true, "Revoked", randomUUID());
    expect(
      (
        await db.query<{ revoked: boolean }>(
          "SELECT revoked FROM guest_state WHERE guild_id=$1 AND user_id=$2",
          [guild, applicant.userId],
        )
      )[0]?.revoked,
    ).toBe(true);
  });
  test("repeat import preserves subsequent ledger and revocation decisions", async () => {
    const before = (
      await db.query<{ balance: bigint }>(
        "SELECT balance FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
        [guild, fc],
      )
    )[0]?.balance;
    const result = z
      .object({ status: z.string() })
      .parse(await importLegacy(db, source, snapshot, mappings(source)));
    expect(result.status).toBe("already_imported");
    expect(
      (
        await db.query<{ balance: bigint }>(
          "SELECT balance FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
          [guild, fc],
        )
      )[0]?.balance,
    ).toBe(before);
    expect(
      (
        await db.query<{ revoked: boolean }>(
          "SELECT revoked FROM guest_state WHERE guild_id=$1 AND user_id='90005'",
          [guild],
        )
      )[0]?.revoked,
    ).toBe(true);
  });
  /** Claim a particular test job so unrelated queued fixture work cannot affect the scenario. */
  async function leased(jobId: string): Promise<Job> {
    const job = (
      await db.query<Job>(
        "UPDATE jobs SET status='running',lease_token=$2,lease_until=now()+interval '5 minutes',attempts=attempts+1 WHERE id=$1 RETURNING *",
        [jobId, randomUUID()],
      )
    )[0];
    if (!job) throw new Error("Missing test job");
    return job;
  }
  test("imported member protection, two absences, reappearance, and failed publication", async () => {
    const publish = async (appears: boolean, instant: Date) => {
      nodestone.rosterValue = {
        company: {
          id: fc,
          name: "Woven Souls",
          tag: "Souls",
          world: "Diabolos",
          dc: "Crystal",
          count: appears ? 1 : 0,
        },
        members: appears
          ? [
              {
                id: historical.char_id,
                name: `${historical.forename} ${historical.surname}`,
                world: historical.world,
                dc: "Crystal",
                fcId: fc,
              },
            ]
          : [],
        startedAt: new Date(instant.getTime() - 1000),
        observedAt: instant,
        pages: 1,
      };
      await db.query(
        "UPDATE free_companies SET last_attempt_at=now()-interval '61 seconds' WHERE id=$1",
        [fc],
      );
      const key = await enqueue(db.pool, "roster", `roster:${fc}`, { fcId: fc });
      const job = await leased(key);
      try {
        return await sync.roster(job, async () => {});
      } finally {
        await db.query("UPDATE jobs SET status='succeeded',lease_until=NULL WHERE id=$1", [key]);
      }
    };
    const initial = Date.now();
    await publish(false, new Date(initial));
    expect(
      (
        await db.query<{ state: string }>(
          "SELECT state FROM membership WHERE guild_id=$1 AND character_id=$2 AND fc_id=$3",
          [guild, historical.char_id, fc],
        )
      )[0]?.state,
    ).toBe("missing");
    const currentGuild = await service.guild(actor);
    const member = await discord.member(guild, historicalOwner);
    if (!member) throw new Error("Missing member");
    expect(desiredAccess(await sync.facts(currentGuild, member)).member).toBe(true);
    await expect(
      service.ledger(
        { ...actor, userId: historicalOwner, officer: false },
        "deposit",
        1,
        "Needs confirmed roster evidence",
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "forbidden", detail: { scope: "membership" } });
    await publish(false, new Date(initial + 61000));
    expect(desiredAccess(await sync.facts(currentGuild, member))).toEqual({
      member: false,
      guest: true,
    });
    await publish(true, new Date(initial + 122000));
    expect(desiredAccess(await sync.facts(currentGuild, member)).member).toBe(true);
    const before = (
      await db.query<{ last_successful_roster_at: Date }>(
        "SELECT last_successful_roster_at FROM free_companies WHERE id=$1",
        [fc],
      )
    )[0]?.last_successful_roster_at;
    nodestone.rosterFailure = true;
    await expect(publish(false, new Date(initial + 183000))).rejects.toThrow("incomplete");
    nodestone.rosterFailure = false;
    expect(
      (
        await db.query<{ last_successful_roster_at: Date }>(
          "SELECT last_successful_roster_at FROM free_companies WHERE id=$1",
          [fc],
        )
      )[0]?.last_successful_roster_at,
    ).toEqual(before);
    expect(desiredAccess(await sync.facts(currentGuild, member)).member).toBe(true);
  });
  test("imported owners without a legacy-FC character are registered Guests with onboarding disabled", async () => {
    // Relies on the accepted rosters the previous test published, which evaluated every imported
    // link in the imported guild; that guild never ran /setup, so onboarding stays disabled.
    const ownership = mappings(source).ownership;
    const humans = new Set(snapshot.guilds[0]?.members.map((member) => member.id));
    const owned = new Map<string, (typeof source.characters)[number][]>();
    for (const row of source.characters)
      if (row.owner) owned.set(row.owner, [...(owned.get(row.owner) ?? []), row]);
    const owner = [...owned].find(
      ([user, rows]) =>
        !humans.has(user) &&
        rows.every((row) => row.fc !== fc) &&
        rows.some((row) => (ownership[row.char_id] ?? []).includes(guild)),
    )?.[0];
    if (!owner) throw new Error("Missing imported owner outside the legacy FC");
    const currentGuild = await service.guild(actor);
    expect(currentGuild.access_policy_enabled).toBe(false);
    const member = await discord.member(guild, owner);
    if (!member) throw new Error("Missing imported owner");
    const facts = await sync.facts(currentGuild, member);
    // Imported links are trusted registration; no grant, history or held role explains this Guest.
    expect(facts).toMatchObject({
      membership: "ineligible",
      verified: true,
      fresh: true,
      former: false,
      grant: false,
      revoked: false,
      hasGuest: false,
    });
    expect(desiredAccess(facts)).toEqual({ member: false, guest: true });
  });
  test("a grandfathering plan on the imported fixture is read-only and stable", async () => {
    // Runs on the accepted rosters published above (the fixture's baseline reappeared, so no
    // departure is pending) and never activates, so the shared fixture guild stays pending.
    const ownership = mappings(source).ownership;
    const humans = new Set(snapshot.guilds[0]?.members.map((member) => member.id));
    const outsider = source.characters.find(
      (row) =>
        row.owner &&
        !humans.has(row.owner) &&
        source.characters.every((other) => other.owner !== row.owner || other.fc !== fc) &&
        (ownership[row.char_id] ?? []).includes(guild),
    )?.owner;
    if (!outsider) throw new Error("Missing imported owner outside the legacy FC");
    const currentGuild = await service.guild(actor);
    expect(currentGuild.guest_grandfather).toBe("pending");
    const views: MemberView[] = [
      ...(snapshot.guilds[0]?.members ?? []).map((member) => ({
        ...member,
        guildId: guild,
        joinedAt: new Date(member.joinedAt),
        bot: false,
      })),
      // A registered owner present in Discord but outside the FC, and a bot.
      {
        id: outsider,
        guildId: guild,
        joinedAt: new Date("2021-01-01T00:00:00Z"),
        nickname: null,
        roles: [],
        bot: false,
      },
      {
        id: "999999999999999901",
        guildId: guild,
        joinedAt: new Date("2021-01-01T00:00:00Z"),
        nickname: null,
        roles: [],
        bot: true,
      },
    ];
    const counts = async () =>
      (
        await db.query<{ grants: bigint; audits: bigint; users: bigint }>(
          "SELECT (SELECT count(*) FROM guest_grants) AS grants,(SELECT count(*) FROM audit) AS audits,(SELECT count(*) FROM guild_users) AS users",
        )
      )[0];
    const before = await counts();
    expect(await pendingDepartures(db.orm, currentGuild)).toEqual({ count: 0, sample: [] });
    const first = await planGrandfathering(db.orm, currentGuild, views, 21600, new Date());
    // A later enumeration of the same members, in another order, with changed nicknames and the
    // planned outsider now holding Guest, reproduces the checksum (C8).
    const second = await planGrandfathering(
      db.orm,
      currentGuild,
      views
        .map((view) => ({
          ...view,
          nickname: "Renamed",
          roles:
            view.id === outsider ? [...view.roles, currentGuild.guest_role_id ?? ""] : view.roles,
        }))
        .reverse(),
      21600,
      new Date(Date.now() + 60_000),
    );
    expect(second.checksum).toBe(first.checksum);
    expect(second.candidates.find((row) => row.userId === outsider)?.heldGuest).toBe(true);
    expect(first).toMatchObject({
      importFingerprint: source.fingerprint,
      humans: 3,
      bots: 1,
      grants: [outsider],
    });
    expect(first.rosterSnapshotId).toEqual(expect.any(String));
    const report = grandfatherReport({ state: "pending", plan: first, completedAt: null });
    expect(report).toMatchObject({
      memberEligible: 1,
      planned: { count: 1, sample: [outsider] },
      plannedDetail: { registeredVisitors: { count: 1, sample: [outsider] } },
      skipped: {
        existingGrant: {
          count: 1,
          sample: ["987654321012345678"],
          byProvenance: { imported_guest: 1 },
        },
        revoked: { count: 0 },
      },
    });
    expect(await counts()).toEqual(before);
  });
  test("local loss overrides uncertain new links; imported nickname opt-in respects manual overrides", async () => {
    const identity = {
      id: "77777779",
      name: "Nickname Target",
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    };
    await service.assign(actor, historicalOwner, identity, "Additional pending character");
    await service.unclaim(
      actor,
      historicalOwner,
      historical.char_id,
      "Local unlink while another character is uncertain",
    );
    const guildRecord = await service.guild(actor);
    const member = await discord.member(guild, historicalOwner);
    if (!member) throw new Error("Missing member");
    expect(desiredAccess(await sync.facts(guildRecord, member))).toEqual({
      member: false,
      guest: true,
    });
    await db.query("UPDATE guilds SET effects_enabled=true WHERE id=$1", [guild]);
    const self = { ...actor, userId: historicalOwner, officer: false };
    await service.preferences(self, identity.id, true);
    const reconcile = async () => {
      const key = await enqueue(
        db.pool,
        "reconcile.user",
        `user:${guild}:${historicalOwner}`,
        {},
        guild,
        historicalOwner,
      );
      const job = await leased(key);
      await sync.user(job, async () => {});
      await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1", [key]);
    };
    await reconcile();
    expect(member.nickname).toBe("Nickname Target");
    await service.preferences(self, null, false);
    await reconcile();
    expect(member.nickname).toBe("Imported nickname");
    await service.preferences(self, null, true);
    await reconcile();
    member.nickname = "Manual override";
    await reconcile();
    expect(
      (
        await db.query<{ nickname_suspended: boolean }>(
          "SELECT nickname_suspended FROM guild_users WHERE guild_id=$1 AND user_id=$2",
          [guild, historicalOwner],
        )
      )[0]?.nickname_suspended,
    ).toBe(true);
    await service.preferences(self, null, false);
    await reconcile();
    expect(member.nickname).toBe("Manual override");
  });
  test("unknown account initializes once, including a known zero opening", async () => {
    const unknown = source.companies.find((row) => row.gil_balance === null);
    if (!unknown) throw new Error("Missing unknown account");
    await db.query("UPDATE guilds SET fc_id=$2 WHERE id=$1", [guild, unknown.fc_id]);
    try {
      const results = await Promise.allSettled([
        service.ledger(actor, "initialize", "0", "Known opening", randomUUID()),
        service.ledger(actor, "initialize", "0", "Competing opening", randomUUID()),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        (
          await db.query<{ count: bigint }>(
            "SELECT count(*) FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.guild_id=$1 AND a.fc_id=$2",
            [guild, unknown.fc_id],
          )
        )[0]?.count,
      ).toBe(1n);
      expect(
        (
          await db.query<{ balance: bigint | null }>(
            "SELECT balance FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
            [guild, unknown.fc_id],
          )
        )[0]?.balance,
      ).toBe(0n);
    } finally {
      await db.query("UPDATE guilds SET fc_id=$2 WHERE id=$1", [guild, fc]);
    }
  });
  test("notification failure preserves one entry and an independent retry delivers it", async () => {
    await db.query("UPDATE jobs SET status='succeeded' WHERE kind='ledger.notify'");
    const key = randomUUID();
    const result = z
      .object({ entry: z.object({ id: z.string() }) })
      .parse(await service.ledger(actor, "deposit", 5, "Delivery recovery", key));
    const queued = (
      await db.query<{ id: string }>(
        "SELECT id FROM jobs WHERE kind='ledger.notify' AND payload->>'entryId'=$1",
        [result.entry.id],
      )
    )[0];
    if (!queued) throw new Error("Missing notification");
    const queue = new Queue(db, dispatcher(service, sync, access), () => {});
    sendBlocked = true;
    await queue.perform(await leased(queued.id));
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [queued.id]))[0]
        ?.status,
    ).toBe("blocked");
    sendBlocked = false;
    await queue.perform(await leased(queued.id));
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [queued.id]))[0]
        ?.status,
    ).toBe("succeeded");
    expect(
      (
        await db.query<{ count: bigint }>(
          "SELECT count(*) FROM ledger_entries WHERE idempotency_key=$1",
          [key],
        )
      )[0]?.count,
    ).toBe(1n);
    // The dispatcher hands over the stored entry, not text, under the unchanged nonce key.
    expect(sent.at(-1)).toMatchObject({
      guild,
      key: `ledger:${result.entry.id}`,
      message: {
        kind: "ledger",
        view: { entry: { id: result.entry.id, operation: "deposit" }, correctionSequence: null },
      },
    });
  });
  test("a correction's post names the corrected entry by its number from one read", async () => {
    await db.query("UPDATE jobs SET status='succeeded' WHERE kind='ledger.notify'");
    const deposit = await service.ledger(actor, "deposit", 7, "Corrected below", randomUUID());
    if (deposit.status !== "recorded") throw new Error("Missing deposit");
    const correction = await service.ledger(
      actor,
      "adjust",
      (deposit.entry.balance - 2n).toString(),
      "The deposit was 5 gil",
      randomUUID(),
      deposit.entry.id,
    );
    if (correction.status !== "recorded") throw new Error("Missing correction");
    // Posts go out in entry order, so the deposit's post is delivered first.
    await db.query(
      "UPDATE jobs SET status='succeeded' WHERE kind='ledger.notify' AND payload->>'entryId'=$1",
      [deposit.entry.id],
    );
    const queued = (
      await db.query<{ id: string }>(
        "SELECT id FROM jobs WHERE kind='ledger.notify' AND payload->>'entryId'=$1",
        [correction.entry.id],
      )
    )[0];
    if (!queued) throw new Error("Missing correction notification");
    await new Queue(db, dispatcher(service, sync, access), () => {}).perform(
      await leased(queued.id),
    );
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [queued.id]))[0]
        ?.status,
    ).toBe("succeeded");
    const post = sent.at(-1);
    expect(post).toMatchObject({
      key: `ledger:${correction.entry.id}`,
      message: {
        kind: "ledger",
        view: {
          entry: { id: correction.entry.id, operation: "adjust", delta: -2n },
          correctionSequence: deposit.entry.sequence,
        },
      },
    });
    // The gateway renders that view as the approved correction post (ledger#32).
    if (post?.message.kind !== "ledger") throw new Error("Expected a ledger post");
    expect(ledgerPost(post.message.view).options.embeds[0]?.fields).toContainEqual({
      name: "Corrects",
      value: `#${deposit.entry.sequence}`,
      inline: true,
    });
  });
  test("PostgreSQL bigint maximum round-trips and overflow is rejected atomically", async () => {
    const unknown = source.companies.filter((row) => row.gil_balance === null)[1];
    if (!unknown) throw new Error("Missing second unknown account");
    await db.query("UPDATE guilds SET fc_id=$2 WHERE id=$1", [guild, unknown.fc_id]);
    try {
      await service.ledger(
        actor,
        "initialize",
        "9223372036854775807",
        "Exact bigint boundary",
        randomUUID(),
      );
      // Passing the storable maximum is an input failure on the amount, not a funds refusal.
      await expect(
        service.ledger(actor, "deposit", 1, "Overflow must fail", randomUUID()),
      ).rejects.toMatchObject({ code: "input", detail: { kind: "option", option: "amount" } });
      expect(
        (
          await db.query<{ balance: bigint }>(
            "SELECT balance FROM ledger_accounts WHERE guild_id=$1 AND fc_id=$2",
            [guild, unknown.fc_id],
          )
        )[0]?.balance,
      ).toBe(9223372036854775807n);
    } finally {
      await db.query("UPDATE guilds SET fc_id=$2 WHERE id=$1", [guild, fc]);
    }
  });
  test("accounts, eligibility and private reads remain independent across guilds", async () => {
    const owner = "90010";
    await service.assign(
      actor,
      owner,
      { id: historical.char_id, name: "Guild Scoped", world: "Diabolos", dc: "Crystal", fcId: fc },
      "Relink for guild-scoping test",
    );
    const original = await service.guild(actor);
    expect(await service.memberEligible(db.pool, original, owner)).toBe(true);
    const otherGuild = "777777777777777777";
    await db.query("INSERT INTO guilds(id,fc_id,ledger_channel_id) VALUES($1,$2,'777888999')", [
      otherGuild,
      fc,
    ]);
    await db.query("INSERT INTO ledger_accounts(guild_id,fc_id) VALUES($1,$2)", [otherGuild, fc]);
    await service.ledger(
      { ...actor, guildId: otherGuild },
      "initialize",
      "42",
      "Second guild opening",
      randomUUID(),
    );
    const visitor: Actor = {
      ...actor,
      guildId: otherGuild,
      userId: owner,
      officer: false,
      manageRoles: false,
    };
    const second = await service.guild(visitor);
    expect(await service.memberEligible(db.pool, second, owner)).toBe(false);
    await expect(service.ledgerRead(visitor, null, null, false)).rejects.toMatchObject({
      code: "forbidden",
      detail: { kind: "scope", scope: "membership" },
    });
    expect(await service.characters(visitor, owner)).toEqual({ characters: [] });
    const balance = z
      .object({ account: z.object({ balance: z.bigint() }) })
      .parse(await service.ledgerRead({ ...visitor, officer: true }, null, null, false));
    expect(balance.account.balance).toBe(42n);
  });
  test("obsolete join context cancels pending review and forged message identity is rejected", async () => {
    const applicant = { ...actor, userId: "90006", officer: false };
    const application = z
      .object({ id: z.string() })
      .parse(await service.apply(applicant, await applicationInput(applicant)));
    await db.query("UPDATE guest_applications SET message_id='112233' WHERE id=$1", [
      application.id,
    ]);
    await expect(service.decide(actor, application.id, true, null, "445566")).rejects.toMatchObject(
      { code: "stale", detail: { kind: "stale", what: "review" } },
    );
    absent.add(applicant.userId);
    await service.decide(actor, application.id, true);
    expect(
      (
        await db.query<{ state: string }>("SELECT state FROM guest_applications WHERE id=$1", [
          application.id,
        ])
      )[0]?.state,
    ).toBe("cancelled");
  });
  test("rejoining replaces an obsolete pending application", async () => {
    const actorInGuild = { ...actor, userId: "90007", officer: false };
    const opened = await applicationInput(actorInGuild);
    const old = z.object({ id: z.string() }).parse(await service.apply(actorInGuild, opened));
    const member = members.get(actorInGuild.userId);
    if (!member) throw new Error("Missing rejoining member");
    member.joinedAt = new Date("2026-09-21T12:00:00Z");
    await expect(service.apply(actorInGuild, opened)).rejects.toMatchObject({ code: "stale" });
    const current = z
      .object({ id: z.string() })
      .parse(await service.apply(actorInGuild, await applicationInput(actorInGuild)));
    expect(current.id).not.toBe(old.id);
    expect(
      (
        await db.query<{ state: string }>("SELECT state FROM guest_applications WHERE id=$1", [
          old.id,
        ])
      )[0]?.state,
    ).toBe("cancelled");
  });
  test("an import publication failure rolls all staged application rows back", async () => {
    // Fail the final publication statement, after identities/links/accounts have already been staged.
    const copy = structuredClone(source);
    copy.fingerprint = "rejected-transaction-test";
    const first = copy.guilds[0];
    if (!first) throw new Error("Missing guild");
    first.guild_id = "888888888888888888";
    const empty: Snapshot = {
      capturedAt: new Date().toISOString(),
      guilds: [
        { id: first.guild_id, complete: true, expectedCount: 0, enumeratedCount: 0, members: [] },
      ],
    };
    await db.query(
      "CREATE FUNCTION reject_test_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected import publication failure'; END $$",
    );
    await db.query(
      "CREATE TRIGGER reject_test_import BEFORE INSERT ON imports FOR EACH ROW EXECUTE FUNCTION reject_test_import()",
    );
    try {
      // Drizzle retains the PostgreSQL failure as cause; assert the actual injected trigger error.
      await expect(importLegacy(db, copy, empty, mappings(copy))).rejects.toMatchObject({
        cause: { code: "P0001", message: "injected import publication failure" },
      });
      expect(await db.query("SELECT id FROM guilds WHERE id=$1", [first.guild_id])).toHaveLength(0);
    } finally {
      await db.query("DROP TRIGGER reject_test_import ON imports");
      await db.query("DROP FUNCTION reject_test_import()");
    }
  });
  test("imported guilds keep notification channels but open no guest applications", async () => {
    // A copy with no FC, characters or source users cannot disturb shared counts, metrics or
    // roster dedupe. 777777777777777777 is already another test's second guild.
    const closedGuild = "555555555555555555";
    const copy = structuredClone(source);
    copy.fingerprint = "closed-applications-test";
    copy.companies = [];
    copy.characters = [];
    copy.users = [];
    const first = copy.guilds[0];
    if (!first?.guest_role_id || !first.guest_application_channel_id)
      throw new Error("The fixture guild needs a guest role and a legacy review channel");
    copy.guilds = [{ ...first, guild_id: closedGuild, fc: null }];
    const visitor = { id: "555555555555555001", joinedAt: "2026-01-01T00:00:00Z" };
    members.set(visitor.id, {
      id: visitor.id,
      guildId: closedGuild,
      joinedAt: new Date(visitor.joinedAt),
      nickname: null,
      roles: [],
      bot: false,
    });
    const capture: Snapshot = {
      capturedAt: new Date().toISOString(),
      guilds: [
        {
          id: closedGuild,
          complete: true,
          expectedCount: 1,
          enumeratedCount: 1,
          members: [{ id: visitor.id, roles: [], nickname: null, joinedAt: visitor.joinedAt }],
        },
      ],
    };
    const closed = { state: "closed", legacyChannelId: first.guest_application_channel_id };
    expect(await importLegacy(db, copy, capture, mappings(copy))).toMatchObject({
      status: "imported",
      report: { guildSettings: [{ guildId: closedGuild, guestApplications: closed }] },
    });
    // Ledger and roster notices keep their legacy destinations; only the review channel is closed.
    const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, closedGuild));
    expect(row).toMatchObject({
      guest_application_channel_id: null,
      ledger_channel_id: first.ledger_channel_id,
      officer_notifications_channel_id: first.officer_notifications_channel_id,
      effects_enabled: false,
      role_layout_enabled: false,
      guest_grandfather: "pending",
    });
    const [imported] = await db.orm
      .select({ details: t.auditEvents.details })
      .from(t.auditEvents)
      .where(
        and(eq(t.auditEvents.guild_id, closedGuild), eq(t.auditEvents.action, "migration.import")),
      );
    expect(imported?.details).toMatchObject({ guestApplications: closed });
    // The real /apply module refuses before the form opens, using one read of this database.
    const interactions = interactionFixture();
    interactions.member.guildId = closedGuild;
    interactions.member.userId = visitor.id;
    const router = new InteractionRouter(
      {
        client: interactions.client,
        services: new Services().provide(applicationKey, service),
        allowsGuild: (id) => id === closedGuild,
        isStopping: () => false,
        report: () => {},
        resolveActor: async () => {
          throw new Error("The pre-form check must not fetch an actor");
        },
      },
      new Map([[applyCommand.name, applyCommand]]),
      new Map(),
    );
    try {
      await router.handle(interactions.slash());
      // The approved closed card (guests#21): an expected state, so no Code · Ref footer.
      expect(interactions.requests.at(-1)?.body).toMatchObject({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          content: "",
          embeds: [
            { title: "Guest applications are closed", description: GUEST_APPLICATIONS_CLOSED },
          ],
          flags: MessageFlags.Ephemeral,
        },
      });
      expect(interactions.requests.at(-1)?.body).not.toMatchObject({
        data: { embeds: [{ footer: expect.anything() }] },
      });
      // A form opened earlier, or a forged submission, is refused again at submission.
      const applicant: Actor = {
        guildId: closedGuild,
        userId: visitor.id,
        officer: false,
        manageRoles: false,
      };
      await expect(
        service.apply(applicant, await applicationInput(applicant)),
      ).rejects.toMatchObject({ code: "setup", message: GUEST_APPLICATIONS_CLOSED });
      const applications = () =>
        db.orm
          .select()
          .from(t.guestApplications)
          .where(eq(t.guestApplications.guild_id, closedGuild));
      expect(await applications()).toHaveLength(0);
      // An explicit, audited /config choice opens applications; the form then opens and a
      // submission queues its officer review.
      await service.configure(
        { ...actor, guildId: closedGuild },
        "guest_application_channel_id",
        "81003",
      );
      await router.handle(interactions.slash());
      expect(interactions.requests.at(-1)?.body).toMatchObject({
        type: InteractionResponseType.Modal,
      });
      const application = await service.apply(applicant, await applicationInput(applicant));
      expect(application).toMatchObject({ state: "pending", channel_id: "81003" });
      expect(await applications()).toHaveLength(1);
      expect(
        await db.orm
          .select({ kind: t.jobs.kind })
          .from(t.jobs)
          .where(eq(t.jobs.dedupe_key, `review:${application.id}`)),
      ).toEqual([{ kind: "guest.review" }]);
    } finally {
      await interactions.close();
    }
  });
  test("expired job ownership is fenced and committed work can resume", async () => {
    // The old worker runs after recovery deliberately; its lease token must no longer authorize writes.
    await db.query("UPDATE jobs SET status='disabled'");
    const key = await enqueue(db.pool, "probe", "test:lease", {});
    expect(await enqueue(db.pool, "probe", "test:lease", {})).toBe(key);
    const events: QueueEvent[] = [];
    const queue = new Queue(
      db,
      async (_job, guard) => {
        await guard();
        return { ok: true };
      },
      (event) => {
        events.push(event);
      },
    );
    const old = await queue.claim();
    if (!old) throw new Error("Missing lease");
    await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [key]);
    const recovered = await queue.claim();
    if (!recovered) throw new Error("Missing recovered lease");
    expect(recovered.lease_token).not.toBe(old.lease_token);
    await queue.perform(old);
    // The stale worker reports the actual cause at warn and leaves the new owner's row untouched.
    const stale = events.find((event) => event.type === "job" && event.job === old);
    expect(stale?.type === "job" ? stale.outcome : undefined).toMatchObject({
      code: "lease_lost",
      status: "unchanged",
      level: "warn",
    });
    expect((await db.orm.select().from(t.jobs).where(eq(t.jobs.id, key)))[0]).toMatchObject({
      status: "running",
      lease_token: recovered.lease_token,
      last_error: null,
    });
    await queue.perform(recovered);
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [key]))[0]?.status,
    ).toBe("succeeded");
  });
  test("an expired, unreclaimed lease writes nothing and is reclaimed as a counted attempt", async () => {
    // The worker outlived its lease but nobody reclaimed it yet: it must not refund or requeue the row.
    await db.query("UPDATE jobs SET status='disabled'");
    const key = await enqueue(db.pool, "probe", "test:unreclaimed", {});
    const events: QueueEvent[] = [];
    const queue = new Queue(
      db,
      async (_job, guard) => {
        await guard();
        return { ok: true };
      },
      (event) => {
        events.push(event);
      },
    );
    const old = await queue.claim();
    if (!old || old.id !== key) throw new Error("Missing lease");
    await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [key]);
    await queue.perform(old);
    const event = events.at(-1);
    expect(event?.type === "job" ? event.outcome : undefined).toMatchObject({
      code: "lease_lost",
      status: "unchanged",
      delaySeconds: 0,
      level: "warn",
    });
    expect((await db.orm.select().from(t.jobs).where(eq(t.jobs.id, key)))[0]).toMatchObject({
      status: "running",
      lease_token: old.lease_token,
      attempts: 1,
      last_error: null,
    });
    // claim() reclaims the expired running row directly, counting the new attempt.
    const again = await queue.claim();
    if (!again || again.id !== key) throw new Error("Missing reclaimed lease");
    expect(again.lease_token).not.toBe(old.lease_token);
    expect(again.attempts).toBe(2);
    await queue.perform(again);
    expect((await db.orm.select().from(t.jobs).where(eq(t.jobs.id, key)))[0]?.status).toBe(
      "succeeded",
    );
  });
  test("only a continuous wait streak escalates, never a first wait on an old row", async () => {
    // Activation re-queues long-lived disabled rows; their first echo supersession stays at debug.
    await db.query("UPDATE jobs SET status='disabled'");
    const key = await enqueue(db.pool, "probe", "test:wait-streak", {});
    await db.orm
      .update(t.jobs)
      .set({ created_at: sql`now()-interval '1 day'` })
      .where(eq(t.jobs.id, key));
    let clock = Date.now();
    const events: QueueEvent[] = [];
    const queue = new Queue(
      db,
      async () => {
        throw new Failure("busy", "Held elsewhere.");
      },
      (event) => {
        events.push(event);
      },
      () => clock,
    );
    /** Make the row due now, run one attempt, and return its job event. */
    const attempt = async () => {
      await db.orm.update(t.jobs).set({ due_at: sql`now()` }).where(eq(t.jobs.id, key));
      const job = await queue.claim();
      if (!job || job.id !== key) throw new Error("Missing wait-streak candidate");
      await queue.perform(job);
      const event = events.at(-1);
      if (event?.type !== "job") throw new Error("Missing job event");
      return event;
    };
    const first = await attempt();
    expect(first.outcome).toMatchObject({ code: "busy", status: "queued", level: "debug" });
    expect(first.ageMs).toBeGreaterThan(STALE_WAIT_MS);
    clock += STALE_WAIT_MS;
    expect((await attempt()).outcome.level).toBe("debug");
    clock += 1;
    expect((await attempt()).outcome).toMatchObject({
      code: "busy",
      status: "queued",
      level: "warn",
    });
    // Escalation changes visibility only: every wait still returned its attempt.
    expect((await db.orm.select().from(t.jobs).where(eq(t.jobs.id, key)))[0]).toMatchObject({
      status: "queued",
      attempts: 0,
      last_error: "busy: Held elsewhere.",
    });
    await db.orm.delete(t.jobs).where(eq(t.jobs.id, key));
  });
  test("application operations enforce officer and target-owner authorization", async () => {
    const ordinary = { ...actor, officer: false, manageRoles: false };
    // Each refusal names its rule in the scope detail; officer-only actions and another member's
    // records are refused differently, and nothing matches on message text.
    const officerOnly = { code: "forbidden", detail: { kind: "scope", scope: "officer" } };
    const ownerOnly = { code: "forbidden", detail: { kind: "scope", scope: "owner" } };
    await expect(
      service.guestAction(ordinary, "90005", false, "Unauthorized", randomUUID()),
    ).rejects.toMatchObject(officerOnly);
    await expect(
      service.ledger(ordinary, "withdraw", 1, "Unauthorized", randomUUID()),
    ).rejects.toMatchObject(officerOnly);
    await expect(
      service.unclaim(ordinary, "90005", "77777777", "Unauthorized"),
    ).rejects.toMatchObject(officerOnly);
    await expect(service.characters(ordinary, "90005")).rejects.toMatchObject(ownerOnly);
    await expect(service.guestStatus(ordinary, "90005")).rejects.toMatchObject(ownerOnly);
    await expect(service.applicationChoices(ordinary)).rejects.toMatchObject(officerOnly);
  });
  test("sync status includes child delivery work and protects other requesters' runs", async () => {
    const requestor = { ...actor, userId: "90007", officer: false };
    const requested = await sync.refresh(requestor, false);
    expect(requested).toMatchObject({
      forced: false,
      intervalSeconds: config.ROSTER_INTERVAL_SECONDS,
    });
    const run = (
      await db.query<{ job_id: string }>("SELECT job_id FROM sync_runs WHERE id=$1", [
        requested.runId,
      ])
    )[0];
    if (!run) throw new Error("Missing run");
    await sync.guild(guild, run.job_id);
    await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1", [run.job_id]);
    const status = await service.syncStatus(requestor, requested.runId);
    expect(status.runs[0]?.status).toBe("queued");
    expect(status.runs[0]?.work_total).toBeGreaterThan(1);
    // An unfinished run has no completion time; its requester is recorded.
    expect(status.runs[0]).toMatchObject({ completed_at: null, requester_id: requestor.userId });
    for (const row of status.work)
      expect(Object.keys(row)).toEqual(expect.arrayContaining(["user_id", "created_at"]));
    const attachedLayout = () =>
      db.query(
        "SELECT j.id FROM jobs j JOIN sync_run_jobs r ON r.job_id=j.id WHERE r.run_id=$1 AND j.kind='roles.layout'",
        [requested.runId],
      );
    // The imported guild launches with its role layout off, so a refresh attaches no layout pass.
    expect(await attachedLayout()).toHaveLength(0);
    // Once the switch is on, the next guild pass attaches the coalesced layout job to the run.
    // The switch is restored afterwards because later scenarios share the imported guild.
    await db.orm.update(t.guilds).set({ role_layout_enabled: true }).where(eq(t.guilds.id, guild));
    try {
      await sync.guild(guild, run.job_id);
      expect(await attachedLayout()).toHaveLength(1);
    } finally {
      await db.orm
        .update(t.guilds)
        .set({ role_layout_enabled: false })
        .where(eq(t.guilds.id, guild));
    }
    const other = z
      .object({ runs: z.array(z.unknown()) })
      .parse(await service.syncStatus({ ...requestor, userId: "90008" }, requested.runId));
    expect(other.runs).toHaveLength(0);
    await db.query(
      "UPDATE jobs SET status='succeeded',completed_at=now() WHERE id IN (SELECT job_id FROM sync_run_jobs WHERE run_id=$1)",
      [requested.runId],
    );
    const completed = await service.syncStatus(requestor, requested.runId);
    expect(completed.runs[0]?.status).toBe("completed");
    // A completed run finished when its last child job did, decoded as a Date.
    expect(completed.runs[0]?.completed_at).toBeInstanceOf(Date);
  });
  test("failed nickname writes do not invent a successful write; manual races are preserved", async () => {
    const owner = "90011";
    await service.assign(
      actor,
      owner,
      { id: "77777781", name: "Blocked Nickname", world: "Diabolos", dc: "Crystal", fcId: null },
      "Nickname failure fixture",
    );
    const queue = new Queue(db, dispatcher(service, sync, access), () => {});
    const reconcile = async () => {
      const key = await enqueue(
        db.pool,
        "reconcile.user",
        `user:${guild}:${owner}`,
        {},
        guild,
        owner,
      );
      await queue.perform(await leased(key));
      return (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [key]))[0]
        ?.status;
    };
    nicknameBlocked = true;
    expect(await reconcile()).toBe("blocked");
    expect(
      (
        await db.query<{ nickname_last: string | null; nickname_written: boolean }>(
          "SELECT nickname_last,nickname_written FROM guild_users WHERE guild_id=$1 AND user_id=$2",
          [guild, owner],
        )
      )[0],
    ).toEqual({ nickname_last: null, nickname_written: false });
    await service.preferences({ ...actor, userId: owner }, null, false);
    expect(await reconcile()).toBe("succeeded");
    nicknameBlocked = false;
    await service.preferences({ ...actor, userId: owner }, null, true);
    nicknameRace = true;
    expect(await reconcile()).toBe("succeeded");
    expect(members.get(owner)?.nickname).toBe("Race override");
    expect(
      (
        await db.query<{ nickname_suspended: boolean }>(
          "SELECT nickname_suspended FROM guild_users WHERE guild_id=$1 AND user_id=$2",
          [guild, owner],
        )
      )[0]?.nickname_suspended,
    ).toBe(true);
  });
  test("replacement, tuple binding and expiry prevent invalid proof completion", async () => {
    const owner = { ...actor, userId: "90013", officer: false };
    const identity = {
      id: "77777782",
      name: "Proof Fixture",
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    };
    const first = z.object({ token: z.string() }).parse(await service.claim(owner, identity));
    const second = z
      .object({ token: z.string(), challenge: z.string() })
      .parse(await service.claim(owner, identity));
    proof = first.token;
    // A replaced token is not proof; the newest claim stays valid until it expires.
    await expect(service.verify(owner, identity.id)).rejects.toMatchObject({
      code: "pending_proof",
      detail: { kind: "proof", character: { id: identity.id } },
    });
    proof = second.token;
    const noClaim = { code: "not_found", detail: { kind: "resource", resource: "challenge" } };
    await expect(service.verify({ ...owner, userId: "90014" }, identity.id)).rejects.toMatchObject(
      noClaim,
    );
    await db.query("UPDATE challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [
      second.challenge,
    ]);
    await expect(service.verify(owner, identity.id)).rejects.toMatchObject(noClaim);
    expect(
      await db.query("SELECT id FROM links WHERE guild_id=$1 AND character_id=$2 AND active", [
        guild,
        identity.id,
      ]),
    ).toHaveLength(0);
  });
  test("extracted guild event operations preserve policy and cancel departed-user reviews", async () => {
    const observations = new GuildEvents(db);
    const owner = "90100";
    const member = await discord.member(guild, owner);
    if (!member) throw new Error("Missing event fixture member");
    await observations.memberJoined(guild, owner, member.joinedAt);
    const pending = z
      .object({ id: z.string() })
      .parse(
        await service.apply(
          { ...actor, userId: owner, officer: false },
          await applicationInput({ ...actor, userId: owner }),
        ),
      );
    await service.assign(
      actor,
      owner,
      { id: "77777790", name: "Event Fixture", world: "Diabolos", dc: "Crystal", fcId: null },
      "Event observation fixture",
    );
    await service.guestAction(actor, owner, false, "Grant survives departure", randomUUID());
    await observations.memberLeft(guild, owner);
    expect(
      (
        await db.query<{ state: string }>("SELECT state FROM guest_applications WHERE id=$1", [
          pending.id,
        ])
      )[0]?.state,
    ).toBe("cancelled");
    expect(
      (
        await db.query<{ active: boolean }>(
          "SELECT active FROM links WHERE guild_id=$1 AND user_id=$2",
          [guild, owner],
        )
      )[0]?.active,
    ).toBe(true);
    expect(
      (
        await db.query<{ count: bigint }>(
          "SELECT count(*) FROM guest_grants WHERE guild_id=$1 AND user_id=$2",
          [guild, owner],
        )
      )[0]?.count,
    ).toBe(1n);
    await observations.memberJoined(guild, owner, new Date("2026-09-22T00:00:00Z"));
    expect(
      (
        await db.query<{ present: boolean }>(
          "SELECT present FROM guild_users WHERE guild_id=$1 AND user_id=$2",
          [guild, owner],
        )
      )[0]?.present,
    ).toBe(true);
    await observations.guildLeft(guild);
    expect(
      (await db.query<{ active: boolean }>("SELECT active FROM guilds WHERE id=$1", [guild]))[0]
        ?.active,
    ).toBe(false);
    await observations.guildJoined(guild);
    expect(
      (await db.query<{ active: boolean }>("SELECT active FROM guilds WHERE id=$1", [guild]))[0]
        ?.active,
    ).toBe(true);
    // Observing an unconfigured server must not create policy/configuration as a side effect.
    await observations.memberJoined("999999888", owner, member.joinedAt);
    expect(await db.query("SELECT id FROM guilds WHERE id='999999888'")).toHaveLength(0);
  });

  test("setup is repeatable and officer rank authority honors explicit manager overrides", async () => {
    const setupGuild = "666666666666666666";
    const manager: Actor = { ...actor, guildId: setupGuild, serverManager: true };
    const created = new Map<string, string>();
    const hoists: boolean[] = [];
    let serial = 60000;
    const provisioner: RoleProvisioner = {
      ...discord,
      async members() {
        return [];
      },
      async ensureRole(_guild, name, _actor, configured, _canonical, hoist) {
        // Record the layout switch each provisioning call receives.
        hoists.push(hoist);
        if (configured) return { id: configured, created: false };
        const existing = created.get(name);
        if (existing) return { id: existing, created: false };
        const role = String(++serial);
        created.set(name, role);
        return { id: role, created: true };
      },
    };
    const administration = new RoleAdministration(service, provisioner, access);
    await expect(
      administration.setup({ ...manager, serverManager: false }, "DevBot", fc, "Officer"),
    ).rejects.toThrow("Manage Server");
    const first = z
      .object({ roleLayout: z.string() })
      .parse(await administration.setup(manager, "DevBot", fc, "Officer"));
    const configured = await service.guild(manager);
    expect(configured.access_policy_enabled).toBe(true);
    // A guild first created by /setup takes the column default: layout on, roles created hoisted.
    expect(configured.role_layout_enabled).toBe(true);
    expect(first.roleLayout).toStartWith("FC Leader > Officer > Member > Guest");
    expect(hoists).toEqual([true, true, true, true]);
    expect(
      await db.orm
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .where(and(eq(t.jobs.guild_id, setupGuild), eq(t.jobs.kind, "roles.layout"))),
    ).toHaveLength(1);
    expect(configured.officer_notifications_channel_id).toBe(configured.officer_channel_id);
    expect(configured.guest_application_channel_id).toBe(configured.officer_channel_id);
    await administration.setup(manager, "DevBot", null, null);
    expect(created.size).toBe(4);
    expect((await service.guild(manager)).officer_role_id).toBe(configured.officer_role_id);
    const officerRole = configured.officer_role_id;
    if (!officerRole) throw new Error("Missing officer role");
    await administration.officer(manager, "90030", true, "Manual officer fixture");
    const base: Actor = {
      guildId: setupGuild,
      userId: "90030",
      officer: false,
      serverManager: false,
      manageRoles: false,
      roleIds: [officerRole],
    };
    const delegated = await service.enrichActor(base);
    expect(delegated.officer).toBe(true);
    await expect(
      administration.officer(
        { ...delegated, manageRoles: true },
        "90031",
        true,
        "Unauthorized delegation",
      ),
    ).rejects.toThrow("Manage Server");
    await expect(
      service.configureOfficerRank({ ...delegated, manageRoles: true }, "Member"),
    ).rejects.toThrow("Manage Server");

    const leader = {
      id: "77777111",
      name: "Leader Fixture",
      world: "Diabolos",
      dc: "Crystal",
      fcId: fc,
      fcRankName: "Fussy Bunbun",
      isFcLeader: true,
    };
    const officer = {
      id: "77777112",
      name: "Officer Fixture",
      world: "Diabolos",
      dc: "Crystal",
      fcId: fc,
      fcRankName: "Officer",
      isFcLeader: false,
    };
    const indirect = {
      id: "77777113",
      name: "Indirect Fixture",
      world: "Diabolos",
      dc: "Crystal",
      fcId: fc,
      fcRankName: "Officer",
      isFcLeader: false,
    };
    await service.assign(manager, "90031", leader, "Leader link");
    await service.assign(manager, "90032", officer, "Officer link");
    await service.assign(delegated, "90033", indirect, "Delegated membership assignment");
    nodestone.rosterValue = {
      company: {
        id: fc,
        name: "Setup FC",
        tag: "TEST",
        world: "Diabolos",
        dc: "Crystal",
        count: 3,
      },
      members: [leader, officer, indirect],
      startedAt: new Date(Date.now() - 1000),
      observedAt: new Date(),
      pages: 1,
    };
    await db.query(
      "UPDATE free_companies SET last_attempt_at=now()-interval '61 seconds' WHERE id=$1",
      [fc],
    );
    const job = await leased(await enqueue(db.pool, "roster", `roster:${fc}`, { fcId: fc }));
    await sync.roster(job, async () => {});
    await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1", [job.id]);
    expect((await rankAccess(db, configured, "90031", 21600)).leader).toBe("yes");
    expect((await rankAccess(db, configured, "90032", 21600)).officer).toBe("yes");
    expect((await rankAccess(db, configured, "90033", 21600)).officer).toBe("no");
    expect((await service.enrichActor({ ...base, userId: "90032" })).officer).toBe(true);
    await administration.officer(manager, "90032", false, "Rank override fixture");
    expect((await service.enrichActor({ ...base, userId: "90032" })).officer).toBe(false);
    const revoked = await rankAccess(db, configured, "90032", 21600);
    expect(desiredRankRole(revoked.officer, true, true)).toBe(false);
    await service.configureOfficerRank(manager, null);
    expect((await rankAccess(db, await service.guild(manager), "90030", 21600)).manualOfficer).toBe(
      true,
    );
  });

  test("a lost roster lease is an ownership change, not Lodestone degradation", async () => {
    // The reclaiming worker owns FC state: no FC error, degraded metric, or officer notice here.
    await db.query(
      "UPDATE free_companies SET last_error=NULL,last_attempt_at=now()-interval '61 seconds' WHERE id=$1",
      [fc],
    );
    const notices = () =>
      db.query<{ id: string; generation: number }>(
        "SELECT id,generation FROM jobs WHERE kind='officer.notify' ORDER BY id",
      );
    const before = await notices();
    const job = await leased(await enqueue(db.pool, "roster", `roster:${fc}`, { fcId: fc }));
    // The lease expires after the Lodestone fetch, so the publication transaction finds no live lease.
    const expire = async (): Promise<void> => {
      await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    };
    await expect(sync.roster(job, expire)).rejects.toMatchObject({ code: "lease_lost" });
    await db.query("UPDATE jobs SET status='succeeded',lease_until=NULL WHERE id=$1", [job.id]);
    expect(
      (
        await db.query<{ last_error: string | null }>(
          "SELECT last_error FROM free_companies WHERE id=$1",
          [fc],
        )
      )[0]?.last_error,
    ).toBeNull();
    // A degraded notice would insert a row or bump a pending notice's generation.
    expect(await notices()).toEqual(before);
  });

  test("role layout checks activation, setup exclusion and current configuration before writes", async () => {
    const layoutGuild = "666666666666666667";
    await db.query(
      "INSERT INTO guilds(id,effects_enabled,member_role_id,guest_role_id,officer_role_id,leader_role_id) VALUES($1,true,'70001','70002','70003','70004')",
      [layoutGuild],
    );
    const job = await leased(await layoutGuildRoles(db.pool, layoutGuild));
    let writes = 0;
    let changeConfiguration = false;
    const layoutPort: DiscordPort = {
      ...discord,
      async layoutRoles(guildId, priority, guard) {
        // A concurrent configuration edit must fence the next external write, even with a valid lease.
        if (changeConfiguration)
          await db.query("UPDATE guilds SET revision=revision+1 WHERE id=$1", [guildId]);
        await guard();
        writes++;
        return { order: [...priority] };
      },
    };
    const app = new Service(db, layoutPort, nodestone, config);
    const run = dispatcher(app, new Synchronization(app), new GuildAccess(app, accessPort));
    const disabled = new Service(db, layoutPort, nodestone, { ...config, ENABLE_EFFECTS: false });
    await expect(
      dispatcher(
        disabled,
        new Synchronization(disabled),
        new GuildAccess(disabled, accessPort),
      )(job, async () => {}),
    ).rejects.toMatchObject({ code: "disabled" });
    await db.query("UPDATE guilds SET effects_enabled=false WHERE id=$1", [layoutGuild]);
    await expect(run(job, async () => {})).rejects.toMatchObject({ code: "disabled" });
    await db.query("UPDATE guilds SET effects_enabled=true WHERE id=$1", [layoutGuild]);
    const setup = await db.pool.connect();
    try {
      await setup.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        `setup:${layoutGuild}`,
      ]);
      await expect(run(job, async () => {})).rejects.toMatchObject({ code: "busy" });
    } finally {
      await setup.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `setup:${layoutGuild}`,
      ]);
      setup.release();
    }
    changeConfiguration = true;
    await expect(run(job, async () => {})).rejects.toMatchObject({ code: "superseded" });
    expect(writes).toBe(0);
    changeConfiguration = false;
    expect(await run(job, async () => {})).toEqual({ order: ["70004", "70003", "70001", "70002"] });
    expect(writes).toBe(1);
  });

  test("role layout coalesces its own Discord events and converges on a follow-up pass", async () => {
    const layoutGuild = "666666666666666668";
    await db.query(
      "INSERT INTO guilds(id,effects_enabled,member_role_id) VALUES($1,true,'71001')",
      [layoutGuild],
    );
    const key = await layoutGuildRoles(db.pool, layoutGuild);
    let calls = 0;
    const layoutPort: DiscordPort = {
      ...discord,
      async layoutRoles(guildId, priority, guard) {
        // Discord echoes the first role mutation; the second observation requires no new write/event.
        if (++calls === 1) expect(await layoutGuildRoles(db.pool, guildId)).toBe(key);
        await guard();
        return { order: [...priority] };
      },
    };
    const app = new Service(db, layoutPort, nodestone, config);
    const queue = new Queue(
      db,
      dispatcher(app, new Synchronization(app), new GuildAccess(app, accessPort)),
      () => {},
    );
    await queue.perform(await leased(key));
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [key]))[0]?.status,
    ).toBe("queued");
    await queue.perform(await leased(key));
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [key]))[0]?.status,
    ).toBe("succeeded");
    expect(calls).toBe(2);
  });

  test("disabled role layout completes as skipped before activation, after requeue and after a mid-pass disable", async () => {
    // Decision 4: with the switch off no pass reaches Discord, yet the job completes instead of
    // parking as `disabled`, so activation or a /config change has nothing to requeue.
    const layoutGuild = "666666666666666690";
    await db.query(
      "INSERT INTO guilds(id,effects_enabled,role_layout_enabled,member_role_id,guest_role_id,officer_role_id,leader_role_id) VALUES($1,false,false,'72001','72002','72003','72004')",
      [layoutGuild],
    );
    let writes = 0;
    let disableMidPass = false;
    const layoutPort: DiscordPort = {
      ...discord,
      async layoutRoles(guildId, priority, guard) {
        // An operator switching layout off mid-pass, without a revision bump, fences the next write.
        if (disableMidPass)
          await db.orm
            .update(t.guilds)
            .set({ role_layout_enabled: false })
            .where(eq(t.guilds.id, guildId));
        await guard();
        writes++;
        return { order: [...priority] };
      },
    };
    const app = new Service(db, layoutPort, nodestone, config);
    const run = dispatcher(app, new Synchronization(app), new GuildAccess(app, accessPort));
    const queue = new Queue(db, run, () => {});
    const outcome = async (id: string) =>
      (
        await db.orm
          .select({ status: t.jobs.status, result: t.jobs.result })
          .from(t.jobs)
          .where(eq(t.jobs.id, id))
      )[0];
    const skipped = { status: "succeeded", result: { skipped: "layout disabled" } };
    // 1. Before activation: the switch is checked before effects, so this is no `disabled` park.
    const before = await layoutGuildRoles(db.pool, layoutGuild);
    expect(await run(await leased(before), async () => {})).toEqual({ skipped: "layout disabled" });
    await queue.perform(await leased(before));
    expect(await outcome(before)).toEqual(skipped);
    // 2. A job parked `disabled` by an older build, requeued exactly as scripts/activate.ts does.
    const parked = await layoutGuildRoles(db.pool, layoutGuild);
    await db.query("UPDATE jobs SET status='disabled' WHERE id=$1", [parked]);
    await db.transaction(async (client) => {
      const store = orm(client);
      await store
        .update(t.guilds)
        .set({ effects_enabled: true, revision: sql`${t.guilds.revision}+1` })
        .where(eq(t.guilds.id, layoutGuild));
      await store
        .update(t.jobs)
        .set({ status: "queued", due_at: sql`now()`, attempts: 0 })
        .where(
          and(eq(t.jobs.guild_id, layoutGuild), inArray(t.jobs.status, ["disabled", "blocked"])),
        );
    });
    await queue.perform(await leased(parked));
    expect(await outcome(parked)).toEqual(skipped);
    expect(writes).toBe(0);
    // 3. Opting in lets the next pass write once.
    await db.orm
      .update(t.guilds)
      .set({ role_layout_enabled: true })
      .where(eq(t.guilds.id, layoutGuild));
    const enabled = await layoutGuildRoles(db.pool, layoutGuild);
    await queue.perform(await leased(enabled));
    expect(await outcome(enabled)).toEqual({
      status: "succeeded",
      result: { order: ["72004", "72003", "72001", "72002"] },
    });
    expect(writes).toBe(1);
    // 4. Disabling mid-pass supersedes the pass before its write; the retry completes skipped.
    disableMidPass = true;
    const fenced = await layoutGuildRoles(db.pool, layoutGuild);
    await expect(run(await leased(fenced), async () => {})).rejects.toMatchObject({
      code: "superseded",
    });
    expect(writes).toBe(1);
    disableMidPass = false;
    await queue.perform(await leased(fenced));
    expect(await outcome(fenced)).toEqual(skipped);
    expect(writes).toBe(1);
  });

  test("/config role_layout requires server-manager authority, audits, fences revisions and queues layout only when enabling", async () => {
    const layoutGuild = "666666666666666691";
    await db.orm.insert(t.guilds).values({
      id: layoutGuild,
      effects_enabled: true,
      role_layout_enabled: false,
      member_role_id: "73001",
      guest_role_id: "73002",
      officer_role_id: "73003",
      leader_role_id: "73004",
    });
    // The enabling preflight repeats AUTH-03 per managed role; one role can be made unmanageable.
    const checked: string[] = [];
    let unmanageable: string | null = null;
    const port: DiscordPort = {
      ...discord,
      async validateRole(_guild, role, actorId) {
        checked.push(`${role}:${actorId}`);
        if (role === unmanageable)
          throw new Failure("forbidden", "Your highest role must be above the selected role.");
      },
    };
    const app = new Service(db, port, nodestone, config);
    const manager: Actor = { ...actor, guildId: layoutGuild, serverManager: true };
    const state = async () =>
      (
        await db.orm
          .select({ revision: t.guilds.revision, layout: t.guilds.role_layout_enabled })
          .from(t.guilds)
          .where(eq(t.guilds.id, layoutGuild))
      )[0];
    const audits = () =>
      db.orm
        .select({ actor: t.auditEvents.actor_id, details: t.auditEvents.details })
        .from(t.auditEvents)
        .where(
          and(
            eq(t.auditEvents.guild_id, layoutGuild),
            eq(t.auditEvents.action, "config.role_layout"),
          ),
        )
        .orderBy(t.auditEvents.id);
    const layoutJobs = () =>
      db.orm
        .select({ id: t.jobs.id, status: t.jobs.status })
        .from(t.jobs)
        .where(and(eq(t.jobs.guild_id, layoutGuild), eq(t.jobs.kind, "roles.layout")));
    // Officer-only actors and managers without Manage Roles cannot change presentation.
    await expect(
      app.configureRoleLayout({ ...manager, serverManager: false }, true),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      app.configureRoleLayout({ ...manager, manageRoles: false }, true),
    ).rejects.toMatchObject({ code: "forbidden" });
    unmanageable = "73003";
    await expect(app.configureRoleLayout(manager, true)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await state()).toEqual({ revision: 1n, layout: false });
    expect(await audits()).toEqual([]);
    unmanageable = null;
    checked.length = 0;
    const enabled = z
      .object({ status: z.string(), roleLayout: z.string(), layoutJob: z.string() })
      .parse(await app.configureRoleLayout(manager, true));
    expect(enabled).toMatchObject({ status: "saved", roleLayout: "enabled" });
    expect(checked).toEqual(
      ["73004", "73003", "73001", "73002"].map((r) => `${r}:${actor.userId}`),
    );
    expect(await state()).toEqual({ revision: 2n, layout: true });
    expect(await audits()).toEqual([
      { actor: actor.userId, details: { enabled: true, previous: false } },
    ]);
    expect(await layoutJobs()).toEqual([{ id: enabled.layoutJob, status: "queued" }]);
    // Repeating the choice changes nothing: no revision bump, no audit, no new work.
    expect(await app.configureRoleLayout(manager, true)).toEqual({
      status: "unchanged",
      roleLayout: "enabled",
      effectsMode: "live",
    });
    expect(await state()).toEqual({ revision: 2n, layout: true });
    expect(await audits()).toHaveLength(1);
    // Disabling needs no hierarchy preflight and queues nothing; the queued pass will skip.
    checked.length = 0;
    expect(await app.configureRoleLayout(manager, false)).toMatchObject({
      status: "saved",
      roleLayout: "disabled",
      effects: "none",
      layoutJob: null,
    });
    expect(checked).toEqual([]);
    expect(await state()).toEqual({ revision: 3n, layout: false });
    expect((await audits()).at(-1)).toEqual({
      actor: actor.userId,
      details: { enabled: false, previous: true },
    });
    expect(await layoutJobs()).toEqual([{ id: enabled.layoutJob, status: "queued" }]);
    const run = dispatcher(app, new Synchronization(app), new GuildAccess(app, accessPort));
    expect(await run(await leased(enabled.layoutJob), async () => {})).toEqual({
      skipped: "layout disabled",
    });
    expect(await app.validate(manager)).toMatchObject({
      configuration: { role_layout_enabled: false },
      roleLayout: "disabled (role display and order are not changed by the bot)",
    });
    // The setting never creates configuration for an unconfigured guild.
    await expect(
      app.configureRoleLayout({ ...manager, guildId: "666666666666666699" }, true),
    ).rejects.toMatchObject({ code: "setup" });
    expect(await db.query("SELECT id FROM guilds WHERE id='666666666666666699'")).toHaveLength(0);
  });

  test("layout-disabled guilds enqueue no layout work until the switch is enabled", async () => {
    const fixture = await accessFixture("666666666666666692");
    const guildId = fixture.guild.id;
    await db.orm
      .update(t.guilds)
      .set({ role_layout_enabled: false })
      .where(eq(t.guilds.id, guildId));
    const events = new GuildEvents(db);
    const jobsOf = (kind: string) =>
      db.orm
        .select({ id: t.jobs.id, key: t.jobs.dedupe_key, generation: t.jobs.generation })
        .from(t.jobs)
        .where(and(eq(t.jobs.guild_id, guildId), eq(t.jobs.kind, kind)));
    // A refresh run, with a member-less enumeration so only guild-wide children are attached.
    const parent = await enqueue(db.pool, "reconcile.guild", `guild:${guildId}`, {}, guildId);
    const [runRow] = await db.orm
      .insert(t.syncRuns)
      .values({ guild_id: guildId, requester_id: actor.userId, job_id: parent })
      .returning();
    if (!runRow) throw new Error("Missing refresh run");
    await db.orm.insert(t.syncRunJobs).values({ run_id: runRow.id, job_id: parent });
    const app = new Service(
      db,
      {
        ...discord,
        async members() {
          return [];
        },
      },
      nodestone,
      config,
    );
    const refresh = new Synchronization(app);
    const children = async () =>
      (
        await db.orm
          .select({ kind: t.jobs.kind })
          .from(t.syncRunJobs)
          .innerJoin(t.jobs, eq(t.jobs.id, t.syncRunJobs.job_id))
          .where(eq(t.syncRunJobs.run_id, runRow.id))
      )
        .map((row) => row.kind)
        .sort();
    // Every enqueue path: rejoin, role events, a role binding and a refresh pass.
    const everyPath = async (guestRole: string) => {
      await events.guildJoined(guildId);
      await events.roleChanged(guildId);
      await service.configure(fixture.manager, "guest_role_id", guestRole);
      await refresh.guild(guildId, parent);
    };
    await everyPath("81902");
    expect(await jobsOf("roles.layout")).toEqual([]);
    // Reconciliation and channel work are unchanged, each coalesced into one job.
    expect(await jobsOf("reconcile.guild")).toHaveLength(1);
    expect(await jobsOf("channels.access")).toHaveLength(1);
    expect(await children()).toEqual(["channels.access", "reconcile.guild"]);
    // After enabling, every path feeds the single coalesced role-layout:<guild> job.
    const enabled = z
      .object({ layoutJob: z.string() })
      .parse(await service.configureRoleLayout(fixture.manager, true));
    await everyPath("81903");
    expect(await jobsOf("roles.layout")).toEqual([
      { id: enabled.layoutJob, key: `role-layout:${guildId}`, generation: 5 },
    ]);
    expect(await children()).toEqual(["channels.access", "reconcile.guild", "roles.layout"]);
  });

  test("setup keeps a layout-disabled guild's display: created roles are not hoisted and no layout is queued", async () => {
    // An imported (layout-off) guild that later runs /setup keeps its switch and role display.
    const setupGuild = "666666666666666693";
    await db.orm
      .insert(t.guilds)
      .values({ id: setupGuild, effects_enabled: true, role_layout_enabled: false });
    const hoists: boolean[] = [];
    let serial = 74000;
    const provisioner: RoleProvisioner = {
      ...discord,
      async members() {
        return [];
      },
      async ensureRole(_guild, _name, _actor, _configured, _canonical, hoist) {
        hoists.push(hoist);
        return { id: String(++serial), created: true };
      },
    };
    const administration = new RoleAdministration(service, provisioner, access);
    const manager: Actor = { ...actor, guildId: setupGuild, serverManager: true };
    const result = z
      .object({ roleLayout: z.string() })
      .parse(await administration.setup(manager, "Imported", null, null));
    expect(result.roleLayout).toStartWith("disabled");
    expect(hoists).toEqual([false, false, false, false]);
    const configured = await service.guild(manager);
    expect(configured).toMatchObject({ role_layout_enabled: false, access_policy_enabled: true });
    const kinds = await db.orm
      .select({ kind: t.jobs.kind })
      .from(t.jobs)
      .where(eq(t.jobs.guild_id, setupGuild));
    expect(kinds.map((row) => row.kind).sort()).toEqual(["channels.access", "reconcile.guild"]);
  });

  test("/config roles officer adopts current holders by default and nobody with adopt_holders:false", async () => {
    // Owner decision O1: a rank-based launch binds the legacy Officer role without adopting holders.
    const adopting = "666666666666666694";
    const skipping = "666666666666666695";
    const officerRole = "75003";
    let enumerations = 0;
    const holder = (id: string, roles: string[], bot = false): MemberView => ({
      id,
      guildId: "",
      joinedAt: new Date("2026-01-01T00:00:00Z"),
      nickname: null,
      roles,
      bot,
    });
    const port: DiscordPort = {
      ...discord,
      async members(guildId) {
        enumerations++;
        return [
          holder("75101", [officerRole]),
          holder("75102", [officerRole, "75001"]),
          holder("75103", [officerRole], true),
          holder("75104", ["75001"]),
        ].map((member) => ({ ...member, guildId }));
      },
    };
    const app = new Service(db, port, nodestone, config);
    for (const id of [adopting, skipping])
      await db.orm.insert(t.guilds).values({ id, effects_enabled: true });
    const overrides = (guildId: string) =>
      db.orm
        .select({ user: t.officerOverrides.user_id, state: t.officerOverrides.state })
        .from(t.officerOverrides)
        .where(eq(t.officerOverrides.guild_id, guildId))
        .orderBy(t.officerOverrides.user_id);
    const audits = (guildId: string) =>
      db.orm
        .select({
          action: t.auditEvents.action,
          target: t.auditEvents.target,
          details: t.auditEvents.details,
        })
        .from(t.auditEvents)
        .where(eq(t.auditEvents.guild_id, guildId))
        .orderBy(t.auditEvents.id);
    const adopter: Actor = { ...actor, guildId: adopting, serverManager: true };
    const skipper: Actor = { ...actor, guildId: skipping, serverManager: true };
    // Manager authority is unchanged: binding the Officer role still needs Manage Server.
    await expect(
      app.configure({ ...skipper, serverManager: false }, "officer_role_id", officerRole, {
        adoptHolders: false,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // The option belongs to an Officer role binding only.
    await expect(
      app.configure(skipper, "guest_role_id", "75002", { adoptHolders: false }),
    ).rejects.toMatchObject({ code: "input" });
    await expect(
      app.configure(skipper, "officer_role_id", null, { adoptHolders: true }),
    ).rejects.toMatchObject({ code: "input" });
    // Default (true): every current human holder gets an audited manual officer grant.
    expect(await app.configure(adopter, "officer_role_id", officerRole)).toMatchObject({
      status: "saved",
      effects: "queued",
      effectsMode: "live",
      field: "officer_role_id",
      value: officerRole,
      previous: null,
      rebound: false,
      requeued: 0,
      company: null,
      officerHolders: { adopt: true, adopted: 2, sample: ["75101", "75102"] },
    });
    expect(enumerations).toBe(1);
    expect(await overrides(adopting)).toEqual([
      { user: "75101", state: "granted" },
      { user: "75102", state: "granted" },
    ]);
    expect(await audits(adopting)).toEqual([
      {
        action: "config",
        target: "officer_role_id",
        details: { value: officerRole, adoptHolders: true, adopted: 2 },
      },
      { action: "officer.adopt", target: "75101", details: { roleId: officerRole } },
      { action: "officer.adopt", target: "75102", details: { roleId: officerRole } },
    ]);
    expect((await rankAccess(db, await app.guild(adopter), "75101", 21600)).manualOfficer).toBe(
      true,
    );
    // adopt_holders:false: holders are not even enumerated and nobody gains officer access.
    expect(
      await app.configure(skipper, "officer_role_id", officerRole, { adoptHolders: false }),
    ).toMatchObject({ status: "saved", officerHolders: { adopt: false, adopted: 0 } });
    expect(enumerations).toBe(1);
    expect(await overrides(skipping)).toEqual([]);
    expect(await audits(skipping)).toEqual([
      {
        action: "config",
        target: "officer_role_id",
        details: { value: officerRole, adoptHolders: false, adopted: 0 },
      },
    ]);
    expect((await rankAccess(db, await app.guild(skipper), "75101", 21600)).manualOfficer).toBe(
      false,
    );
    // Other role bindings keep their original audit shape.
    await app.configure(skipper, "guest_role_id", "75002");
    expect((await audits(skipping)).at(-1)).toEqual({
      action: "config",
      target: "guest_role_id",
      details: { value: "75002" },
    });
  });

  test("an officer exception granted before the Officer role is bound keeps it through adopt_holders:false", async () => {
    // Production W15 order: record the owner-approved exceptions, then bind the legacy role without
    // adopting holders. The binding's repair pass must not strip the role from an exception.
    const guildId = "666666666666666696";
    const officerRole = "75203";
    const [exception, holder] = ["75201", "75202"];
    for (const id of [exception, holder])
      members.set(id, {
        id,
        guildId,
        joinedAt: new Date("2026-01-01T00:00:00Z"),
        nickname: null,
        roles: [officerRole],
        bot: false,
      });
    await db.orm.insert(t.guilds).values({ id: guildId, effects_enabled: true });
    const manager: Actor = { ...actor, guildId, serverManager: true };
    const provisioner: RoleProvisioner = {
      ...discord,
      async ensureRole() {
        throw new Error("No role is provisioned by an officer grant.");
      },
    };
    const administration = new RoleAdministration(service, provisioner, access);
    // Manager authority is unchanged even though no role is bound yet.
    await expect(
      administration.officer({ ...manager, serverManager: false }, exception, true, "Exception"),
    ).rejects.toThrow("Manage Server");
    // No role is bound, so the grant is only recorded; there is nothing to apply yet.
    expect(
      await administration.officer(manager, exception, true, "Owner-approved exception"),
    ).toEqual({
      status: "granted",
      effects: "recorded",
      effectsMode: "live",
      user: exception,
      reason: "Owner-approved exception",
      present: true,
      previous: null,
    });
    const before = await service.guild(manager);
    expect(before.officer_role_id).toBeNull();
    // Without a bound role the override confers no authority (Service.enrichActor).
    expect(
      (
        await service.enrichActor({
          guildId,
          userId: exception,
          officer: false,
          serverManager: false,
          manageRoles: false,
          roleIds: [officerRole],
        })
      ).officer,
    ).toBe(false);
    // Nothing to reconcile yet: an unbound role is skipped, so the holder keeps the Discord role.
    expect(await reconcileIn(guildId, exception, true)).toMatchObject({ add: [], remove: [] });

    expect(
      await service.configure(manager, "officer_role_id", officerRole, { adoptHolders: false }),
    ).toMatchObject({ status: "saved", officerHolders: { adopt: false, adopted: 0 } });
    // The recorded grant survives the binding, and only it: nobody was adopted.
    expect(
      await db.orm
        .select({ user: t.officerOverrides.user_id, state: t.officerOverrides.state })
        .from(t.officerOverrides)
        .where(eq(t.officerOverrides.guild_id, guildId)),
    ).toEqual([{ user: exception, state: "granted" }]);
    const bound = await service.guild(manager);
    const granted = await rankAccess(db, bound, exception, 21600);
    expect(granted).toMatchObject({ officer: "yes", manualOfficer: true });
    expect(desiredRankRole(granted.officer, true, granted.fresh, granted.manualOfficer)).toBe(true);
    // The repair pass keeps the exception's role and removes it only from a holder with neither
    // the mapped rank nor a grant.
    expect(await reconcileIn(guildId, exception, true)).toMatchObject({ add: [], remove: [] });
    expect(await reconcileIn(guildId, holder, true)).toMatchObject({
      add: [],
      remove: [officerRole],
    });
    // Once bound, the exception holds bot-officer authority through the role.
    expect(
      (
        await service.enrichActor({
          guildId,
          userId: exception,
          officer: false,
          serverManager: false,
          manageRoles: false,
          roleIds: [officerRole],
        })
      ).officer,
    ).toBe(true);
    // A later grant against the bound role is queued as before.
    expect(await administration.officer(manager, holder, true, "Second exception")).toMatchObject({
      status: "granted",
      effects: "queued",
      effectsMode: "live",
      user: holder,
      reason: "Second exception",
      present: true,
      previous: null,
    });
  });

  /**
   * A pre-existing guild captures its original public/private areas before enabling the opt-in
   * channel policy. `onboarding=false` models a /config-only or imported guild: the same roles and
   * review channel, but no lobby/staff rooms, no @everyone baseline and no channel snapshots.
   */
  async function accessFixture(guildId: string, fcId: string | null = null, onboarding = true) {
    const port = new FakeGuildAccess();
    const remote = port.state(guildId);
    const room = (
      id: string,
      type: ChannelType,
      privateArea = false,
      parentId: string | null = null,
    ): AccessChannel => ({
      id,
      type,
      name: id,
      parentId,
      everyoneVisible: !privateArea,
      memberVisible: !privateArea,
      guestVisible: !privateArea,
      overwrites: privateArea
        ? [{ id: guildId, type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) }]
        : [],
    });
    remote.channels = [
      room("81001", ChannelType.GuildText, false, "81003"),
      room("81002", ChannelType.GuildText, true),
      room("81003", ChannelType.GuildCategory),
      room("81004", ChannelType.GuildVoice),
      room("81005", ChannelType.GuildForum),
      room("81006", ChannelType.GuildCategory, true),
      room("81007", ChannelType.GuildMedia, true, "81006"),
    ];
    const policy = new GuildAccess(service, port);
    await db.transaction(async (client) => {
      await orm(client)
        .insert(t.guilds)
        .values({
          id: guildId,
          fc_id: fcId,
          effects_enabled: true,
          member_role_id: "81101",
          guest_role_id: "81102",
          officer_role_id: "81103",
          leader_role_id: "81104",
          lobby_channel_id: onboarding ? "81001" : null,
          officer_channel_id: onboarding ? "81002" : null,
          access_policy_enabled: onboarding,
          access_everyone_before: onboarding ? remote.everyonePermissions : null,
          guest_application_channel_id: "81002",
        });
      if (onboarding)
        await policy.remember(client, guildId, structuredClone(remote), "81001", "81002", false);
    });
    const manager = { ...actor, guildId, serverManager: true };
    return { port, remote, policy, manager, guild: await service.guild(manager) };
  }

  test("channel access retains first snapshots and private areas through partial failure, restart and role replacement", async () => {
    const fixture = await accessFixture("666666666666666671");
    const original = structuredClone(fixture.remote.channels);
    fixture.port.beforeWrite = async (id) => {
      if (id === "81004") throw new Failure("blocked", "Injected channel permission failure");
    };
    await expect(fixture.policy.reconcile(fixture.guild.id, async () => {})).rejects.toThrow(
      "Injected",
    );
    expect(fixture.port.writes.slice(0, 2)).toEqual(["81001", "everyone"]);
    expect(BigInt(fixture.remote.everyonePermissions) & P.ViewChannel).toBe(0n);
    fixture.port.beforeWrite = undefined;
    const restarted = new GuildAccess(service, fixture.port);
    expect(await restarted.reconcile(fixture.guild.id, async () => {})).toMatchObject({
      status: "secured",
    });
    const writes = fixture.port.writes.length;
    expect(await restarted.reconcile(fixture.guild.id, async () => {})).toMatchObject({
      changed: [],
      defaultChanged: false,
    });
    expect(fixture.port.writes).toHaveLength(writes);
    const saved = await db.orm
      .select()
      .from(t.channelAccessPolicies)
      .where(eq(t.channelAccessPolicies.guild_id, fixture.guild.id));
    for (const row of saved)
      expect(row.original_state).toEqual(original.find((channel) => channel.id === row.channel_id));
    expect(
      saved
        .filter((row) => row.staff_only)
        .map((row) => row.channel_id)
        .sort(),
    ).toEqual(["81002", "81006", "81007"]);
    await service.configure(fixture.manager, "member_role_id", "81109");
    await expect(service.configure(fixture.manager, "guest_role_id", null)).rejects.toThrow(
      "all four roles",
    );
    await expect(
      service.configure({ ...fixture.manager, serverManager: false }, "guest_role_id", "81110"),
    ).rejects.toThrow("Manage Server");
    await restarted.reconcile(fixture.guild.id, async () => {});
    const voice = fixture.remote.channels.find((channel) => channel.id === "81004");
    expect(
      voice?.overwrites.some(
        (overwrite) => overwrite.id === "81101" && (BigInt(overwrite.allow) & P.ViewChannel) !== 0n,
      ),
    ).toBe(false);
    expect(
      voice?.overwrites.some(
        (overwrite) => overwrite.id === "81109" && (BigInt(overwrite.allow) & P.ViewChannel) !== 0n,
      ),
    ).toBe(true);
    expect(
      (
        await db.orm
          .select()
          .from(t.channelAccessPolicies)
          .where(
            and(
              eq(t.channelAccessPolicies.guild_id, fixture.guild.id),
              eq(t.channelAccessPolicies.channel_id, "81001"),
            ),
          )
      )[0]?.original_state,
    ).toEqual(original[0]);
  });

  test("channel effects honor activation, setup exclusion, revision fencing and missing-room readback", async () => {
    const fixture = await accessFixture("666666666666666672");
    const disabled = new Service(db, discord, nodestone, { ...config, ENABLE_EFFECTS: false });
    await expect(
      new GuildAccess(disabled, fixture.port).reconcile(fixture.guild.id, async () => {}),
    ).rejects.toMatchObject({ code: "disabled" });
    const lock = await db.pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        `setup:${fixture.guild.id}`,
      ]);
      await expect(
        fixture.policy.reconcile(fixture.guild.id, async () => {}),
      ).rejects.toMatchObject({ code: "busy" });
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `setup:${fixture.guild.id}`,
      ]);
      lock.release();
    }
    fixture.port.beforeWrite = async () => {
      await db.orm
        .update(t.guilds)
        .set({ revision: sql`${t.guilds.revision}+1` })
        .where(eq(t.guilds.id, fixture.guild.id));
    };
    await expect(fixture.policy.reconcile(fixture.guild.id, async () => {})).rejects.toMatchObject({
      code: "superseded",
    });
    expect(fixture.port.writes).toHaveLength(0);
    fixture.port.beforeWrite = undefined;
    fixture.port.afterWrite = async (id) => {
      if (id === "81007")
        fixture.remote.channels = fixture.remote.channels.filter(
          (channel) => channel.id !== "81002",
        );
    };
    await expect(fixture.policy.reconcile(fixture.guild.id, async () => {})).rejects.toMatchObject({
      code: "blocked",
    });
    expect(
      await db.orm
        .select()
        .from(t.auditEvents)
        .where(
          and(
            eq(t.auditEvents.guild_id, fixture.guild.id),
            eq(t.auditEvents.action, "channels.secured"),
          ),
        ),
    ).toEqual([]);
  });

  test("channel events coalesce without member enumeration and refresh status tracks channel repair", async () => {
    const fixture = await accessFixture("666666666666666673");
    const events = new GuildEvents(db);
    await events.channelChanged(fixture.guild.id);
    await events.channelChanged(fixture.guild.id);
    const pending = await db.orm
      .select()
      .from(t.jobs)
      .where(and(eq(t.jobs.guild_id, fixture.guild.id), eq(t.jobs.kind, "channels.access")));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.generation).toBe(2);
    const parent = await enqueue(
      db.pool,
      "reconcile.guild",
      `guild:${fixture.guild.id}`,
      {},
      fixture.guild.id,
    );
    const [run] = await db.orm
      .insert(t.syncRuns)
      .values({ guild_id: fixture.guild.id, requester_id: actor.userId, job_id: parent })
      .returning();
    if (!run) throw new Error("Missing refresh run");
    await db.orm.insert(t.syncRunJobs).values({ run_id: run.id, job_id: parent });
    let enumerations = 0;
    const app = new Service(
      db,
      {
        ...discord,
        async members() {
          enumerations++;
          return [];
        },
      },
      nodestone,
      config,
    );
    const sync = new Synchronization(app);
    await sync.guild(fixture.guild.id, parent);
    expect(enumerations).toBe(1);
    const children = await db.orm
      .select({ kind: t.jobs.kind })
      .from(t.syncRunJobs)
      .innerJoin(t.jobs, eq(t.jobs.id, t.syncRunJobs.job_id))
      .where(eq(t.syncRunJobs.run_id, run.id));
    expect(children.map((row) => row.kind).sort()).toEqual([
      "channels.access",
      "reconcile.guild",
      "roles.layout",
    ]);
    await dispatcher(app, sync, fixture.policy)(await leased(pending[0]?.id ?? ""), async () => {});
    // A new default-closed channel is ordinary; a newly explicit private channel stays staff-only.
    fixture.remote.channels.push({
      id: "81008",
      name: "new",
      type: ChannelType.GuildStageVoice,
      parentId: null,
      overwrites: [],
      everyoneVisible: false,
      memberVisible: false,
      guestVisible: false,
    });
    const privateChannels: AccessChannel[] = [
      { id: fixture.guild.member_role_id ?? "", type: OverwriteType.Role },
      { id: fixture.guild.guest_role_id ?? "", type: OverwriteType.Role },
      { id: "81901", type: OverwriteType.Role },
      { id: "94001", type: OverwriteType.Member },
    ].map((denied, index) => ({
      id: String(81009 + index),
      name: `private-${denied.id}`,
      type: ChannelType.GuildText,
      parentId: null,
      everyoneVisible: false,
      memberVisible: false,
      guestVisible: false,
      overwrites: [{ ...denied, allow: "0", deny: String(P.ViewChannel) }],
    }));
    fixture.remote.channels.push(...structuredClone(privateChannels));
    await events.channelChanged(fixture.guild.id);
    await fixture.policy.reconcile(fixture.guild.id, async () => {});
    expect(
      (
        await db.orm
          .select()
          .from(t.channelAccessPolicies)
          .where(
            and(
              eq(t.channelAccessPolicies.guild_id, fixture.guild.id),
              eq(t.channelAccessPolicies.channel_id, "81008"),
            ),
          )
      )[0]?.staff_only,
    ).toBe(false);
    for (const original of privateChannels) {
      const [saved] = await db.orm
        .select()
        .from(t.channelAccessPolicies)
        .where(
          and(
            eq(t.channelAccessPolicies.guild_id, fixture.guild.id),
            eq(t.channelAccessPolicies.channel_id, original.id),
          ),
        );
      expect(saved).toMatchObject({ staff_only: true, original_state: original });
      const channel = fixture.remote.channels.find((channel) => channel.id === original.id);
      for (const role of [fixture.guild.member_role_id, fixture.guild.guest_role_id]) {
        const overwrite = channel?.overwrites.find((overwrite) => overwrite.id === role);
        expect(BigInt(overwrite?.allow ?? "0") & P.ViewChannel).toBe(0n);
        expect(BigInt(overwrite?.deny ?? "0") & P.ViewChannel).toBe(P.ViewChannel);
      }
    }
    expect(enumerations).toBe(1);
    await db.orm.insert(t.guilds).values({ id: "666666666666666679" });
    await events.channelChanged("666666666666666679");
    expect(
      await db.orm.select().from(t.jobs).where(eq(t.jobs.guild_id, "666666666666666679")),
    ).toEqual([]);
  });

  test("reserved community resources are neither snapshotted nor enforced and cannot become onboarding bindings", async () => {
    const fixture = await accessFixture("666666666666666680");
    const reserved: AccessChannel[] = [
      {
        id: "81400",
        name: "Admin",
        type: ChannelType.GuildCategory,
        parentId: null,
        overwrites: [],
        everyoneVisible: true,
        memberVisible: true,
        guestVisible: true,
      },
      {
        id: "81401",
        name: "community-updates",
        type: ChannelType.GuildText,
        parentId: "81400",
        overwrites: [],
        everyoneVisible: true,
        memberVisible: true,
        guestVisible: true,
      },
    ];
    fixture.remote.channels.push(...structuredClone(reserved));
    fixture.remote.excludedChannelIds = reserved.map((channel) => channel.id);
    fixture.remote.preserveEveryoneView = true;
    const everyone = fixture.remote.everyonePermissions;
    const result = await fixture.policy.reconcile(fixture.guild.id, async () => {});
    expect(result).toMatchObject({
      status: "secured",
      channels: 7,
      excludedChannels: fixture.remote.excludedChannelIds,
      preservedEveryoneView: true,
      defaultChanged: false,
    });
    expect(fixture.remote.everyonePermissions).toBe(everyone);
    expect(
      fixture.remote.channels.filter((channel) =>
        fixture.remote.excludedChannelIds.includes(channel.id),
      ),
    ).toEqual(reserved);
    expect(
      await db.orm
        .select()
        .from(t.channelAccessPolicies)
        .where(
          and(
            eq(t.channelAccessPolicies.guild_id, fixture.guild.id),
            inArray(t.channelAccessPolicies.channel_id, fixture.remote.excludedChannelIds),
          ),
        ),
    ).toEqual([]);
    expect(fixture.port.writes.some((id) => fixture.remote.excludedChannelIds.includes(id))).toBe(
      false,
    );
    const writes = fixture.port.writes.length;
    expect(
      await new GuildAccess(service, fixture.port).reconcile(fixture.guild.id, async () => {}),
    ).toMatchObject({ changed: [], defaultChanged: false });
    expect(fixture.port.writes).toHaveLength(writes);
    await db.orm
      .update(t.guilds)
      .set({ officer_channel_id: "81401", revision: sql`${t.guilds.revision}+1` })
      .where(eq(t.guilds.id, fixture.guild.id));
    await expect(fixture.policy.reconcile(fixture.guild.id, async () => {})).rejects.toThrow(
      "reserved community channel",
    );
    expect(fixture.port.writes).toHaveLength(writes);
  });

  test("large-guild reconciliation uses two catalogues and reads only changed targets", async () => {
    // Exercise the real application loop, SDK adapter, and database together; count REST endpoints.
    const fixture = discordAccessFixture();
    try {
      const everyone = fixture.roles.find((role) => role.id === "100");
      if (!everyone) throw new Error("Missing everyone role");
      everyone.permissions = String(BigInt(everyone.permissions) & ~P.ViewChannel);
      const closed = [
        { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
      ];
      const parent = fixture.add("Admin", ChannelType.GuildCategory, structuredClone(closed));
      const updates = fixture.add(
        "community-updates",
        ChannelType.GuildText,
        structuredClone(closed),
        parent.id,
      );
      fixture.community.updatesChannelId = updates.id;
      const lobby = fixture.add(
        "lobby",
        ChannelType.GuildText,
        channelAccessOverwrites([], "100", "900", fixture.bindings, "lobby"),
      );
      const officers = fixture.add(
        "officer-chat",
        ChannelType.GuildText,
        channelAccessOverwrites([], "100", "900", fixture.bindings, "officers"),
      );
      const ordinary = Array.from({ length: 80 }, (_, index) =>
        fixture.add(
          `room-${index}`,
          ChannelType.GuildText,
          channelAccessOverwrites([], "100", "900", fixture.bindings, "members"),
        ),
      );
      await db.orm.insert(t.guilds).values({
        id: "100",
        effects_enabled: true,
        access_policy_enabled: true,
        lobby_channel_id: lobby.id,
        officer_channel_id: officers.id,
        member_role_id: fixture.bindings.member,
        guest_role_id: fixture.bindings.guest,
        officer_role_id: fixture.bindings.officer,
        leader_role_id: fixture.bindings.leader,
        access_everyone_before: everyone.permissions,
      });
      const policy = new GuildAccess(service, fixture.port);
      expect(await policy.reconcile("100", async () => {})).toMatchObject({
        status: "secured",
        channels: 82,
        changed: [],
        defaultChanged: false,
      });
      expect(fixture.reads.filter((route) => route === "/guilds/100/channels")).toHaveLength(2);
      expect(fixture.reads.filter((route) => route.startsWith("/channels/"))).toHaveLength(0);
      expect(fixture.writes).toEqual([]);
      fixture.reads.length = 0;
      const changed = ordinary[0];
      if (!changed) throw new Error("Missing drift target");
      changed.permission_overwrites = [];
      expect(await policy.reconcile("100", async () => {})).toMatchObject({
        status: "secured",
        changed: [changed.id],
      });
      expect(fixture.reads.filter((route) => route === "/guilds/100/channels")).toHaveLength(2);
      expect(fixture.reads.filter((route) => route.startsWith("/channels/"))).toEqual([
        `/channels/${changed.id}`,
        `/channels/${changed.id}`,
      ]);
      expect(fixture.writes).toEqual([`/channels/${changed.id}`]);
      expect([parent.permission_overwrites, updates.permission_overwrites]).toEqual([
        closed,
        closed,
      ]);
    } finally {
      await fixture.close();
    }
  });

  /**
   * Registered-visitor Guest is computed identically with lobby onboarding enabled or disabled
   * (ROLE-07, ACCESS-04); each pass uses its own guild, users and characters.
   */
  const verifiedVisitorScenario = async (pass: {
    onboarding: boolean;
    guild: string;
    users: readonly [string, string];
    characters: readonly [string, string];
  }) => {
    const [firstUser, secondUser] = pass.users;
    const fixture = await accessFixture(pass.guild, fc, pass.onboarding);
    await db.orm
      .update(t.freeCompanies)
      .set({ last_successful_roster_at: sql`now()` })
      .where(eq(t.freeCompanies.id, fc));
    const visitor = {
      id: pass.characters[0],
      name: "Verified Visitor",
      world: "Diabolos",
      dc: "Crystal",
      fcId: fc,
    };
    await service.assign(fixture.manager, firstUser, visitor, "Trusted visitor");
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, firstUser)).toBe(false);
    const reconcile = async (user: string) =>
      sync.user(
        await leased(
          await enqueue(
            db.pool,
            "reconcile.user",
            `user:${fixture.guild.id}:${user}`,
            {},
            fixture.guild.id,
            user,
          ),
        ),
        async () => {},
      );
    await reconcile(firstUser);
    expect(members.get(firstUser)?.roles).toContain(fixture.guild.guest_role_id ?? "");
    expect(members.get(firstUser)?.roles).not.toContain(fixture.guild.member_role_id ?? "");
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, firstUser)).toBe(true);
    expect(
      await db.orm
        .select()
        .from(t.guestGrants)
        .where(
          and(eq(t.guestGrants.guild_id, fixture.guild.id), eq(t.guestGrants.user_id, firstUser)),
        ),
    ).toEqual([]);
    await expect(
      service.apply(
        { ...fixture.manager, userId: firstUser, officer: false, serverManager: false },
        await applicationInput({ ...fixture.manager, userId: firstUser }),
      ),
    ).rejects.toMatchObject({ code: "eligible" });
    await service.guestAction(fixture.manager, firstUser, true, "Explicit revoke", randomUUID());
    await reconcile(firstUser);
    expect(members.get(firstUser)?.roles).not.toContain(fixture.guild.guest_role_id ?? "");
    const events = new GuildEvents(db);
    await events.memberLeft(fixture.guild.id, firstUser);
    const rejoined = members.get(firstUser);
    if (!rejoined) throw new Error("Missing rejoining visitor");
    rejoined.joinedAt = new Date();
    await events.memberJoined(fixture.guild.id, firstUser, rejoined.joinedAt);
    const restarted = new Service(db, discord, nodestone, config);
    expect(await restarted.registrationGuestEligible(db.pool, fixture.guild, firstUser)).toBe(
      false,
    );
    await reconcile(firstUser);
    expect(rejoined.roles).not.toContain(fixture.guild.guest_role_id ?? "");
    // Positive accepted roster evidence grants Member even though the independent Guest revoke persists.
    const [positive] = await db.orm
      .insert(t.rosterSnapshots)
      .values({
        fc_id: fc,
        started_at: new Date(),
        observed_at: new Date(),
        member_count: 1,
        evidence: { fixture: true },
      })
      .returning();
    if (!positive) throw new Error("Missing positive snapshot");
    await db.orm
      .insert(t.rosterMembers)
      .values({ snapshot_id: positive.id, character_id: visitor.id });
    await db.orm
      .update(t.membership)
      .set({ state: "present", snapshot_id: positive.id, confirmed_snapshot_id: positive.id })
      .where(
        and(
          eq(t.membership.guild_id, fixture.guild.id),
          eq(t.membership.character_id, visitor.id),
          eq(t.membership.fc_id, fc),
        ),
      );
    await reconcile(firstUser);
    expect(members.get(firstUser)?.roles).toContain(fixture.guild.member_role_id ?? "");
    expect(members.get(firstUser)?.roles).not.toContain(fixture.guild.guest_role_id ?? "");
    const second = { ...visitor, id: pass.characters[1] };
    await service.assign(fixture.manager, secondUser, second, "Second visitor");
    await reconcile(secondUser);
    const current = members.get(secondUser);
    if (!current) throw new Error("Missing second visitor");
    expect(current.roles).toContain(fixture.guild.guest_role_id ?? "");
    await db.orm
      .update(t.freeCompanies)
      .set({ last_successful_roster_at: sql`now()-interval '7 hours'` })
      .where(eq(t.freeCompanies.id, fc));
    await reconcile(secondUser);
    expect(current.roles).toContain(fixture.guild.guest_role_id ?? "");
    current.roles = [];
    await reconcile(secondUser);
    expect(current.roles).toEqual([]);
    await db.orm
      .update(t.freeCompanies)
      .set({ last_successful_roster_at: sql`now()` })
      .where(eq(t.freeCompanies.id, fc));
    await reconcile(secondUser);
    expect(current.roles).toContain(fixture.guild.guest_role_id ?? "");
    await service.unclaim(
      { ...fixture.manager, userId: secondUser, officer: false },
      secondUser,
      second.id,
    );
    await reconcile(secondUser);
    expect(current.roles).not.toContain(fixture.guild.guest_role_id ?? "");
  };
  for (const pass of [
    {
      onboarding: true,
      guild: "666666666666666674",
      users: ["94001", "94002"],
      characters: ["77777200", "77777201"],
    },
    {
      onboarding: false,
      guild: "666666666666666682",
      users: ["94011", "94012"],
      characters: ["77777210", "77777211"],
    },
  ] as const)
    test(`verified visitors get derived Guest access while revocation, FC membership, staleness and unlink remain authoritative (onboarding ${pass.onboarding ? "enabled" : "disabled"})`, () =>
      verifiedVisitorScenario(pass));

  /** Run one leased user pass exactly as the worker would (or as a preview), without a queue loop. */
  async function reconcileIn(guildId: string, user: string, preview = false) {
    const work = await enqueue(
      db.pool,
      "reconcile.user",
      `user:${guildId}:${user}`,
      {},
      guildId,
      user,
    );
    return sync.user(await leased(work), async () => {}, preview);
  }

  /**
   * Publish one accepted roster for an isolated FC through the real acquisition path. An explicit
   * observation instant lets departure confirmation (two absences 60 s apart) run without waiting.
   */
  async function publishRoster(fcId: string, roster: Roster["members"], observedAt = new Date()) {
    nodestone.rosterValue = {
      company: {
        id: fcId,
        name: "Isolated FC",
        tag: "ISO",
        world: "Diabolos",
        dc: "Crystal",
        count: roster.length,
      },
      members: roster,
      startedAt: new Date(observedAt.getTime() - 1000),
      observedAt,
      pages: 1,
    };
    await db.orm
      .update(t.freeCompanies)
      .set({ last_attempt_at: sql`now()-interval '61 seconds'` })
      .where(eq(t.freeCompanies.id, fcId));
    // The dedupe key coalesces with an early acquisition that seedFreshLink may already have queued.
    const key = await enqueue(db.pool, "roster", `roster:${fcId}`, { fcId });
    try {
      await sync.roster(await leased(key), async () => {});
    } finally {
      await db.orm
        .update(t.jobs)
        .set({ status: "succeeded", lease_until: null })
        .where(eq(t.jobs.id, key));
    }
    return key;
  }

  /** No onboarding means no channel-visibility work at all: no queued job and no snapshot rows. */
  async function expectNoChannelWork(guildId: string) {
    expect(
      await db.orm
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .where(and(eq(t.jobs.guild_id, guildId), eq(t.jobs.kind, "channels.access"))),
    ).toEqual([]);
    expect(
      await db.orm
        .select({ channel_id: t.channelAccessPolicies.channel_id })
        .from(t.channelAccessPolicies)
        .where(eq(t.channelAccessPolicies.guild_id, guildId)),
    ).toEqual([]);
  }

  test("registered visitor access applies with onboarding disabled, is guild-scoped and works before linking an FC", async () => {
    const fixture = await accessFixture("666666666666666675");
    const character = {
      id: "77777202",
      name: "Local Registration",
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    };
    await service.assign(fixture.manager, "94003", character, "FC-less registration");
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, "94003")).toBe(true);
    await reconcileIn(fixture.guild.id, "94003");
    expect(members.get("94003")?.roles).toContain(fixture.guild.guest_role_id ?? "");
    const other = await accessFixture("666666666666666676");
    expect(await service.registrationGuestEligible(db.pool, other.guild, "94003")).toBe(false);
    // A /config-only guild (no /setup, so no onboarding) with active effects and no linked FC.
    const legacy = { ...fixture.manager, guildId: "666666666666666678" };
    await db.orm.insert(t.guilds).values({
      id: legacy.guildId,
      effects_enabled: true,
      member_role_id: "81201",
      guest_role_id: "81202",
    });
    await service.assign(legacy, "94003", character, "Legacy local link");
    const configured = await service.guild(legacy);
    expect(configured.access_policy_enabled).toBe(false);
    // Registration alone is a Guest credential in every configured guild (ROLE-07).
    expect(await service.registrationGuestEligible(db.pool, configured, "94003")).toBe(true);
    await reconcileIn(legacy.guildId, "94003");
    expect(members.get("94003")?.roles).toContain("81202");
    // Guild reconciliation still covers the user but performs no channel-visibility work.
    const visitor = members.get("94003");
    if (!visitor) throw new Error("Missing registered visitor");
    const enumerating = new Synchronization(
      new Service(
        db,
        {
          ...discord,
          async members() {
            return [visitor];
          },
        },
        nodestone,
        config,
      ),
    );
    const parent = await enqueue(
      db.pool,
      "reconcile.guild",
      `guild:${legacy.guildId}`,
      {},
      legacy.guildId,
    );
    expect(await enumerating.guild(legacy.guildId, parent)).toMatchObject({ humans: 1 });
    await expectNoChannelWork(legacy.guildId);
  });

  test("multi-character union grants Member, Officer and registered Guest with onboarding disabled", async () => {
    // An isolated FC keeps this roster from moving links in guilds bound to the legacy fixture FC.
    const unionFc = "9232097761132950001";
    await db.orm
      .insert(t.freeCompanies)
      .values({ id: unionFc, name: "Union FC", world: "Diabolos", dc: "Crystal" });
    const fixture = await accessFixture("666666666666666683", unionFc, false);
    await service.configureOfficerRank(fixture.manager, "Officer");
    const ranked = (id: string, rank: string) => ({
      id,
      name: `Union ${rank} ${id}`,
      world: "Diabolos",
      dc: "Crystal",
      fcId: unionFc,
      fcRankName: rank,
      isFcLeader: false,
    });
    const outside = (id: string) => ({
      id,
      name: `Union Visitor ${id}`,
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    });
    const officerA = ranked("88000001", "Officer");
    const memberB = ranked("88000002", "Member");
    const officerC = ranked("88000007", "Officer");
    await publishRoster(unionFc, [officerA, memberB, officerC]);
    // Each user links one or more characters; the FC characters gain evidence from the fresh roster
    // at assignment, and the outside characters are evaluated absent by seedFreshLink.
    await service.assign(fixture.manager, "95001", officerA, "Union officer character");
    await service.assign(fixture.manager, "95001", outside("88000003"), "Union alt character");
    await service.assign(fixture.manager, "95002", memberB, "Union member character");
    await service.assign(fixture.manager, "95002", outside("88000004"), "Union alt character");
    await service.assign(fixture.manager, "95003", outside("88000005"), "Registered visitor");
    await service.assign(fixture.manager, "95003", outside("88000006"), "Registered visitor alt");
    // A bot-only officer can vouch for membership but cannot make anyone an officer.
    const botOfficer = { ...fixture.manager, userId: "95090", serverManager: false };
    await service.assign(botOfficer, "95004", officerC, "Bot-only officer assignment");
    for (const user of ["95001", "95002", "95003", "95004"])
      await reconcileIn(fixture.guild.id, user);
    const roles = (user: string) => members.get(user)?.roles ?? [];
    const {
      member_role_id: member,
      guest_role_id: guest,
      officer_role_id: officer,
    } = fixture.guild;
    expect(roles("95001")).toContain(member ?? "");
    expect(roles("95001")).toContain(officer ?? "");
    expect(roles("95001")).not.toContain(guest ?? "");
    expect(roles("95002")).toContain(member ?? "");
    expect(roles("95002")).not.toContain(officer ?? "");
    expect(roles("95002")).not.toContain(guest ?? "");
    expect(roles("95003")).toEqual([guest ?? ""]);
    // The Guest is derived from registration alone: no durable grant and no former-member history.
    expect(
      await db.orm
        .select({ id: t.guestGrants.id })
        .from(t.guestGrants)
        .where(
          and(eq(t.guestGrants.guild_id, fixture.guild.id), eq(t.guestGrants.user_id, "95003")),
        ),
    ).toEqual([]);
    expect(
      await db.orm
        .select({ id: t.membershipHistory.id })
        .from(t.membershipHistory)
        .where(
          and(
            eq(t.membershipHistory.guild_id, fixture.guild.id),
            eq(t.membershipHistory.user_id, "95003"),
          ),
        ),
    ).toEqual([]);
    expect(roles("95004")).toContain(member ?? "");
    expect(roles("95004")).not.toContain(officer ?? "");
    // Unlinking the only FC character leaves an outside link: Member and Officer end, Guest begins.
    await service.unclaim(fixture.manager, "95001", officerA.id, "Officer character moved");
    await reconcileIn(fixture.guild.id, "95001");
    expect(roles("95001")).not.toContain(member ?? "");
    expect(roles("95001")).not.toContain(officer ?? "");
    expect(roles("95001")).toContain(guest ?? "");
    expect(
      (
        await db.orm
          .select({ local_member_loss: t.guildUsers.local_member_loss })
          .from(t.guildUsers)
          .where(
            and(eq(t.guildUsers.guild_id, fixture.guild.id), eq(t.guildUsers.user_id, "95001")),
          )
      )[0]?.local_member_loss,
    ).toBe(true);
    await expectNoChannelWork(fixture.guild.id);
  });

  test("unknown and stale evidence delay registered Guest in onboarding-disabled guilds", async () => {
    // No accepted snapshot is newer than the freshness window, so a new link stays unevaluated.
    const staleFc = "9232097761132950002";
    await db.orm.insert(t.freeCompanies).values({
      id: staleFc,
      name: "Stale FC",
      world: "Diabolos",
      dc: "Crystal",
      last_successful_roster_at: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    const fixture = await accessFixture("666666666666666684", staleFc, false);
    const character = {
      id: "88000008",
      name: "Stale Visitor",
      world: "Diabolos",
      dc: "Crystal",
      fcId: null,
    };
    await service.assign(
      fixture.manager,
      "95005",
      character,
      "Registration while evidence is stale",
    );
    await reconcileIn(fixture.guild.id, "95005");
    expect(members.get("95005")?.roles).toEqual([]);
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, "95005")).toBe(false);
    // seedFreshLink requested an early acquisition instead of guessing from stale evidence.
    const early = await db.orm
      .select({ id: t.jobs.id })
      .from(t.jobs)
      .where(
        and(
          eq(t.jobs.kind, "roster"),
          eq(t.jobs.dedupe_key, `roster:${staleFc}`),
          eq(t.jobs.status, "queued"),
        ),
      );
    expect(early).toHaveLength(1);
    expect(
      await publishRoster(staleFc, [
        {
          id: "88000009",
          name: "Stale Member",
          world: "Diabolos",
          dc: "Crystal",
          fcId: staleFc,
          fcRankName: "Member",
        },
      ]),
    ).toBe(early[0]?.id ?? "");
    // Preview and the worker agree once the link is evaluated against fresh accepted evidence.
    expect(await reconcileIn(fixture.guild.id, "95005", true)).toMatchObject({
      desired: { member: false, guest: true },
      add: [fixture.guild.guest_role_id],
    });
    await reconcileIn(fixture.guild.id, "95005");
    expect(members.get("95005")?.roles).toEqual([fixture.guild.guest_role_id ?? ""]);
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, "95005")).toBe(true);
    await expectNoChannelWork(fixture.guild.id);
  });

  test("onboarding-disabled reconciliation supersedes a pending application once the applicant registers", async () => {
    const fixture = await accessFixture("666666666666666685", null, false);
    const applicant = { ...fixture.manager, userId: "95006", officer: false, serverManager: false };
    const pending = await service.apply(applicant, await applicationInput(applicant));
    const review = and(
      eq(t.jobs.kind, "guest.review"),
      eq(t.jobs.dedupe_key, `review:${pending.id}`),
    );
    // Treat the submission's review message as delivered, so a new job can only come from reconcile.
    await db.orm.update(t.jobs).set({ status: "succeeded" }).where(review);
    await service.assign(
      fixture.manager,
      applicant.userId,
      { id: "88000010", name: "Late Registration", world: "Diabolos", dc: "Crystal", fcId: null },
      "Applicant registered a character",
    );
    await reconcileIn(fixture.guild.id, applicant.userId);
    expect(
      (
        await db.orm
          .select({ state: t.guestApplications.state })
          .from(t.guestApplications)
          .where(eq(t.guestApplications.id, pending.id))
      )[0]?.state,
    ).toBe("superseded");
    expect(
      await db.orm
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .where(and(review, eq(t.jobs.status, "queued"))),
    ).toHaveLength(1);
    expect(members.get(applicant.userId)?.roles).toContain(fixture.guild.guest_role_id ?? "");
    expect(
      await db.orm
        .select({ id: t.guestGrants.id })
        .from(t.guestGrants)
        .where(
          and(
            eq(t.guestGrants.guild_id, fixture.guild.id),
            eq(t.guestGrants.user_id, applicant.userId),
          ),
        ),
    ).toEqual([]);
    await expectNoChannelWork(fixture.guild.id);
  });

  /**
   * A synthetic imported guild awaiting its first activation: its own FC (so its rosters never move
   * other tests' links), four managed roles, applications closed unless a legacy review channel is
   * given, the 'pending' marker, effects off, and a migration.import audit an hour old, so a roster
   * published now counts as post-import evidence.
   */
  async function importedGuild(guildId: string, fcId: string, channel: string | null = null) {
    await db.orm
      .insert(t.freeCompanies)
      .values({ id: fcId, name: `Cutover FC ${fcId}`, world: "Diabolos", dc: "Crystal" })
      .onConflictDoNothing();
    await db.orm.insert(t.guilds).values({
      id: guildId,
      fc_id: fcId,
      member_role_id: "82101",
      guest_role_id: "82102",
      officer_role_id: "82103",
      leader_role_id: "82104",
      guest_application_channel_id: channel,
      role_layout_enabled: false,
      guest_grandfather: "pending",
      effects_enabled: false,
    });
    await db.orm.insert(t.auditEvents).values({
      guild_id: guildId,
      action: "migration.import",
      target: `fingerprint:${guildId}`,
      details: { guestGrandfather: "pending" },
      event_at: sql`now()-interval '1 hour'`,
    });
    const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, guildId));
    if (!row) throw new Error("Missing imported guild fixture");
    return row;
  }

  /** An imported human (guild_users.imported), optionally owning one active character link. */
  async function importedHuman(guildId: string, user: string, character?: string) {
    await ensureUser(db.pool, guildId, user, new Date("2026-01-01T00:00:00Z"));
    await db.orm
      .update(t.guildUsers)
      .set({ imported: true })
      .where(and(eq(t.guildUsers.guild_id, guildId), eq(t.guildUsers.user_id, user)));
    if (character) return linkCharacter(guildId, user, character);
    return null;
  }

  /** An active link to a new character, as the importer or /assign would store it. */
  async function linkCharacter(guildId: string, user: string, character: string) {
    await db.orm
      .insert(t.characters)
      .values({ id: character, name: `Cutover ${character}`, world: "Diabolos", dc: "Crystal" })
      .onConflictDoNothing();
    const [link] = await db.orm
      .insert(t.links)
      .values({
        guild_id: guildId,
        user_id: user,
        character_id: character,
        provenance: "imported_link",
      })
      .returning({ id: t.links.id });
    if (!link) throw new Error("Missing link fixture");
    return link.id;
  }

  /** A roster member of the given FC, as Nodestone reports one. */
  const rosterMember = (id: string, fcId: string) => ({
    id,
    name: `Cutover ${id}`,
    world: "Diabolos",
    dc: "Crystal",
    fcId,
    fcRankName: "Member",
  });

  /** A current Discord member view; bots are enumerated too and must never be grandfathered. */
  const memberView = (
    guildId: string,
    id: string,
    roles: string[] = [],
    joinedAt = new Date("2026-01-01T00:00:00Z"),
    bot = false,
  ): MemberView => ({ id, guildId, joinedAt, nickname: null, roles, bot });

  /** Everything a refused activation must leave untouched in a pending guild. */
  async function expectNotActivated(guildId: string) {
    const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, guildId));
    expect(row).toMatchObject({
      guest_grandfather: "pending",
      guest_grandfathered_at: null,
      effects_enabled: false,
    });
    expect(
      await db.orm
        .select({ id: t.guestGrants.id })
        .from(t.guestGrants)
        .where(
          and(eq(t.guestGrants.guild_id, guildId), eq(t.guestGrants.provenance, "grandfathered")),
        ),
    ).toEqual([]);
    expect(
      await db.orm
        .select({ action: t.auditEvents.action })
        .from(t.auditEvents)
        .where(
          and(
            eq(t.auditEvents.guild_id, guildId),
            inArray(t.auditEvents.action, [
              "activation",
              "guest.grandfather",
              "guest.grandfather.completed",
            ]),
          ),
        ),
    ).toEqual([]);
  }

  /** Audit rows of one action in one guild. */
  const auditsOf = (guildId: string, action: string) =>
    db.orm
      .select({ target: t.auditEvents.target, details: t.auditEvents.details })
      .from(t.auditEvents)
      .where(and(eq(t.auditEvents.guild_id, guildId), eq(t.auditEvents.action, action)));

  // The first-activation scenario: the first test activates it, the second reconciles it.
  const cutover = {
    guild: "666666666666666700",
    fc: "9232097761132950010",
    present: "97001",
    memberWithoutLink: "97002",
    roleless: "97003",
    importedGuest: "97004",
    revoked: "97005",
    absentLink: "97006",
    uncertain: "97007",
    newcomer: "97008",
    bot: "97090",
    lateJoiner: "97009",
  } as const;
  let cutoverEnumeratedAt: Date | null = null;

  test("first activation grandfathers current non-member humans exactly once with audit", async () => {
    const { guild: id, fc: fcId } = cutover;
    const row = await importedGuild(id, fcId);
    const member = row.member_role_id ?? "";
    const guest = row.guest_role_id ?? "";
    await importedHuman(id, cutover.present, "88100001");
    for (const user of [
      cutover.memberWithoutLink,
      cutover.roleless,
      cutover.importedGuest,
      cutover.revoked,
      cutover.uncertain,
    ])
      await importedHuman(id, user);
    await importedHuman(id, cutover.absentLink, "88100006");
    await db.orm.insert(t.guestGrants).values({
      guild_id: id,
      user_id: cutover.importedGuest,
      provenance: "imported_guest",
      source_key: `import:cutover:guest:${id}:${cutover.importedGuest}`,
    });
    await db.orm
      .insert(t.guestState)
      .values({ guild_id: id, user_id: cutover.revoked, revoked: true, reason: "Imported ban" });
    // The accepted post-import roster: the present link is observed, the other link is absent.
    await publishRoster(fcId, [rosterMember("88100001", fcId)]);
    // A link stored after that roster has no evidence yet, so its owner is uncertain.
    await linkCharacter(id, cutover.uncertain, "88100007");
    const views = [
      memberView(id, cutover.present, [member]),
      memberView(id, cutover.memberWithoutLink, [member]),
      memberView(id, cutover.roleless),
      memberView(id, cutover.importedGuest, [guest]),
      memberView(id, cutover.revoked),
      memberView(id, cutover.absentLink),
      memberView(id, cutover.uncertain, [member]),
      // Joined after the cutover snapshot: no guild_users row yet.
      memberView(id, cutover.newcomer, [], new Date("2026-09-20T00:00:00Z")),
      memberView(id, cutover.bot, [], new Date("2026-01-01T00:00:00Z"), true),
    ];
    for (const view of views) members.set(view.id, structuredClone(view));
    const enumeratedAt = new Date();
    cutoverEnumeratedAt = enumeratedAt;
    const plan = await planGrandfathering(db.orm, row, views, 21600, enumeratedAt);
    const planned = [
      cutover.memberWithoutLink,
      cutover.roleless,
      cutover.absentLink,
      cutover.uncertain,
      cutover.newcomer,
    ];
    expect(plan.grants).toEqual(planned);
    expect(grandfatherReport({ state: "pending", plan, completedAt: null })).toMatchObject({
      humans: 8,
      bots: 1,
      memberEligible: 1,
      planned: { count: 5 },
      plannedDetail: {
        // The uncertain holder keeps Member behind a dormant grant; only the unlinked one loses it.
        memberRoleRemoved: { count: 1, sample: [cutover.memberWithoutLink] },
        uncertainKeepsMember: { count: 1, sample: [cutover.uncertain] },
        registeredVisitors: { count: 2, sample: [cutover.absentLink, cutover.uncertain] },
        newSinceImport: { count: 1, sample: [cutover.newcomer] },
      },
      skipped: {
        existingGrant: { count: 1, sample: [cutover.importedGuest] },
        revoked: { count: 1, sample: [cutover.revoked] },
      },
    });
    const [revocation] = await db.orm
      .select()
      .from(t.guestState)
      .where(and(eq(t.guestState.guild_id, id), eq(t.guestState.user_id, cutover.revoked)));
    const result = await activateGuild(db, {
      guildId: id,
      freshnessSeconds: 21600,
      resourcesValidated: true,
      members: views,
      enumeratedAt,
      grandfatherPlan: plan.checksum,
    });
    expect(result).toMatchObject({
      status: "activated",
      requeued: false,
      revision: row.revision + 1n,
      grandfathering: { state: "completed", planChecksum: plan.checksum, granted: 5 },
      guestApplications: "closed",
      onboarding: false,
      roleLayout: "disabled",
    });
    const grants = await db.orm
      .select({
        user: t.guestGrants.user_id,
        key: t.guestGrants.source_key,
        actor: t.guestGrants.actor_id,
        source: t.guestGrants.source,
      })
      .from(t.guestGrants)
      .where(and(eq(t.guestGrants.guild_id, id), eq(t.guestGrants.provenance, "grandfathered")));
    expect(grants.map((grant) => grant.user).sort()).toEqual(planned);
    for (const grant of grants) {
      expect(grant.key).toBe(`grandfather:${id}:${grant.user}`);
      expect(grant.actor).toBeNull();
      expect(grant.source).toMatchObject({
        planChecksum: plan.checksum,
        enumeratedAt: enumeratedAt.toISOString(),
      });
    }
    expect(await auditsOf(id, "guest.grandfather")).toHaveLength(5);
    // The completion audit keeps enumeratedAt for the late-joiner report (C9).
    expect(await auditsOf(id, "guest.grandfather.completed")).toEqual([
      {
        target: id,
        details: expect.objectContaining({
          planChecksum: plan.checksum,
          granted: 5,
          enumeratedAt: enumeratedAt.toISOString(),
          counts: expect.objectContaining({ humans: 8, bots: 1, planned: 5, revoked: 1 }),
        }),
      },
    ]);
    expect(await auditsOf(id, "activation")).toEqual([
      {
        target: id,
        details: expect.objectContaining({
          grandfathering: { state: "completed", planChecksum: plan.checksum, granted: 5 },
        }),
      },
    ]);
    const [activated] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, id));
    expect(activated).toMatchObject({
      guest_grandfather: "completed",
      effects_enabled: true,
      active: true,
    });
    expect(activated?.guest_grandfathered_at).toBeInstanceOf(Date);
    expect(
      await db.orm
        .select({ status: t.jobs.status })
        .from(t.jobs)
        .where(and(eq(t.jobs.kind, "reconcile.guild"), eq(t.jobs.dedupe_key, `guild:${id}`))),
    ).toEqual([{ status: "queued" }]);
    // The revocation stands untouched, and the newcomer's guild row now exists.
    expect(
      (
        await db.orm
          .select()
          .from(t.guestState)
          .where(and(eq(t.guestState.guild_id, id), eq(t.guestState.user_id, cutover.revoked)))
      )[0],
    ).toEqual(revocation);
    expect(
      (
        await db.orm
          .select({ present: t.guildUsers.present, imported: t.guildUsers.imported })
          .from(t.guildUsers)
          .where(and(eq(t.guildUsers.guild_id, id), eq(t.guildUsers.user_id, cutover.newcomer)))
      )[0],
    ).toEqual({ present: true, imported: false });

    // A rerun on the live guild, even with a new joiner, is a no-op (amendment C11).
    const state = async () => ({
      revision: (await db.orm.select().from(t.guilds).where(eq(t.guilds.id, id)))[0]?.revision,
      audits: (
        await db.query<{ count: bigint }>("SELECT count(*) FROM audit WHERE guild_id=$1", [id])
      )[0]?.count,
      jobs: await db.query("SELECT id,status,generation FROM jobs WHERE guild_id=$1 ORDER BY id", [
        id,
      ]),
      grants: (
        await db.query<{ count: bigint }>("SELECT count(*) FROM guest_grants WHERE guild_id=$1", [
          id,
        ])
      )[0]?.count,
    });
    const settled = await state();
    const withJoiner = [...views, memberView(id, cutover.lateJoiner, [], new Date())];
    expect(
      await activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: false,
        members: withJoiner,
        enumeratedAt: new Date(),
        grandfatherPlan: plan.checksum,
      }),
    ).toMatchObject({
      status: "already_active",
      revision: row.revision + 1n,
      grandfathering: { state: "completed", granted: 0 },
    });
    expect(await state()).toEqual(settled);
    // An explicit requeue repeats only the activation writes; grandfathering never runs again.
    expect(
      await activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: withJoiner,
        enumeratedAt: new Date(),
        requeue: true,
      }),
    ).toMatchObject({
      status: "activated",
      requeued: true,
      revision: row.revision + 2n,
      grandfathering: { state: "completed", planChecksum: null, granted: 0 },
    });
    expect((await state()).grants).toBe(settled.grants);
    expect(await auditsOf(id, "guest.grandfather")).toHaveLength(5);
    expect(await auditsOf(id, "activation")).toHaveLength(2);
  });

  test("grandfathered grants behave like approved grants", async () => {
    const id = cutover.guild;
    if (!cutoverEnumeratedAt) throw new Error("Run the first-activation test first");
    const current = await service.guild({ ...actor, guildId: id });
    const member = current.member_role_id ?? "";
    const guest = current.guest_role_id ?? "";
    const roles = (user: string) => members.get(user)?.roles ?? [];
    for (const user of [
      cutover.present,
      cutover.memberWithoutLink,
      cutover.roleless,
      cutover.importedGuest,
      cutover.revoked,
      cutover.absentLink,
      cutover.uncertain,
      cutover.newcomer,
    ])
      await reconcileIn(id, user);
    expect(roles(cutover.present)).toEqual([member]);
    expect(roles(cutover.memberWithoutLink)).toEqual([guest]);
    expect(roles(cutover.roleless)).toEqual([guest]);
    expect(roles(cutover.importedGuest)).toEqual([guest]);
    expect(roles(cutover.revoked)).toEqual([]);
    expect(roles(cutover.absentLink)).toEqual([guest]);
    // Once the uncertain link is evaluated absent, the dormant grant replaces Member with Guest.
    expect(roles(cutover.uncertain)).toEqual([guest]);
    expect(roles(cutover.newcomer)).toEqual([guest]);
    const officer = { ...actor, guildId: id };
    // /guest status lists the new provenance.
    expect(await service.guestStatus(officer, cutover.memberWithoutLink)).toMatchObject({
      grants: [{ provenance: "grandfathered", reason: "Grandfathered Guest at first activation" }],
    });
    // Explicit revocation suppresses the grant through departure, rejoin and a new process.
    await service.guestAction(
      officer,
      cutover.roleless,
      true,
      "Grandfathered access withdrawn",
      randomUUID(),
    );
    await reconcileIn(id, cutover.roleless);
    expect(roles(cutover.roleless)).toEqual([]);
    const events = new GuildEvents(db);
    await events.memberLeft(id, cutover.roleless);
    await events.memberJoined(id, cutover.roleless, new Date("2026-01-01T00:00:00Z"));
    await reconcileIn(id, cutover.roleless);
    expect(roles(cutover.roleless)).toEqual([]);
    const restarted = new Synchronization(new Service(db, discord, nodestone, config));
    const work = await enqueue(
      db.pool,
      "reconcile.user",
      `user:${id}:${cutover.roleless}`,
      {},
      id,
      cutover.roleless,
    );
    await restarted.user(await leased(work), async () => {});
    expect(roles(cutover.roleless)).toEqual([]);
    // An explicit officer grant restores it with a manual grant and an audited restore.
    await service.guestAction(officer, cutover.roleless, false, "Welcome back", randomUUID());
    await reconcileIn(id, cutover.roleless);
    expect(roles(cutover.roleless)).toEqual([guest]);
    expect(await auditsOf(id, "guest.restore")).toHaveLength(1);
    // Positive roster evidence gives Member precedence over the grant.
    await publishRoster(cutover.fc, [
      rosterMember("88100001", cutover.fc),
      rosterMember("88100006", cutover.fc),
    ]);
    await reconcileIn(id, cutover.absentLink);
    expect(roles(cutover.absentLink)).toEqual([member]);
    // Someone joining after activation gets nothing automatically and is listed for officers.
    const late = memberView(id, cutover.lateJoiner, [], new Date());
    members.set(late.id, structuredClone(late));
    await events.memberJoined(id, late.id, late.joinedAt);
    await reconcileIn(id, late.id);
    expect(roles(late.id)).toEqual([]);
    // Two more late joiners the report leaves out: one registered, one already gone again.
    const registered = memberView(id, "97010", [], new Date());
    const departed = memberView(id, "97011", [], new Date());
    for (const view of [registered, departed]) {
      members.set(view.id, structuredClone(view));
      await events.memberJoined(id, view.id, view.joinedAt);
    }
    await linkCharacter(id, registered.id, "88100010");
    await events.memberLeft(id, departed.id);
    expect(await lateJoiners(db.orm, id)).toEqual({
      guildId: id,
      state: "completed",
      enumeratedAt: cutoverEnumeratedAt.toISOString(),
      count: 1,
      users: [{ userId: late.id, joinedAt: late.joinedAt }],
    });
    await service.guestAction(officer, late.id, false, "Late joiner welcomed", randomUUID());
    expect(await lateJoiners(db.orm, id)).toMatchObject({ count: 0, users: [] });
    // A guild that was never grandfathered has nothing to report.
    expect(await lateJoiners(db.orm, guild)).toMatchObject({ state: "pending", count: 0 });
  });

  test("grandfathering fails closed and rolls activation back", async () => {
    const id = "666666666666666701";
    const fcId = "9232097761132950011";
    const row = await importedGuild(id, fcId);
    const user = "97101";
    await importedHuman(id, user);
    await publishRoster(fcId, []);
    const views = [memberView(id, user)];
    const reviewed = await planGrandfathering(db.orm, row, views, 21600, new Date());
    const activate = (input: Partial<Parameters<typeof activateGuild>[1]>) =>
      activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: views,
        enumeratedAt: new Date(),
        grandfatherPlan: reviewed.checksum,
        ...input,
      });
    // No complete enumeration, or no Discord validation, while grandfathering is pending.
    await expect(activate({ members: null, enumeratedAt: null })).rejects.toMatchObject({
      code: "incomplete",
    });
    await expect(activate({ resourcesValidated: false })).rejects.toMatchObject({
      code: "conflict",
    });
    await expectNotActivated(id);
    // A missing checksum returns the full report and the checksum to confirm.
    const missing = await activate({ grandfatherPlan: undefined }).catch((error) => error);
    expect(missing).toBeInstanceOf(GrandfatherPlanMismatch);
    expect(missing).toMatchObject({
      checksum: reviewed.checksum,
      difference: null,
      report: { state: "pending", planned: { count: 1, sample: [user] } },
    });
    await expectNotActivated(id);
    // Against the reviewed plan file, a new joiner shows up as the only addition (C8).
    const file = reviewedPlan(JSON.parse(json(reviewed, 2)), reviewed.checksum);
    const joined = await activate({
      members: [...views, memberView(id, "97102", [], new Date())],
      reviewedPlan: file,
    }).catch((error) => error);
    expect(joined).toBeInstanceOf(GrandfatherPlanMismatch);
    expect(joined.difference).toEqual({
      added: ["97102"],
      removed: [],
      guildChanged: false,
      importChanged: false,
      rosterSnapshotChanged: false,
    });
    await expectNotActivated(id);
    // Any newer accepted roster changes the checksum even when the planned users do not.
    await publishRoster(fcId, []);
    const acquired = await activate({ reviewedPlan: file }).catch((error) => error);
    expect(acquired).toBeInstanceOf(GrandfatherPlanMismatch);
    expect(acquired.difference).toMatchObject({
      added: [],
      removed: [],
      rosterSnapshotChanged: true,
    });
    expect(acquired.checksum).not.toBe(reviewed.checksum);
    await expectNotActivated(id);
    const confirmed = (await planGrandfathering(db.orm, row, views, 21600, new Date())).checksum;
    // A roster that is not newer than the import is refused.
    await db.orm
      .update(t.auditEvents)
      .set({ event_at: sql`now()+interval '1 minute'` })
      .where(and(eq(t.auditEvents.guild_id, id), eq(t.auditEvents.action, "migration.import")));
    await expect(activate({ grandfatherPlan: confirmed })).rejects.toMatchObject({ code: "stale" });
    await db.orm
      .update(t.auditEvents)
      .set({ event_at: sql`now()-interval '1 hour'` })
      .where(and(eq(t.auditEvents.guild_id, id), eq(t.auditEvents.action, "migration.import")));
    // So is a roster older than the freshness window.
    await db.orm
      .update(t.freeCompanies)
      .set({ last_successful_roster_at: sql`now()-interval '7 hours'` })
      .where(eq(t.freeCompanies.id, fcId));
    await expect(activate({ grandfatherPlan: confirmed })).rejects.toMatchObject({ code: "stale" });
    await expectNotActivated(id);
    // A guild that was never imported activates without grandfathering.
    const plain = "666666666666666702";
    await db.orm.insert(t.guilds).values({ id: plain, guest_role_id: "82102" });
    expect(
      await activateGuild(db, {
        guildId: plain,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: null,
        enumeratedAt: null,
      }),
    ).toMatchObject({
      status: "activated",
      grandfathering: { state: "not_applicable", planChecksum: null, granted: 0 },
    });
    expect(await auditsOf(plain, "guest.grandfather.completed")).toEqual([]);
  });

  test("first activation never opens guest applications implicitly", async () => {
    const legacyChannel = "82201";
    const setup = async (id: string, fcId: string) => {
      const row = await importedGuild(id, fcId, legacyChannel);
      await publishRoster(fcId, []);
      const plan = await planGrandfathering(db.orm, row, [], 21600, new Date());
      return { row, plan };
    };
    const activate = (id: string, checksum: string, choice?: "open" | "closed") =>
      activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: [],
        enumeratedAt: new Date(),
        grandfatherPlan: checksum,
        guestApplications: choice,
      });
    // A 2.12.x import still carries its review channel: activation needs an explicit choice.
    const kept = await setup("666666666666666703", "9232097761132950012");
    await expect(activate(kept.row.id, kept.plan.checksum)).rejects.toMatchObject({
      code: "conflict",
    });
    await expectNotActivated(kept.row.id);
    expect(await activate(kept.row.id, kept.plan.checksum, "open")).toMatchObject({
      status: "activated",
      guestApplications: "open",
    });
    expect(
      (await db.orm.select().from(t.guilds).where(eq(t.guilds.id, kept.row.id)))[0]
        ?.guest_application_channel_id,
    ).toBe(legacyChannel);
    expect(await auditsOf(kept.row.id, "config")).toEqual([]);
    const closed = await setup("666666666666666704", "9232097761132950013");
    expect(await activate(closed.row.id, closed.plan.checksum, "closed")).toMatchObject({
      status: "activated",
      guestApplications: "closed",
      revision: closed.row.revision + 1n,
    });
    expect(
      (await db.orm.select().from(t.guilds).where(eq(t.guilds.id, closed.row.id)))[0]
        ?.guest_application_channel_id,
    ).toBeNull();
    expect(await auditsOf(closed.row.id, "config")).toEqual([
      {
        target: "guest_application_channel_id",
        details: { value: null, source: "activation" },
      },
    ]);
    // A guild imported closed (2.13.0) needs no flag; the first scenario above activates one.
  });

  test("pending departures block grandfathering until a confirming roster settles them", async () => {
    const id = "666666666666666705";
    const fcId = "9232097761132950014";
    const row = await importedGuild(id, fcId);
    const [departing, staying] = ["97201", "97202"];
    // Imported Member holders keep a 'present' baseline for their legacy FC character.
    for (const [user, character] of [
      [departing, "88100201"],
      [staying, "88100202"],
    ] as const) {
      const link = await importedHuman(id, user, character);
      if (!link) throw new Error("Missing imported link");
      await db.orm
        .insert(t.membershipHistory)
        .values({ guild_id: id, user_id: user, fc_id: fcId, link_id: link });
      await db.orm
        .insert(t.membership)
        .values({ guild_id: id, fc_id: fcId, character_id: character, state: "present" });
    }
    const views = [
      memberView(id, departing, [row.member_role_id ?? ""]),
      memberView(id, staying, [row.member_role_id ?? ""]),
    ];
    const first = new Date();
    await publishRoster(fcId, [rosterMember("88100202", fcId)], first);
    // One absence only marks the departing character missing; it still counts as membership.
    expect(await pendingDepartures(db.orm, row)).toEqual({ count: 1, sample: [departing] });
    await expect(planGrandfathering(db.orm, row, views, 21600, new Date())).rejects.toMatchObject({
      code: "stale",
    });
    await expect(
      activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: views,
        enumeratedAt: new Date(),
        grandfatherPlan: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "stale" });
    await expectNotActivated(id);
    // The confirming acquisition at least 60 s later settles the departure.
    await publishRoster(fcId, [rosterMember("88100202", fcId)], new Date(first.getTime() + 61_000));
    expect(await pendingDepartures(db.orm, row)).toEqual({ count: 0, sample: [] });
    const enumeratedAt = new Date();
    const plan = await planGrandfathering(db.orm, row, views, 21600, enumeratedAt);
    expect(plan.grants).toEqual([departing]);
    expect(plan.candidates).toEqual([
      expect.objectContaining({
        userId: departing,
        basis: "grant",
        former: true,
        heldMember: true,
        projected: { member: false, guest: true },
      }),
      expect.objectContaining({ userId: staying, basis: "member" }),
    ]);
    expect(
      await activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: views,
        enumeratedAt,
        grandfatherPlan: plan.checksum,
      }),
    ).toMatchObject({ status: "activated", grandfathering: { state: "completed", granted: 1 } });
    expect(
      await db.orm
        .select({ user: t.guestGrants.user_id })
        .from(t.guestGrants)
        .where(and(eq(t.guestGrants.guild_id, id), eq(t.guestGrants.provenance, "grandfathered"))),
    ).toEqual([{ user: departing }]);
  });

  test("an imported guild with no linked FC gets a reviewable plan that activation accepts", async () => {
    // The importer accepts a guild without an FC and marks it pending. Preview and activation gate
    // on the same freshness predicate, which has no roster to wait for here, so preview can still
    // produce the plan and checksum that activation confirms (MIG-14).
    const id = "666666666666666706";
    await db.orm.insert(t.guilds).values({
      id,
      fc_id: null,
      member_role_id: "82301",
      guest_role_id: "82302",
      role_layout_enabled: false,
      guest_grandfather: "pending",
      effects_enabled: false,
    });
    await db.orm.insert(t.auditEvents).values({
      guild_id: id,
      action: "migration.import",
      target: `fingerprint:${id}`,
      details: { guestGrandfather: "pending" },
      event_at: sql`now()-interval '1 hour'`,
    });
    const [row] = await db.orm.select().from(t.guilds).where(eq(t.guilds.id, id));
    if (!row) throw new Error("Missing no-FC guild fixture");
    const user = "97301";
    await importedHuman(id, user);
    const views = [memberView(id, user, [row.member_role_id ?? ""])];
    // The preview's gate (scripts/preview.ts) and the departure check both pass without an FC.
    await assertFreshRoster(db.orm, row, 21600);
    expect(await pendingDepartures(db.orm, row)).toEqual({ count: 0, sample: [] });
    const enumeratedAt = new Date();
    // Read-only on the pool, exactly as preview plans it.
    const plan = await planGrandfathering(db.orm, row, views, 21600, enumeratedAt);
    expect(plan).toMatchObject({
      guildId: id,
      importFingerprint: `fingerprint:${id}`,
      rosterSnapshotId: null,
      grants: [user],
    });
    await expectNotActivated(id);
    // The reviewed plan file and its checksum are what activation confirms.
    const file = reviewedPlan(JSON.parse(json(plan, 2)), plan.checksum);
    expect(
      await activateGuild(db, {
        guildId: id,
        freshnessSeconds: 21600,
        resourcesValidated: true,
        members: views,
        enumeratedAt,
        grandfatherPlan: plan.checksum,
        reviewedPlan: file,
      }),
    ).toMatchObject({
      status: "activated",
      grandfathering: { state: "completed", planChecksum: plan.checksum, granted: 1 },
    });
    expect(
      await db.orm
        .select({ user: t.guestGrants.user_id })
        .from(t.guestGrants)
        .where(and(eq(t.guestGrants.guild_id, id), eq(t.guestGrants.provenance, "grandfathered"))),
    ).toEqual([{ user }]);
  });

  test("Drizzle mappings agree with every migrated application column", async () => {
    // The SQL migrations are an independent authority: catch missing/default/null/type mapping drift.
    const columns = await db.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      domain_name: string | null;
      is_nullable: string;
      column_default: string | null;
      is_identity: string;
    }>(
      "SELECT table_name,column_name,data_type,domain_name,is_nullable,column_default,is_identity FROM information_schema.columns WHERE table_schema='public' AND table_name<>'schema_migrations'",
    );
    const mappings = Object.values(t).map((table) => getTableConfig(table));
    expect([...new Set(columns.map((column) => column.table_name))].sort()).toEqual(
      mappings.map((table) => table.name).sort(),
    );
    for (const table of mappings) {
      const actual = columns.filter((column) => column.table_name === table.name);
      expect(actual.map((column) => column.column_name).sort()).toEqual(
        table.columns.map((column) => column.name).sort(),
      );
      for (const column of table.columns) {
        const row = actual.find((row) => row.column_name === column.name);
        if (!row) throw new Error(`Missing migrated column ${table.name}.${column.name}`);
        expect({
          table: table.name,
          column: column.name,
          type: column.getSQLType(),
          notNull: column.notNull,
          hasDefault: column.hasDefault,
        }).toEqual({
          table: table.name,
          column: row.column_name,
          type: row.domain_name ?? row.data_type,
          notNull: row.is_nullable === "NO",
          hasDefault: row.column_default !== null || row.is_identity === "YES",
        });
      }
    }
  });

  test("ORM values remain exact and policy, audit and outbox share rollback visibility", async () => {
    // Exercise the actual node-postgres codecs, including JSON strings that are not serialized JSON.
    const external = "18446744073709551615";
    const maximum = 9223372036854775807n;
    const sequence = 9007199254740993n;
    const instant = new Date("2026-09-22T01:45:12.123-05:00");
    const rollback = new Error("Intentional ORM visibility rollback");
    const key = `orm:rollback:${randomUUID()}`;
    await expect(
      db.transaction(async (client) => {
        const store = orm(client);
        expect(orm(client)).toBe(store);
        expect(store).not.toBe(db.orm);
        await store
          .insert(t.freeCompanies)
          .values({ id: external, name: "Exact FC", world: "Diabolos", profile_at: instant });
        await store.insert(t.guilds).values({ id: external, fc_id: external, created_at: instant });
        await ensureUser(client, external, external, instant);
        const [account] = await store
          .insert(t.ledgerAccounts)
          .values({ guild_id: external, fc_id: external, balance: maximum, sequence })
          .returning();
        expect(account).toMatchObject({
          guild_id: external,
          fc_id: external,
          balance: maximum,
          sequence,
        });
        if (!account) throw new Error("Missing exact account");
        const [entry] = await store
          .insert(t.ledgerEntries)
          .values({
            account_id: account.id,
            guild_id: external,
            sequence,
            operation: "import",
            delta: maximum,
            balance: maximum,
            note: "Exact ORM boundary",
            idempotency_key: key,
            event_at: instant,
          })
          .returning();
        expect(entry).toMatchObject({
          delta: maximum,
          balance: maximum,
          sequence,
          event_at: instant,
        });
        const [present] = await store
          .select()
          .from(t.guildUsers)
          .where(and(eq(t.guildUsers.guild_id, external), eq(t.guildUsers.user_id, external)));
        expect(present).toMatchObject({
          user_id: external,
          present: true,
          joined_at: instant,
          nickname_before: null,
        });

        for (const value of [
          "plain text",
          "00123",
          "null",
          7,
          true,
          false,
          null,
          { amount: maximum, nested: ["零", null] },
        ]) {
          await audit(client, external, external, "orm.codec", null, value);
          const queued = await enqueue(
            client,
            "probe",
            `${key}:${randomUUID()}`,
            value,
            external,
            external,
          );
          const [job] = await store
            .select({ payload: t.jobs.payload })
            .from(t.jobs)
            .where(eq(t.jobs.id, queued));
          expect(job?.payload).toEqual(
            typeof value === "object" && value !== null
              ? { amount: maximum.toString(), nested: ["零", null] }
              : value,
          );
        }
        const entries = await store
          .select({ details: t.auditEvents.details })
          .from(t.auditEvents)
          .where(eq(t.auditEvents.guild_id, external))
          .orderBy(t.auditEvents.id);
        expect(entries.map((entry) => entry.details)).toEqual([
          "plain text",
          "00123",
          "null",
          7,
          true,
          false,
          null,
          { amount: maximum.toString(), nested: ["零", null] },
        ]);
        // Raw SQL independently confirms JSON null was not turned into SQL NULL, and UTC is intact.
        const raw = (
          await client.query<{ json_null: boolean; utc: string }>(
            "SELECT EXISTS(SELECT 1 FROM audit WHERE guild_id=$1 AND details='null'::jsonb AND details IS NOT NULL) AS json_null,(SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS') FROM guilds WHERE id=$1) AS utc",
            [external],
          )
        ).rows[0];
        expect(raw).toEqual({ json_null: true, utc: "2026-09-22T06:45:12.123" });
        expect(
          await db.orm.select({ id: t.guilds.id }).from(t.guilds).where(eq(t.guilds.id, external)),
        ).toEqual([]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await db.query("SELECT id FROM guilds WHERE id=$1", [external])).toEqual([]);
    expect(await db.query("SELECT id FROM audit WHERE guild_id=$1", [external])).toEqual([]);
    expect(await db.query("SELECT id FROM jobs WHERE guild_id=$1", [external])).toEqual([]);
    expect(await db.query("SELECT id FROM ledger_entries WHERE idempotency_key=$1", [key])).toEqual(
      [],
    );
  });

  test("ORM capability aggregates include empty scopes and count shared FCs only once", async () => {
    const rollback = new Error("Intentional metrics rollback");
    await expect(
      db.transaction(async (client) => {
        const store = orm(client);
        // Hide existing work/FCs inside this transaction; the rest of the suite keeps its state.
        await store.update(t.guilds).set({ active: false });
        await store.update(t.jobs).set({ status: "disabled" });
        expect(await capabilityMetrics(store)).toEqual({
          pending: 0,
          blocked: 0,
          oldest_roster_age_seconds: null,
          degraded_fcs: 0,
        });
        const company = "18446744073709551614";
        await store.insert(t.freeCompanies).values({
          id: company,
          name: "Metrics FC",
          world: "Diabolos",
          last_error: "upstream",
          last_successful_roster_at: sql`now()-interval '90 seconds'`,
        });
        await store.insert(t.guilds).values([
          { id: company, fc_id: company },
          { id: "18446744073709551613", fc_id: company },
        ]);
        for (const status of ["queued", "running", "blocked", "failed", "succeeded", "disabled"])
          await store
            .insert(t.jobs)
            .values({ kind: "probe", dedupe_key: `metrics:${status}`, payload: {}, status });
        expect(await capabilityMetrics(store)).toEqual({
          pending: 2,
          blocked: 2,
          oldest_roster_age_seconds: 90,
          degraded_fcs: 1,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  test("ORM queue claims skip held locks and superseding generations cannot publish stale results", async () => {
    // Isolate candidates from other scenarios, then hold the oldest row on a separate session.
    await db.orm.update(t.jobs).set({ status: "disabled" });
    const first = await enqueue(db.pool, "reconcile.user", "orm:claim:first", { revision: 1 });
    const second = await enqueue(db.pool, "probe", "orm:claim:second", {});
    const third = await enqueue(db.pool, "probe", "orm:claim:third", {});
    let supersede = true;
    const events: QueueEvent[] = [];
    const queue = new Queue(
      db,
      async (job, guard) => {
        await guard();
        if (job.id === first && supersede) {
          supersede = false;
          expect(await enqueue(db.pool, job.kind, "orm:claim:first", { revision: 2 })).toBe(first);
        }
        await guard();
        return { generation: job.generation };
      },
      (event) => {
        events.push(event);
      },
    );
    const lock = await db.pool.connect();
    try {
      await lock.query("BEGIN");
      await orm(lock)
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .where(eq(t.jobs.id, first))
        .for("update");
      const claimed = await Promise.all([queue.claim(), queue.claim()]);
      expect(claimed.map((job) => job?.id).sort()).toEqual([second, third].sort());
      expect(new Set(claimed.map((job) => job?.lease_token)).size).toBe(2);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    const old = await queue.claim();
    if (!old || old.id !== first) throw new Error("Missing unlocked candidate");
    await queue.perform(old);
    const [superseded] = await db.orm.select().from(t.jobs).where(eq(t.jobs.id, first));
    expect(superseded).toMatchObject({
      status: "queued",
      generation: 2,
      result: null,
      payload: { revision: 2 },
    });
    // The guard names the changed generation rather than a lease expiry, and waits log at debug.
    expect(superseded?.last_error).toStartWith(
      "superseded: Reconciliation inputs changed (generation 1→2)",
    );
    const waited = events.find((event) => event.type === "job" && event.job === old);
    expect(waited?.type === "job" ? waited.outcome : undefined).toMatchObject({
      code: "superseded",
      status: "queued",
      level: "debug",
    });
    expect(await queue.claim()).toBeUndefined();
    // Advance the persisted due time instead of sleeping through the normal retry backoff, and
    // seed an earlier pass's evidence: only `applied` may carry into the new result, never stale keys.
    await db.orm
      .update(t.jobs)
      .set({ due_at: sql`now()`, result: { skipped: "stale", applied: [{ generation: 1 }] } })
      .where(eq(t.jobs.id, first));
    const current = await queue.claim();
    if (!current || current.id !== first) throw new Error("Missing superseding candidate");
    await queue.perform(current);
    const [done] = await db.orm.select().from(t.jobs).where(eq(t.jobs.id, first));
    expect(done?.status).toBe("succeeded");
    // Exact equality: this attempt's keys plus the carried `applied` list, with `skipped` dropped.
    expect(done?.result).toEqual({ generation: 2, applied: [{ generation: 1 }] });
    await db.orm.delete(t.jobs).where(inArray(t.jobs.id, [first, second, third]));
  });

  test("superseded reconciliation retains the applied Guest delta", async () => {
    // Discord echoes the bot's own role write as a member update, superseding the running pass.
    const fixture = await accessFixture("666666666666666681");
    const user = "94004";
    const guestRole = fixture.guild.guest_role_id ?? "";
    await service.assign(
      fixture.manager,
      user,
      { id: "77777203", name: "Echoed Guest", world: "Diabolos", dc: "Crystal", fcId: null },
      "Gateway echo fixture",
    );
    let echoed = false;
    const echoPort: DiscordPort = {
      ...discord,
      async roles(guildId, userId, add, remove) {
        await discord.roles(guildId, userId, add, remove);
        if (echoed) return;
        echoed = true;
        await reconcileUser(db.pool, guildId, userId);
      },
    };
    const app = new Service(db, echoPort, nodestone, config);
    const events: QueueEvent[] = [];
    const queue = new Queue(
      db,
      dispatcher(app, new Synchronization(app), new GuildAccess(app, accessPort)),
      (event) => {
        events.push(event);
      },
    );
    const key = await reconcileUser(db.pool, fixture.guild.id, user);
    const read = async () => (await db.orm.select().from(t.jobs).where(eq(t.jobs.id, key)))[0];
    await queue.perform(await leased(key));
    const superseded = await read();
    expect(superseded?.status).toBe("queued");
    expect(superseded?.last_error).toStartWith("superseded: Reconciliation inputs changed");
    expect(members.get(user)?.roles).toContain(guestRole);
    // The follow-up pass finds nothing left to change but keeps the delta Discord already received.
    await queue.perform(await leased(key));
    const completed = await read();
    expect(completed?.status).toBe("succeeded");
    const result = z
      .object({
        add: z.array(z.string()),
        remove: z.array(z.string()),
        applied: z.array(
          z.object({
            generation: z.number(),
            at: z.iso.datetime(),
            add: z.array(z.string()),
            remove: z.array(z.string()),
            status: z.string(),
          }),
        ),
      })
      .parse(completed?.result);
    expect(result.add).toEqual([]);
    expect(result.remove).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.add).toContain(guestRole);
    expect(result.applied[0]?.status).toBe("applied");
    expect(
      events.flatMap((event) =>
        event.type === "job" ? [[event.outcome.code, event.outcome.level]] : [],
      ),
    ).toEqual([["superseded", "debug"]]);
    // A long-lived job keeps only the newest 20 deltas: seed a full history, then append one.
    const other = "94005";
    await service.assign(
      fixture.manager,
      other,
      { id: "77777204", name: "Bounded History", world: "Diabolos", dc: "Crystal", fcId: null },
      "Bounded history fixture",
    );
    const bounded = await reconcileUser(db.pool, fixture.guild.id, other);
    const seeded = Array.from({ length: 20 }, (_, index) => ({
      generation: 0,
      at: new Date(0).toISOString(),
      add: [],
      remove: [String(index)],
      status: "applied",
    }));
    await db.orm
      .update(t.jobs)
      .set({ result: { applied: seeded } })
      .where(eq(t.jobs.id, bounded));
    await queue.perform(await leased(bounded));
    const history = z
      .object({
        applied: z.array(z.object({ add: z.array(z.string()), remove: z.array(z.string()) })),
      })
      .parse((await db.orm.select().from(t.jobs).where(eq(t.jobs.id, bounded)))[0]?.result);
    expect(history.applied).toHaveLength(20);
    expect(history.applied[0]?.remove).toEqual(["1"]);
    expect(history.applied[19]?.add).toContain(guestRole);
  });

  test("modal answers survive restart, duplicate submission and officer approval without granting early access", async () => {
    const fixture = await accessFixture("96000");
    const interactions = interactionFixture();
    interactions.member.guildId = fixture.guild.id;
    interactions.member.userId = "96001";
    const applicant = { ...fixture.manager, userId: "96001", officer: false, serverManager: false };
    const input = await applicationInput(applicant);
    let review: ApplicationRecord | undefined;
    const reviewPort: DiscordPort = {
      ...discord,
      async editReview(application) {
        review = application;
        return "123456789";
      },
    };
    const app = new Service(db, reviewPort, nodestone, config);
    const synchronization = new Synchronization(app);
    const services = new Services();
    services.provide(applicationKey, app);
    const router = new InteractionRouter(
      {
        client: interactions.client,
        services,
        allowsGuild: (id) => id === fixture.guild.id,
        publicResponseGuildId: fixture.guild.id,
        isStopping: () => false,
        report: () => {},
        resolveActor: async (_guild, user) =>
          user === fixture.manager.userId ? fixture.manager : applicant,
      },
      new Map([[applyCommand.name, applyCommand]]),
      new Map([
        [applyComponent.prefix, applyComponent],
        [reviewComponent.prefix, reviewComponent],
      ]),
    );
    try {
      const modalId = guestApplicationModal(interactions.slash()).toJSON().custom_id;
      // The router/service are new instances; no in-memory form session is needed after restart.
      await router.handle(interactions.submit(modalId, input));
      // The receipt is the pending 'Application sent' card; it never echoes the answers.
      expect(interactions.requests.at(-1)?.body).toMatchObject({
        content: "",
        embeds: [
          {
            title: "Application sent",
            description: expect.stringContaining("awaiting officer review"),
          },
        ],
      });
      const pending = await db.orm
        .select()
        .from(t.guestApplications)
        .where(eq(t.guestApplications.user_id, applicant.userId));
      const application = pending[0];
      if (!application) throw new Error("Missing submitted application");
      expect(pending).toHaveLength(1);
      expect(application).toMatchObject({
        introduction: input.introduction,
        interest: input.interest,
        state: "pending",
        channel_id: fixture.guild.officer_channel_id,
      });
      await router.handle(
        interactions.submit(modalId, {
          ...input,
          introduction: "Changed answers must not replace a review.",
        }),
      );
      expect(
        await db.orm
          .select()
          .from(t.guestApplications)
          .where(eq(t.guestApplications.user_id, applicant.userId)),
      ).toEqual(pending);
      expect(
        await db.query("SELECT id FROM guest_grants WHERE guild_id=$1 AND user_id=$2", [
          fixture.guild.id,
          applicant.userId,
        ]),
      ).toHaveLength(0);
      expect(
        await db.query("SELECT id FROM audit WHERE action='guest.applied' AND target=$1", [
          application.id,
        ]),
      ).toHaveLength(1);
      expect(JSON.stringify(await app.guestStatus(applicant, applicant.userId))).not.toContain(
        input.introduction,
      );
      expect(JSON.stringify(interactions.requests)).not.toContain(input.introduction);
      const [job] = await db.orm
        .select()
        .from(t.jobs)
        .where(eq(t.jobs.dedupe_key, `review:${application.id}`));
      if (!job) throw new Error("Missing durable review work");
      const deliver = dispatcher(app, synchronization, fixture.policy);
      await deliver(await leased(job.id), async () => {});
      expect(review).toMatchObject({ introduction: input.introduction, interest: input.interest });
      // A visitor cannot approve their own application; the officer's fresh actor can.
      const refused = interactions.button(`guest:approve:${application.id}`);
      await router.handle(refused);
      expect(interactions.requests.at(-1)?.body).toMatchObject({
        embeds: [
          {
            title: "Officers only",
            description: "Only officers can decide guest access. Nothing was changed.",
            footer: { text: `Code forbidden · Ref ${refused.id}` },
          },
        ],
      });
      interactions.member.userId = fixture.manager.userId;
      await router.handle(interactions.button(`guest:approve:${application.id}`));
      await router.handle(interactions.button(`guest:approve:${application.id}`));
      expect(
        await db.query("SELECT id FROM guest_grants WHERE guild_id=$1 AND user_id=$2", [
          fixture.guild.id,
          applicant.userId,
        ]),
      ).toHaveLength(1);
      const [repair] = await db.orm
        .select()
        .from(t.jobs)
        .where(eq(t.jobs.dedupe_key, `user:${fixture.guild.id}:${applicant.userId}`));
      if (!repair) throw new Error("Missing access reconciliation");
      await synchronization.user(await leased(repair.id), async () => {});
      expect(members.get(applicant.userId)?.roles).toContain(fixture.guild.guest_role_id ?? "");
      await deliver(await leased(job.id), async () => {});
      expect(review).toMatchObject({
        state: "approved",
        introduction: input.introduction,
        interest: input.interest,
      });
      // The decision DM carries the stored application and the configured reapply cooldown.
      const [dm] = await db.orm
        .select()
        .from(t.jobs)
        .where(eq(t.jobs.dedupe_key, `dm:${application.id}`));
      if (!dm) throw new Error("Missing decision DM work");
      await deliver(await leased(dm.id), async () => {});
      expect(dms.at(-1)).toMatchObject({
        user: applicant.userId,
        message: {
          kind: "decision",
          application: { id: application.id, state: "approved" },
          cooldownSeconds: config.GUEST_COOLDOWN_SECONDS,
        },
      });
      expect(JSON.stringify(interactions.requests)).not.toContain(input.introduction);
    } finally {
      await interactions.close();
    }
  });

  test("invalid answers and raced departure/newer presence cannot publish stale applications", async () => {
    const fixture = await accessFixture("96010");
    const applicant = { ...fixture.manager, userId: "96011", officer: false, serverManager: false };
    const input = await applicationInput(applicant);
    for (const introduction of ["  ", "x".repeat(301), "invalid text\0", "broken text\ud800"]) {
      await expect(service.apply(applicant, { ...input, introduction })).rejects.toMatchObject({
        code: "input",
      });
    }
    const events = new GuildEvents(db);
    await events.memberJoined(fixture.guild.id, applicant.userId, input.joinedAt);
    for (const newer of [false, true]) {
      const app = new Service(
        db,
        {
          ...discord,
          async member(guildId, userId) {
            const observed = await discord.member(guildId, userId);
            if (newer)
              await events.memberJoined(guildId, userId, new Date(input.joinedAt.getTime() + 1000));
            else await events.memberLeft(guildId, userId);
            return observed;
          },
        },
        nodestone,
        config,
      );
      await expect(app.apply(applicant, input)).rejects.toMatchObject({ code: "stale" });
    }
    expect(
      await db.query("SELECT id FROM guest_applications WHERE guild_id=$1", [fixture.guild.id]),
    ).toHaveLength(0);
    expect(
      await db.query("SELECT joined_at,present FROM guild_users WHERE guild_id=$1 AND user_id=$2", [
        fixture.guild.id,
        applicant.userId,
      ]),
    ).toEqual([{ joined_at: new Date(input.joinedAt.getTime() + 1000), present: true }]);
  });

  test("denial cooldown, database answer constraints and legacy form-less reviews remain durable", async () => {
    const fixture = await accessFixture("96020");
    const applicant = { ...fixture.manager, userId: "96021", officer: false, serverManager: false };
    const input = await applicationInput(applicant);
    const application = await service.apply(applicant, input);
    // Another guild's application is simply not found here.
    await expect(
      service.decide({ ...fixture.manager, guildId: guild }, application.id, true),
    ).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "application", id: application.id },
    });
    await service.decide(
      fixture.manager,
      application.id,
      false,
      "Please ask an officer before reapplying.",
    );
    const restarted = new Service(db, discord, nodestone, config);
    await expect(restarted.apply(applicant, input)).rejects.toMatchObject({ code: "cooldown" });
    await db.query("UPDATE guest_applications SET decided_at=now()-interval '2 days' WHERE id=$1", [
      application.id,
    ]);
    const again = await restarted.apply(applicant, input);
    expect(again.id).not.toBe(application.id);
    await expect(
      db.query("UPDATE guest_applications SET introduction=NULL WHERE id=$1", [again.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("UPDATE guest_applications SET interest='short' WHERE id=$1", [again.id]),
    ).rejects.toMatchObject({ code: "23514" });
    // Nullable paired answers preserve old pending rows during the additive migration.
    await db.query("UPDATE guest_applications SET introduction=NULL,interest=NULL WHERE id=$1", [
      again.id,
    ]);
    expect(await restarted.decide(fixture.manager, again.id, true)).toMatchObject({
      status: "approved",
    });
  });

  test("verification supersedes form approval and remains automatic unless explicitly revoked", async () => {
    const fixture = await accessFixture("96030");
    const applicant = { ...fixture.manager, userId: "96031", officer: false, serverManager: false };
    const input = await applicationInput(applicant);
    const pending = await service.apply(applicant, input);
    await service.assign(
      fixture.manager,
      applicant.userId,
      { id: "777796031", name: "Registered Visitor", world: "Diabolos", dc: "Crystal", fcId: null },
      "Verified visitor fixture",
    );
    await expect(service.apply(applicant, input)).rejects.toMatchObject({ code: "eligible" });
    expect(await service.decide(fixture.manager, pending.id, true)).toMatchObject({
      status: "superseded",
    });
    expect(
      await db.query("SELECT id FROM guest_grants WHERE guild_id=$1 AND user_id=$2", [
        fixture.guild.id,
        applicant.userId,
      ]),
    ).toHaveLength(0);
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, applicant.userId)).toBe(
      true,
    );
    await service.guestAction(
      fixture.manager,
      applicant.userId,
      true,
      "Explicit visitor revocation",
      randomUUID(),
    );
    await expect(service.apply(applicant, input)).rejects.toMatchObject({ code: "eligible" });
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, applicant.userId)).toBe(
      false,
    );
  });

  test("form answers, submission audit and outbox roll back together on publication failure", async () => {
    const fixture = await accessFixture("96040");
    const applicant = { ...fixture.manager, userId: "96041", officer: false, serverManager: false };
    await db.query(
      "CREATE FUNCTION reject_test_guest_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='guest.review' AND NEW.guild_id='96040' THEN RAISE EXCEPTION 'injected review publication failure'; END IF; RETURN NEW; END $$",
    );
    await db.query(
      "CREATE TRIGGER reject_test_guest_review BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_test_guest_review()",
    );
    try {
      await expect(
        service.apply(applicant, await applicationInput(applicant)),
      ).rejects.toMatchObject({ cause: { code: "P0001" } });
      expect(
        await db.query("SELECT id FROM guest_applications WHERE guild_id=$1", [fixture.guild.id]),
      ).toHaveLength(0);
      expect(
        await db.query("SELECT id FROM audit WHERE guild_id=$1 AND action='guest.applied'", [
          fixture.guild.id,
        ]),
      ).toHaveLength(0);
      expect(
        await db.query("SELECT id FROM jobs WHERE guild_id=$1 AND kind='guest.review'", [
          fixture.guild.id,
        ]),
      ).toHaveLength(0);
    } finally {
      await db.query("DROP TRIGGER reject_test_guest_review ON jobs");
      await db.query("DROP FUNCTION reject_test_guest_review()");
    }
  });

  /**
   * A configured guild of its own for the 2.14.0 display-data scenarios: a linked FC with a stored
   * identity and a fresh roster read, four roles, ledger and review channels, and Discord effects
   * on unless a scenario holds them.
   */
  async function displayGuild(guildId: string, fcId: string, effects = true): Promise<Actor> {
    await db.orm
      .insert(t.freeCompanies)
      .values({
        id: fcId,
        name: "Display Company",
        tag: "DISP",
        world: "Diabolos",
        last_successful_roster_at: new Date(),
      })
      .onConflictDoNothing();
    await db.orm.insert(t.guilds).values({
      id: guildId,
      fc_id: fcId,
      effects_enabled: effects,
      member_role_id: "98101",
      guest_role_id: "98102",
      officer_role_id: "98103",
      leader_role_id: "98104",
      ledger_channel_id: "98201",
      guest_application_channel_id: "98202",
    });
    await db.orm.insert(t.ledgerAccounts).values({ guild_id: guildId, fc_id: fcId });
    return { ...actor, guildId, serverManager: true };
  }
  /** A Lodestone identity for scenarios that pass one straight to the service. */
  const character = (id: string, name: string) => ({
    id,
    name,
    world: "Diabolos",
    dc: "Crystal",
    fcId: null,
  });

  test("character results carry identity, main-character and roster evidence, and recoded failures", async () => {
    const guildId = "888888888888888801";
    const manager = await displayGuild(guildId, "9230000000000098001");
    const self: Actor = { guildId, userId: "98001", officer: false, manageRoles: false };
    const claimed = await service.claim(self, character("77980001", "Claimed Character"));
    if (claimed.status !== "pending") throw new Error("Expected a new token");
    proof = claimed.token;
    // The fake profile publishes the token under its own stored name.
    expect(await service.verify(self, "77980001")).toMatchObject({
      status: "verified",
      effects: "queued",
      effectsMode: "live",
      character: { id: "77980001", name: "Verified Character", world: "Diabolos" },
      // The first link becomes the main character.
      primary: true,
      roster: { fcLinked: true, fresh: true, checkedAt: expect.any(Date), listed: false },
    });
    expect(await service.verify(self, "77980001")).toEqual({
      status: "already_verified",
      character: { id: "77980001", name: "Verified Character", world: "Diabolos" },
    });
    expect(await service.claim(self, character("77980001", "Verified Character"))).toEqual({
      status: "already_linked",
      effects: "queued",
      effectsMode: "live",
      character: { id: "77980001", name: "Verified Character", world: "Diabolos" },
    });
    const assigned = await service.assign(
      manager,
      self.userId,
      character("77980002", "Assigned Character"),
      "  Confirmed in game  ",
    );
    expect(assigned).toMatchObject({
      status: "assigned",
      owner: self.userId,
      reason: "Confirmed in game",
      character: { id: "77980002", name: "Assigned Character", world: "Diabolos" },
      primary: false,
      officerAuthority: true,
      roster: { fresh: true },
    });
    // Assigning the same character to the same member again is the idempotent repeat.
    expect(
      await service.assign(
        manager,
        self.userId,
        character("77980002", "Assigned Character"),
        "Again",
      ),
    ).toMatchObject({ status: "already_assigned", link: assigned.link, primary: false });
    // Another member's link: the detail names the character and its owner for both audiences
    // (the reply shows the owner to officers only).
    const conflict = {
      code: "ownership_conflict",
      detail: { kind: "ownership", character: { id: "77980002" }, owner: self.userId },
    };
    await expect(
      service.assign(manager, "98002", character("77980002", "Assigned Character"), "Mistake"),
    ).rejects.toMatchObject(conflict);
    await expect(
      service.claim({ ...self, userId: "98002" }, character("77980002", "Assigned Character")),
    ).rejects.toMatchObject(conflict);
    absent.add("98009");
    await expect(
      service.assign(manager, "98009", character("77980003", "Absent Owner"), "Departed"),
    ).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "member", id: "98009" },
    });
    // Preferences report the saved main character and nickname state.
    expect(await service.preferences(self, "77980002", null)).toEqual({
      status: "saved",
      effects: "queued",
      effectsMode: "live",
      primary: { id: "77980002", name: "Assigned Character", world: "Diabolos" },
      nickname: { enabled: true, suspended: false },
    });
    await expect(service.preferences(self, "77989999", null)).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "link", id: "77989999" },
    });
    // Turning nickname sync off for someone TaruBot never tracked is a no-op, not a refusal.
    const untracked = { ...self, userId: "98010" };
    expect(await service.preferences(untracked, null, false)).toEqual({
      status: "unchanged",
      effects: "unchanged",
      effectsMode: "live",
      primary: null,
      nickname: { enabled: false, suspended: false },
    });
    await expect(service.preferences(untracked, null, true)).rejects.toMatchObject({
      code: "input",
      detail: { kind: "option", option: "enabled" },
    });
    // Unlinking the main character clears it; the owner keeps one active link.
    expect(await service.unclaim(self, self.userId, "77980002")).toMatchObject({
      status: "unlinked",
      owner: self.userId,
      character: { id: "77980002", name: "Assigned Character", world: "Diabolos" },
      primaryCleared: true,
      remainingActive: 1,
      reason: null,
    });
    expect(
      await service.unclaim(manager, self.userId, "77980001", "  Left the FC  "),
    ).toMatchObject({ primaryCleared: false, remainingActive: 0, reason: "Left the FC" });
    const history = await service.characters(self, self.userId);
    expect(history.characters.map((row) => [row.character_id, row.active])).toEqual([
      ["77980001", false],
      ["77980002", false],
    ]);
    for (const row of history.characters) expect(row.ended_at).toBeInstanceOf(Date);
  });

  test("claim limits carry retry timing and which limit refused", async () => {
    const guildId = "888888888888888802";
    await displayGuild(guildId, "9230000000000098002");
    const claimant: Actor = { guildId, userId: "98003", officer: false, manageRoles: false };
    for (const index of [1, 2, 3, 4, 5])
      await service.claim(claimant, character(`7798001${index}`, `Claim ${index}`));
    let own: unknown;
    try {
      await service.claim(claimant, character("77980016", "Claim 6"));
    } catch (error) {
      own = error;
    }
    expect(own).toMatchObject({
      code: "cooldown",
      detail: { kind: "limit", limit: "claims_own", until: expect.any(Date) },
    });
    // The oldest token frees the next slot within the verification window.
    const retry = own instanceof Failure ? own.retryAfter : 0;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(config.VERIFICATION_SECONDS);
    // The global cap: 1,000 unexpired tokens across the deployment refuse everyone else.
    const users = "SELECT (9801000+g)::text AS id FROM generate_series(1,200) g";
    await db.query(`INSERT INTO users(id) ${users} ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO guild_users(guild_id,user_id) SELECT $1,id FROM (${users}) u`, [
      guildId,
    ]);
    try {
      await db.query(
        `INSERT INTO challenges(guild_id,user_id,character_id,token_hash,expires_at) SELECT $1,u.id,c.id,repeat('a',64),now()+interval '1 hour' FROM (${users}) u CROSS JOIN (SELECT id FROM characters WHERE id IN ('77980011','77980012','77980013','77980014','77980015')) c`,
        [guildId],
      );
      await expect(
        service.claim({ ...claimant, userId: "98004" }, character("77980017", "Claim 7")),
      ).rejects.toMatchObject({
        code: "cooldown",
        detail: { kind: "limit", limit: "claims_all", until: expect.any(Date) },
      });
    } finally {
      // Later scenarios claim too, so the synthetic tokens must not outlive this test.
      await db.query(
        `DELETE FROM challenges WHERE guild_id=$1 AND user_id IN (${users.replace(" AS id", "")})`,
        [guildId],
      );
      await db.query(
        `DELETE FROM guild_users WHERE guild_id=$1 AND user_id IN (${users.replace(" AS id", "")})`,
        [guildId],
      );
    }
  });

  test("ledger receipts and views carry the FC, channel, corrections and exact paging", async () => {
    const guildId = "888888888888888803";
    const fcId = "9230000000000098003";
    const officer = await displayGuild(guildId, fcId);
    const company = { id: fcId, name: "Display Company", tag: "DISP", world: "Diabolos" };
    expect(
      await service.ledger(officer, "initialize", "0", "Opening balance", randomUUID()),
    ).toMatchObject({
      status: "recorded",
      effectsMode: "live",
      fc: company,
      channelId: "98201",
      correction: null,
      entry: { sequence: 1n, balance: 0n },
    });
    // Entries #2–#42 are deposits of 1 gil each; #43 corrects #5.
    const keys: string[] = [];
    for (let index = 2; index <= 42; index++) {
      const key = randomUUID();
      keys.push(key);
      await service.ledger(officer, "deposit", 1, `Deposit ${index}`, key);
    }
    const history = (before: string | null) => service.ledgerRead(officer, null, before, true);
    const fifth = (await history("6")).entries[0];
    if (fifth?.sequence !== 5n) throw new Error("Missing entry #5");
    const corrected = await service.ledger(
      officer,
      "adjust",
      "40",
      "Recount after chest audit",
      randomUUID(),
      fifth.id,
    );
    expect(corrected).toMatchObject({
      status: "recorded",
      correction: { id: fifth.id, sequence: 5n },
      entry: { sequence: 43n, balance: 40n },
    });
    // A replayed interaction reports the entry and its channel post's delivery state.
    expect(await service.ledger(officer, "deposit", 1, "Deposit 2", keys[0] ?? "")).toMatchObject({
      status: "already_recorded",
      entry: { sequence: 2n },
      fc: company,
      channelId: "98201",
      correction: null,
      post: { status: "queued", message_id: null, last_error: null },
    });
    expect(
      await service.ledger(officer, "adjust", "40", "Same balance", randomUUID()),
    ).toMatchObject({ status: "unchanged", balance: 40n, fc: company, channelId: "98201" });
    await expect(
      service.ledger(officer, "adjust", "41", "Bad target", randomUUID(), randomUUID()),
    ).rejects.toMatchObject({ code: "not_found", detail: { kind: "resource", resource: "entry" } });
    await expect(
      service.ledger(officer, "withdraw", 50, "Too much", randomUUID()),
    ).rejects.toMatchObject({
      code: "insufficient_funds",
      detail: { kind: "funds", balance: 40n, amount: 50n },
    });

    const balance = await service.ledgerRead(officer, null, null, false);
    expect(balance).toMatchObject({
      view: "balance",
      balanceState: "known",
      fc: company,
      current: true,
      channelId: "98201",
      effectsMode: "live",
      latest: { sequence: 43n, operation: "adjust", event_at: expect.any(Date) },
    });
    expect(balance.delivery.map((row) => row.sequence)).toEqual([
      43n,
      42n,
      41n,
      40n,
      39n,
      38n,
      37n,
      36n,
      35n,
      34n,
    ]);
    for (const row of balance.delivery)
      expect(row).toMatchObject({ attempts: 0, due_at: expect.any(Date) });

    /** The page as entry numbers plus its cursors and counts. */
    const page = async (before: string | null) => {
      const view = await history(before);
      return {
        entries: view.entries.map((entry) => Number(entry.sequence)),
        older: view.older,
        newer: view.newer,
        total: view.total,
        above: view.above,
      };
    };
    // The newest page: exactly ten entries and an exact older cursor.
    expect(await page(null)).toEqual({
      entries: [43, 42, 41, 40, 39, 38, 37, 36, 35, 34],
      older: 34n,
      newer: null,
      total: 43,
      above: 0,
    });
    // Page two: its posts are exactly its own entries, and the newer page is the newest one.
    const second = await history("34");
    expect(second.delivery.map((row) => row.entry_id).sort()).toEqual(
      second.entries.map((entry) => entry.id).sort(),
    );
    expect(second).toMatchObject({ before: 34n, older: 24n, newer: "latest", above: 10 });
    // A typed cursor that is not a multiple of ten (the approved example): nine newer entries.
    expect(await page("35")).toEqual({
      entries: [34, 33, 32, 31, 30, 29, 28, 27, 26, 25],
      older: 25n,
      newer: "latest",
      total: 43,
      above: 9,
    });
    // Deep enough that the newer page is itself a cursor: the ten entries just above #13.
    expect(await page("14")).toMatchObject({
      entries: [13, 12, 11, 10, 9, 8, 7, 6, 5, 4],
      newer: 24n,
      above: 30,
    });
    expect((await page("24")).entries).toEqual([23, 22, 21, 20, 19, 18, 17, 16, 15, 14]);
    // Exactly ten left: no older cursor, so the last page is never empty.
    expect(await page("11")).toMatchObject({
      entries: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      older: null,
    });
    // A cursor past the newest entry shows the newest page.
    expect(await page("100")).toMatchObject({
      entries: [43, 42, 41, 40, 39, 38, 37, 36, 35, 34],
      newer: null,
      above: 0,
    });
    // The page holding the correction maps its target's entry number.
    expect((await history(null)).corrections).toEqual({ [fifth.id]: 5n });
    // A malformed cursor is its own input failure, not a balance error.
    let cursorFailure: unknown;
    try {
      await history("page 2");
    } catch (error) {
      cursorFailure = error;
    }
    expect(cursorFailure).toMatchObject({
      code: "input",
      detail: { kind: "option", option: "before" },
    });
    expect(cursorFailure instanceof Failure && cursorFailure.message).not.toContain("Balance");
    // Unknown accounts, out-of-date pager controls and members reading a past FC.
    await expect(
      service.ledgerRead(officer, "9230000000000098999", null, true),
    ).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "account", id: "9230000000000098999" },
    });
    await expect(
      service.ledgerRead(officer, "9230000000000098999", null, true, "current"),
    ).rejects.toMatchObject({ code: "stale", detail: { kind: "stale", what: "control" } });
    await expect(
      service.ledgerRead(
        { ...officer, userId: "98011", officer: false, serverManager: false },
        "9230000000000098999",
        null,
        true,
      ),
    ).rejects.toMatchObject({ code: "forbidden", detail: { kind: "scope", scope: "officer" } });
  });

  test("configuration results carry what changed, the FC identity and the role order", async () => {
    const guildId = "888888888888888804";
    const fcId = "9230000000000098004";
    const manager = await displayGuild(guildId, fcId);
    const report = await service.validate(manager);
    expect(report).toMatchObject({
      effectsMode: "live",
      guestApplicationsOpen: true,
      fc: [
        {
          id: fcId,
          name: "Display Company",
          tag: "DISP",
          world: "Diabolos",
          fresh: true,
          attemptFailed: false,
        },
      ],
    });
    // A held job is queued again by the change, and the result counts it.
    await enqueue(db.pool, "reconcile.user", `user:${guildId}:98020`, {}, guildId, "98020");
    await db.query("UPDATE jobs SET status='blocked' WHERE dedupe_key=$1", [
      `user:${guildId}:98020`,
    ]);
    expect(await service.configure(manager, "ledger_channel_id", "98205")).toMatchObject({
      status: "saved",
      field: "ledger_channel_id",
      value: "98205",
      previous: "98201",
      rebound: false,
      requeued: 1,
      company: null,
      guild: { id: guildId, ledger_channel_id: "98205" },
    });
    expect(await service.configure(manager, "ledger_channel_id", "98205")).toMatchObject({
      rebound: true,
      requeued: 0,
    });
    // Linking a second FC needs an explicit unlink; the detail names the linked FC.
    await expect(service.configure(manager, "fc_id", "9230000000000098005")).rejects.toMatchObject({
      code: "fc_linked",
      detail: { kind: "resource", resource: "freecompany", id: fcId },
    });
    expect(await service.configure(manager, "fc_id", fcId)).toEqual({
      status: "unchanged",
      field: "fc_id",
      value: fcId,
    });
    await expect(service.unlinkCompany(manager, "9230000000000098005")).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "fc_link", id: "9230000000000098005" },
    });
    expect(await service.unlinkCompany(manager, fcId)).toMatchObject({
      status: "unlinked",
      effectsMode: "live",
      company: { id: fcId, name: "Display Company", tag: "DISP", world: "Diabolos" },
    });
    // A new link reports the Lodestone identity it stored.
    expect(await service.configure(manager, "fc_id", "9230000000000098005")).toMatchObject({
      status: "saved",
      previous: null,
      company: { id: "9230000000000098005", name: "Setup FC", tag: "TEST", world: "Diabolos" },
    });
    expect(await service.configureOfficerRank(manager, "  Council  ")).toMatchObject({
      status: "saved",
      officerRank: "Council",
      previous: null,
      fcLinked: true,
      officerRoleId: "98103",
      effectsMode: "live",
    });
    await expect(service.configureOfficerRank(manager, " ")).rejects.toMatchObject({
      code: "input",
      detail: { kind: "option", option: "rank" },
    });
    // Enabling the layout reports the order a pass applies: FC Leader, Officer, Member, Guest.
    expect(await service.configureRoleLayout(manager, false)).toMatchObject({ status: "saved" });
    expect(await service.configureRoleLayout(manager, true)).toMatchObject({
      status: "saved",
      order: ["98104", "98103", "98101", "98102"],
      layoutJob: expect.any(String),
    });
    // Applications need both the review channel and the Guest role, at the gate and at submission.
    expect(await service.guestApplicationsOpen(guildId)).toBe(true);
    await db.orm.update(t.guilds).set({ guest_role_id: null }).where(eq(t.guilds.id, guildId));
    expect(await service.guestApplicationsOpen(guildId)).toBe(false);
    const visitor: Actor = { guildId, userId: "98021", officer: false, manageRoles: false };
    await expect(service.apply(visitor, await applicationInput(visitor))).rejects.toMatchObject({
      code: "setup",
      message: GUEST_APPLICATIONS_CLOSED,
      detail: { kind: "setup", missing: "guest_role" },
    });
  });

  test("guest results carry outcomes, decisions and the facts behind the status view", async () => {
    const guildId = "888888888888888805";
    const manager = await displayGuild(guildId, "9230000000000098006");
    const applicant: Actor = { guildId, userId: "98030", officer: false, manageRoles: false };
    const first = await service.apply(applicant, await applicationInput(applicant));
    expect(first).toMatchObject({ outcome: "created", effectsMode: "live", state: "pending" });
    expect(await service.apply(applicant, await applicationInput(applicant))).toMatchObject({
      id: first.id,
      outcome: "existing",
    });
    // A rejoin replaces the pending application from the earlier join.
    const rejoined = members.get(applicant.userId);
    if (!rejoined) throw new Error("Missing applicant");
    rejoined.joinedAt = new Date("2026-02-01T00:00:00Z");
    const replaced = await service.apply(applicant, await applicationInput(applicant));
    expect(replaced).toMatchObject({ outcome: "replaced" });
    expect(replaced.id).not.toBe(first.id);
    // Officers see the pending application in autocomplete rows, and nothing more.
    const choices = await service.applicationChoices(manager);
    expect(choices.map((row) => Object.keys(row).sort())).toEqual([
      ["created_at", "id", "user_id"],
    ]);
    expect(choices[0]).toMatchObject({ id: replaced.id, user_id: applicant.userId });
    // The optional denial reason is validated like every officer reason.
    await expect(service.decide(manager, replaced.id, false, "   ")).rejects.toMatchObject({
      code: "input",
      detail: { kind: "option", option: "reason" },
    });
    const denied = await service.decide(manager, replaced.id, false, "  Not a fit right now  ");
    expect(denied).toMatchObject({
      id: replaced.id,
      status: "denied",
      effects: "queued",
      effectsMode: "live",
      userId: applicant.userId,
      reason: "Not a fit right now",
      reviewerId: manager.userId,
      decidedAt: expect.any(Date),
      cooldownSeconds: config.GUEST_COOLDOWN_SECONDS,
    });
    expect(await service.decide(manager, replaced.id, true)).toMatchObject({
      status: "denied",
      effects: "unchanged",
      reason: "Not a fit right now",
      reviewerId: manager.userId,
    });
    // Reapplying waits for the cooldown and says until when.
    let cooldown: unknown;
    try {
      await service.apply(applicant, await applicationInput(applicant));
    } catch (error) {
      cooldown = error;
    }
    expect(cooldown).toMatchObject({
      code: "cooldown",
      detail: { kind: "limit", limit: "apply", until: expect.any(Date) },
    });
    expect(cooldown instanceof Failure && cooldown.retryAfter).toBeGreaterThan(
      config.GUEST_COOLDOWN_SECONDS - 60,
    );
    const status = await service.guestStatus(manager, applicant.userId);
    expect(status).toMatchObject({
      membership: "ineligible",
      rosterFresh: true,
      registered: false,
      verifiedGuestEligible: false,
      cooldownSeconds: config.GUEST_COOLDOWN_SECONDS,
      effectsMode: "live",
    });
    for (const row of status.delivery)
      expect(row).toMatchObject({
        attempts: expect.any(Number),
        due_at: expect.any(Date),
        created_at: expect.any(Date),
      });
    // A grant reports the member, the trimmed reason and whether a revocation was lifted.
    const guest = "98031";
    const pending = await service.apply(
      { ...applicant, userId: guest },
      await applicationInput({ ...applicant, userId: guest }),
    );
    expect(
      await service.guestAction(manager, guest, false, "  Vouched for  ", randomUUID()),
    ).toMatchObject({
      status: "granted",
      user: guest,
      reason: "Vouched for",
      restored: false,
      cancelledApplications: 0,
      present: true,
      guestRoleConfigured: true,
    });
    expect(
      await service.guestAction(manager, guest, true, "Disruption", randomUUID()),
    ).toMatchObject({ status: "revoked", cancelledApplications: 1 });
    expect(
      (
        await db.query<{ state: string }>("SELECT state FROM guest_applications WHERE id=$1", [
          pending.id,
        ])
      )[0]?.state,
    ).toBe("cancelled");
    expect(
      await service.guestAction(manager, guest, false, "Second chance", randomUUID()),
    ).toMatchObject({ status: "granted", restored: true });
    // Grants read newest first.
    const grants = (await service.guestStatus(manager, guest)).grants;
    expect(grants.map((grant) => grant.reason)).toEqual(["Second chance", "Vouched for"]);
    members.set("98032", {
      id: "98032",
      guildId,
      joinedAt: new Date("2026-01-01T00:00:00Z"),
      nickname: null,
      roles: [],
      bot: true,
    });
    await expect(
      service.guestAction(manager, "98032", false, "Bot", randomUUID()),
    ).rejects.toMatchObject({ code: "input", detail: { kind: "option", option: "member" } });
  });

  test("setup, officer overrides and refresh report what they did", async () => {
    const guildId = "888888888888888806";
    const manager: Actor = { ...actor, guildId, serverManager: true };
    await db.orm.insert(t.guilds).values({ id: guildId, effects_enabled: true });
    let serial = 98300;
    const provisioner: RoleProvisioner = {
      ...discord,
      async ensureRole(_guild, _name, _actor, configured) {
        return configured
          ? { id: configured, created: false }
          : { id: String(++serial), created: true };
      },
    };
    const administration = new RoleAdministration(service, provisioner, access);
    const created = await administration.setup(manager, "", "9230000000000098007", "  Council  ");
    expect(created).toMatchObject({
      status: "configured",
      company: { id: "9230000000000098007", name: "Setup FC", tag: "TEST", world: "Diabolos" },
      officerRank: "Council",
      effectsMode: "live",
      roleLayoutEnabled: true,
      layoutJob: expect.any(String),
      adopted: 0,
      ledgerChannelId: null,
      officerNotifications: { defaulted: true },
      guestApplications: { defaulted: true },
    });
    expect(created.roles.every((role) => role.created)).toBe(true);
    // A rerun reuses everything and leaves the settings /setup filled in the first time.
    const again = await administration.setup(manager, "", null, null);
    expect(again.roles.every((role) => !role.created)).toBe(true);
    expect(again).toMatchObject({
      officerNotifications: { id: created.officerNotifications.id, defaulted: false },
      guestApplications: { defaulted: false },
    });
    await expect(
      administration.setup(manager, "", "9230000000000098008", null),
    ).rejects.toMatchObject({
      code: "fc_linked",
      detail: { kind: "resource", resource: "freecompany", id: "9230000000000098007" },
    });
    // Officer overrides report the member, the reason and the state they replaced.
    expect(await administration.officer(manager, "98040", true, "  Trusted  ")).toMatchObject({
      status: "granted",
      user: "98040",
      reason: "Trusted",
      present: true,
      previous: null,
      effectsMode: "live",
    });
    expect(await administration.officer(manager, "98040", false, "Stepped down")).toMatchObject({
      status: "revoked",
      previous: "granted",
    });
    absent.add("98041");
    await expect(administration.officer(manager, "98041", true, "Departed")).rejects.toMatchObject({
      code: "not_found",
      detail: { kind: "resource", resource: "member", id: "98041" },
    });
    // A departed user's grant can still be revoked; it applies if they rejoin.
    expect(await administration.officer(manager, "98041", false, "Departed")).toMatchObject({
      present: false,
    });
    // Refresh: force is officer-only, a missing FC is a setup gap, and a run is always recorded.
    const member: Actor = { guildId, userId: "98042", officer: false, manageRoles: false };
    await expect(sync.refresh(member, true)).rejects.toMatchObject({
      code: "forbidden",
      detail: { kind: "scope", scope: "officer" },
    });
    expect(await sync.refresh(manager, true)).toMatchObject({
      runId: expect.any(String),
      status: "queued",
      forced: true,
      cached: false,
      intervalSeconds: config.ROSTER_INTERVAL_SECONDS,
      effectsMode: "live",
    });
    await db.orm.update(t.guilds).set({ fc_id: null }).where(eq(t.guilds.id, guildId));
    await expect(sync.refresh(member, false)).rejects.toMatchObject({
      code: "setup",
      detail: { kind: "setup", missing: "fc" },
    });
  });

  test("effects mode says whether queued Discord work is held, and why", async () => {
    // A guild not yet activated holds its work until activation.
    const held = await displayGuild("888888888888888807", "9230000000000098009", false);
    expect((await service.validate(held)).effectsMode).toBe("awaiting_activation");
    expect(
      await service.configure(held, "officer_notifications_channel_id", "98206"),
    ).toMatchObject({ effectsMode: "awaiting_activation" });
    // ENABLE_EFFECTS=false holds every guild's work, whatever its own activation state.
    const disabled = new Service(db, discord, nodestone, { ...config, ENABLE_EFFECTS: false });
    const live = await displayGuild("888888888888888808", "9230000000000098010");
    expect((await disabled.validate(live)).effectsMode).toBe("deployment_disabled");
    expect(
      await disabled.ledger(live, "initialize", "5", "Opening balance", randomUUID()),
    ).toMatchObject({ status: "recorded", effectsMode: "deployment_disabled" });
    expect(
      await disabled.apply(
        { guildId: live.guildId, userId: "98050", officer: false, manageRoles: false },
        await applicationInput({ ...live, userId: "98050" }),
      ),
    ).toMatchObject({ outcome: "created", effectsMode: "deployment_disabled" });
  });

  test("a disconnected checked-out session releases locks and the pool reconnects", async () => {
    // Killing an idle checked-out session reproduces a database restart during remote I/O.
    const client = await db.pool.connect();
    const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      ?.pid;
    if (!pid) throw new Error("Missing backend PID");
    await client.query("SELECT pg_advisory_lock(714882493)");
    const disconnected = new Promise<void>((resolve) => client.once("error", () => resolve()));
    await db.query("SELECT pg_terminate_backend($1)", [pid]);
    await disconnected;
    try {
      await expect(client.query("SELECT 1")).rejects.toThrow();
    } finally {
      client.release();
    }
    expect(
      (
        await db.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(714882493) AS locked")
      )[0]?.locked,
    ).toBe(true);
    expect(db.healthy).toBe(true);
  });
});
