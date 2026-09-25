-- migrations/010_status_notices.sql (TaruBot 2.27.0; owner decisions of 2026-09-25, issue #31).
-- Officer status notices: one post in the officer notifications channel, about two minutes after the
-- first change, lists the members who gained or lost Member, Guest, Officer or FC Leader (with the
-- reason the bot decided it) and the linked characters that left the FC. Everything lives on the
-- member's guild_users row, so there is no change table, no command and no setting.
--
-- status_state:   NULL until the member is first observed. Otherwise a JSON document validated on
--                 every read (src/domain/status.ts): the join time it belongs to, the access last
--                 announced (or silently taken as the baseline), the last decisive access, the reason
--                 for each difference, and the confirmed FC departures not yet posted. Only decisions
--                 that don't depend on the roles a member already holds are recorded, so rebinding a
--                 role, an out-of-date roster or a hand edit the bot keeps never posts anything.
-- status_since:   when the member first had something waiting to be announced (database clock);
--                 NULL exactly when nothing is waiting. The two-minute window counts from the oldest.
-- status_posting: the exact lines this member contributes to the post being sent, with the post's
--                 batch ID, its position and freeze time. NULL when the member is in no post in
--                 flight. A retry resends a frozen batch unchanged, under the same nonce.
--
-- Resulting state of existing rows: all three NULL, so the first pass after the deploy only records
-- everyone's baseline and posts nothing. No index: every query filters on guild_id, the primary key's
-- prefix. Additive; needs no superuser.

ALTER TABLE guild_users
  ADD COLUMN status_state jsonb,
  ADD COLUMN status_since timestamptz,
  ADD COLUMN status_posting jsonb;
