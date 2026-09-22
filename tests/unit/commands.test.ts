/** Snapshot the declared feature surface through real discovery, including nested subcommands. */
import { expect, test } from "bun:test";
import { ApplicationCommandOptionType, InteractionContextType } from "discord.js";
import { loadCommands } from "../../src/bot/discovery.js";

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
