/**
 * Member suggestions on every free-text member option (owner decision, 2026-09-24): officers typed
 * names into ID-only options during the 2.14.0 reply session and got "Check your input".
 */
import { expect, test } from "bun:test";
import type { AutocompleteContext } from "../../src/bot/command.js";
import { completeMember, focusedOption } from "../../src/discord/autocomplete.js";

const OWNER = "725369723964882976";
const PIGEON = "289803961693765632";
const PAZZ = "1010097911566180445";
const BOT = "943291473477128243";

/** A cached guild member as completeMember reads it. */
const member = (
  id: string,
  username: string,
  displayName = username,
  extra: { nickname?: string; globalName?: string; bot?: boolean } = {},
) => ({
  id,
  displayName,
  nickname: extra.nickname ?? null,
  user: { username, globalName: extra.globalName ?? null, bot: extra.bot ?? false },
});

const CACHED = [
  member(OWNER, "kaanidog"),
  member(PIGEON, "pigeonmuffin", "PigeonMuffin", { globalName: "PigeonMuffin" }),
  member(PAZZ, "pazzberry", "Pazz", { nickname: "Pazz" }),
  member(BOT, "devbot", "DevBot", { bot: true }),
];

/** An autocomplete context over a member cache, optionally with Discord's member search. */
function context(
  typed: string,
  options: {
    cached?: ReturnType<typeof member>[];
    officer?: boolean;
    userId?: string;
    search?: (query: { query: string; limit: number }) => Promise<Map<string, unknown>>;
  } = {},
): AutocompleteContext {
  const cached = options.cached ?? CACHED;
  return {
    actor: {
      guildId: "1040379370159743139",
      userId: options.userId ?? OWNER,
      officer: options.officer ?? true,
      manageRoles: false,
    },
    interaction: {
      options: {
        getFocused: (full?: boolean) => (full ? { name: "member", value: typed } : typed),
      },
      guild: {
        members: {
          cache: new Map(cached.map((row) => [row.id, row])),
          search: options.search ?? (async () => new Map()),
        },
      },
    },
  } as unknown as AutocompleteContext;
}

test("typing filters cached members by display name, username, global name or nickname", async () => {
  expect(focusedOption(context("pig"))).toBe("member");
  expect(await completeMember(context("pig"))).toEqual([
    { name: "PigeonMuffin (@pigeonmuffin)", value: PIGEON },
  ]);
  expect((await completeMember(context("PAZZ"))).map((choice) => choice.value)).toEqual([PAZZ]);
  // A display name equal to the username shows once; bots are never suggested.
  expect(await completeMember(context("kaan"))).toEqual([{ name: "@kaanidog", value: OWNER }]);
  expect(await completeMember(context("devbot"))).toEqual([]);
});

test("an empty query lists members, names that start with the query first, at most 25", async () => {
  expect((await completeMember(context(""))).map((choice) => choice.value)).toEqual([
    OWNER,
    PAZZ,
    PIGEON,
  ]);
  // 'p' starts Pazz and PigeonMuffin, and only appears inside no other name.
  expect((await completeMember(context("p"))).map((choice) => choice.value)).toEqual([
    PAZZ,
    PIGEON,
  ]);
  const many = Array.from({ length: 30 }, (_, index) =>
    member(`1000000000000000${String(index).padStart(3, "0")}`, `tester${index}`),
  );
  expect(await completeMember(context("tester", { cached: many }))).toHaveLength(25);
});

test("a pasted ID or mention is offered back, cached or not, so departed owners stay nameable", async () => {
  expect(await completeMember(context(` ${PIGEON} `))).toEqual([
    { name: "PigeonMuffin (@pigeonmuffin)", value: PIGEON },
  ]);
  expect(await completeMember(context(`<@!${PAZZ}>`))).toEqual([
    { name: "Pazz (@pazzberry)", value: PAZZ },
  ]);
  expect(await completeMember(context("123456789012345678"))).toEqual([
    { name: "User ID 123456789012345678", value: "123456789012345678" },
  ]);
});

test("members are offered only themselves, since naming anyone else is refused", async () => {
  expect(await completeMember(context("pig", { officer: false, userId: PAZZ }), true)).toEqual([
    { name: "Pazz (@pazzberry)", value: PAZZ },
  ]);
  expect(
    await completeMember(context("", { officer: false, userId: "555555555555555555" }), true),
  ).toEqual([{ name: "You", value: "555555555555555555" }]);
});

test("Discord's member search runs only when the cache has no match, within its budget", async () => {
  const searched: string[] = [];
  const found = member("222222222222222222", "uncached", "Uncached Member");
  const search = async ({ query }: { query: string; limit: number }) => {
    searched.push(query);
    return new Map([[found.id, found]]);
  };
  expect(await completeMember(context("pig", { search }))).toHaveLength(1);
  expect(searched).toEqual([]);
  expect(await completeMember(context("Uncached", { search }))).toEqual([
    { name: "Uncached Member (@uncached)", value: found.id },
  ]);
  expect(searched).toEqual(["Uncached"]);
  // One character never searches; a failing search suggests nothing instead of failing.
  expect(await completeMember(context("q", { search }))).toEqual([]);
  expect(searched).toEqual(["Uncached"]);
  const failing = async () => {
    throw new Error("rate limited");
  };
  expect(await completeMember(context("nobody", { search: failing }))).toEqual([]);
});
