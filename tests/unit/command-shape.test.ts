/**
 * The router's shape check against every discovered command: each declared path, with every one
 * of its options, is accepted, and anything another release could register instead is refused.
 */
import { expect, test } from "bun:test";
import { ApplicationCommandOptionType } from "discord.js";
import { loadCommands } from "../../src/bot/discovery.js";
import { type DeclaredOption, type InvokedOption, undeclaredShape } from "../../src/bot/shape.js";

const { Subcommand, SubcommandGroup, String: Text } = ApplicationCommandOptionType;

/** Every invocable path of a command: the nested subcommand options down to a leaf, and its options. */
function invocations(
  options: readonly DeclaredOption[],
): { path: InvokedOption[]; leaf: readonly DeclaredOption[] }[] {
  const nested = options.filter(
    (option) => option.type === Subcommand || option.type === SubcommandGroup,
  );
  if (!nested.length) return [{ path: [], leaf: options }];
  return nested.flatMap((option) =>
    invocations(option.options ?? []).map(({ path, leaf }) => ({
      path: [{ name: option.name, type: option.type, options: path }],
      leaf,
    })),
  );
}

/** Wrap leaf options into the innermost level of an invocation path. */
function invoke(path: readonly InvokedOption[], leaf: InvokedOption[]): InvokedOption[] {
  const [first] = path;
  if (!first) return leaf;
  return [{ ...first, options: invoke(first.options ?? [], leaf) }];
}

test("every declared path, with all of its options, fits its own command's shape", async () => {
  let paths = 0;
  for (const command of (await loadCommands()).values()) {
    const declared = command.toJSON().options ?? [];
    for (const { path, leaf } of invocations(declared)) {
      paths++;
      const supplied = leaf.map((option) => ({ name: option.name, type: option.type }));
      expect(undeclaredShape(declared, invoke(path, supplied)), command.name).toBeNull();
    }
  }
  // The registered surface: 46 paths across 21 roots (a root without subcommands is one path);
  // 2.18.0 added /issue, 2.25.0 /config changelog and 2.26.0 /suggest.
  expect(paths).toBe(46);
});

test("shapes another release could register are refused", async () => {
  const commands = await loadCommands();
  const officer = commands.get("officer")?.toJSON().options ?? [];
  const config = commands.get("config")?.toJSON().options ?? [];
  // An /officer subcommand this release doesn't have (the pre-2.16 handler revoked on it).
  expect(undeclaredShape(officer, [{ name: "promote", type: Subcommand, options: [] }])).toBe(
    'the subcommand "promote"',
  );
  // A declared subcommand with an option it doesn't have, or with another type.
  expect(
    undeclaredShape(officer, [
      { name: "reset", type: Subcommand, options: [{ name: "note", type: Text }] },
    ]),
  ).toBe('the option "note"');
  expect(
    undeclaredShape(config, [
      {
        name: "guest_applications",
        type: Subcommand,
        options: [{ name: "enabled", type: Text }],
      },
    ]),
  ).toBe('the option "enabled"');
  // A command that requires a subcommand, invoked without one, and a mixed level.
  expect(undeclaredShape(officer, [])).toBe('a missing subcommand after ""');
  expect(
    undeclaredShape(officer, [
      { name: "reset", type: Subcommand, options: [] },
      { name: "reason", type: Text },
    ]),
  ).toBe('a mixed option list at ""');
});
