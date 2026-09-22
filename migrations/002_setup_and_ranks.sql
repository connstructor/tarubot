-- Optional staff/leader projection. These roles carry bot authority/status, never server permissions.
ALTER TABLE guilds ADD COLUMN officer_role_id external_id;
ALTER TABLE guilds ADD COLUMN leader_role_id external_id;
ALTER TABLE guilds ADD COLUMN officer_rank_name text;
ALTER TABLE guilds ADD COLUMN officer_rank_key text;
ALTER TABLE guilds ADD CONSTRAINT officer_role_distinct CHECK (
  officer_role_id IS NULL OR (officer_role_id IS DISTINCT FROM member_role_id
    AND officer_role_id IS DISTINCT FROM guest_role_id AND officer_role_id IS DISTINCT FROM leader_role_id)
);
ALTER TABLE guilds ADD CONSTRAINT leader_role_distinct CHECK (
  leader_role_id IS NULL OR (leader_role_id IS DISTINCT FROM member_role_id AND leader_role_id IS DISTINCT FROM guest_role_id)
);

-- Accepted snapshot rank facts remain attached to the observation, not mutable profile hints.
ALTER TABLE roster_members ADD COLUMN fc_rank_name text;
ALTER TABLE roster_members ADD COLUMN fc_rank_key text;
ALTER TABLE roster_members ADD COLUMN is_fc_leader boolean;

-- Explicit manager decisions override automatic officer eligibility, including after rejoin.
CREATE TABLE officer_overrides (
  guild_id external_id NOT NULL, user_id external_id NOT NULL,
  state text NOT NULL CHECK(state IN ('granted','revoked')),
  actor_id external_id NOT NULL, reason text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(guild_id,user_id),
  FOREIGN KEY(guild_id,user_id) REFERENCES guild_users(guild_id,user_id)
);
