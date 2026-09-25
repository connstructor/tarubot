-- migrations/007_profile_checks.sql (TaruBot 2.17.0; owner decisions of 2026-09-24).
-- Profile refreshes after the Linode move showed a retry storm: the 30-second scheduler re-queued
-- every stale profile, pulled a backing-off job forward each tick, and re-created a job as soon as
-- the last one failed, so one deleted or private character cost the Lodestone requests every minute.
--
-- profile_retry_at: the scheduler queues no profile refresh for a character before this time. It is
-- stamped an hour ahead whenever the scheduler queues one, so a failing profile is tried at most once
-- an hour however its job ends; a private profile moves it to the normal profile interval; a
-- successful refresh clears it.
--
-- profile_missing_at: when the Lodestone first answered 404 ("no such character") for a linked
-- character. The owner requires two 404s before unlinking, "just in case": a second 404 at least an
-- hour later ends every active link to the character, audited, with an officer notice. Any later
-- sighting (a profile read, a private profile, a roster listing) proves the character exists and
-- clears it.
--
-- Both columns are NULL for existing rows, which keeps today's behavior until the first refresh.

ALTER TABLE characters
  ADD COLUMN profile_retry_at timestamptz,
  ADD COLUMN profile_missing_at timestamptz;
