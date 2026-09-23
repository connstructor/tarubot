/**
 * The approved buttons. Link buttons point at the Lodestone; every other button's custom ID is
 * built by the codec in ../custom-ids.ts, so its handler parses exactly what was rendered. The
 * handlers re-authorize whoever clicks, so these carry selectors only.
 */
import { encodeControl, type ControlOf, type LedgerScope } from "../custom-ids.js";
import { lodestone } from "./format.js";
import type { ButtonSpec } from "./reply.js";

/** 'Open Lodestone profile': the character's public page (approved characters#0). */
export const lodestoneProfileButton = (characterId: string): ButtonSpec => ({
  style: "link",
  label: "Open Lodestone profile",
  url: lodestone.character(characterId),
});

/** 'Edit Character Profile': where the claim token is pasted (approved characters#0). */
export const editProfileButton = (): ButtonSpec => ({
  style: "link",
  label: "Edit Character Profile",
  url: lodestone.profileEdit,
});

/**
 * /claim's primary 'I've added it — verify now' (a new reply, so the token message is never
 * edited) and /verify's 'Check again' (re-renders the pending card in place).
 */
export function verifyButton(mode: "claim" | "again", characterId: string): ButtonSpec {
  return {
    style: mode === "claim" ? "primary" : "secondary",
    label: mode === "claim" ? "I've added it — verify now" : "Check again",
    customId: encodeControl({ prefix: "verify", action: mode, characterId }),
  };
}

/** Where a history page sits, from the service's exact paging counts and cursors. */
export interface PagerState {
  readonly scope: LedgerScope;
  readonly fcId: string;
  /** Entries newer than this page. */
  readonly above: number;
  /** Cursor for the next newer page, 'latest' when that is the newest page, or null. */
  readonly newer: bigint | "latest" | null;
  /** Cursor for the next older page, or null on the oldest page. */
  readonly older: bigint | null;
}

/**
 * The history pager, edited in place. Latest and Newer are enabled whenever at least one newer
 * entry exists (above > 0), whatever cursor the page was opened with; Latest is hidden on the
 * newest page and Newer disabled there. Older is disabled on the oldest page. A disabled button
 * omits its cursor, and each action name keeps the IDs unique within the message.
 */
export function ledgerPager(page: PagerState): ButtonSpec[] {
  const newer = page.above > 0;
  const buttons: ButtonSpec[] = [];
  if (newer)
    buttons.push({
      style: "secondary",
      label: "Latest",
      customId: encodeControl({
        prefix: "ledger",
        action: "latest",
        scope: page.scope,
        fcId: page.fcId,
      }),
    });
  buttons.push(
    {
      style: "secondary",
      label: "Newer",
      disabled: !newer,
      customId: encodeControl({
        prefix: "ledger",
        action: "newer",
        scope: page.scope,
        fcId: page.fcId,
        // No cursor opens the newest page; a disabled button carries none either.
        before: newer && typeof page.newer === "bigint" ? page.newer : null,
      }),
    },
    {
      style: "secondary",
      label: "Older",
      disabled: page.older === null,
      customId: encodeControl({
        prefix: "ledger",
        action: "older",
        scope: page.scope,
        fcId: page.fcId,
        before: page.older,
      }),
    },
  );
  return buttons;
}

/** /ledger balance's 'View history': opens history page 1 as a new reply. */
export const viewHistoryButton = (scope: LedgerScope, fcId: string): ButtonSpec => ({
  style: "secondary",
  label: "View history",
  customId: encodeControl({ prefix: "ledger", action: "open", scope, fcId }),
});

/** A details target: which officer read view to re-run, and its selectors. */
export type DetailsTarget =
  ControlOf<"details"> extends infer Control
    ? Control extends { readonly prefix: "details" }
      ? Omit<Control, "prefix">
      : never
    : never;

/**
 * 'Full details (JSON)' on officer read views that summarize or cut records: /sync status,
 * another member's /guest status or /characters, and /ledger balance or history. /config show and
 * validate keep their approved button rows (their embeds are complete), so they don't offer it.
 * It opens a new reply with the JSON file.
 */
export function detailsButton(target: DetailsTarget): ButtonSpec {
  return {
    style: "secondary",
    label: "Full details (JSON)",
    customId: encodeControl({ prefix: "details", ...target } as ControlOf<"details">),
  };
}

/** /config show's 'Run health check' and /config validate's 'Re-check'; both edit in place. */
export const recheckButton = (label: "Run health check" | "Re-check"): ButtonSpec => ({
  style: "secondary",
  label,
  customId: encodeControl({ prefix: "config", action: "validate" }),
});

/**
 * The review message's Approve and Deny (moved here from the gateway in 2.14.0). Their custom IDs
 * are unchanged since 2.12.0, because posted review messages still carry them; both are disabled
 * once the application is decided, so the message keeps its record without live controls.
 */
export function reviewButtons(application: string, decided: boolean): ButtonSpec[] {
  return (["approve", "deny"] as const).map((action) => ({
    style: action === "approve" ? "success" : "danger",
    label: action === "approve" ? "Approve" : "Deny",
    disabled: decided,
    customId: encodeControl({ prefix: "guest", action, application }),
  }));
}

/** /setup's 'Check sync status', optionally for one run; it opens a new reply. */
export const syncStatusButton = (run: string | null = null): ButtonSpec => ({
  style: "secondary",
  label: "Check sync status",
  customId: encodeControl({ prefix: "sync", action: "status", run }),
});
