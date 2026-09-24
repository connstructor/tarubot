/**
 * One codec builds and parses every button custom ID, so a renderer and its handler can't drift.
 * IDs read `<prefix>:<action>[:<selector>…]` and carry only selectors (an FC, an entry number, a
 * character, a run, an application or a target member), never the clicker's identity, roles or
 * authority: every click resolves a fresh actor and is authorized again. Parsing is strict (exact
 * segment counts, canonical decimals and lowercase UUIDs); anything else is an out-of-date or
 * forged control and fails as Failure('stale').
 *
 * The grammar (each ID at most 100 characters at maximum inputs):
 * - ledger:open:<c|h>:<fcId>                     View history, opened as a new reply
 * - ledger:latest:<c|h>:<fcId>                   pager, edits the page in place
 * - ledger:newer|older:<c|h>:<fcId>[:<before>]   pager; a disabled button omits the cursor
 * - details:balance:<c|h>:<fcId>                 officer Full details (JSON)
 * - details:history:<c|h>:<fcId>[:<before>]
 * - details:sync[:<run>]
 * - details:guest:<userId>, details:characters:<userId>
 * - details:config
 * - verify:claim:<characterId>, verify:again:<characterId>
 * - config:validate
 * - sync:status[:<run>]
 * - guest:approve|deny:<application>              review buttons, unchanged since 2.12.0
 * Scope c is "the FC linked when this was rendered", h a historical FC chosen with fc_id.
 *
 * Messages outlive deployments, so a grammar only ever gains actions; a retired action keeps
 * parsing for at least one minor release. The /apply form's guest-apply:<guild>:<user>:<joined>
 * modal ID binds the form to its opener and stays with its parser in guest-application.ts.
 */
import { Failure, MAX_GIL, MAX_ID } from "../domain/values.js";

/** Which FC a ledger control means: the currently linked one, or a historical one. */
export type LedgerScope = "c" | "h";

/** A parsed custom ID; its fields are selectors only. */
export type ControlId =
  | {
      readonly prefix: "ledger";
      readonly action: "open" | "latest";
      readonly scope: LedgerScope;
      readonly fcId: string;
    }
  | {
      readonly prefix: "ledger";
      readonly action: "newer" | "older";
      readonly scope: LedgerScope;
      readonly fcId: string;
      /** The page's cursor (entries below this number); null for the newest page. */
      readonly before: bigint | null;
    }
  | {
      readonly prefix: "details";
      readonly action: "balance";
      readonly scope: LedgerScope;
      readonly fcId: string;
    }
  | {
      readonly prefix: "details";
      readonly action: "history";
      readonly scope: LedgerScope;
      readonly fcId: string;
      readonly before: bigint | null;
    }
  | { readonly prefix: "details"; readonly action: "sync"; readonly run: string | null }
  | {
      readonly prefix: "details";
      readonly action: "guest" | "characters";
      /** The member whose record the officer view shows (a target, not the clicker). */
      readonly userId: string;
    }
  | { readonly prefix: "details"; readonly action: "config" }
  | {
      readonly prefix: "verify";
      readonly action: "claim" | "again";
      readonly characterId: string;
    }
  | { readonly prefix: "config"; readonly action: "validate" }
  | { readonly prefix: "sync"; readonly action: "status"; readonly run: string | null }
  | {
      readonly prefix: "guest";
      readonly action: "approve" | "deny";
      readonly application: string;
    };

/** A custom-ID prefix this codec owns; each is one discovered component module's namespace. */
export type ControlPrefix = ControlId["prefix"];

/** The controls a prefix owns. */
export type ControlOf<P extends ControlPrefix> = Extract<ControlId, { readonly prefix: P }>;

/** Longest custom ID Discord accepts. */
const MAX_LENGTH = 100;
/** Canonical decimal ID: no leading zero, sign or whitespace; the range is checked separately. */
const DECIMAL = /^[1-9][0-9]{0,19}$/u;
/** Canonical entry number: 1 to MAX_GIL (19 digits at most). */
const CURSOR = /^[1-9][0-9]{0,18}$/u;
/** Canonical lowercase UUID, as PostgreSQL renders one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Every parse failure: the control came from an older release or was forged. */
function outOfDate(): Failure {
  return new Failure(
    "stale",
    "This button is out of date. Run the command again to get a current one.",
    0,
    { kind: "stale", what: "control" },
  );
}

/** Selector checks shared by encoding (a presenter bug) and parsing (a stale control). */
const validId = (value: string): boolean => DECIMAL.test(value) && BigInt(value) <= MAX_ID;
const validCursor = (value: bigint): boolean => value >= 1n && value <= MAX_GIL;
const validUuid = (value: string): boolean => UUID.test(value);
const validScope = (value: string): value is LedgerScope => value === "c" || value === "h";

/** Reject a selector a presenter should never produce; custom IDs are built from stored data. */
function checked(valid: boolean): void {
  if (!valid) throw new Error("A custom ID selector is not canonical.");
}

/** The selector segments of a control, in grammar order, after checking each one. */
function segments(control: ControlId): (string | bigint | null)[] {
  switch (control.prefix) {
    case "ledger":
    case "details":
      if ("fcId" in control) {
        checked(validScope(control.scope) && validId(control.fcId));
        if ("before" in control) {
          checked(control.before === null || validCursor(control.before));
          return [control.scope, control.fcId, control.before];
        }
        return [control.scope, control.fcId];
      }
      if ("userId" in control) {
        checked(validId(control.userId));
        return [control.userId];
      }
      if ("run" in control) {
        checked(control.run === null || validUuid(control.run));
        return [control.run];
      }
      return [];
    case "verify":
      checked(validId(control.characterId));
      return [control.characterId];
    case "config":
      return [];
    case "sync":
      checked(control.run === null || validUuid(control.run));
      return [control.run];
    case "guest":
      checked(validUuid(control.application));
      return [control.application];
  }
}

/** Build a control's custom ID. An optional trailing selector (a cursor or run) may be null. */
export function encodeControl(control: ControlId): string {
  const parts = segments(control);
  // Only the last selector is optional; a null there means the segment is omitted.
  if (parts.length && parts.at(-1) === null) parts.pop();
  if (parts.includes(null)) throw new Error("Only a custom ID's last selector may be omitted.");
  const id = [control.prefix, control.action, ...parts.map(String)].join(":");
  if (id.length > MAX_LENGTH) throw new Error("A custom ID exceeds Discord's 100 characters.");
  return id;
}

/** Parse a decimal ID segment. */
function idSegment(value: string | undefined): string {
  if (value === undefined || !validId(value)) throw outOfDate();
  return value;
}

/** Parse an optional entry-number cursor segment. */
function cursorSegment(value: string | undefined): bigint | null {
  if (value === undefined) return null;
  if (!CURSOR.test(value)) throw outOfDate();
  const cursor = BigInt(value);
  if (!validCursor(cursor)) throw outOfDate();
  return cursor;
}

/** Parse a UUID segment, optional where the grammar allows it. */
function uuidSegment(value: string | undefined, optional: true): string | null;
function uuidSegment(value: string | undefined, optional: false): string;
function uuidSegment(value: string | undefined, optional: boolean): string | null {
  if (value === undefined && optional) return null;
  if (value === undefined || !validUuid(value)) throw outOfDate();
  return value;
}

/** Parse a ledger scope letter. */
function scopeSegment(value: string | undefined): LedgerScope {
  if (value === undefined || !validScope(value)) throw outOfDate();
  return value;
}

/**
 * Require the selector count to be between `min` and `max`; an ID with extra or missing segments
 * is never guessed at.
 */
function arity(selectors: readonly string[], min: number, max = min): void {
  if (selectors.length < min || selectors.length > max) throw outOfDate();
}

/** Parse any custom ID this codec owns; everything else fails as an out-of-date control. */
export function parseControl(customId: string): ControlId {
  if (customId.length > MAX_LENGTH) throw outOfDate();
  const [prefix, action, ...selectors] = customId.split(":");
  switch (prefix) {
    case "ledger":
      if (action === "open" || action === "latest") {
        arity(selectors, 2);
        return {
          prefix,
          action,
          scope: scopeSegment(selectors[0]),
          fcId: idSegment(selectors[1]),
        };
      }
      if (action === "newer" || action === "older") {
        arity(selectors, 2, 3);
        return {
          prefix,
          action,
          scope: scopeSegment(selectors[0]),
          fcId: idSegment(selectors[1]),
          before: cursorSegment(selectors[2]),
        };
      }
      break;
    case "details":
      if (action === "balance") {
        arity(selectors, 2);
        return {
          prefix,
          action,
          scope: scopeSegment(selectors[0]),
          fcId: idSegment(selectors[1]),
        };
      }
      if (action === "history") {
        arity(selectors, 2, 3);
        return {
          prefix,
          action,
          scope: scopeSegment(selectors[0]),
          fcId: idSegment(selectors[1]),
          before: cursorSegment(selectors[2]),
        };
      }
      if (action === "sync") {
        arity(selectors, 0, 1);
        return { prefix, action, run: uuidSegment(selectors[0], true) };
      }
      if (action === "guest" || action === "characters") {
        arity(selectors, 1);
        return { prefix, action, userId: idSegment(selectors[0]) };
      }
      if (action === "config") {
        arity(selectors, 0);
        return { prefix, action };
      }
      break;
    case "verify":
      if (action === "claim" || action === "again") {
        arity(selectors, 1);
        return { prefix, action, characterId: idSegment(selectors[0]) };
      }
      break;
    case "config":
      if (action === "validate") {
        arity(selectors, 0);
        return { prefix, action };
      }
      break;
    case "sync":
      if (action === "status") {
        arity(selectors, 0, 1);
        return { prefix, action, run: uuidSegment(selectors[0], true) };
      }
      break;
    case "guest":
      if (action === "approve" || action === "deny") {
        arity(selectors, 1);
        return { prefix, action, application: uuidSegment(selectors[0], false) };
      }
      break;
  }
  throw outOfDate();
}

/**
 * Parse a custom ID for the component module that owns `prefix`. The router already routed on
 * the prefix, so a mismatch can only be a forged ID and is out of date like any other.
 */
export function parseControlFor<P extends ControlPrefix>(
  prefix: P,
  customId: string,
): ControlOf<P> {
  const control = parseControl(customId);
  if (control.prefix !== prefix) throw outOfDate();
  return control as ControlOf<P>;
}
