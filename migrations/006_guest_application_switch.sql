-- migrations/006_guest_application_switch.sql (TaruBot 2.15.0; owner decision of 2026-09-24).
-- Guest applications get their own switch, separate from the review channel: "The channel setting
-- should be separate from whether applications are enabled." /apply opens only when the switch is
-- on, a review channel is set and a Guest role is set. /config guest_applications enabled:true|false
-- turns it on and off, channel:#… sets the review channel and unset_channel:true unsets it.
-- Resulting state of existing rows:
--   * guilds with a review channel that are not awaiting first activation (e.g. DevBot
--     1040379370159743139): guest_applications_enabled=true, so /apply stays open as before;
--   * guilds without a review channel: false (closed, as before);
--   * imported guilds still awaiting first activation (guest_grandfather='pending'): false even with a
--     review channel, so activation never opens applications implicitly;
--   * an empty database (new managed production cluster, test runs): the UPDATE is a no-op. Guilds
--     created later start off; /setup turns applications on, and the importer keeps them off while
--     storing the legacy review channel.
-- The UPDATE does not change guilds.revision, so a guild such as DevBot keeps its configuration revision.

ALTER TABLE guilds ADD COLUMN guest_applications_enabled boolean NOT NULL DEFAULT false;

UPDATE guilds SET guest_applications_enabled = true
 WHERE guest_application_channel_id IS NOT NULL
   AND guest_grandfather IS DISTINCT FROM 'pending';
