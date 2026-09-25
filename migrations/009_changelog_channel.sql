-- migrations/009_changelog_channel.sql (TaruBot 2.25.0; owner decisions of 2026-09-25, issue #30).
-- Update posts: officers pick a channel with /config changelog channel:#…, and when the bot starts on
-- a newer version it posts one short "what's new" message there, listing the member notes of every
-- release since the last post. Releases without a member note are never shown, and an update with
-- nothing for members posts nothing.
--
-- changelog_channel_id: where update posts go; NULL (the default) means posts are off.
-- changelog_version:    the newest version this guild has been told about (its baseline). It is set
--                       to the running version (or kept, if higher) when a channel is first set, so
--                       setting a channel posts nothing now; the first post comes with the next
--                       release that has a member note. A delivered or empty post moves it forward
--                       with a compare-and-set, and the bot never lowers it, so a restart or a
--                       rollback between releases on the same schema never posts again.
--
-- Resulting state of existing rows: both columns NULL, so nothing is posted on this deploy and
-- `revision` is unchanged. The version CHECK accepts MAJOR.MINOR.PATCH with an optional prerelease,
-- the only shape Bun.semver.order is asked to compare, and changelog_baseline keeps a channel from
-- ever being set without a baseline. Additive; needs no superuser.

ALTER TABLE guilds
  ADD COLUMN changelog_channel_id external_id,
  ADD COLUMN changelog_version text
    CHECK (changelog_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'),
  ADD CONSTRAINT changelog_baseline
    CHECK (changelog_channel_id IS NULL OR changelog_version IS NOT NULL);
