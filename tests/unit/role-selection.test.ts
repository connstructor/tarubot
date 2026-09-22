/** Setup must reuse existing identities across prefixes, while rejecting ambiguous selections. */
import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { DiscordGateway } from "../../src/discord/gateway.js";
import { existingRoleId } from "../../src/domain/role-selection.js";
import { Failure } from "../../src/domain/values.js";

test("a prefix does not hide existing canonical Member and Guest roles", () => {
  const roles = [
    { id: "201", name: " Member " },
    { id: "202", name: "guest" },
  ];
  expect(existingRoleId(roles, "DevBot Member", "Member", null)).toBe("201");
  expect(existingRoleId(roles, "DevBot Guest", "Guest", null)).toBe("202");
  expect(
    existingRoleId([{ id: "203", name: "DevBot Officer" }], "DevBot Officer", "Officer", null),
  ).toBe("203");
  expect(existingRoleId(roles, "DevBot FC Leader", "FC Leader", null)).toBeNull();
});

test("an explicit configured ID survives renaming and disambiguates existing candidates", () => {
  const roles = [
    { id: "201", name: "Member" },
    { id: "202", name: "DevBot Member" },
    { id: "203", name: "Custom membership" },
  ];
  expect(existingRoleId(roles, "DevBot Member", "Member", "201")).toBe("201");
  expect(existingRoleId(roles, "DevBot Member", "Member", "203")).toBe("203");
  expect(() => existingRoleId(roles, "DevBot Member", "Member", null)).toThrow("Several roles");
  expect(() => existingRoleId(roles, "DevBot Member", "Member", "deleted")).toThrow(
    "Several roles",
  );
});

test("a deleted binding reuses a unique existing role instead of creating a replacement", () => {
  const roles = [{ id: "201", name: "Member" }];
  expect(existingRoleId(roles, "DevBot Member", "Member", "deleted")).toBe("201");
  expect(() =>
    existingRoleId([...roles, { id: "202", name: "MEMBER" }], "DevBot Member", "Member", null),
  ).toThrow("Several roles");
});

test("Discord setup renames existing Member and Guest without creating roles or replacing permissions", async () => {
  const gateway = new DiscordGateway();
  const roles = [
    { id: "100", name: "@everyone", position: 0, permissions: "0" },
    { id: "201", name: "Member", position: 2, permissions: "1071698529857" },
    { id: "202", name: "Guest", position: 1, permissions: "1071698529857" },
  ];
  // Exercise the real SDK role adapter with controlled REST responses; hierarchy has its own checks.
  const get = spyOn(gateway.client.rest, "get").mockImplementation(async (route) => {
    if (route === "/guilds/100")
      return { id: "100", name: "Reuse fixture", roles: structuredClone(roles) };
    if (route === "/guilds/100/roles") return structuredClone(roles);
    throw new Error("Unexpected fixture read");
  });
  const patch = spyOn(gateway.client.rest, "patch").mockImplementation(async (route, options) => {
    const role = roles.find((candidate) => route === `/guilds/100/roles/${candidate.id}`);
    if (!role) throw new Error("Unexpected fixture write");
    const input = z.object({ name: z.string() }).parse(options?.body);
    expect(
      Object.keys(options?.body ?? {}).filter(
        (key) => Reflect.get(options?.body ?? {}, key) !== undefined,
      ),
    ).toEqual(["name"]);
    role.name = input.name;
    return structuredClone(role);
  });
  const post = spyOn(gateway.client.rest, "post").mockRejectedValue(
    new Error("Unexpected role creation"),
  );
  const validate = spyOn(gateway, "validateRole").mockResolvedValue();
  try {
    expect(await gateway.ensureRole("100", "DevBot Member", "300", null, "Member")).toEqual({
      id: "201",
      created: false,
    });
    expect(await gateway.ensureRole("100", "DevBot Guest", "300", null, "Guest")).toEqual({
      id: "202",
      created: false,
    });
    expect(await gateway.ensureRole("100", "DevBot Member", "300", "201", "Member")).toEqual({
      id: "201",
      created: false,
    });
    expect(
      roles
        .slice(1)
        .map((role) => ({ id: role.id, name: role.name, permissions: role.permissions })),
    ).toEqual([
      { id: "201", name: "DevBot Member", permissions: "1071698529857" },
      { id: "202", name: "DevBot Guest", permissions: "1071698529857" },
    ]);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledWith("100", "201", "300");
    expect(validate).toHaveBeenCalledWith("100", "202", "300");
    validate.mockRejectedValueOnce(new Failure("blocked", "Unmanageable existing role"));
    await expect(gateway.ensureRole("100", "Other Guest", "300", "202", "Guest")).rejects.toThrow(
      "Unmanageable",
    );
    expect(patch).toHaveBeenCalledTimes(2);
  } finally {
    get.mockRestore();
    patch.mockRestore();
    post.mockRestore();
    validate.mockRestore();
    await gateway.client.destroy();
  }
});
