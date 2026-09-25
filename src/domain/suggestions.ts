/**
 * Public feature suggestions (2.26.0, issue #32; REQUIREMENTS.md "Approved public-suggestion
 * amendments"), pure so every rule can be unit-tested. `/suggest` posts a member's idea as an issue
 * in TaruBot's public repository, so the text is the only thing that goes public, and only after:
 *
 * 1. `normalise`: compatibility forms folded (NFKC) and every invisible or control character
 *    removed, so a disguised ID, link or mention becomes visible to the rules below;
 * 2. `clean`: the shared PUBLIC_PATTERNS list (Discord markup, links, email addresses, credential
 *    shapes, long ID numbers and every `@`), applied until nothing changes;
 * 3. `suggestionTitle` and `suggestionBody`: the fixed public format, with the text fenced;
 * 4. `assertPublic`: a final check over all three, which fails only if the steps above have a bug.
 *
 * Names typed freely, and IDs deliberately split with visible separators, can't be recognised;
 * the option's description warns members, and the owner moderates after posting.
 */
import type { Actor } from "./policy.js";
import { BODY_LIMIT, fenced, SECRET_PATTERNS } from "./reports.js";
import { Failure } from "./values.js";

/** Discord enforces these on the option; the minimum is checked again after normalising. */
export const SUGGESTION_MIN = 10;
export const SUGGESTION_MAX = 1000;
/** A public title has at most this many code points, the ellipsis included. */
export const TITLE_LIMIT = 80;
/** The fenced text wraps at this many columns (code points), at spaces only. */
export const WRAP_COLUMNS = 100;
/** One suggestion per member per hour (owner decision, 2026-09-25)... */
export const MEMBER_SUGGESTION_INTERVAL_SECONDS = 3600;
/** ...three per member in any 24 hours... */
export const MEMBER_SUGGESTIONS_PER_DAY = 3;
/** ...and ten in any 24 hours for the whole deployment. */
export const SUGGESTIONS_PER_DAY = 10;

/**
 * The audit actions every limit counts. `suggestion.unconfirmed` is an attempt GitHub didn't
 * confirm: the issue may exist, so it counts like a post and a quick retry can't post twice.
 */
export const SUGGESTION_ACTIONS = ["suggestion.posted", "suggestion.unconfirmed"] as const;
/** `enhancement` exists in the repository; GitHub creates `from-discord` on first use. */
export const SUGGESTION_LABELS = ["enhancement", "from-discord"] as const;
/**
 * A fixed substring of every suggestion's first line. .github/workflows/claude.yml refuses to
 * start the agent for an issue whose body contains it, whatever the author or the text.
 */
export const SUGGESTION_MARKER = "Suggested in Discord with TaruBot";
/** The fixed first line of every public suggestion; it contains the marker. */
export const SUGGESTION_HEADER = `_${SUGGESTION_MARKER}'s \`/suggest\` command. These are a TaruBot user's words, not the maintainers'. Links, Discord mentions, email addresses and long ID numbers were removed before posting._`;

/**
 * Fold compatibility forms and remove what no reader can see, before any rule runs:
 * - lone surrogates become U+FFFD, so later steps see well-formed text;
 * - NFKC maps full-width digits, `＠`, `﹫` and `ｄｉｓｃｏｒｄ．ｇｇ／` to ASCII, so the rules catch them;
 * - CR, CRLF and the line and paragraph separators become newlines, and tabs spaces;
 * - C0 and C1 controls (category Cc) other than the newline are removed;
 * - default-ignorable, format, private-use and unassigned characters are removed. The
 *   default-ignorable class covers characters browsers draw as nothing: the soft hyphen, U+034F,
 *   the Hangul fillers, the invisible combining marks (U+17B4–17B5, U+180B–180D, U+180F), the
 *   zero-width and bidi controls, the variation selectors, U+FEFF and the tag characters. An ID
 *   split by one of them would otherwise pass as two short numbers that display as one.
 * Then trailing spaces go, runs of blank lines become one, and the ends are trimmed.
 */
export function normalise(raw: string): string {
  return raw
    .toWellFormed()
    .normalize("NFKC")
    .replace(/\r\n?|\p{Zl}|\p{Zp}/gu, "\n")
    .replaceAll("\t", " ")
    .replace(/(?!\n)\p{Cc}/gu, "")
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Co}\p{Cn}]/gu, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * What must never reach the public text, in the order `clean` applies it, and what replaces it.
 * One list drives both `clean` and `assertPublic`, so the check can't be stricter than the cleaner.
 * - Discord markup: member, role and channel mentions become words; custom emoji keep their name
 *   and command mentions their path, without the IDs.
 * - Links (rule f): any scheme URL, `www.…`, or a domain followed by a path, scheme or not, so
 *   `discord.gg/…`, `discord.com/channels/…` and Lodestone character pages all go. A bare domain
 *   (`discord.gg`) carries no ID and stays. Links run before the credential shapes, so a ping URL
 *   or a URL with credentials goes whole.
 * - Email addresses, then the issue reporter's credential shapes (never the deployment's own
 *   secret values), then runs of 17 or more digits in any script (Discord and Lodestone IDs).
 * - Every `@` last: a GitHub @mention notifies that account, and `@claude` would ask the agent.
 * The quantifiers are bounded and Discord caps the option at 1,000 characters, so backtracking
 * stays small. No replacement equals its own match, so a pass that changes nothing proves that no
 * pattern matches.
 */
export const PUBLIC_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/<@!?\d+>/gu, "[member]"],
  [/<@&\d+>/gu, "[role]"],
  [/<#\d+>/gu, "[channel]"],
  [/<a?:(\w{1,32}):\d+>/gu, ":$1:"],
  [/<\/([-\w ]{1,100}):\d+>/gu, "/$1"],
  [
    /[a-z][a-z\d+.-]{0,31}:\/\/\S*|www\.\S*|(?:[a-z\d-]{1,63}\.)+[a-z]{2,63}\/\S*/giu,
    "[link removed]",
  ],
  [/[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})+/gu, "[email removed]"],
  ...SECRET_PATTERNS,
  [/\p{Nd}{17,}/gu, "[ID removed]"],
  [/@/gu, "＠"],
];

/**
 * Apply PUBLIC_PATTERNS until a pass changes nothing. One pass isn't enough: `replace` doesn't
 * rescan what it just replaced, so removing an inner piece of nested markup can complete an outer
 * one (`<a<:b:1>1>` becomes `<a:b:1>` after one pass). Each further pass unwraps one level and
 * shortens the text, so the text's length bounds the passes; real inputs stop within a few.
 */
export function clean(text: string): string {
  let current = text;
  for (let pass = 0; pass <= text.length; pass++) {
    const next = PUBLIC_PATTERNS.reduce(
      (result, [pattern, replacement]) => result.replace(pattern, replacement),
      current,
    );
    if (next === current) return current;
    current = next;
  }
  // Not reached for any input clean can shorten; assertPublic would report it as a bug.
  return current;
}

/**
 * The public title: the start of the cleaned text on one line, with GitHub references (`#12`,
 * `owner/repo#1`, `GH-3`) neutralised by look-alike characters. Over 80 code points, it is cut
 * at the last space between code points 40 and 79 (or hard-cut at 79) and ends with `…`. Cutting
 * by code point never splits a surrogate pair.
 */
export function suggestionTitle(text: string): string {
  const flat = text
    .replace(/\s+/gu, " ")
    .trim()
    .replaceAll("#", "＃")
    .replace(/\bGH-(?=\d)/giu, (match) => `${match.slice(0, 2)}‑`);
  const points = [...flat];
  if (points.length <= TITLE_LIMIT) return flat;
  let cut = TITLE_LIMIT - 1;
  for (let index = TITLE_LIMIT - 1; index >= 40; index--)
    if (points[index] === " ") {
      cut = index;
      break;
    }
  return `${points.slice(0, cut).join("")}…`;
}

/**
 * Greedy wrapping at spaces, `columns` code points per line. A word is never split: one longer
 * than a line stays whole on its own line. Existing line breaks are kept.
 */
export function wrap(text: string, columns = WRAP_COLUMNS): string {
  const width = (value: string) => [...value].length;
  return text
    .split("\n")
    .map((line) => {
      const lines: string[] = [];
      let current: string | null = null;
      for (const word of line.split(" ")) {
        if (current === null) current = word;
        else if (width(current) + 1 + width(word) <= columns) current += ` ${word}`;
        else {
          lines.push(current);
          current = word;
        }
      }
      lines.push(current ?? "");
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * The public issue body: the fixed header, the member's cleaned text in a `text` code block (which
 * renders no links, images or HTML; `fenced` stops the text closing it), and TaruBot's version.
 * Nothing else about the member, the server or the deployment is added.
 */
export function suggestionBody(text: string, version: string): string {
  return [SUGGESTION_HEADER, fenced(wrap(text), "text"), `Sent by TaruBot ${version}.`].join(
    "\n\n",
  );
}

/** Characters no public title or body may carry. */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
/** C0 and C1 controls (category Cc), tab included, but not the newline. */
const CONTROL = /(?!\n)\p{Cc}/u;
const LONG_ID = /\p{Nd}{17,}/u;

/**
 * The final check before anything is posted. Titles are cut and bodies wrapped only at spaces,
 * after `clean`, so neither can create a match `clean` didn't see: a failure here is a bug, thrown
 * as a plain Error so the member gets the unexpected-failure card and the owner a private report.
 * `search` ignores the global patterns' lastIndex.
 */
export function assertPublic(text: string, title: string, body: string): void {
  const safe = (part: string) =>
    !part.includes("@") &&
    part.search(LONG_ID) === -1 &&
    part.search(INVISIBLE) === -1 &&
    part.search(CONTROL) === -1 &&
    part.isWellFormed();
  const passes =
    PUBLIC_PATTERNS.every(([pattern]) => text.search(pattern) === -1) &&
    safe(title) &&
    safe(body) &&
    !title.includes("#") &&
    [...title].length <= TITLE_LIMIT &&
    body.startsWith(SUGGESTION_HEADER) &&
    body.split("```").length === 3 &&
    body.length <= BODY_LIMIT;
  if (!passes) throw new Error("A public suggestion failed its privacy check.");
}

/**
 * Who may suggest (owner decision, 2026-09-25): anyone with server access, meaning they hold the
 * server's bound Member or Guest role right now (the actor's roles are read fresh from Discord).
 * Officer access alone doesn't qualify: officers qualify through their Member role, and a server
 * manager holding neither role is refused. An unbound role qualifies nobody.
 */
export function maySuggest(
  actor: Pick<Actor, "roleIds">,
  roles: { readonly member_role_id: string | null; readonly guest_role_id: string | null },
): boolean {
  const held = actor.roleIds ?? [];
  return [roles.member_role_id, roles.guest_role_id].some(
    (role) => role !== null && held.includes(role),
  );
}

/** The refusal for someone without server access; it shows the membership card. */
export const suggestionAccessRefused = (): Failure =>
  new Failure("forbidden", "Only members and guests of this server can suggest features.", 0, {
    kind: "scope",
    scope: "membership",
  });

/** The refusal for an idea that is too short once invisible characters are removed. */
export const suggestionTooShort = (): Failure =>
  new Failure("input", "Describe your idea in at least 10 characters.", 0, {
    kind: "option",
    option: "idea",
  });
