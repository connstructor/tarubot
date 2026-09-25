-- migrations/008_issue_reports.sql (TaruBot 2.18.0; owner decisions of 2026-09-24).
-- Issue reports go to a private GitHub repository: /issue from any member, and automatic reports of
-- unexpected errors, terminal job failures and repeated trouble (a roster not accepted for 12 hours,
-- the Lodestone unreachable for an hour). This table is the durable side of that: a report is saved
-- here first, in the transaction that detected it, and a job delivers it to GitHub later, so a GitHub
-- outage or a missing token loses nothing.
--
-- One row per fingerprint. Automatic reports of the same trouble share a fingerprint: repeats add to
-- `occurrences` and replace `latest`, and delivery comments on the issue at most hourly with the
-- count since the last post, instead of opening a new issue each time. A user report is its own
-- fingerprint (the interaction), with the reporter and server kept for the /issue limits.
--
-- body:   the first occurrence's Markdown report (the issue body).
-- latest: the newest repeat's Markdown report, posted with the next repeat comment.
-- issue_number and issue_created_at: set once GitHub opened the issue; a repeat of a closed issue
-- opens a new one and moves these to it.

CREATE TABLE issue_reports (
  fingerprint text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('user', 'error', 'job', 'trouble')),
  title text NOT NULL,
  body text NOT NULL,
  latest text,
  guild_id external_id,
  user_id external_id,
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  posted_occurrences integer NOT NULL DEFAULT 0 CHECK (posted_occurrences >= 0),
  issue_number integer,
  issue_created_at timestamptz,
  posted_at timestamptz,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now()
);

-- The /issue limits: one per user per 10 minutes, twenty per server per day.
CREATE INDEX issue_reports_user_recent ON issue_reports (user_id, first_at) WHERE source = 'user';
CREATE INDEX issue_reports_guild_recent ON issue_reports (guild_id, first_at) WHERE source = 'user';
-- The delivery sweep: reports not yet on GitHub, or with repeats not yet posted.
CREATE INDEX issue_reports_pending ON issue_reports (last_at)
  WHERE issue_number IS NULL OR occurrences > posted_occurrences;
