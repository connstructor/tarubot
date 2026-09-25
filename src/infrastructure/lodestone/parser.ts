/**
 * TaruBot's own Lodestone parser (2.20.0), replacing the xivapi/nodestone library: the owner asked to
 * "get rid of Nodestone entirely, pull xivapi/lodestone-css-selectors for ourselves, and do the parsing
 * internally". It applies the selector definitions from lodestone-css-selectors directly, with the
 * semantics TaruBot relied on from Nodestone plus the compatibility fixes the old sidecar patched
 * into it:
 *
 * - a definition selects one element (or all, with `multiple`) and yields its innerHTML or an
 *   attribute ('' when absent), raw and unconverted, so large IDs and explicit zero survive;
 * - a regex yields its named groups, spread into the enclosing record (SERVER → World and DC);
 *   Python-style `(?P<name>` groups are translated to JavaScript's `(?<name>`;
 * - a group of definitions yields a record of its non-null results, or null when none matched;
 * - a group with a ROOT yields `{ List: [...] }`, one record per ROOT element, malformed rows kept;
 * - the top-level ROOT column narrows the page (a page without it is invalid), and ENTRY's list and
 *   PAGE_INFO's regex groups spread into the result, which paginated pages turn into `Pagination`.
 *
 * Pure: no network. It runs inside a parser worker (worker.ts), which receives the page and the active
 * selector files from the bot; which page and keys each operation reads is in pages.ts.
 */
import { parseHTML } from "linkedom";
import type { SelectorRegistry } from "./bundled.js";
import { pagePlan } from "./pages.js";
import type { ParseRequest } from "./protocol.js";

/** One selector definition. */
interface Definition {
  readonly selector: string;
  readonly attribute?: string;
  readonly regex?: string;
  readonly multiple?: boolean;
}

/** A parsed node: a value or record, and whether a record spreads into its parent. */
interface Parsed {
  readonly patch: boolean;
  readonly data: unknown;
}

/**
 * A selector key as its result field: FREE_COMPANY → FreeCompany, FC_RANK_ICON → FcRankIcon. The
 * case-insensitive "Id" → "ID" step is Nodestone's, kept for identical output (it also turns an
 * unused crest layer's "Middle" into "MIDdle").
 */
export function columnName(key: string): string {
  return key
    .split("_")
    .map((part) => `${part.slice(0, 1)}${part.slice(1).toLowerCase()}`)
    .join("")
    .replace(/Id/giu, "ID");
}

/** Python-style named groups and backreferences as JavaScript's. */
export function translateRegex(pattern: string): RegExp {
  return new RegExp(pattern.replaceAll("(?P<", "(?<").replace(/\(\?P=(\w+)\)/gu, "\\k<$1>"));
}

function isDefinition(value: unknown): value is Definition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { selector?: unknown }).selector === "string"
  );
}

/** A minimal DOM surface: linkedom documents and elements both provide it. */
interface Scope {
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): Iterable<ElementLike>;
}
interface ElementLike {
  readonly innerHTML: string;
  getAttribute(name: string): string | null;
}

/** An element's value: innerHTML or an attribute, or its regex's named groups. */
function elementValue(element: ElementLike | null, definition: Definition): unknown {
  if (!element) return null;
  const raw = definition.attribute
    ? (element.getAttribute(definition.attribute) ?? "")
    : (element.innerHTML ?? "");
  if (!definition.regex) return raw;
  const match = translateRegex(definition.regex).exec(raw);
  return match ? { ...(match.groups ?? {}) } : null;
}

/** Parse one definition, group or list against a document or fragment. */
function node(definition: unknown, scope: Scope): Parsed {
  if (definition === null || definition === undefined) return { patch: false, data: null };
  if (isDefinition(definition)) {
    if (definition.multiple) {
      const values: unknown[] = [];
      for (const element of scope.querySelectorAll(definition.selector))
        values.push(elementValue(element, definition));
      return { patch: false, data: values };
    }
    const data = elementValue(scope.querySelector(definition.selector), definition);
    return { patch: data !== null && typeof data === "object", data };
  }
  const registry = definition as SelectorRegistry;
  if (registry.ROOT) return { patch: false, data: list(registry, scope) };
  let record: Record<string, unknown> | null = null;
  for (const [key, child] of Object.entries(registry)) {
    const parsed = node(child, scope);
    if (parsed.data === null || parsed.data === undefined) continue;
    record = parsed.patch
      ? { ...(record ?? {}), ...(parsed.data as Record<string, unknown>) }
      : { ...(record ?? {}), [columnName(key)]: parsed.data };
  }
  return { patch: false, data: record };
}

/** A group with a ROOT: one record per ROOT element; malformed rows stay visible as null. */
function list(registry: SelectorRegistry, scope: Scope): { List: unknown[] } | null {
  const { ROOT, ...fields } = registry;
  const roots = node(ROOT, scope).data;
  if (!Array.isArray(roots)) return null;
  return {
    List: roots.map((html) => node(fields, parseHTML(String(html)).document as Scope).data),
  };
}

/**
 * Parse one page. `files` are the operation's selector files (pagePlan), read from the active set.
 * Throws when a paginated page has no ROOT, which the worker reports as an invalid response.
 */
export function parsePage(
  input: ParseRequest,
  html: string,
  files: readonly SelectorRegistry[],
): Record<string, unknown> {
  const selectors: SelectorRegistry = Object.assign({}, ...files);
  let scope = parseHTML(html).document as Scope;
  const result: Record<string, unknown> = {};
  for (const key of pagePlan(input).keys) {
    const definition = selectors[key] ?? null;
    if (key === "ROOT") {
      const context = node(definition, scope).data;
      if (typeof context !== "string") throw new Error("Missing page root");
      scope = parseHTML(context).document as Scope;
      continue;
    }
    const parsed = node(definition, scope);
    if (parsed.patch || key === "ENTRY") Object.assign(result, parsed.data ?? {});
    else result[columnName(key)] = parsed.data;
  }
  if (input.operation !== "members" && input.operation !== "search") return result;
  // Paginated pages: PAGE_INFO's groups become Pagination.
  const current = Number(result.CurrentPage);
  const total = Number(result.NumPages);
  delete result.CurrentPage;
  delete result.NumPages;
  result.Pagination = {
    Page: current,
    PageTotal: total,
    PageNext: current < total ? current + 1 : null,
    PagePrev: current <= 1 ? null : current - 1,
  };
  return result;
}
