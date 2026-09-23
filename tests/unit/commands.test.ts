/** Snapshot the declared feature surface through real discovery, including nested subcommands. */
import { expect, test } from "bun:test";
import { ApplicationCommandOptionType, InteractionContextType } from "discord.js";
import { loadCommands } from "../../src/bot/discovery.js";
import { applicationKey } from "../../src/application/keys.js";
import { Service } from "../../src/application/service.js";
import { Services } from "../../src/bot/services.js";
import configCommand from "../../src/commands/configuration/config.command.js";
import type { Actor } from "../../src/domain/policy.js";
import { interactionFixture } from "../fixtures/interactions.js";

test("command inventory exactly matches the declared public surface", async () => {
  const commands = await loadCommands();
  const inventory: string[] = [];
  interface Option {
    type: number;
    name: string;
    options?: readonly Option[] | undefined;
  }
  const visit = (prefix: string, options: readonly Option[]): void => {
    // Flatten command groups while ignoring ordinary argument options.
    const nested = options.filter(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand ||
        option.type === ApplicationCommandOptionType.SubcommandGroup,
    );
    if (!nested.length) {
      inventory.push(prefix);
      return;
    }
    for (const option of nested) {
      if ("options" in option) visit(`${prefix} ${option.name}`, option.options ?? []);
      else inventory.push(`${prefix} ${option.name}`);
    }
  };
  for (const command of commands.values()) {
    const data = command.toJSON();
    expect(data.contexts).toEqual([InteractionContextType.Guild]);
    visit(data.name, data.options ?? []);
  }
  expect(inventory.sort()).toEqual(
    [
      "config fc link",
      "config fc unlink",
      "config roles member",
      "config roles guest",
      "config roles officer",
      "config roles leader",
      "config officer_rank",
      "config role_layout",
      "setup",
      "officer grant",
      "officer revoke",
      "config ledger",
      "config officer_notifications",
      "config guest_applications",
      "config show",
      "config validate",
      "claim",
      "verify",
      "unclaim",
      "assign",
      "unassign",
      "characters",
      "main",
      "nickname",
      "refresh",
      "sync status",
      "apply",
      "guest approve",
      "guest deny",
      "guest grant",
      "guest revoke",
      "guest status",
      "ledger deposit",
      "ledger withdraw",
      "ledger balance",
      "ledger history",
      "ledger initialize",
      "ledger adjust",
      "ping",
      "channel",
      "version",
    ].sort(),
  );
});

test("/config role_layout and /config roles officer adopt_holders reach the service as parsed", async () => {
  // A prototype-backed application records calls; the real option resolver parses raw payloads.
  const calls: unknown[][] = [];
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  app.configure = async (...args) => {
    calls.push(["configure", ...args.slice(1)]);
    return { status: "saved" };
  };
  app.configureRoleLayout = async (...args) => {
    calls.push(["configureRoleLayout", ...args.slice(1)]);
    return { status: "saved" };
  };
  const fixture = interactionFixture();
  const actor: Actor = { guildId: "100", userId: "400", officer: true, manageRoles: true };
  const run = async (options: unknown[], resolved?: unknown) => {
    await configCommand.execute?.({
      client: fixture.client,
      services: new Services().provide(applicationKey, app),
      allowsGuild: () => true,
      isStopping: () => false,
      report: () => {},
      resolveActor: async () => actor,
      actor,
      interaction: fixture.slash("config", options, resolved),
    });
  };
  const S = ApplicationCommandOptionType;
  // Only the officer binding declares adopt_holders; role_layout's single boolean is required.
  const declared = configCommand.toJSON().options ?? [];
  const group = declared.find((option) => option.name === "roles");
  if (group?.type !== S.SubcommandGroup) throw new Error("Missing /config roles group");
  expect(
    (group.options ?? []).map((sub) => [
      sub.name,
      (sub.options ?? []).map((option) => option.name),
    ]),
  ).toEqual([
    ["member", ["role", "clear"]],
    ["guest", ["role", "clear"]],
    ["officer", ["role", "clear", "adopt_holders"]],
    ["leader", ["role", "clear"]],
  ]);
  expect(declared.find((option) => option.name === "role_layout")).toMatchObject({
    type: S.Subcommand,
    options: [{ type: S.Boolean, name: "enabled", required: true }],
  });
  const role = { id: "555", name: "Legacy Officer", color: 0, hoist: false, position: 1 };
  const roles = {
    roles: { "555": { ...role, permissions: "0", managed: false, mentionable: false } },
  };
  // Bind the officer role with, without and against holder adoption, then another role.
  const officer = (extra: unknown[]) => [
    {
      type: S.SubcommandGroup,
      name: "roles",
      options: [
        {
          type: S.Subcommand,
          name: "officer",
          options: [{ type: S.Role, name: "role", value: "555" }, ...extra],
        },
      ],
    },
  ];
  try {
    await run(officer([]), roles);
    await run(officer([{ type: S.Boolean, name: "adopt_holders", value: false }]), roles);
    await run(officer([{ type: S.Boolean, name: "adopt_holders", value: true }]), roles);
    await run(
      [
        {
          type: S.SubcommandGroup,
          name: "roles",
          options: [
            {
              type: S.Subcommand,
              name: "guest",
              options: [{ type: S.Role, name: "role", value: "555" }],
            },
          ],
        },
      ],
      roles,
    );
    for (const enabled of [true, false])
      await run([
        {
          type: S.Subcommand,
          name: "role_layout",
          options: [{ type: S.Boolean, name: "enabled", value: enabled }],
        },
      ]);
    expect(calls).toEqual([
      ["configure", "officer_role_id", "555", {}],
      ["configure", "officer_role_id", "555", { adoptHolders: false }],
      ["configure", "officer_role_id", "555", { adoptHolders: true }],
      ["configure", "guest_role_id", "555", {}],
      ["configureRoleLayout", true],
      ["configureRoleLayout", false],
    ]);
  } finally {
    await fixture.close();
  }
});
