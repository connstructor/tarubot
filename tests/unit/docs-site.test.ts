/**
 * The documentation site (site/, Starlight on GitHub Pages) against the code it describes. The
 * site's own build checks its frontmatter and internal links; this test is the required gate for
 * what a build can't know: the hand-written command reference, settings, reply codes and invite
 * permissions must match the code, repository links must resolve, the site package must stay a
 * pnpm package, and the public pages must carry placeholders only.
 *
 * Site files are read as text and never imported, so neither CI's checks job nor the image build
 * needs the site's dependencies. Paths resolve against the working tree with existsSync, because
 * the Docker build context has no .git. The scan uses explicit roots, never site/**, so it never
 * walks site/node_modules or reads site/pnpm-lock.yaml (whose integrity hashes look like tokens).
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApplicationCommandOptionType, PermissionFlagsBits } from "discord.js";
import { loadCommands } from "../../src/bot/discovery.js";
import {
  commandPaths,
  inventoryDiff,
  requiredBotPermissions,
} from "../../src/discord/inspection.js";
import { EXAMPLES } from "../../src/discord/presenters/failure.js";
import { FAILURE_CATEGORY } from "../../src/domain/failures.js";

/** A repository path, resolved relative to this test (the same helper as deployment.test.ts). */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
/** Read a repository file as text. */
const read = (path: string) => Bun.file(root(path)).text();
/** The Markdown page for a site path such as "reference/commands". */
const page = (slug: string) => read(`site/src/content/docs/${slug}.md`);

/**
 * Every command-reference section: the path of each "### /path" heading, with the text up to the
 * next "##" or "###" heading. Headings inside fenced code blocks don't count.
 */
function commandSections(markdown: string): { path: string; text: string }[] {
  const sections: { path: string; text: string }[] = [];
  let current: { path: string; lines: string[] } | null = null;
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : /^(#{2,3}) (.+)$/u.exec(line);
    if (heading) {
      if (current) sections.push({ path: current.path, text: current.lines.join("\n") });
      const title = heading[2] ?? "";
      current =
        heading[1] === "###" && title.startsWith("/") ? { path: title.slice(1), lines: [] } : null;
      continue;
    }
    current?.lines.push(line);
  }
  if (current) sections.push({ path: current.path, text: current.lines.join("\n") });
  return sections;
}

/** A registered option a user types or picks: its command path without the slash, and its name. */
interface OptionRow {
  readonly path: string;
  readonly name: string;
}

/** Walk subcommand groups and subcommands down to their options (as failure-reply.test.ts does). */
const optionsOf = (
  path: string[],
  options: readonly { type: number; name: string; options?: unknown }[] | undefined,
): OptionRow[] =>
  (options ?? []).flatMap((option) =>
    option.type === ApplicationCommandOptionType.Subcommand ||
    option.type === ApplicationCommandOptionType.SubcommandGroup
      ? optionsOf(
          [...path, option.name],
          option.options as readonly { type: number; name: string }[] | undefined,
        )
      : [{ path: path.join(" "), name: option.name }],
  );

/**
 * The files the site publishes or builds from, as repository paths: everything under site/src and
 * site/public, plus the site's config and package files. Never site/node_modules, site/dist or the
 * lockfile.
 */
async function siteFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of ["src/**/*", "public/**/*"])
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root("site") }))
      files.push(`site/${path}`);
  for (const path of ["site/astro.config.mjs", "site/package.json", "site/pnpm-workspace.yaml"])
    if (existsSync(root(path))) files.push(path);
  return files.sort();
}

describe("the command reference matches the registered commands", () => {
  test("one '### /path' section per invocable command path, and no others", async () => {
    const commands = [...(await loadCommands()).values()];
    const declared = commands.flatMap((command) =>
      commandPaths(command.name, command.toJSON().options),
    );
    const documented = commandSections(await page("reference/commands")).map(
      (section) => section.path,
    );
    expect(declared.length).toBeGreaterThan(40);
    // Each path is documented exactly once.
    expect(new Set(documented).size).toBe(documented.length);
    expect(inventoryDiff(declared, documented)).toEqual({ missing: [], unexpected: [] });
  });

  test("each section names every option of its path and says who can use it", async () => {
    const sections = new Map(
      commandSections(await page("reference/commands")).map((section) => [
        section.path,
        section.text,
      ]),
    );
    const rows = [...(await loadCommands()).values()].flatMap((command) =>
      optionsOf([command.name], command.toJSON().options),
    );
    expect(rows.length).toBeGreaterThan(50);
    const missing = rows.filter((row) => !sections.get(row.path)?.includes(`\`${row.name}\``));
    expect(missing).toEqual([]);
    const withoutAccess = [...sections].filter(([, text]) => !text.includes("**Who can use it:**"));
    expect(withoutAccess.map(([path]) => path)).toEqual([]);
  });

  test("each section shows every example the failure replies use, verbatim", async () => {
    const sections = new Map(
      commandSections(await page("reference/commands")).map((section) => [
        section.path,
        section.text,
      ]),
    );
    const missing = Object.entries(EXAMPLES).flatMap(([path, examples]) =>
      examples
        .filter((example) => !sections.get(path)?.includes(example))
        .map((example) => ({ path, example })),
    );
    expect(missing).toEqual([]);
  });
});

describe("the reference pages cover the code's settings, codes and permissions", () => {
  test("the configuration page documents every .env.example setting", async () => {
    const keys = [...(await read(".env.example")).matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)].map(
      (match) => match[1] ?? "",
    );
    expect(keys.length).toBeGreaterThan(20);
    const configuration = await page("deploy/configuration");
    expect(keys.filter((key) => !configuration.includes(`\`${key}\``))).toEqual([]);
  });

  test("the replies page lists every failure code a member can see, and unexpected", async () => {
    const codes = [
      ...Object.entries(FAILURE_CATEGORY)
        .filter(([, category]) => category !== "unexpected")
        .map(([code]) => code),
      "unexpected",
    ];
    const replies = await page("reference/replies");
    expect(codes.filter((code) => !replies.includes(`\`${code}\``))).toEqual([]);
  });

  test("the invite link asks for exactly the code's bot permissions plus Manage Channels", async () => {
    const bits =
      Object.values(requiredBotPermissions).reduce((total, bit) => total | bit, 0n) |
      PermissionFlagsBits.ManageChannels;
    // Manage Channels is the /setup onboarding addition, not part of the launch set.
    expect(Object.values(requiredBotPermissions)).not.toContain(PermissionFlagsBits.ManageChannels);
    const invite = await page("admin/add-to-server");
    expect(invite).toContain(`permissions=${bits}`);
    const asked = [...invite.matchAll(/permissions=(\d+)/gu)].map((match) => match[1]);
    expect(new Set(asked)).toEqual(new Set([String(bits)]));
  });
});

describe("the site package", () => {
  test("is a pnpm package without its own SemVer, beside a Bun root", async () => {
    const manifest = JSON.parse(await read("site/package.json")) as Record<string, unknown>;
    // The root package.json is the only SemVer; the site is never released on its own.
    expect(manifest).not.toHaveProperty("version");
    expect(String(manifest.packageManager)).toStartWith("pnpm@");
    expect(existsSync(root("site/pnpm-lock.yaml"))).toBe(true);
    for (const stray of [
      "site/bun.lock",
      "site/bun.lockb",
      "site/package-lock.json",
      "site/yarn.lock",
    ])
      expect(existsSync(root(stray))).toBe(false);
    // The bot stays on Bun: no pnpm lockfile at the repository root.
    expect(existsSync(root("pnpm-lock.yaml"))).toBe(false);
  });
});

describe("the site's links and public content", () => {
  test("every GitHub blob/tree link on main names a file or directory that exists", async () => {
    const files = await siteFiles();
    expect(files).toContain("site/src/content/docs/reference/commands.md");
    const broken: string[] = [];
    for (const file of files)
      for (const match of (await read(file)).matchAll(
        /https:\/\/github\.com\/deconfined\/tarubot\/(?:blob|tree)\/main\/([^\s)#"'`<>]+)/gu,
      ))
        if (!existsSync(root(match[1] ?? ""))) broken.push(`${file}: ${match[1]}`);
    expect(broken).toEqual([]);
  });

  test("pages carry placeholders only: no real IDs, private hosts, secrets or retired names", async () => {
    /** Patterns that must never appear on a public page, with what each guards. */
    const forbidden: readonly [RegExp, string][] = [
      [/hc-ping\.com\/(?!<)/iu, "a heartbeat ping URL (only hc-ping.com/<your-check-uuid>)"],
      [/discord\.com\/channels\//iu, "a Discord message or channel link"],
      // Any host under the upstream operator's domain. The pattern ends where a hostname ends
      // (the end of a line or a character a hostname can't hold), so it stays a whole-host match.
      [/deconfined\.com(?:$|[^\w.-])/imu, "the upstream instance's host"],
      [/linodeobjects/iu, "the upstream backup bucket's endpoint"],
      [/us-iad/iu, "the upstream instance's region"],
      [/tarubot-pg/iu, "an upstream database cluster name"],
      [/akmadmin|doadmin/iu, "a managed database admin login"],
      [/tarubot-cutover/iu, "the upstream operator's working directory"],
      [/tarubot-backups\b|tarubot-backup-key|tarubot-backup\.log/iu, "upstream backup names"],
      [/\b2752[01]\b/u, "the upstream database's ports"],
      [/\bage1[0-9a-z]{20,}/u, "an age recipient key"],
      [/TaruBot (?:production|backups)\b/u, "an upstream healthchecks check name"],
      [/04:30 UTC/u, "the upstream backup schedule"],
      [/Woven Souls|«Souls»|Fussy Bunbun/iu, "the upstream FC's name, tag or rank title"],
      // Token shapes, as src/domain/reports.ts redacts them.
      [/\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/u, "a Discord token"],
      [/\bgithub_pat_[A-Za-z\d_]{20,}\b/u, "a GitHub token"],
      [/\bgh[pousr]_[A-Za-z\d]{20,}\b/u, "a GitHub token"],
    ];
    /** Long numbers (snowflakes, FC IDs) other than the documented placeholders. */
    const snowflakes = new Set(["123456789012345678", "9230000000000000001"]);
    const characters = new Set(["99000001"]);
    // Components the bot no longer has; only the design record may name them.
    const retired = /nodestone|sidecar|app platform|PAGE_REGION/iu;
    const record = "site/src/content/docs/architecture/decisions.md";
    const problems: string[] = [];
    for (const file of await siteFiles()) {
      const text = await read(file);
      for (const [pattern, what] of forbidden)
        if (pattern.test(text)) problems.push(`${file}: ${what}`);
      for (const match of text.matchAll(/\b\d{17,20}\b/gu))
        if (!snowflakes.has(match[0])) problems.push(`${file}: the ID ${match[0]}`);
      for (const pattern of [/lodestone\/character\/(\d+)/giu, /\bcharacter:(\d+)/giu])
        for (const match of text.matchAll(pattern))
          if (!characters.has(match[1] ?? "")) problems.push(`${file}: character ${match[1]}`);
      if (file !== record && retired.test(text)) problems.push(`${file}: a retired component`);
    }
    expect(problems).toEqual([]);
  });
});
