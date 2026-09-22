/** Persistence/port contracts. IDs stay strings and monetary/sequence values stay exact. */
import type {
  guilds,
  guildUsers,
  guestApplications,
  ledgerEntries,
} from "../infrastructure/postgres/schema.js";

/** Configuration revision fences queued effects; activation is separate from bot membership. */
export type GuildRecord = Omit<typeof guilds.$inferSelect, "created_at">;
/** A nickname baseline distinguishes successful bot writes from pending/ambiguous delivery. */
export type UserRecord = Omit<typeof guildUsers.$inferSelect, "imported" | "local_member_loss">;
/** A review's join context, decision, and message identity survive process restarts. */
export type ApplicationRecord = typeof guestApplications.$inferSelect;
/** Immutable financial decision; delivery status lives in separate outbox records. */
export type EntryRecord = Omit<typeof ledgerEntries.$inferSelect, "correction_id" | "source">;
/** Application-owned snapshot of a current Discord member, avoiding SDK objects in policy. */
export interface MemberView {
  id: string;
  guildId: string;
  joinedAt: Date;
  nickname: string | null;
  roles: string[];
  bot: boolean;
}
/** Presentation input for a persisted review outcome. */
export interface ReviewMessage {
  application: ApplicationRecord;
  content: string;
}
/** Effect boundary implemented by DiscordGateway and controlled integration-test fixtures. */
export interface DiscordPort {
  /** Null is an observed departure; transport failures reject instead of implying absence. */
  member(guild: string, user: string): Promise<MemberView | null>;
  /** Resolve only after complete member enumeration has been checked. */
  members(guild: string): Promise<MemberView[]>;
  /** Validate access-role permissions and both actor/bot hierarchy where applicable. */
  validateRole(guild: string, role: string, actor?: string): Promise<void>;
  /** Check guild ownership and the message/embed/history permissions needed for delivery. */
  validateChannel(guild: string, channel: string): Promise<void>;
  /** Individual deltas must preserve unrelated roles, including concurrent external changes. */
  roles(guild: string, user: string, add: string[], remove: string[]): Promise<void>;
  /** Hoist/reorder only configured role IDs; guard is checked before externally visible writes. */
  layoutRoles(
    guild: string,
    priority: readonly string[],
    guard: () => Promise<void>,
  ): Promise<unknown>;
  /** Return false if a fresh nickname differs from expected; never overwrite that manual change. */
  nickname(
    guild: string,
    user: string,
    value: string | null,
    expected: string | null,
  ): Promise<boolean>;
  /** Stable keys identify retries of the same logical notification. */
  send(
    guild: string,
    channel: string,
    content: string,
    key: string,
    application?: ApplicationRecord,
  ): Promise<string>;
  /** Repair a deleted review message from its durable application record. */
  editReview(application: ApplicationRecord, content: string): Promise<string>;
  /** Best-effort delivery is tracked independently from approval/denial. */
  dm(user: string, content: string): Promise<void>;
}
