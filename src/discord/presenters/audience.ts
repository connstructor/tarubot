/**
 * Who a reply is written for. The router derives the audience once from the same fresh actor the
 * service authorizes against, so presenters choose wording and detail but never make access
 * decisions: the service stays the only authorization and filtering boundary.
 */
import type { Actor } from "../../domain/policy.js";

/**
 * member: ordinary users. officer: bot officers (Manage Server, or delegated through the Officer
 * role). manager: officers who also hold Manage Roles with real server authority, the people who
 * may change officer authority itself.
 */
export type Audience = "member" | "officer" | "manager";

/** The person a reply is rendered for, plus the interaction reference shown in failure footers. */
export interface Viewer {
  readonly audience: Audience;
  readonly userId: string;
  readonly guildId: string;
  /** The interaction ID: the Ref in failure footers and the `operation` field in logs. */
  readonly ref: string;
  /** Discord's Manage Server, as authorizeRoleManager reads it (officer when unknown). */
  readonly manageGuild: boolean;
  /** Discord's Manage Roles, for the failure presenter's "Missing permission" field. */
  readonly manageRoles: boolean;
}

/**
 * The audience for an actor. Manager mirrors authorizeRoleManager exactly: server authority
 * (Manage Server, falling back to officer when the flag is unknown) together with Manage Roles.
 * A delegated officer holding Manage Roles is still an officer, because the policy refuses them.
 */
export function audienceOf(actor: Actor): Audience {
  if ((actor.serverManager ?? actor.officer) && actor.manageRoles) return "manager";
  return actor.officer ? "officer" : "member";
}

/** Build the viewer for an authorized actor and the interaction being answered. */
export function viewerOf(actor: Actor, ref: string): Viewer {
  return {
    audience: audienceOf(actor),
    userId: actor.userId,
    guildId: actor.guildId,
    ref,
    manageGuild: actor.serverManager ?? actor.officer,
    manageRoles: actor.manageRoles,
  };
}

/** Officers and managers see officer detail: raw IDs, job diagnostics and officer next steps. */
export const isOfficer = (viewer: Viewer): boolean => viewer.audience !== "member";
