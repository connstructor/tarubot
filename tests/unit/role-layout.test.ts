/** Role ordering packs one managed block and leaves unrelated roles in their relative order. */
import { expect, spyOn, test } from "bun:test";
import { Client } from "discord.js";
import { z } from "zod";
import { DiscordGateway } from "../../src/discord/gateway.js";
import { managedRoleOrder, rolePositionChanges } from "../../src/domain/role-layout.js";

test("managed priority is leader, officer, member, guest with partial configurations supported", () => {
  expect(
    managedRoleOrder({
      leader_role_id: "leader",
      officer_role_id: "officer",
      member_role_id: "member",
      guest_role_id: "guest",
    }),
  ).toEqual(["leader", "officer", "member", "guest"]);
  expect(
    managedRoleOrder({
      leader_role_id: null,
      officer_role_id: null,
      member_role_id: "member",
      guest_role_id: "guest",
    }),
  ).toEqual(["member", "guest"]);
});
test("reordering sends a complete hierarchy with one consecutive block below higher roles", () => {
  const current = [
    "everyone",
    "leader",
    "unrelated-low",
    "guest",
    "officer",
    "unrelated-high",
    "member",
    "bot",
  ];
  const changes = rolePositionChanges(current, ["leader", "officer", "member", "guest"]);
  const next = [
    "everyone",
    "guest",
    "member",
    "officer",
    "leader",
    "unrelated-low",
    "unrelated-high",
    "bot",
  ];
  expect(changes).toEqual(next.map((role, position) => ({ role, position })));
  expect(next.filter((role) => role.startsWith("unrelated"))).toEqual([
    "unrelated-low",
    "unrelated-high",
  ]);
  expect(next.at(-1)).toBe("bot");
  expect(rolePositionChanges(next, ["leader", "officer", "member", "guest"])).toEqual([]);
});

test("correct priority alone is not convergence when unrelated roles split the block", () => {
  const current = [
    "everyone",
    "guest",
    "custom-low",
    "member",
    "custom-mid",
    "officer",
    "custom-high",
    "leader",
    "bot",
  ];
  const next = rolePositionChanges(current, ["leader", "officer", "member", "guest"]);
  expect(next.map((entry) => entry.role)).toEqual([
    "everyone",
    "guest",
    "member",
    "officer",
    "leader",
    "custom-low",
    "custom-mid",
    "custom-high",
    "bot",
  ]);
});

test("partial configurations preserve lower and higher unrelated roles and stabilize", () => {
  const current = ["everyone", "lower", "member", "middle", "guest", "bot", "admin"];
  const next = rolePositionChanges(current, ["member", "guest"]).map((entry) => entry.role);
  expect(next).toEqual(["everyone", "lower", "guest", "member", "middle", "bot", "admin"]);
  expect(rolePositionChanges(next, ["member", "guest"])).toEqual([]);
  expect(rolePositionChanges(current, [])).toEqual([]);
});
test("missing or duplicated configured role IDs block layout", () => {
  expect(() => rolePositionChanges(["everyone", "member", "bot"], ["member", "guest"])).toThrow(
    "missing",
  );
  expect(() => rolePositionChanges(["everyone", "member", "bot"], ["member", "member"])).toThrow(
    "distinct",
  );
});

test("Discord position ties resolve to effective slots below unrelated roles and the bot", async () => {
  // Match Discord's creation response: all four new roles share the existing bottom role's position.
  const client = new Client({ intents: [] });
  const get = spyOn(client.rest, "get").mockResolvedValue({
    id: "100",
    name: "Role layout fixture",
    roles: [
      ["100", 0],
      ["101", 1],
      ["102", 2],
      ["103", 3],
      ["201", 1],
      ["202", 1],
      ["203", 1],
      ["204", 1],
    ].map(([id, position]) => ({ id, name: id, position, permissions: "0" })),
  });
  try {
    const guild = await client.guilds.fetch("100");
    const ascending = [...guild.roles.cache.values()]
      .sort((left, right) => left.comparePositionTo(right))
      .map((role) => role.id);
    expect(ascending).toEqual(["100", "204", "203", "202", "201", "101", "102", "103"]);
    expect(rolePositionChanges(ascending, ["204", "203", "201", "202"])).toEqual([
      { role: "100", position: 0 },
      { role: "202", position: 1 },
      { role: "201", position: 2 },
      { role: "203", position: 3 },
      { role: "204", position: 4 },
      { role: "101", position: 5 },
      { role: "102", position: 6 },
      { role: "103", position: 7 },
    ]);
    expect(guild.roles.cache.get("103")?.position).toBe(7);
  } finally {
    get.mockRestore();
    await client.destroy();
  }
});

test("Discord readback rejects interleaving despite correct priority, then converges without extra writes", async () => {
  const gateway = new DiscordGateway();
  // Ascending order has the right managed priority but an unrelated role between every pair.
  const roles = ["100", "204", "101", "203", "102", "202", "103", "201", "300"].map(
    (id, position) => ({
      id,
      name: id,
      position,
      permissions: "0",
      hoist: true,
    }),
  );
  const priority = ["201", "202", "203", "204"];
  const expected = ["100", "204", "203", "202", "201", "101", "102", "103", "300"];
  let applyPositions = false;
  let writes = 0;
  const get = spyOn(gateway.client.rest, "get").mockImplementation(async (route) => {
    if (route === "/guilds/100")
      return { id: "100", name: "Layout fixture", roles: structuredClone(roles) };
    if (route === "/guilds/100/roles") return structuredClone(roles);
    throw new Error("Unexpected fixture read");
  });
  const patch = spyOn(gateway.client.rest, "patch").mockImplementation(async (route, options) => {
    expect(route).toBe("/guilds/100/roles");
    const input = z.array(z.object({ id: z.string(), position: z.number() })).parse(options?.body);
    expect(input).toEqual(expected.map((id, position) => ({ id, position })));
    if (applyPositions)
      for (const entry of input) {
        const role = roles.find((candidate) => candidate.id === entry.id);
        if (role) role.position = entry.position;
      }
    return structuredClone(roles);
  });
  const validate = spyOn(gateway, "validateRole").mockResolvedValue();
  const guard = async () => {
    writes++;
  };
  try {
    await expect(gateway.layoutRoles("100", priority, guard)).rejects.toMatchObject({
      code: "transient",
    });
    applyPositions = true;
    expect(await gateway.layoutRoles("100", priority, guard)).toMatchObject({ order: priority });
    expect(await gateway.layoutRoles("100", priority, guard)).toEqual({
      order: priority,
      hoisted: [],
      positions: [],
    });
    expect(patch).toHaveBeenCalledTimes(2);
    expect(writes).toBe(2);
  } finally {
    get.mockRestore();
    patch.mockRestore();
    validate.mockRestore();
    await gateway.client.destroy();
  }
});
