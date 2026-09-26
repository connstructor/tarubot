/**
 * The tool rules of the Claude Code Review workflow (.github/workflows/claude-code-review.yml,
 * 2.30.1). No one can answer a permission prompt in CI, so the review may use only what its
 * `claude_args` allow: the inline-comment tool (allowing it is what makes the action start that MCP
 * server), the file readers, and read-only `git`, `gh` and reader commands. These tests read the
 * rules the way the pinned anthropics/claude-code-action does and pin that the list stays read-only
 * and keeps its one deny rule.
 *
 * How the action reads `claude_args` (base-action/src/parse-sdk-options.ts at the pinned v1.0.231):
 * it drops lines that start with `#`, splits the rest into shell words with shell-quote (quotes
 * group, whitespace separates; `()|&;<>` and glob characters are kept literally), and gives
 * `--allowedTools` and `--disallowedTools` every word after them up to the next `--` flag. It then
 * splits each word on commas into separate rules. When Dependabot moves the pin, check that the
 * action still reads the list this way.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { z } from "zod";

/** A repository file, read relative to this test. */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

/** Only the fields read here: the review job's steps and their inputs. */
const workflow = z.object({
  jobs: z.object({
    review: z.object({
      steps: z.array(
        z.object({
          id: z.string().optional(),
          uses: z.string().optional(),
          with: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
    }),
  }),
});
const steps = workflow.parse(YAML.parse(read(".github/workflows/claude-code-review.yml"))).jobs
  .review.steps;
const reviewStep = steps.find((step) => step.id === "review");
const inputs = reviewStep?.with ?? {};
/** The YAML folded scalar, as one line: folding joins its lines with spaces. */
const claudeArgs = z.string().parse(inputs.claude_args);

/**
 * Shell words, as shell-quote returns them once the action has escaped `()|&;<>`: whitespace
 * separates words, and a quoted part (single or double quotes) may hold whitespace. Characters
 * shell-quote would not keep literally (`$`, a backslash, a backquote, or `#` starting a word) are
 * refused, because this reader would then disagree with the action.
 */
function words(text: string): string[] {
  const kept = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  if (/[$\\`]/u.test(kept))
    throw new Error("claude_args holds $, \\ or `, which shell-quote reads");
  const out: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const char of kept) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
    } else if (/\s/u.test(char)) {
      if (word !== null) out.push(word);
      word = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (char === "#" && word === null) {
      throw new Error("claude_args starts a word with #, which shell-quote reads as a comment");
    } else word = (word ?? "") + char;
  }
  if (quote !== null) throw new Error("claude_args leaves a quote open");
  if (word !== null) out.push(word);
  return out;
}

/** The flags whose values the action gathers, up to the next flag, instead of taking one. */
const GATHERING = new Set([
  "allowedTools",
  "allowed-tools",
  "disallowedTools",
  "disallowed-tools",
  "mcp-config",
  "add-dir",
]);

/**
 * Each flag's values as the action reads them, and any word it reads as no flag's value (after a
 * flag that takes one value, or before the first flag), which it silently drops.
 */
function flags(list: string[]): { values: Map<string, string[]>; dropped: string[] } {
  const values = new Map<string, string[]>();
  const dropped: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const word = list[i] ?? "";
    if (!word.startsWith("--")) {
      dropped.push(word);
      continue;
    }
    const flag = word.slice(2);
    const taken = values.get(flag) ?? [];
    values.set(flag, taken);
    const isValue = (next: string | undefined) => next !== undefined && !next.startsWith("--");
    if (GATHERING.has(flag)) while (isValue(list[i + 1])) taken.push(list[++i] ?? "");
    else if (isValue(list[i + 1])) taken.push(list[++i] ?? "");
  }
  return { values, dropped };
}

const parsed = flags(words(claudeArgs));
/** Both spellings of a tool list, as the action merges them. */
const rules = (camel: string, hyphenated: string) => [
  ...(parsed.values.get(camel) ?? []),
  ...(parsed.values.get(hyphenated) ?? []),
];
const allowed = rules("allowedTools", "allowed-tools");
const denied = rules("disallowedTools", "disallowed-tools");

describe("the review's tool rules", () => {
  test("the review step runs the action, with its tool lists in claude_args only", () => {
    expect(reviewStep?.uses).toStartWith("anthropics/claude-code-action@");
    // A tool list in another input would be merged into these without the checks below.
    expect(Object.keys(inputs).filter((key) => /tools/iu.test(key))).toEqual([]);
  });

  test("the action reads every word as written", () => {
    // Every word belongs to a flag: a rule the action drops would be missing without a sign.
    expect(parsed.dropped).toEqual([]);
    // The action splits each value on commas, so a rule with a comma would become two rules
    // (a Bash rule such as `Bash(a,b:*)` would lose its closing parenthesis).
    for (const rule of [...allowed, ...denied])
      expect({ rule, comma: rule.includes(","), empty: rule.trim() === "" }).toEqual({
        rule,
        comma: false,
        empty: false,
      });
  });

  test("the review may post inline comments and read files", () => {
    for (const tool of [
      "mcp__github_inline_comment__create_inline_comment",
      "Read",
      "Grep",
      "Glob",
    ])
      expect(allowed).toContain(tool);
  });

  test("nothing allowed writes", () => {
    for (const rule of allowed)
      expect({
        rule,
        // Any command, or any file edit: an output redirect would need an Edit rule.
        writes: ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(rule),
        scopedWrite: /^(?:Write|Edit|MultiEdit|NotebookEdit)\(/u.test(rule),
        // `gh api` can post, whatever the method it is given.
        ghApi: rule.startsWith("Bash(gh api"),
        // A Bash rule is a literal command prefix: a wildcard inside it, such as `Bash(git *)`,
        // would also allow `git push`.
        wildcard:
          rule.startsWith("Bash(") && !/^Bash\([a-z][\w-]*(?: [a-z][\w-]*)*:\*\)$/u.test(rule),
      }).toEqual({ rule, writes: false, scopedWrite: false, ghApi: false, wildcard: false });
  });

  test("git's --output option stays denied", () => {
    // `git diff --output=<file>` (and log, show) writes a file; the allowed git rules would
    // otherwise cover it.
    expect(denied).toContain("Bash(git *--output*)");
  });
});

describe("the claude_args reader", () => {
  test("reads words, quoted groups and gathered flags as the action does", () => {
    expect(
      words(`--allowedTools "Read" 'Bash(git log:*)' Glob\n# a comment line\n--x "a b"`),
    ).toEqual(["--allowedTools", "Read", "Bash(git log:*)", "Glob", "--x", "a b"]);
    const gathered = flags([
      "stray",
      "--allowedTools",
      "A",
      "B",
      "--model",
      "m",
      "late",
      "--allowedTools",
      "C",
    ]);
    expect(gathered.values.get("allowedTools")).toEqual(["A", "B", "C"]);
    expect(gathered.values.get("model")).toEqual(["m"]);
    expect(gathered.dropped).toEqual(["stray", "late"]);
    expect(() => words(`"Bash($HOME:*)"`)).toThrow("shell-quote");
    expect(() => words(`"Read`)).toThrow("quote");
  });
});
