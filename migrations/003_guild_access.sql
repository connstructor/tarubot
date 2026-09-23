-- Existing guilds retain their current access behavior until a manager explicitly runs setup.
ALTER TABLE guilds
  ADD COLUMN lobby_channel_id external_id,
  ADD COLUMN officer_channel_id external_id,
  ADD COLUMN access_policy_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN access_everyone_before text,
  ADD CONSTRAINT access_channels_distinct CHECK (lobby_channel_id IS NULL OR officer_channel_id IS NULL OR lobby_channel_id <> officer_channel_id),
  ADD CONSTRAINT access_setup_complete CHECK (NOT access_policy_enabled OR (
    lobby_channel_id IS NOT NULL AND officer_channel_id IS NOT NULL AND
    member_role_id IS NOT NULL AND guest_role_id IS NOT NULL AND
    officer_role_id IS NOT NULL AND leader_role_id IS NOT NULL
  ));

-- Preserve the first observation for recovery and keep private areas private across role rebinding.
CREATE TABLE channel_access_policies (
  guild_id external_id NOT NULL REFERENCES guilds(id),
  channel_id external_id NOT NULL,
  staff_only boolean NOT NULL,
  original_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id)
);
