/**
 * Public suggestions (2.26.0, issue #32): what /suggest publishes. Every cleaning rule, the
 * invisible characters normalising removes, the fixed point `clean` reaches on nested markup, a
 * seeded fuzz of the whole pipeline, the exact public example the owner approved, the final
 * check's refusals, who may suggest, where each deployment posts, the settings guard, the
 * workflow guard, how Suggestions translates GitHub's answers, the refusals' log levels, and the
 * shutdown drain (with a fake database; the PostgreSQL behaviour is in
 * tests/integration/persistence.test.ts).
 *
 * Invisible characters are written as \u{…} escapes, never literally, so reviewers can see them.
 * Token-shaped samples are assembled at runtime, so secret scanners never see a literal one.
 */
import { describe, expect, test } from "bun:test";
import { Service } from "../../src/application/service.js";
import {
  type SuggestionTarget,
  Suggestions,
  suggestionGuilds,
  suggestionTarget,
} from "../../src/application/suggestions.js";
import { configuration, type Configuration } from "../../src/config/env.js";
import { deployments } from "../../src/config/deployment.js";
import { project } from "../../src/config/project.js";
import type { Actor } from "../../src/domain/policy.js";
import {
  assertPublic,
  clean,
  maySuggest,
  normalise,
  PUBLIC_PATTERNS,
  SUGGESTION_HEADER,
  SUGGESTION_LABELS,
  SUGGESTION_MARKER,
  suggestionBody,
  suggestionTitle,
  TITLE_LIMIT,
  wrap,
} from "../../src/domain/suggestions.js";
import { classifyFailure } from "../../src/domain/failures.js";
import { Failure } from "../../src/domain/values.js";
import { GitHubIssues } from "../../src/infrastructure/github/issues.js";
import { orm } from "../../src/infrastructure/postgres/database.js";

/** The whole public pipeline for one raw idea, as Suggestions.submit runs it. */
function pipeline(raw: string, version = "2.26.0") {
  const text = clean(normalise(raw));
  const title = suggestionTitle(text);
  const body = suggestionBody(text, version);
  return { text, title, body };
}

/** The cleaned public text of one raw idea. */
const cleaned = (raw: string) => clean(normalise(raw));

/** Code points, the unit titles and wrapping count in. */
const points = (text: string) => [...text].length;

describe("cleaning rules", () => {
  test("Discord markup keeps its words and loses its IDs", () => {
    expect(cleaned("ask <@123456789012345678> and <@!123456789012345678>")).toBe(
      "ask [member] and [member]",
    );
    expect(cleaned("ping <@&223456789012345678> please")).toBe("ping [role] please");
    expect(cleaned("post in <#323456789012345678> daily")).toBe("post in [channel] daily");
    expect(cleaned("react with <:pog:423456789012345678> and <a:dance:523456789012345678>")).toBe(
      "react with :pog: and :dance:",
    );
    expect(cleaned("make </ledger deposit:623456789012345678> faster")).toBe(
      "make /ledger deposit faster",
    );
    // Discord timestamps carry no ID and stay as written.
    expect(cleaned("remind at <t:1700000000:R> please")).toBe("remind at <t:1700000000:R> please");
  });

  test("every link goes, with or without a scheme; a bare domain stays", () => {
    for (const link of [
      "https://example.com/events",
      "http://example.com",
      "ftp://files.example",
      "postgres://u:p@host/db",
      "www.example.com",
      "discord.gg/abcdef",
      "discord.com/channels/1036062273631952955/1/2",
      "na.finalfantasyxiv.com/lodestone/character/12345678/",
      "hc-ping.com/0123-4567",
      // A query, a fragment or a port after a domain, without a path (2.26.0 review).
      "example.com?invite=abc",
      "mysite.io#secret-anchor",
      "discord.gg?code",
      "tarubot.example:8080",
      "example.com:8080/private/path",
      // localhost with a port or path, and IPv4 addresses, bare or with a port or path.
      "localhost:3000/health/ready",
      "localhost:3000",
      "localhost/x",
      "192.168.1.10",
      "192.168.1.10/admin",
      "192.168.1.10:8080",
      // A name in front of a linked host goes with it, so it can't survive as `name＠`.
      "john@example.com?subject=hi",
      "a@b.com/x",
      "user@192.168.1.10",
    ])
      expect(cleaned(`see ${link} please`)).toBe("see [link removed] please");
    // A bare domain carries no ID: "the discord.gg invite" is an ordinary phrase.
    const bare = pipeline("Show the discord.gg invite in the welcome channel");
    expect(bare.text).toBe("Show the discord.gg invite in the welcome channel");
    expect(() => assertPublic(bare.text, bare.title, bare.body)).not.toThrow();
    // Nor do these: a word before a colon or a question mark, bare localhost, a three-part
    // version, a longer dotted number, and a clock time.
    for (const phrase of [
      "Could we support Node.js? It would help",
      "Node.js: it would help",
      "run it on localhost first",
      "since version 2.26.0 and v1.2.3.4",
      "a build number 1.2.3.4567",
      "at 10.30:00 today",
    ])
      expect(cleaned(phrase)).toBe(phrase);
  });

  test("a link in any script goes like its ASCII equivalent (2.26.0 review)", () => {
    for (const link of [
      // Cyrillic, with a path, a subdomain, a port, a query and a fragment.
      "пример.рф/путь",
      "поддомен.пример.рф/путь",
      "пример.рф:8080",
      "пример.рф?q=1",
      "пример.рф#якорь",
      // Mixed scripts: across labels, within a label, and Latin letters with diacritics.
      "пример.com/путь",
      "example.рф/путь",
      "shopпример.com/x",
      "münchen.de/karte",
      // Chinese and Japanese labels and TLDs, with Katakana's ー.
      "例子.中国/路径",
      "例え.jp/パス",
      "サーバー.例え.jp/パス",
      "blog.例え.jp/x",
      "日本語ドメイン.jp:8080",
      "例え.みんな/パス",
      "例子.公司:443",
      "サーバー.jp?id=1",
      "例え.jp#top",
      // Korean, Greek, and Arabic and Hebrew (right to left, written here in logical order).
      "예시.한국/경로",
      "παράδειγμα.δοκιμή/x",
      "مثال.إختبار/مسار",
      "مثال.السعودية?id=1",
      "דוגמה.קום/נתיב",
      // Scripts whose letters carry combining marks (Devanagari's vowel signs, Thai's tone marks).
      "उदाहरण.भारत/पथ",
      "ตัวอย่าง.ไทย/x",
      // Punycode labels and TLDs.
      "xn--e1afmkfd.xn--p1ai/путь",
      "xn--r8jz45g.xn--q9jyb4c#top",
      "xn--80ak6aa92e.com?x=1",
      // The ideographic full stop, which browsers treat as a dot; NFKC folds the half-width one
      // (U+FF61) into it and the full-width full stop (U+FF0E) into `.`.
      "discord。gg/abc",
      "discord。gg?code",
      "sub。example。com:8080",
      "www。example。com",
      "пример。рф/путь",
      "example\u{FF61}com/x",
      "example\u{FF0E}com/x",
      // A name in front goes with the link.
      "имя@пример.рф/путь",
    ])
      expect(cleaned(`see ${link} please`)).toBe("see [link removed] please");
    // Email addresses in any script go too, marks and ideographic full stops included.
    for (const address of ["имя@пример.рф", "नाम@उदाहरण.भारत", "name@example。com"])
      expect(cleaned(`mail ${address} soon`)).toBe("mail [email removed] soon");
  });

  test("Chinese and Japanese sentences stay, and so do words running into a link", () => {
    // Their sentences end in `。`, `．` or `？` with no space after, so these read as prose
    // (NFKC folds the full-width forms).
    for (const sentence of [
      "イベント機能がほしいです。できますか\u{FF1F}よろしくお願いします",
      "設定しました。ON/OFFで切り替えたいです",
      "機能を追加。オン/オフを選べるように",
      "理系の書き方です\u{FF0E}できますか\u{FF1F}はい",
      "好的.可以吗?谢谢",
      "好的。可以吗\u{FF1F}谢谢",
      "面白いwww。次もお願いします",
      "Node.jsに対応してほしい",
      // The same shape as the sentences above: an ideographic full stop next to a Han, Hiragana
      // or Katakana label can't be told from a sentence end (an accepted limit).
      "例え。jp/パス",
      "例子。中国/路径",
    ])
      expect(cleaned(sentence)).toBe(normalise(sentence));
    // Other scripts' prose puts a space after its punctuation, as English does.
    for (const sentence of [
      "Можно добавить опросы? Спасибо. Очень нужно!",
      "Könnten wir Umfragen hinzufügen? Danke.",
      "هل يمكن إضافة تذكير؟ شكرا.",
      "कृपया रिमाइंडर जोड़ें। धन्यवाद",
    ])
      expect(cleaned(sentence)).toBe(sentence);
    // Chinese or Japanese text running straight into a link keeps its words.
    for (const [raw, expected] of [
      ["招待リンクはこちらdiscord.gg/abc", "招待リンクはこちら[link removed]"],
      ["ありがとうございます.discord.gg/abc", "ありがとうございます.[link removed]"],
      ["こちらです。discord。gg/abc", "こちらです。[link removed]"],
      // A label mixing Latin letters and Han keeps its Latin part; the rest of the host goes.
      ["abc日本.jp/x", "abc[link removed]"],
      // Text in those scripts running into a label in them can't be told apart from it, so it
      // goes with the link, as ASCII letters running into an ASCII host do.
      ["こちら例え.jp/パス", "[link removed]"],
    ])
      expect(cleaned(raw ?? "")).toBe(expected ?? "");
  });

  test("email addresses, long IDs and every @ go", () => {
    expect(cleaned("mail me at someone.else+tag@example.co.uk soon")).toBe(
      "mail me at [email removed] soon",
    );
    expect(cleaned("character 12345678901234567890 is mine")).toBe(
      "character [ID removed] is mine",
    );
    // Eight digits (a Lodestone character ID on its own) are not an ID shape TaruBot recognises.
    expect(cleaned("character 12345678 is mine")).toBe("character 12345678 is mine");
    expect(cleaned("thanks @claude")).toBe("thanks ＠claude");
  });

  test("credential shapes are redacted, never the deployment's own values", () => {
    const fineGrained = ["github", "pat", "11TESTONLY0000000000000", "notARealTokenForTests"].join(
      "_",
    );
    const classic = ["ghp", "0123456789abcdefghijABCDEFGHIJ012345"].join("_");
    const discord = ["MTA0MDM3OTM3MDE1OTc0MzEzOQ", "GaBcDe", "a".repeat(38)].join(".");
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBszCCAVmg",
      "-----END RSA PRIVATE KEY-----",
    ];
    expect(cleaned(`leaked ${fineGrained} here`)).toBe("leaked [github token redacted] here");
    expect(cleaned(`leaked ${classic} here`)).toBe("leaked [github token redacted] here");
    expect(cleaned(`leaked ${discord} here`)).toBe("leaked [discord token redacted] here");
    expect(cleaned(`key ${pem.join("\n")} end`)).toBe("key [pem redacted] end");
    // Links run first, so a ping URL or credentials in a URL go whole.
    expect(cleaned("https://hc-ping.com/abc-def")).toBe("[link removed]");
    expect(cleaned("postgres://u:p@h/db")).toBe("[link removed]");
  });

  test("no @ survives, whatever carries it", () => {
    for (const [raw, expected] of [
      ["hey @claude look", "hey ＠claude look"],
      ["hey @CLAUDE look", "hey ＠CLAUDE look"],
      ["hey @\u{200B}claude look", "hey ＠claude look"],
      ["write a@b.com here", "write [email removed] here"],
      ["tell @everyone now", "tell ＠everyone now"],
      ["ask <@123456789012345678> now", "ask [member] now"],
      ["open https://u:p@h now", "open [link removed] now"],
      ["full-width \u{FF20}claude too", "full-width ＠claude too"],
      ["small \u{FE6B}claude too", "small ＠claude too"],
    ])
      expect(cleaned(raw ?? "")).toBe(expected ?? "");
  });
});

describe("normalising", () => {
  test("controls, bidi and zero-width characters, and tag characters are removed", () => {
    expect(normalise("a\u{0}b\u{7}c\u{1B}d\u{7F}e\u{85}f\u{9F}g")).toBe("abcdefg");
    expect(normalise("a\u{202E}b\u{2066}c\u{200B}d\u{200D}e\u{FEFF}f")).toBe("abcdef");
    expect(normalise("idea\u{E0041}\u{E0042}\u{E007F} here")).toBe("idea here");
  });

  test("soft hyphens, variation selectors and Hangul fillers are removed", () => {
    expect(normalise("sug\u{AD}gest\u{FE0F}ion\u{E0100}")).toBe("suggestion");
    expect(normalise("a\u{115F}b\u{1160}c\u{3164}d\u{FFA0}e\u{34F}f")).toBe("abcdef");
  });

  test("the invisible combining marks are removed", () => {
    for (const mark of ["\u{17B4}", "\u{17B5}", "\u{180B}", "\u{180C}", "\u{180D}", "\u{180F}"])
      expect(normalise(`ab${mark}cd`)).toBe("abcd");
  });

  test("line breaks, tabs, blank lines and lone surrogates", () => {
    expect(normalise("one\u{2028}two\u{2029}three\r\nfour\rfive")).toBe(
      "one\ntwo\nthree\nfour\nfive",
    );
    expect(normalise("a\tb   \n\n\n\nc  ")).toBe("a b\n\nc");
    expect(normalise("lone \uD800 surrogate")).toBe("lone \u{FFFD} surrogate");
    expect(normalise("lone \uD800 surrogate").isWellFormed()).toBe(true);
  });

  test("compatibility forms fold so the rules catch them", () => {
    expect(normalise("\u{FF11}\u{FF12}\u{FF13}")).toBe("123");
    expect(cleaned("\u{FE6B}claude")).toBe("＠claude");
    expect(
      cleaned(
        "see \u{FF44}\u{FF49}\u{FF53}\u{FF43}\u{FF4F}\u{FF52}\u{FF44}\u{FF0E}\u{FF47}\u{FF47}\u{FF0F}x",
      ),
    ).toBe("see [link removed]");
    // Other scripts' digits count as digits: 18 Arabic-Indic digits are an ID.
    expect(
      cleaned(
        "id \u{660}\u{661}\u{662}\u{663}\u{664}\u{665}\u{666}\u{667}\u{668}\u{669}\u{660}\u{661}\u{662}\u{663}\u{664}\u{665}\u{666}\u{667}",
      ),
    ).toBe("id [ID removed]");
    expect(cleaned(`id ${"\u{FF11}".repeat(18)}`)).toBe("id [ID removed]");
  });

  test("an ID split by an invisible character is still an ID", () => {
    expect(cleaned("1234567890\u{AD}12345678")).toBe("[ID removed]");
    expect(cleaned("1234567890\u{180B}12345678")).toBe("[ID removed]");
    expect(cleaned("1234567890\u{17B4}12345678")).toBe("[ID removed]");
  });
});

/** Every fixed token clean emits, as it appears in cleaned text. */
const TOKENS = [
  "[member]",
  "[role]",
  "[channel]",
  ":pog:",
  "/ledger deposit",
  "[link removed]",
  "[email removed]",
  "[pem redacted]",
  "[discord token redacted]",
  "[github token redacted]",
  "token [redacted]",
  "[ID removed]",
  "＠",
];

describe("the fixed point", () => {
  test("replacement tokens, the header and the footer match no pattern", () => {
    // `hc-ping.com/[ping URL redacted]` and `…://[credentials redacted]@` are link-shaped, but
    // rule f removes every link before the credential shapes run, so they are never emitted.
    for (const token of [...TOKENS, SUGGESTION_HEADER, `Sent by TaruBot ${project.version}.`])
      for (const [pattern] of PUBLIC_PATTERNS)
        expect({ token, match: token.search(pattern) !== -1 }).toEqual({ token, match: false });
  });

  test("cleaning twice changes nothing", () => {
    for (const raw of [
      "ask <@123456789012345678> about https://example.com/x and a@b.com",
      "token abcdefghijklmnopqrstuvwxyz and 1234567890123456789",
      "<a<:b:1>1> my idea here",
      "@@@ <<<>>> :1> </ run:1>",
      "see пример.рф/путь, 例子.中国/路径 or discord。gg/x, then 招待はこちらdiscord.gg/y",
    ])
      expect(clean(cleaned(raw))).toBe(cleaned(raw));
  });

  test("nested markup unwraps to a fixed point that passes the check", () => {
    for (const [raw, expected] of [
      ["<a<:b:1>1> my idea here", ":b: my idea here"],
      ["<</run:1>:2> my idea here", "/run my idea here"],
      ["example.com<</run:1>:2>", "[link removed]"],
      // A Chinese TLD needs a path, which only the second pass's `/run` supplies.
      ["例子.中国<</run:1>:2>", "[link removed]"],
      ["пример。рф<</run:1>:2>", "[link removed]"],
    ]) {
      const { text, title, body } = pipeline(raw ?? "");
      expect(text).toBe(expected ?? "");
      expect(() => assertPublic(text, title, body)).not.toThrow();
    }
  });

  test("deep nesting stays within the bound", () => {
    // 246 levels of `<a…1>` around `<:b:1>` (990 characters), and 245 of `<…:2>` around
    // `</run:1>` (988): one level unwraps per pass.
    const emoji = `${"<a".repeat(246)}<:b:1>${"1>".repeat(246)}`;
    const command = `${"<".repeat(245)}</run:1>${":2>".repeat(245)}`;
    expect(emoji).toHaveLength(990);
    expect(command).toHaveLength(988);
    expect(clean(emoji)).toBe(":b:");
    expect(clean(command)).toBe("/run");
  });
});

/** mulberry32: a tiny seeded generator, so the fuzz is repeatable without a dependency. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe("seeded fuzz", () => {
  test("2,000 random ideas all come out public-safe", () => {
    const random = mulberry32(32);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const digits = () =>
      Array.from({ length: 1 + Math.floor(random() * 20) }, () =>
        String(Math.floor(random() * 10)),
      ).join("");
    const fragments: readonly (() => string)[] = [
      ...["@", "<@", "<", "<a", "<:", "</", ":", ":1>", "1>", ">", "<@&", "<#", "!"].map(
        (fragment) => () => fragment,
      ),
      digits,
      digits,
      ...["discord.gg/", "https://", "www.", ".com/", "a.b", "x@y.z", "token ", "Bearer "].map(
        (fragment) => () => fragment,
      ),
      ...[".io?", "#a", ":8080", "?x=1", "192.168.1.10", "localhost", "1.2."].map(
        (fragment) => () => fragment,
      ),
      // Internationalised hosts: other scripts' labels and TLDs, punycode, combining marks, the
      // ideographic full stop and its half-width and full-width forms, and CJK sentence pieces.
      ...["пример", ".рф/", "例子", ".中国/", "です", "。", "\u{FF61}", "\u{FF0E}", "\u{FF1F}"].map(
        (fragment) => () => fragment,
      ),
      ...["xn--p1ai", "xn--", "مثال", ".भारत", "\u{301}", "ー", "ON/", "münchen"].map(
        (fragment) => () => fragment,
      ),
      ...["\u{AD}", "\u{200B}", "\u{180B}", "\u{17B4}", "\u{E0041}", "\u{FF20}", "\u{D800}"].map(
        (fragment) => () => fragment,
      ),
      ...["#", "GH-", "```", "\u{1F600}", " ", " ", " ", "\n", "\t"].map(
        (fragment) => () => fragment,
      ),
      ...["idea", "officers", "event", "run", "b", "claude", "everyone"].map(
        (fragment) => () => fragment,
      ),
    ];
    let checked = 0;
    for (let run = 0; run < 2000; run++) {
      const raw = Array.from({ length: 1 + Math.floor(random() * 120) }, () => pick(fragments)())
        .join("")
        .slice(0, 1000);
      if (points(normalise(raw)) < 10) continue;
      const { text, title, body } = pipeline(raw);
      for (const part of [title, body]) {
        expect(part).not.toContain("@");
        expect(part).not.toMatch(/\p{Nd}{17,}/u);
        expect(part).not.toMatch(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/u);
        expect(part.isWellFormed()).toBe(true);
      }
      expect(points(title)).toBeLessThanOrEqual(TITLE_LIMIT);
      expect(body.split("```")).toHaveLength(3);
      expect(() => assertPublic(text, title, body)).not.toThrow();
      checked++;
    }
    // Most runs are long enough to post.
    expect(checked).toBeGreaterThan(1500);
  });
});

describe("titles", () => {
  test("GitHub references are neutralised", () => {
    expect(suggestionTitle("fix #12 soon")).toBe("fix ＃12 soon");
    expect(suggestionTitle("like owner/repo#1 does")).toBe("like owner/repo＃1 does");
    expect(suggestionTitle("see GH-3 and gh-4")).toBe("see GH\u{2011}3 and gh\u{2011}4");
  });

  test("the cut falls at a space after code point 40, or is hard at 79", () => {
    const words = `${"word ".repeat(20)}end`;
    const title = suggestionTitle(words);
    expect(title.endsWith("…")).toBe(true);
    expect(points(title)).toBeLessThanOrEqual(TITLE_LIMIT);
    expect(title.slice(0, -1).endsWith("word")).toBe(true);
    // No space after code point 40: a hard cut at 79 code points, plus the ellipsis.
    const long = `short ${"x".repeat(120)}`;
    expect(suggestionTitle(long)).toBe(`short ${"x".repeat(73)}…`);
    // Up to 80 code points, nothing is cut; newlines become spaces.
    expect(suggestionTitle("a\nb")).toBe("a b");
    expect(suggestionTitle("y".repeat(80))).toBe("y".repeat(80));
  });

  test("an emoji on the boundary is never split", () => {
    const title = suggestionTitle(`${"a".repeat(78)}\u{1F600}\u{1F600}bbbb`);
    expect(title).toBe(`${"a".repeat(78)}\u{1F600}…`);
    expect(points(title)).toBe(TITLE_LIMIT);
    expect(title.isWellFormed()).toBe(true);
  });
});

describe("wrapping", () => {
  test("lines fit 100 columns, and an overlong word stays whole", () => {
    const long = "z".repeat(130);
    const wrapped = wrap(`${"alpha beta gamma ".repeat(12)}${long} tail`);
    const lines = wrapped.split("\n");
    for (const line of lines) if (line !== long) expect(points(line)).toBeLessThanOrEqual(100);
    expect(lines).toContain(long);
    expect(wrapped.replaceAll("\n", " ")).toBe(`${"alpha beta gamma ".repeat(12)}${long} tail`);
    // Existing line breaks are kept.
    expect(wrap("one\ntwo")).toBe("one\ntwo");
  });
});

describe("the public example the owner approved (issue #32, Q7)", () => {
  test("title and fenced text are exactly as shown", () => {
    const { text, title, body } = pipeline(
      "Let officers schedule FC events and remind members an hour before. Something like https://example.com/events would be great.",
      "X.Y.Z",
    );
    expect(points(text)).toBe(112);
    expect(title).toBe(
      "Let officers schedule FC events and remind members an hour before. Something…",
    );
    expect(points(title)).toBe(77);
    expect(body).toBe(
      [
        "_Suggested in Discord with TaruBot's `/suggest` command. These are a TaruBot user's words, not the maintainers'. Links, Discord mentions, email addresses and long ID numbers were removed before posting._",
        "",
        "```text",
        "Let officers schedule FC events and remind members an hour before. Something like [link removed]",
        "would be great.",
        "```",
        "",
        "Sent by TaruBot X.Y.Z.",
      ].join("\n"),
    );
    expect(() => assertPublic(text, title, body)).not.toThrow();
    expect(SUGGESTION_HEADER).toContain(SUGGESTION_MARKER);
    expect(SUGGESTION_LABELS).toEqual(["enhancement", "from-discord"]);
  });
});

describe("the final check", () => {
  const good = pipeline("A perfectly ordinary idea for the bot");
  const refused = (text: string, title: string, body: string) =>
    expect(() => assertPublic(text, title, body)).toThrow(
      "A public suggestion failed its privacy check.",
    );

  test("a cleaned suggestion passes", () => {
    expect(() => assertPublic(good.text, good.title, good.body)).not.toThrow();
  });

  test("refuses anything a bug could let through", () => {
    // Text that still matches the shared list.
    refused("see https://example.com/x", good.title, good.body);
    refused("hello @claude", good.title, good.body);
    // An @, a long ID, a format or default-ignorable character, or a control in the title or body.
    refused(good.text, `${good.title} @x`, good.body);
    refused(good.text, good.title, `${good.body} 12345678901234567`);
    refused(good.text, `a\u{200B}b`, good.body);
    refused(good.text, `a\u{180B}b`, good.body);
    refused(good.text, good.title, `${good.body}\u{17B4}`);
    refused(good.text, good.title, `${good.body}\u{7}`);
    refused(good.text, `a\tb`, good.body);
    // Ill-formed text.
    refused(good.text, `a\uD800b`, good.body);
    // An ASCII # or an overlong title.
    refused(good.text, "fix #1", good.body);
    refused(good.text, "t".repeat(81), good.body);
    // A body without the header, or with a second fenced block.
    refused(good.text, good.title, good.body.replace(SUGGESTION_HEADER, "Hello"));
    refused(good.text, good.title, `${good.body}\n\n\`\`\`\nmore\n\`\`\``);
  });
});

describe("who may suggest (owner decision, 2026-09-25)", () => {
  const roles = { member_role_id: "70001", guest_role_id: "70002" };
  const actor = (roleIds?: readonly string[]): Pick<Actor, "roleIds"> =>
    roleIds === undefined ? {} : { roleIds };

  test("holding the Member or the Guest role qualifies", () => {
    expect(maySuggest(actor(["70001"]), roles)).toBe(true);
    expect(maySuggest(actor(["70002"]), roles)).toBe(true);
    expect(maySuggest(actor(["123", "70001", "70002"]), roles)).toBe(true);
  });

  test("officer access alone, a lobby visitor and an unbound role qualify nobody", () => {
    // maySuggest reads only roles: an officer or server manager holding neither is refused.
    const officer: Actor = {
      guildId: "1",
      userId: "2",
      officer: true,
      manageRoles: true,
      serverManager: true,
      roleIds: ["70003"],
    };
    expect(maySuggest(officer, roles)).toBe(false);
    expect(maySuggest(actor([]), roles)).toBe(false);
    expect(maySuggest(actor(), roles)).toBe(false);
    expect(maySuggest(actor(["70001"]), { member_role_id: null, guest_role_id: "70002" })).toBe(
      false,
    );
    expect(maySuggest(actor(["70001"]), { member_role_id: null, guest_role_id: null })).toBe(false);
  });
});

/** A complete configuration for the target and guild helpers; overrides pick the deployment. */
const settings = (overrides: Partial<Configuration> = {}): Configuration => ({
  DATABASE_URL: "postgresql://unused/unused",
  DISCORD_TOKEN: "test-only",
  DISCORD_APPLICATION_ID: "123",
  LOG_LEVEL: "error",
  ENABLE_EFFECTS: false,
  TEST_GUILD_ID: "",
  PUBLIC_TEST_RESPONSES: false,
  ROSTER_INTERVAL_SECONDS: 21600,
  PROFILE_INTERVAL_SECONDS: 86400,
  VERIFICATION_SECONDS: 1800,
  GUEST_COOLDOWN_SECONDS: 86400,
  HEALTH_PORT: 0,
  GITHUB_REPORTS_TOKEN: "",
  GITHUB_REPORTS_REPO: "deconfined/tarubot-reports",
  GITHUB_APP_CLIENT_ID: "",
  GITHUB_APP_PRIVATE_KEY: "",
  HEALTHCHECKS_PING_URL: "",
  ...overrides,
});
const DEVBOT_GUILD = deployments.devbot.guilds[0];

describe("where suggestions go", () => {
  test("production's allowlist, or DevBot's test guild", () => {
    expect(suggestionGuilds(settings())).toEqual(deployments.production.guilds);
    expect(suggestionGuilds(settings({ TEST_GUILD_ID: DEVBOT_GUILD }))).toEqual([DEVBOT_GUILD]);
  });

  test("DevBot previews into the reports repository and ignores the app", async () => {
    const devbot = { TEST_GUILD_ID: DEVBOT_GUILD };
    const app = { GITHUB_APP_CLIENT_ID: "Iv23test", GITHUB_APP_PRIVATE_KEY: "not a key" };
    const target = suggestionTarget(settings({ ...devbot, ...app, GITHUB_REPORTS_TOKEN: "t" }));
    expect(target?.repository).toBe("deconfined/tarubot-reports");
    // Constructing the client makes no request; it is the reports client, not the app's.
    expect(await target?.client()).toBeInstanceOf(GitHubIssues);
    // Without the reports token, DevBot has nowhere to preview, whatever the app settings say.
    expect(suggestionTarget(settings({ ...devbot, ...app }))).toBeNull();
  });

  test("production posts to the public repository as the app, or is switched off", async () => {
    const app = { GITHUB_APP_CLIENT_ID: "Iv23test", GITHUB_APP_PRIVATE_KEY: "not a key" };
    const target = suggestionTarget(settings(app));
    expect(target?.repository).toBe(project.repository);
    // A bad key fails the post with a configuration failure, before any request.
    await expect(target?.client()).rejects.toMatchObject({ code: "configuration" });
    // Either app setting empty switches /suggest off; the reports token doesn't stand in.
    expect(
      suggestionTarget(settings({ GITHUB_APP_CLIENT_ID: "Iv23test", GITHUB_REPORTS_TOKEN: "t" })),
    ).toBeNull();
    expect(suggestionTarget(settings({ GITHUB_APP_PRIVATE_KEY: "key" }))).toBeNull();
  });

  test("the reports repository can never be the public one", () => {
    const keys = [
      "DATABASE_URL",
      "DISCORD_TOKEN",
      "DISCORD_APPLICATION_ID",
      "GITHUB_REPORTS_REPO",
    ] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, {
        DATABASE_URL: "postgresql://unused/unused",
        DISCORD_TOKEN: "test-only",
        DISCORD_APPLICATION_ID: "123",
        GITHUB_REPORTS_REPO: "Deconfined/TaruBot",
      });
      expect(() => configuration()).toThrow("GITHUB_REPORTS_REPO: must be the private reports");
      process.env.GITHUB_REPORTS_REPO = "deconfined/tarubot-reports";
      expect(configuration().GITHUB_REPORTS_REPO).toBe("deconfined/tarubot-reports");
    } finally {
      for (const key of keys)
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
  });

  test("the Claude workflow never starts for a suggestion", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/claude.yml", import.meta.url),
    ).text();
    expect(workflow).toContain(`!contains(github.event.issue.body, '${SUGGESTION_MARKER}')`);
  });
});

/**
 * A pg-shaped fake for Suggestions: limit reads find no rows, and audit inserts are recorded (or
 * fail on demand). A class, so drizzle treats it as a client rather than a config object.
 */
class FakePool {
  inserts: unknown[][] = [];
  failInserts = false;
  async query(config: { text: string }, params: unknown[] = []) {
    if (/^insert/iu.test(config.text)) {
      if (this.failInserts) throw new Error("audit insert failed");
      this.inserts.push(params);
      return { rows: [], rowCount: 1, fields: [] };
    }
    return { rows: [], rowCount: 0, fields: [] };
  }
}

/** A member of the production FC server holding its Member role. */
const MEMBER: Actor = {
  guildId: deployments.production.guilds[0],
  userId: "400000000000000001",
  officer: false,
  manageRoles: false,
  roleIds: ["70001"],
};

/**
 * Suggestions over the fake database, a scripted GitHub and a recording reporter; with
 * `switchedOn` false, no target, as when the owner's off switch is thrown.
 */
function harness(
  create: (title: string, body: string) => Promise<{ number: number }>,
  switchedOn = true,
) {
  const pool = new FakePool();
  const reports: [unknown, string][] = [];
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  Object.assign(app, {
    config: settings(),
    db: { pool, orm: orm(pool as never) },
    guild: async () => ({ member_role_id: "70001", guest_role_id: "70002" }),
  });
  const creates: { title: string; body: string; labels: readonly string[] }[] = [];
  const target: SuggestionTarget = {
    repository: project.repository,
    client: async () => ({
      create: async (title: string, body: string, labels: readonly string[]) => {
        creates.push({ title, body, labels });
        const { number } = await create(title, body);
        return { number, state: "open" as const };
      },
    }),
  };
  const suggestions = new Suggestions(app, switchedOn ? target : null, (error, operation) => {
    reports.push([error, operation]);
  });
  return { suggestions, pool, reports, creates };
}

describe("posting", () => {
  test("a post links the issue and records who sent it", async () => {
    const { suggestions, pool, creates } = harness(async () => ({ number: 7 }));
    expect(await suggestions.submit(MEMBER, "An idea long enough to post")).toEqual({
      number: 7,
      url: `https://github.com/${project.repository}/issues/7`,
      repository: project.repository,
    });
    expect(creates).toHaveLength(1);
    expect(creates[0]?.labels).toEqual(["enhancement", "from-discord"]);
    expect(pool.inserts).toHaveLength(1);
    expect(pool.inserts[0]).toEqual(
      expect.arrayContaining([MEMBER.guildId, MEMBER.userId, "suggestion.posted", "#7"]),
    );
  });

  test("a failed audit insert still returns the link and is reported once", async () => {
    const { suggestions, pool, reports } = harness(async () => ({ number: 8 }));
    pool.failInserts = true;
    expect((await suggestions.submit(MEMBER, "An idea long enough to post")).number).toBe(8);
    expect(reports.map(([, operation]) => operation)).toEqual(["/suggest audit"]);
  });

  test("refusals come before any GitHub call", async () => {
    const { suggestions, creates } = harness(async () => ({ number: 1 }));
    await expect(
      suggestions.submit({ ...MEMBER, guildId: "999999999999999999" }, "An idea long enough"),
    ).rejects.toMatchObject({ code: "forbidden", detail: undefined });
    await expect(
      suggestions.submit({ ...MEMBER, roleIds: ["70003"], officer: true }, "An idea long enough"),
    ).rejects.toMatchObject({ code: "forbidden", detail: { kind: "scope", scope: "membership" } });
    await expect(
      suggestions.submit(MEMBER, "short\u{200B}\u{200B}\u{200B}\u{200B}\u{200B}"),
    ).rejects.toMatchObject({
      code: "input",
      detail: { kind: "option", option: "idea" },
    });
    expect(creates).toEqual([]);
  });

  test("the off switch and a foreign server are routine refusals, never private reports", async () => {
    // The router logs a failure at its classified level, and main.ts's reporter opens a private
    // issue report only at error level; both refusals must stay at info.
    const off = harness(async () => ({ number: 1 }), false);
    const on = harness(async () => ({ number: 1 }));
    for (const [suggestions, actor, message] of [
      [off.suggestions, MEMBER, "Suggestions are switched off on this TaruBot right now."],
      [
        on.suggestions,
        { ...MEMBER, guildId: "999999999999999999" },
        "Suggestions can be sent only from the Free Company server this TaruBot serves.",
      ],
    ] as const) {
      const error = await suggestions
        .submit(actor, "An idea long enough to post")
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "forbidden", message });
      expect(classifyFailure(error)).toMatchObject({ category: "forbidden", level: "info" });
    }
    expect([...off.reports, ...on.reports]).toEqual([]);
    expect([...off.creates, ...on.creates]).toEqual([]);
  });

  test("GitHub's answers: refusals record nothing, anything unclear counts", async () => {
    const cases: [unknown, { code: string; detail?: unknown }, "none" | "unconfirmed"][] = [
      [
        new Failure("rate_limited", "GitHub is rate limiting issue reports.", 42),
        { code: "rate_limited", detail: { kind: "limit", limit: "suggest" } },
        "none",
      ],
      [
        new Failure("invalid_data", "GitHub rejected the issue report (422)."),
        { code: "configuration" },
        "none",
      ],
      [new Failure("configuration", "GitHub refused."), { code: "configuration" }, "none"],
      [
        new Failure("unavailable", "GitHub answered 502.", 60),
        { code: "unavailable", detail: { kind: "github" } },
        "unconfirmed",
      ],
      [
        new Failure("invalid_response", "GitHub returned an issue without a number or state."),
        { code: "unavailable", detail: { kind: "github" } },
        "unconfirmed",
      ],
      [
        new DOMException("The operation timed out.", "TimeoutError"),
        { code: "unavailable", detail: { kind: "github" } },
        "unconfirmed",
      ],
      [new Error("boom"), { code: "unavailable", detail: { kind: "github" } }, "unconfirmed"],
    ];
    for (const [thrown, expected, recorded] of cases) {
      const { suggestions, pool, reports } = harness(async () => {
        throw thrown;
      });
      await expect(suggestions.submit(MEMBER, "An idea long enough to post")).rejects.toMatchObject(
        expected,
      );
      expect(pool.inserts.map((row) => row.includes("suggestion.unconfirmed"))).toEqual(
        recorded === "unconfirmed" ? [true] : [],
      );
      // Only a plain error, which the member's card can't describe, reaches the private reporter.
      expect(reports.map(([, operation]) => operation)).toEqual(
        thrown instanceof Failure ? [] : ["/suggest publish"],
      );
    }
  });

  test("submissions run one at a time, and a failure doesn't block the next", async () => {
    const order: string[] = [];
    let calls = 0;
    const { suggestions } = harness(async (title) => {
      calls++;
      order.push(`start ${title}`);
      await Bun.sleep(20);
      order.push(`end ${title}`);
      if (calls === 1) throw new Failure("configuration", "GitHub refused.");
      return { number: calls };
    });
    const first = suggestions.submit(MEMBER, "First idea for the bot");
    const second = suggestions.submit({ ...MEMBER, userId: "400000000000000002" }, "Second idea");
    await expect(first).rejects.toMatchObject({ code: "configuration" });
    expect((await second).number).toBe(2);
    expect(order).toEqual([
      "start First idea for the bot",
      "end First idea for the bot",
      "start Second idea",
      "end Second idea",
    ]);
  });

  test("shutdown drains the post in progress and refuses the ones that haven't started", async () => {
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const { suggestions, pool } = harness(async () => {
      calls++;
      await release.promise;
      return { number: calls };
    });
    const inFlight = suggestions.submit(MEMBER, "First idea for the bot");
    const queued = suggestions.submit({ ...MEMBER, userId: "400000000000000002" }, "Second idea");
    // Let the first submission reach GitHub, where it waits until released.
    while (calls === 0) await Bun.sleep(1);
    let drained = false;
    const draining = suggestions.drain().then(() => {
      drained = true;
    });
    await Bun.sleep(20);
    expect(drained).toBe(false);
    release.resolve();
    await draining;
    // The post finished, audit row included, before the drain resolved; the queued one never
    // reached GitHub and tells the member to retry after the restart.
    expect((await inFlight).number).toBe(1);
    expect(pool.inserts).toHaveLength(1);
    await expect(queued).rejects.toMatchObject({ code: "stopping" });
    // One that arrives after the drain began is refused the same way.
    await expect(
      suggestions.submit({ ...MEMBER, userId: "400000000000000003" }, "Third idea, late"),
    ).rejects.toMatchObject({ code: "stopping" });
    expect(calls).toBe(1);
    expect(classifyFailure(await queued.catch((caught: unknown) => caught)).level).toBe("info");
  });
});
