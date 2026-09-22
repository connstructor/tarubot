-- Initial schema: UTC timestamptz instants, textual external IDs, and exact bigint money.
-- Keep applied migrations immutable; future schema changes belong in new numbered files.

-- Unsigned 64-bit IDs exceed PostgreSQL's signed bigint range, so validate decimal text.
CREATE DOMAIN external_id AS text CHECK (VALUE ~ '^[1-9][0-9]{0,19}$' AND VALUE::numeric <= 18446744073709551615);
-- Shared public caches keep attempted and successful roster timestamps separate.
CREATE TABLE free_companies (
  id external_id PRIMARY KEY, name text NOT NULL, tag text NOT NULL DEFAULT '', world text NOT NULL,
  dc text, profile_at timestamptz, last_successful_roster_at timestamptz, last_attempt_at timestamptz,
  last_error text, source_timestamp text
);
-- Profile FC hints are display facts; accepted rosters establish membership authority.
CREATE TABLE characters (
  id external_id PRIMARY KEY, name text NOT NULL, world text NOT NULL, dc text,
  fc_hint external_id, profile_at timestamptz
);
-- Stable identities survive Discord departures and preserve financial/audit attribution.
CREATE TABLE users (id external_id PRIMARY KEY);
-- Authority-bearing configuration is guild-scoped; revision fences stale delivery work.
CREATE TABLE guilds (
  id external_id PRIMARY KEY, fc_id external_id REFERENCES free_companies(id),
  member_role_id external_id, guest_role_id external_id, ledger_channel_id external_id,
  officer_notifications_channel_id external_id, guest_application_channel_id external_id,
  revision bigint NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
  effects_enabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (member_role_id IS NULL OR guest_role_id IS NULL OR member_role_id <> guest_role_id)
);
-- Preferences/presence belong to a guild/user pair. nickname_written distinguishes a
-- baseline from a successful bot write; expected/pending recover ambiguous acknowledgements.
CREATE TABLE guild_users (
  guild_id external_id REFERENCES guilds(id), user_id external_id REFERENCES users(id),
  present boolean NOT NULL DEFAULT false, joined_at timestamptz, imported boolean NOT NULL DEFAULT false, primary_character_id external_id REFERENCES characters(id),
  nickname_enabled boolean NOT NULL DEFAULT false, nickname_baseline_set boolean NOT NULL DEFAULT false,
  nickname_before text, nickname_last text, nickname_written boolean NOT NULL DEFAULT false, nickname_expected text, nickname_pending boolean NOT NULL DEFAULT false,
  nickname_restore boolean NOT NULL DEFAULT false, nickname_suspended boolean NOT NULL DEFAULT false, local_member_loss boolean NOT NULL DEFAULT false,
  PRIMARY KEY (guild_id, user_id)
);
-- Trusted links retain provenance after unlinking; changing ownership creates a new record.
CREATE TABLE links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guild_id external_id NOT NULL, user_id external_id NOT NULL,
  character_id external_id NOT NULL REFERENCES characters(id), active boolean NOT NULL DEFAULT true,
  provenance text NOT NULL CHECK (provenance IN ('profile_token','officer_assignment','imported_link')),
  actor_id external_id, reason text, source jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  FOREIGN KEY (guild_id,user_id) REFERENCES guild_users(guild_id,user_id), UNIQUE(id,guild_id,user_id)
);
-- The database resolves competing owners, including requests in concurrent processes.
CREATE UNIQUE INDEX one_active_owner ON links(guild_id,character_id) WHERE active;
CREATE INDEX user_links ON links(guild_id,user_id) WHERE active;
-- Proof is bound to guild/user/character and persisted only as a SHA-256 hash.
CREATE TABLE challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guild_id external_id NOT NULL, user_id external_id NOT NULL,
  character_id external_id NOT NULL REFERENCES characters(id), token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, consumed_at timestamptz, replaced_at timestamptz,
  FOREIGN KEY (guild_id,user_id) REFERENCES guild_users(guild_id,user_id)
);
-- Replacements invalidate their predecessor before inserting a new live challenge.
CREATE UNIQUE INDEX live_challenges ON challenges(guild_id,user_id,character_id) WHERE consumed_at IS NULL AND replaced_at IS NULL;
-- Only complete observations are published here; a crawl retains its acquisition interval.
CREATE TABLE roster_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fc_id external_id NOT NULL REFERENCES free_companies(id),
  started_at timestamptz NOT NULL, observed_at timestamptz NOT NULL, member_count integer NOT NULL CHECK(member_count >= 0),
  evidence jsonb NOT NULL
);
CREATE INDEX latest_roster ON roster_snapshots(fc_id,observed_at DESC);
-- Unique IDs support count reconciliation independently of later character renames.
CREATE TABLE roster_members (
  snapshot_id uuid REFERENCES roster_snapshots(id), character_id external_id REFERENCES characters(id), PRIMARY KEY(snapshot_id,character_id)
);
-- Preserve first absence across restart. confirmed_snapshot_id excludes import-only
-- access-preservation baselines from ledger authority until live positive evidence exists.
CREATE TABLE membership (
  guild_id external_id REFERENCES guilds(id), fc_id external_id REFERENCES free_companies(id), character_id external_id REFERENCES characters(id),
  state text NOT NULL CHECK(state IN ('present','missing','absent')), first_absence_at timestamptz,
  snapshot_id uuid REFERENCES roster_snapshots(id), confirmed_snapshot_id uuid REFERENCES roster_snapshots(id), source jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(guild_id,fc_id,character_id)
);
-- Former-member evidence references the supporting trusted link and its owning guild/user.
-- Imported evidence uses source keys/checksum when no live snapshot supported the fact.
CREATE TABLE membership_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guild_id external_id NOT NULL, user_id external_id NOT NULL,
  fc_id external_id NOT NULL REFERENCES free_companies(id), link_id uuid NOT NULL REFERENCES links(id),
  snapshot_id uuid REFERENCES roster_snapshots(id), source jsonb NOT NULL DEFAULT '{}', observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(guild_id,user_id) REFERENCES guild_users(guild_id,user_id), UNIQUE(link_id,fc_id),
  FOREIGN KEY(link_id,guild_id,user_id) REFERENCES links(id,guild_id,user_id)
);
CREATE INDEX former_members ON membership_history(guild_id,user_id,fc_id);
-- Revocation overrides explicit grants and automatic former-member guest eligibility.
CREATE TABLE guest_state (
  guild_id external_id NOT NULL, user_id external_id NOT NULL, revoked boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT now(), actor_id external_id, reason text,
  PRIMARY KEY(guild_id,user_id), FOREIGN KEY(guild_id,user_id) REFERENCES guild_users(guild_id,user_id)
);
-- Grants survive departure and deduplicate by their decision/import source identity.
CREATE TABLE guest_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guild_id external_id NOT NULL, user_id external_id NOT NULL,
  provenance text NOT NULL CHECK(provenance IN ('approved','manual','imported_guest')),
  source_key text NOT NULL UNIQUE, actor_id external_id, reason text, source jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(guild_id,user_id) REFERENCES guild_users(guild_id,user_id)
);
-- Durable review identity and join context prevent approving a departed/obsolete applicant.
CREATE TABLE guest_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guild_id external_id NOT NULL, user_id external_id NOT NULL,
  joined_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','cancelled','superseded')),
  channel_id external_id NOT NULL, message_id external_id, reviewer_id external_id, decided_at timestamptz, reason text,
  FOREIGN KEY(guild_id,user_id) REFERENCES guild_users(guild_id,user_id)
);
-- Enforce one pending request even when submissions race across handlers.
CREATE UNIQUE INDEX one_pending_application ON guest_applications(guild_id,user_id) WHERE state='pending';
-- NULL is uninitialized. Known zero has an opening entry and a positive account sequence.
CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guild_id external_id NOT NULL REFERENCES guilds(id),
  fc_id external_id NOT NULL REFERENCES free_companies(id), balance bigint CHECK(balance >= 0),
  sequence bigint NOT NULL DEFAULT 0, UNIQUE(guild_id,fc_id), UNIQUE(id,guild_id),
  CHECK((balance IS NULL AND sequence=0) OR (balance IS NOT NULL AND sequence>=1))
);
-- Append-only exact deltas/resulting balances. Composite foreign keys keep entries
-- and correction references inside the owning guild/account.
CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  sequence bigint NOT NULL CHECK(sequence > 0), operation text NOT NULL CHECK(operation IN ('import','initialize','deposit','withdraw','adjust')),
  delta bigint NOT NULL, balance bigint NOT NULL CHECK(balance >= 0), actor_id external_id, guild_id external_id NOT NULL REFERENCES guilds(id),
  note text NOT NULL CHECK(length(btrim(note)) > 0), event_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL UNIQUE, correction_id uuid REFERENCES ledger_entries(id), source jsonb NOT NULL DEFAULT '{}',
  UNIQUE(account_id,sequence), UNIQUE(id,account_id), CHECK(operation <> 'deposit' OR delta > 0), CHECK(operation <> 'withdraw' OR delta < 0),
  FOREIGN KEY(account_id,guild_id) REFERENCES ledger_accounts(id,guild_id),
  FOREIGN KEY(correction_id,account_id) REFERENCES ledger_entries(id,account_id)
);
-- Corrections append; updates/deletes cannot rewrite acknowledged financial history.
CREATE FUNCTION immutable_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Ledger entries are immutable'; END $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION immutable_entry();
-- Queue/outbox payload version describes shape; generation invalidates superseded work;
-- lease tokens prevent expired workers from publishing another worker's results.
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, guild_id external_id REFERENCES guilds(id),
  user_id external_id, payload jsonb NOT NULL, payload_version integer NOT NULL DEFAULT 1 CHECK(payload_version>0), dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','blocked','failed','disabled')),
  generation integer NOT NULL DEFAULT 1, attempts integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, last_error text, result jsonb,
  message_id external_id
);
-- Deduplicate active work while allowing later independent runs after success/failure.
CREATE UNIQUE INDEX active_job ON jobs(dedupe_key) WHERE status IN ('queued','running','blocked');
CREATE INDEX due_jobs ON jobs(due_at) WHERE status IN ('queued','running');
-- At-least-once notification history remains separate from committed application decisions.
CREATE TABLE delivery_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id uuid REFERENCES jobs(id), attempted_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL, message_id external_id, diagnostic text
);
-- Request ownership keeps status inspection authorized after interaction tokens expire.
CREATE TABLE sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guild_id external_id NOT NULL REFERENCES guilds(id), requester_id external_id,
  job_id uuid REFERENCES jobs(id), created_at timestamptz NOT NULL DEFAULT now(), enumeration_completed_at timestamptz,
  status text NOT NULL DEFAULT 'queued', result jsonb
);
-- Coalesced jobs can satisfy multiple requests; child work keeps completion status honest.
CREATE TABLE sync_run_jobs (
  run_id uuid REFERENCES sync_runs(id), job_id uuid REFERENCES jobs(id), PRIMARY KEY(run_id,job_id)
);
CREATE INDEX run_jobs_by_job ON sync_run_jobs(job_id);
-- Clearing/replacing roles retains durable cleanup targets without touching unrelated roles.
CREATE TABLE retired_roles (
  guild_id external_id REFERENCES guilds(id), role_id external_id, revision bigint NOT NULL, PRIMARY KEY(guild_id,role_id)
);
-- Human decisions and operator actions are recorded with their owning guild and target.
CREATE TABLE audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, guild_id external_id NOT NULL REFERENCES guilds(id), actor_id external_id,
  action text NOT NULL, target text, details jsonb NOT NULL DEFAULT '{}', event_at timestamptz NOT NULL DEFAULT now()
);
-- Fingerprint plus original mapping prevents reruns from overwriting later application state.
CREATE TABLE imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fingerprint text NOT NULL UNIQUE, report jsonb NOT NULL,
  source_timezone text NOT NULL, snapshot_checksum text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now()
);
