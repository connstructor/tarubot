/** The installed version stays visible, and command output respects authorization and embed bounds. */
import { expect, test } from "bun:test";
import { ApplicationCommandOptionType, EmbedBuilder } from "discord.js";
import { VersionInformation } from "../../src/application/version-information.js";
import versionCommand from "../../src/commands/utility/version.command.js";
import { project } from "../../src/config/project.js";
import { GitHubHistory } from "../../src/infrastructure/github/client.js";
import { versionReply } from "../../src/discord/version.js";

test("version is available to ordinary users and offers a bounded optional commit count", () => {
  const definition = versionCommand.toJSON();
  expect(versionCommand.access).toBe("user");
  expect(definition.default_member_permissions).toBeUndefined();
  expect(definition.options).toEqual([
    expect.objectContaining({
      type: ApplicationCommandOptionType.Integer,
      name: "commits",
      min_value: 1,
      max_value: 10,
    }),
  ]);
  expect(definition.options?.[0]?.required).not.toBe(true);
  expect(project.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
});

test("version output links commit IDs, badges only verified signatures, and fits Discord limits", async () => {
  const source = new GitHubHistory(async () =>
    Response.json(
      Array.from({ length: 10 }, (_, index) => ({
        sha: String(index).repeat(40),
        commit: {
          message: "_*😀".repeat(1000),
          verification: {
            verified: index === 0,
            reason: index === 0 ? "valid" : "unsigned",
            signature: index === 0 ? "signature" : null,
          },
        },
      })),
    ),
  );
  const report = await new VersionInformation(source).get(10);
  const reply = versionReply(report);
  const raw = reply.embeds?.[0];
  if (!raw) throw new Error("Missing version embed");
  const embed = new EmbedBuilder("toJSON" in raw ? raw.toJSON() : raw).toJSON();
  expect(embed.title).toBe(`TaruBot v${project.version}`);
  expect(embed.fields).toHaveLength(10);
  expect(embed.fields?.[0]?.value).toBe(`[0000000](${project.url}/commit/${"0".repeat(40)}) ✅`);
  expect(embed.fields?.slice(1).every((field) => !field.value.includes("✅"))).toBe(true);
  expect(
    embed.fields?.every((field) => field.name.length <= 256 && field.value.length <= 1024),
  ).toBe(true);
  expect(JSON.stringify(embed).length).toBeLessThan(6000);
  expect(reply.allowedMentions).toEqual({ parse: [] });
});

test("GitHub outages leave the installed version visible without inventing history", async () => {
  const service = new VersionInformation(
    new GitHubHistory(async () => {
      throw new Error("offline");
    }),
  );
  const reply = versionReply(await service.get());
  const raw = reply.embeds?.[0];
  if (!raw) throw new Error("Missing version embed");
  const embed = "toJSON" in raw ? raw.toJSON() : raw;
  expect(embed.title).toBe(`TaruBot v${project.version}`);
  expect(embed.description).toContain("temporarily unavailable");
  expect(embed.fields).toEqual([]);
});
