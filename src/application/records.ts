/** Persistence/port contracts. IDs stay strings and monetary/sequence values stay exact. */

/** Configuration revision fences queued effects; activation is separate from bot membership. */
export interface GuildRecord {
  id: string;
  fc_id: string | null;
  member_role_id: string | null;
  guest_role_id: string | null;
  officer_role_id: string | null;
  leader_role_id: string | null;
  officer_rank_name: string | null;
  officer_rank_key: string | null;
  ledger_channel_id: string | null;
  officer_notifications_channel_id: string | null;
  guest_application_channel_id: string | null;
  revision: bigint;
  active: boolean;
  effects_enabled: boolean;
}
/** A nickname baseline distinguishes successful bot writes from pending/ambiguous delivery. */
export interface UserRecord {
  guild_id: string;
  user_id: string;
  present: boolean;
  joined_at: Date | null;
  primary_character_id: string | null;
  nickname_enabled: boolean;
  nickname_baseline_set: boolean;
  nickname_before: string | null;
  /** Last confirmed bot-written value; nullable because restoring no nickname is valid. */
  nickname_last: string | null;
  nickname_written: boolean;
  /** Expected in-flight value lets restart recovery recognize an acknowledged-late write. */
  nickname_expected: string | null;
  nickname_pending: boolean;
  nickname_restore: boolean;
  nickname_suspended: boolean;
}
/** A review's join context, decision, and message identity survive process restarts. */
export interface ApplicationRecord {
  id: string;
  guild_id: string;
  user_id: string;
  joined_at: Date;
  created_at: Date;
  state: string;
  channel_id: string;
  message_id: string | null;
  reviewer_id: string | null;
  decided_at: Date | null;
  reason: string | null;
}
/** Immutable financial decision; delivery status lives in separate outbox records. */
export interface EntryRecord {
  id: string;
  account_id: string;
  sequence: bigint;
  operation: string;
  delta: bigint;
  balance: bigint;
  actor_id: string | null;
  guild_id: string;
  note: string;
  event_at: Date;
  idempotency_key: string;
}
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
