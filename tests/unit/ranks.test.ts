/** Privileged rank projections require trustworthy observations and explicit management authority. */
import { expect, test } from "bun:test";
import { authorizeRoleManager } from "../../src/domain/policy.js";
import {
  desiredRankRole,
  rankUnion,
  type RankEvidence,
} from "../../src/application/rank-policy.js";
import {
  character,
  markRosterLeader,
  type CharacterIdentity,
} from "../../src/infrastructure/lodestone/client.js";

test("bot-only officers cannot provision or delegate officer authority", () => {
  expect(() =>
    authorizeRoleManager({
      guildId: "1",
      userId: "2",
      officer: true,
      serverManager: false,
      manageRoles: true,
    }),
  ).toThrow();
  expect(() =>
    authorizeRoleManager({
      guildId: "1",
      userId: "2",
      officer: true,
      serverManager: true,
      manageRoles: true,
    }),
  ).not.toThrow();
});
test("uncertain or stale rank data preserves existing roles without new automatic grants", () => {
  expect(desiredRankRole("unknown", true, false)).toBe(true);
  expect(desiredRankRole("unknown", false, true)).toBe(false);
  expect(desiredRankRole("yes", false, false)).toBe(false);
  expect(desiredRankRole("yes", false, false, true)).toBe(true);
  expect(desiredRankRole("no", true, true)).toBe(false);
});
test("FC rank fields are separate from Grand Company rank and a custom leader title", () => {
  const member = character({
    ID: "123",
    Name: "Test Character",
    World: "Diabolos",
    DC: "Crystal",
    FcRank: "Fussy Bunbun",
    FcRankIcon: "https://lds-img.finalfantasyxiv.com/h/Z/W5a6yeRyN2eYiaV-AGU7mJKEhs.png",
    RankName: "Serpent Captain",
  });
  const officer: CharacterIdentity = {
    id: "456",
    name: "Another Character",
    world: "Diabolos",
    dc: "Crystal",
    fcId: null,
    fcRankName: "Officer",
    fcRankIcon: "https://lds-img.finalfantasyxiv.com/h/6/p94F1j-5xhM2ySM16VNrA08qjU.png",
  };
  markRosterLeader([member, officer]);
  expect(member.fcRankName).toBe("Fussy Bunbun");
  expect(member.isFcLeader).toBe(true);
  expect(officer.isFcLeader).toBe(false);
  const unknown = { ...officer };
  markRosterLeader([unknown]);
  expect(unknown.isFcLeader).toBeUndefined();
  const changed: CharacterIdentity = {
    ...member,
    fcRankIcon: "https://lds-img.finalfantasyxiv.com/changed.png",
  };
  delete changed.isFcLeader;
  markRosterLeader([changed]);
  expect(changed.isFcLeader).toBeUndefined();
});

test("officer and leader use any qualifying linked character", () => {
  // Each row is one active trusted link with the evidence accepted for the guild's current FC.
  const row = (
    state: RankEvidence["state"],
    rank: string | null,
    extra: Partial<RankEvidence> = {},
  ): RankEvidence => ({
    state,
    fc_rank_key: rank,
    is_fc_leader: false,
    officer_authority: true,
    ...extra,
  });
  const context = { fcLinked: true, officerRankKey: "officer", localLoss: false };
  const officer = (rows: RankEvidence[], overrides: Partial<typeof context> = {}) =>
    rankUnion(rows, { ...context, ...overrides }).officer;
  expect(officer([row("present", "member"), row("present", "officer")])).toBe("yes");
  expect(officer([row("absent", "officer")])).toBe("no");
  // A character awaiting departure confirmation still counts (SYNC-10).
  expect(officer([row("missing", "officer")])).toBe("yes");
  // A bot-only officer's assignment vouches for membership but cannot appoint an officer.
  expect(officer([row("present", "officer", { officer_authority: false })])).toBe("no");
  expect(officer([row("present", "member"), row(null, null)])).toBe("unknown");
  expect(officer([row("present", "member"), row(null, null)], { localLoss: true })).toBe("no");
  expect(officer([row("present", null)])).toBe("unknown");
  expect(rankUnion([row("present", null, { is_fc_leader: null })], context).leader).toBe("unknown");
  expect(
    rankUnion([row("present", "officer", { is_fc_leader: true })], { ...context, fcLinked: false }),
  ).toEqual({ officer: "no", leader: "no" });
  // Without a configured officer rank the leader union is still computed.
  expect(
    rankUnion([row("present", "member"), row("present", "leader", { is_fc_leader: true })], {
      ...context,
      officerRankKey: null,
    }),
  ).toEqual({ officer: "no", leader: "yes" });
});
