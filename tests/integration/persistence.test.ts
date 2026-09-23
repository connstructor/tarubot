/** Real PostgreSQL invariants/recovery with supplied or synthetic SQL and controlled external effects. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ChannelType, OverwriteType, PermissionFlagsBits as P } from "discord.js";
import type { AccessChannel } from "../../src/domain/channel-access.js";
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
import type { ApplicationRecord, DiscordPort, MemberView } from "../../src/application/records.js";
import type { Configuration } from "../../src/config/env.js";
import type { Actor } from "../../src/domain/policy.js";
import { desiredAccess } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { audit, Database, ensureUser, orm } from "../../src/infrastructure/postgres/database.js";
import { Nodestone } from "../../src/infrastructure/nodestone/client.js";
import type { Roster } from "../../src/infrastructure/nodestone/client.js";
import { readDump } from "../../src/import/dump.js";
import { importLegacy, mappings, type Snapshot } from "../../src/import/importer.js";
import { enqueue, layoutGuildRoles, Queue, type Job } from "../../src/jobs/queue.js";
import { dispatcher } from "../../src/jobs/dispatch.js";
import { GuildAccess } from "../../src/application/guild-access.js";
import { FakeGuildAccess } from "../fixtures/guild-access.js";

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
    async send() {
      if (sendBlocked) throw new Failure("blocked", "Test channel delivery blocked.");
      return "123456789";
    },
    async editReview(_application: ApplicationRecord) {
      return "123456789";
    },
    async dm() {},
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
    await expect(service.unclaim(actor, "90003", identity.id, "Wrong owner")).rejects.toThrow(
      "specified owner",
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
    const applications = await Promise.all([service.apply(applicant), service.apply(applicant)]);
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
    ).rejects.toThrow("membership");
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
      await expect(
        service.ledger(actor, "deposit", 1, "Overflow must fail", randomUUID()),
      ).rejects.toThrow("range");
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
    await expect(service.ledgerRead(visitor, null, null, false)).rejects.toThrow("membership");
    expect(await service.characters(visitor, owner)).toEqual({ characters: [] });
    const balance = z
      .object({ account: z.object({ balance: z.bigint() }) })
      .parse(await service.ledgerRead({ ...visitor, officer: true }, null, null, false));
    expect(balance.account.balance).toBe(42n);
  });
  test("obsolete join context cancels pending review and forged message identity is rejected", async () => {
    const applicant = { ...actor, userId: "90006", officer: false };
    const application = z.object({ id: z.string() }).parse(await service.apply(applicant));
    await db.query("UPDATE guest_applications SET message_id='112233' WHERE id=$1", [
      application.id,
    ]);
    await expect(service.decide(actor, application.id, true, null, "445566")).rejects.toThrow(
      "obsolete",
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
    const old = z.object({ id: z.string() }).parse(await service.apply(actorInGuild));
    const member = members.get(actorInGuild.userId);
    if (!member) throw new Error("Missing rejoining member");
    member.joinedAt = new Date("2026-09-21T12:00:00Z");
    const current = z.object({ id: z.string() }).parse(await service.apply(actorInGuild));
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
  test("expired job ownership is fenced and committed work can resume", async () => {
    // The old worker runs after recovery deliberately; its lease token must no longer authorize writes.
    await db.query("UPDATE jobs SET status='disabled'");
    const key = await enqueue(db.pool, "probe", "test:lease", {});
    expect(await enqueue(db.pool, "probe", "test:lease", {})).toBe(key);
    const queue = new Queue(
      db,
      async (_job, guard) => {
        await guard();
        return { ok: true };
      },
      () => {},
    );
    const old = await queue.claim();
    if (!old) throw new Error("Missing lease");
    await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [key]);
    const recovered = await queue.claim();
    if (!recovered) throw new Error("Missing recovered lease");
    expect(recovered.lease_token).not.toBe(old.lease_token);
    await queue.perform(old);
    await queue.perform(recovered);
    expect(
      (await db.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [key]))[0]?.status,
    ).toBe("succeeded");
  });
  test("application operations enforce officer and target-owner authorization", async () => {
    const ordinary = { ...actor, officer: false, manageRoles: false };
    await expect(
      service.guestAction(ordinary, "90005", false, "Unauthorized", randomUUID()),
    ).rejects.toThrow("not authorized");
    await expect(
      service.ledger(ordinary, "withdraw", 1, "Unauthorized", randomUUID()),
    ).rejects.toThrow("not authorized");
    await expect(service.unclaim(ordinary, "90005", "77777777", "Unauthorized")).rejects.toThrow(
      "not authorized",
    );
    await expect(service.characters(ordinary, "90005")).rejects.toThrow("not authorized");
    await expect(service.guestStatus(ordinary, "90005")).rejects.toThrow("not authorized");
    await expect(
      service.autocomplete(ordinary, "application", ordinary.userId, ""),
    ).rejects.toThrow("not authorized");
  });
  test("sync status includes child delivery work and protects other requesters' runs", async () => {
    const requestor = { ...actor, userId: "90007", officer: false };
    const requested = z.object({ runId: z.string() }).parse(await sync.refresh(requestor, false));
    const run = (
      await db.query<{ job_id: string }>("SELECT job_id FROM sync_runs WHERE id=$1", [
        requested.runId,
      ])
    )[0];
    if (!run) throw new Error("Missing run");
    await sync.guild(guild, run.job_id);
    await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1", [run.job_id]);
    const status = z
      .object({ runs: z.array(z.object({ status: z.string(), work_total: z.number() })) })
      .parse(await service.syncStatus(requestor, requested.runId));
    expect(status.runs[0]?.status).toBe("queued");
    expect(status.runs[0]?.work_total).toBeGreaterThan(1);
    expect(
      await db.query(
        "SELECT j.id FROM jobs j JOIN sync_run_jobs r ON r.job_id=j.id WHERE r.run_id=$1 AND j.kind='roles.layout'",
        [requested.runId],
      ),
    ).toHaveLength(1);
    const other = z
      .object({ runs: z.array(z.unknown()) })
      .parse(await service.syncStatus({ ...requestor, userId: "90008" }, requested.runId));
    expect(other.runs).toHaveLength(0);
    await db.query(
      "UPDATE jobs SET status='succeeded' WHERE id IN (SELECT job_id FROM sync_run_jobs WHERE run_id=$1)",
      [requested.runId],
    );
    const completed = z
      .object({ runs: z.array(z.object({ status: z.string() })) })
      .parse(await service.syncStatus(requestor, requested.runId));
    expect(completed.runs[0]?.status).toBe("completed");
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
    await expect(service.verify(owner, identity.id)).rejects.toThrow("not visible");
    proof = second.token;
    await expect(service.verify({ ...owner, userId: "90014" }, identity.id)).rejects.toThrow(
      "unexpired challenge",
    );
    await db.query("UPDATE challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [
      second.challenge,
    ]);
    await expect(service.verify(owner, identity.id)).rejects.toThrow("unexpired challenge");
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
      .parse(await service.apply({ ...actor, userId: owner, officer: false }));
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
    let serial = 60000;
    const provisioner: RoleProvisioner = {
      ...discord,
      async members() {
        return [];
      },
      async ensureRole(_guild, name, _actor, configured) {
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
    await administration.setup(manager, "DevBot", fc, "Officer");
    const configured = await service.guild(manager);
    expect(configured.access_policy_enabled).toBe(true);
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

  /** A pre-existing guild captures its original public/private areas before enabling the opt-in policy. */
  async function accessFixture(guildId: string, fcId: string | null = null) {
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
      await orm(client).insert(t.guilds).values({
        id: guildId,
        fc_id: fcId,
        effects_enabled: true,
        member_role_id: "81101",
        guest_role_id: "81102",
        officer_role_id: "81103",
        leader_role_id: "81104",
        lobby_channel_id: "81001",
        officer_channel_id: "81002",
        access_policy_enabled: true,
        access_everyone_before: remote.everyonePermissions,
        guest_application_channel_id: "81002",
      });
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

  test("verified visitors get derived Guest access while revocation, FC membership, staleness and unlink remain authoritative", async () => {
    const fixture = await accessFixture("666666666666666674", fc);
    await db.orm
      .update(t.freeCompanies)
      .set({ last_successful_roster_at: sql`now()` })
      .where(eq(t.freeCompanies.id, fc));
    const visitor = {
      id: "77777200",
      name: "Verified Visitor",
      world: "Diabolos",
      dc: "Crystal",
      fcId: fc,
    };
    await service.assign(fixture.manager, "94001", visitor, "Trusted visitor");
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, "94001")).toBe(false);
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
    await reconcile("94001");
    expect(members.get("94001")?.roles).toContain(fixture.guild.guest_role_id ?? "");
    expect(members.get("94001")?.roles).not.toContain(fixture.guild.member_role_id ?? "");
    expect(await service.registrationGuestEligible(db.pool, fixture.guild, "94001")).toBe(true);
    expect(
      await db.orm
        .select()
        .from(t.guestGrants)
        .where(
          and(eq(t.guestGrants.guild_id, fixture.guild.id), eq(t.guestGrants.user_id, "94001")),
        ),
    ).toEqual([]);
    await expect(
      service.apply({ ...fixture.manager, userId: "94001", officer: false, serverManager: false }),
    ).rejects.toMatchObject({ code: "eligible" });
    await service.guestAction(fixture.manager, "94001", true, "Explicit revoke", randomUUID());
    await reconcile("94001");
    expect(members.get("94001")?.roles).not.toContain(fixture.guild.guest_role_id ?? "");
    const events = new GuildEvents(db);
    await events.memberLeft(fixture.guild.id, "94001");
    const rejoined = members.get("94001");
    if (!rejoined) throw new Error("Missing rejoining visitor");
    rejoined.joinedAt = new Date();
    await events.memberJoined(fixture.guild.id, "94001", rejoined.joinedAt);
    const restarted = new Service(db, discord, nodestone, config);
    expect(await restarted.registrationGuestEligible(db.pool, fixture.guild, "94001")).toBe(false);
    await reconcile("94001");
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
    await reconcile("94001");
    expect(members.get("94001")?.roles).toContain(fixture.guild.member_role_id ?? "");
    expect(members.get("94001")?.roles).not.toContain(fixture.guild.guest_role_id ?? "");
    const second = { ...visitor, id: "77777201" };
    await service.assign(fixture.manager, "94002", second, "Second visitor");
    await reconcile("94002");
    const current = members.get("94002");
    if (!current) throw new Error("Missing second visitor");
    expect(current.roles).toContain(fixture.guild.guest_role_id ?? "");
    await db.orm
      .update(t.freeCompanies)
      .set({ last_successful_roster_at: sql`now()-interval '7 hours'` })
      .where(eq(t.freeCompanies.id, fc));
    await reconcile("94002");
    expect(current.roles).toContain(fixture.guild.guest_role_id ?? "");
    current.roles = [];
    await reconcile("94002");
    expect(current.roles).toEqual([]);
    await db.orm
      .update(t.freeCompanies)
      .set({ last_successful_roster_at: sql`now()` })
      .where(eq(t.freeCompanies.id, fc));
    await reconcile("94002");
    expect(current.roles).toContain(fixture.guild.guest_role_id ?? "");
    await service.unclaim(
      { ...fixture.manager, userId: "94002", officer: false },
      "94002",
      second.id,
    );
    await reconcile("94002");
    expect(current.roles).not.toContain(fixture.guild.guest_role_id ?? "");
  });

  test("registered visitor access is opt-in, guild-scoped and works before linking an FC", async () => {
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
    const work = await enqueue(
      db.pool,
      "reconcile.user",
      `user:${fixture.guild.id}:94003`,
      {},
      fixture.guild.id,
      "94003",
    );
    await sync.user(await leased(work), async () => {});
    expect(members.get("94003")?.roles).toContain(fixture.guild.guest_role_id ?? "");
    const other = await accessFixture("666666666666666676");
    expect(await service.registrationGuestEligible(db.pool, other.guild, "94003")).toBe(false);
    const legacy = { ...fixture.manager, guildId: "666666666666666678" };
    await db.orm
      .insert(t.guilds)
      .values({ id: legacy.guildId, member_role_id: "81201", guest_role_id: "81202" });
    await service.assign(legacy, "94003", character, "Legacy local link");
    const configured = await service.guild(legacy);
    expect(configured.access_policy_enabled).toBe(false);
    expect(await service.registrationGuestEligible(db.pool, configured, "94003")).toBe(false);
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
      () => {},
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
    expect((await db.orm.select().from(t.jobs).where(eq(t.jobs.id, first)))[0]).toMatchObject({
      status: "queued",
      generation: 2,
      result: null,
      payload: { revision: 2 },
    });
    expect(await queue.claim()).toBeUndefined();
    // Advance the persisted due time instead of sleeping through the normal retry backoff.
    await db.orm.update(t.jobs).set({ due_at: sql`now()` }).where(eq(t.jobs.id, first));
    const current = await queue.claim();
    if (!current || current.id !== first) throw new Error("Missing superseding candidate");
    await queue.perform(current);
    expect((await db.orm.select().from(t.jobs).where(eq(t.jobs.id, first)))[0]).toMatchObject({
      status: "succeeded",
      result: { generation: 2 },
    });
    await db.orm.delete(t.jobs).where(inArray(t.jobs.id, [first, second, third]));
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
