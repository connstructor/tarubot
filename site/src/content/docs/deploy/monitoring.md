---
title: Monitoring
description: Health probes, logs, background jobs, Lodestone refreshes, officer notices, update posts, issue reports and the optional heartbeat.
sidebar:
  order: 6
---

## Health probes

The bot serves two probes on `HEALTH_PORT` (3000 by default) inside its container. No port is published: read them through the container. The command reads the port from the container's own setting, as Compose's health check does.

```sh
docker compose exec -T tarubot \
  bun -e 'const r = await fetch("http://127.0.0.1:" + (process.env.HEALTH_PORT || "3000") + "/health/ready"); console.log(await r.text())'
```

- **`/health/live`** answers 200 whenever the process can answer at all, even while it waits for the writer lease.
- **`/health/ready`** is 200 only when the bot is fully working, and 503 otherwise. Compose's health check uses it.

The readiness body reports:

| Field | Meaning |
| --- | --- |
| `live` | `true` until shutdown begins. |
| `ready` | The overall verdict. |
| `database` | The database is reachable and on the expected schema. |
| `writerLease` | This process holds the [writer lease](/tarubot/deploy/operations/#single-database-writer). `false` means another bot holds it. |
| `discord` | Connected to Discord. |
| `effects` | `ENABLE_EFFECTS` is on. |
| `publicTestResponses` | Development replies are public: `TEST_GUILD_ID` is set and `PUBLIC_TEST_RESPONSES` is on. Normally `false`. |
| `capabilities` | Pending and blocked work, the age of the oldest accepted roster, and FCs whose roster reads are failing. |
| `lodestone` | Informational; a Lodestone outage never makes the bot unready. `parsing` and `waiting` count parses running and waiting; `cooldownSeconds` above 0 means Lodestone requests are paused after a 429; `selectors` shows the [live selector set](#live-selectors). |

Probes never fetch a Lodestone page. The bot also logs a capability summary periodically: queue counts, blocked work, the oldest roster's age and failing FCs.

## Logs

```sh
docker compose logs --since 1h tarubot
```

Logs are structured JSON lines. Tokens, passwords, message payloads and command option values are never logged.

**Finding a member's error.** Every failure reply ends with `Code <code> · Ref <interaction ID>`, and the log entry for it carries the same ID in `operation`:

```sh
docker compose logs tarubot | grep '"operation":"123456789012345678"'
```

The entry's `code`, `source`, `scope` and `diagnostic` say what happened. [Replies and error codes](/tarubot/reference/replies/) explains each code and log level.

**Background jobs** log each attempt with the job ID, kind, attempts, code, status and timings, never the payload:

- Expected waits (another job first, contention, a cooldown, a Lodestone rate limit, a superseded input) log at debug, and at warn once a job has waited 10 minutes.
- Blocked, paused and retrying work logs at warn.
- Terminal failures log at error.
- Each Lodestone 429 logs one line: "The Lodestone throttled TaruBot".

A member's role update (`reconcile.user`) keeps an `applied` list in its stored result: the newest 20 role changes Discord actually received, including those from a pass that a newer change later superseded. It's the record of what TaruBot really changed for that member.

## Jobs that need attention

Officers see outstanding and failed work in `/sync status`. Blocked work (a permission, the role order, a deleted channel) resumes once an officer fixes the cause. The scheduler retries it by itself about every 10 minutes; saving a `/config` role or channel, the FC link or `/config guest_applications` retries it at once, and so does queuing the same work again. `/config officer_rank`, `/config role_layout` and `/config fc unlink` don't requeue it.

A job that **failed** has stopped for good. After fixing the cause, retry it with [`retry.js`](/tarubot/deploy/tools/#retryjs), giving the server's ID and the job's full ID:

```sh
docker compose run --rm --no-deps -T tarubot bun dist/scripts/retry.js YOUR_GUILD_ID JOB_ID
```

It retries a blocked, failed or paused job of that server and clears its diagnostic. It refuses, changing nothing, when a newer job for the same work is already queued, running or blocked, and prints that job's ID. A retry recomputes what's wanted now: it never repeats a decision, and a ledger post is posted for the same entry.

To find job IDs, use the officer `/sync status` with **Full details (JSON)**, or query the database:

```sh
docker compose exec -T postgres psql -U tarubot -d tarubot -c "
SELECT id, kind, status, attempts, due_at, last_error
FROM jobs WHERE status IN ('queued','running','blocked','failed','disabled')
ORDER BY created_at;"
```

## Profile refreshes

TaruBot refreshes each linked character's profile about once every `PROFILE_INTERVAL_SECONDS` (a day by default), to keep names and worlds current.

- **Pacing.** A character's profile is queued at most once an hour, whatever happens to the job.
- **Throttling.** A Lodestone 429 pauses all Lodestone requests for a shared cooldown (15 seconds, doubling to 5 minutes). Jobs wait it out as `↻ WAITING` without using attempts, and readiness shows `lodestone.cooldownSeconds`.
- **Private profiles** complete as private and wait for the next interval. Links are unaffected, because membership comes from the FC roster.
- **Deleted characters.** A first "not found" is recorded. A second one at least an hour later ends every active link to the character, audited as an automatic unlink, with an officer notice per link. A profile read, a private answer or a roster listing in between clears the first.

To see what's waiting, private or awaiting a second "not found":

```sh
docker compose exec -T postgres psql -U tarubot -d tarubot -c "
SELECT id, name, world, profile_at, profile_retry_at, profile_missing_at
FROM characters
WHERE profile_missing_at IS NOT NULL OR profile_retry_at > now()
ORDER BY profile_missing_at NULLS LAST, profile_retry_at;"
```

## Officer notices

Officer notices are `officer.notify` jobs that post plain text to a server's officer notifications channel ([what officers see](/tarubot/admin/notices-and-updates/#officer-notices)). Each kind has its own job key:

- **Lodestone degraded** (`officer:<guild>:degraded:<fc>`). Queued on the first roster failure since the FC's last accepted roster that isn't a wait, and posted only if it is still pending 5 minutes later. While the FC keeps failing it repeats at most once a day, counted from when the last one finished. A notice still waiting to post (held, paused or blocked) blocks new ones. Throttling and the queue's other waits post nothing.
- **Recovered** (`officer:<guild>:recovered:<fc>`). One line after an accepted roster, only when a degraded notice posted (or was posting) during that outage.
- **Character no longer on the Lodestone** (`officer:<guild>:missing:<link>`), one per link the [two-"not found" rule](#profile-refreshes) ends.
- **FC roster accepted** (`officer:<guild>`), only on a development deployment's test server (`TEST_GUILD_ID`). Other servers get no line for a routine roster read.

A degraded notice that completes `– SKIPPED` with `recovered before posting` (the roster was accepted during the hold, while it was paused or blocked, or while the bot was out of that server) or `FC unlinked` (`/config fc unlink` during an outage) is expected. The queue never claims a job of a server the bot was removed from, so an accepted roster closes such a server's waiting notice too, and posts no recovery line there. `/sync status` lists only unfinished and failed work, so it never shows these closed jobs; this query does:

```sh
docker compose exec -T postgres psql -U tarubot -d tarubot -c "
SELECT dedupe_key, status, created_at, completed_at, message_id, result
FROM jobs
WHERE dedupe_key LIKE 'officer:%:degraded:%' OR dedupe_key LIKE 'officer:%:recovered:%'
ORDER BY created_at DESC
LIMIT 10;"
```

Accepted edge cases and assumptions:

- **A send in flight.** A degraded notice being sent when the roster is accepted counts as posted, so the recovery line is queued; one being sent during `/config fc unlink` is left to finish. If that send fails (or its worker dies) and the queue retries it, the degraded line can post after the recovery line, or about the unlinked FC, with nothing after it. The window is one send in flight at that moment.
- **An FC with no active server.** Rosters run only while a server linked to the FC is active. If the bot is removed from every such server during an outage, a waiting notice stays queued until the bot is added back. It can then post before the next roster, which, once accepted, posts the recovery line after it.
- **Clocks.** The outage boundary is the accepted roster's observation time from the bot's clock, compared with job times from PostgreSQL's clock. They must agree to within a few seconds (one roster fetch); NTP on the host keeps them far closer.

The rate limit reads these job rows, so don't prune `officer.notify` jobs ([persistence conventions](https://github.com/deconfined/tarubot/blob/main/docs/PERSISTENCE.md)).

## Update posts

When the bot starts on a newer version, it posts what's new for members in each server's changelog channel ([what officers see](/tarubot/admin/notices-and-updates/#update-posts)). The member notes live in [`src/domain/release-notes.ts`](https://github.com/deconfined/tarubot/blob/main/src/domain/release-notes.ts), one sentence for each release that changes something members notice.

- **The baseline.** Each server stores the newest version it was told about, `guilds.changelog_version`. Setting a channel where none was stores the running version (or keeps a higher stored one), so nothing posts at once, and releases published while no channel is set are never posted. Moving or unsetting the channel keeps the baseline, and the bot never lowers it.
- **Startup.** Each present server with a channel and an older baseline gets one `changelog.post` job (`changelog:<guild>`), logged as "Queued update posts" with the count and the version. A restart while one is pending merges into it, so one post covers every release since the last.
- **Outcomes.** The job reads the release range when it runs. It completes as `– SKIPPED` with `changelog unconfigured` (the channel was unset), `already announced` (the baseline is already at or past the running version) or `nothing for members` (no notes in the range; the baseline still moves). A post succeeds with its `messageId`, `channelId` and `version`, and writes a `changelog.advanced` audit.
- **Missing permissions.** The job is `! BLOCKED` and the baseline doesn't move. The scheduler requeues it about every 10 minutes, and it is released at once by a `/config` save of the FC link, a role or a channel, by `/config guest_applications`, and by [`retry.js`](/tarubot/deploy/tools/#retryjs) or the next startup; `/config officer_rank`, `role_layout` and `fc unlink` don't release it. It never fails on its own, so a problem never fixed leaves a warning line and a delivery attempt about every 10 minutes. A restart merge keeps its attempt count, so about seven restarts inside one scheduler window use up its 8 attempts; the first transient error after that ends it as failed, and the next startup queues it again without a double post.
- **Paused.** With Discord changes off for the deployment or the server, a post parks as `‖ PAUSED`, and each restart on a newer version adds one more parked job. Resuming keeps only the newest and closes the rest as `superseded`, so one post goes out.
- **Duplicates.** A retry within a few minutes is deduplicated by Discord's nonce check (`changelog:<guild>:<running version>`). A kill, out-of-memory stop or host loss between the send and the baseline update, followed by a different version, can repeat that post's releases once, the same risk ledger posts accept. A graceful stop can't cause it.
- **Restores and baselines.** Restoring a backup taken before a post was delivered can post it again: [raise the baseline](/tarubot/deploy/operations/#recovery) before starting the bot. An operator may move a baseline by hand; the column accepts only `MAJOR.MINOR.PATCH` with an optional prerelease, and lowering it announces the notes in between again at the next startup:

  ```sh
  docker compose exec -T postgres psql -U tarubot -d tarubot \
    -c "UPDATE guilds SET changelog_version = 'X.Y.Z' WHERE id = 'YOUR_GUILD_ID'"
  ```

## Live selectors

The bot's Lodestone parser reads pages with the CSS selectors from [`xivapi/lodestone-css-selectors`](https://github.com/xivapi/lodestone-css-selectors), and keeps them current by itself. It checks the repository every `LODESTONE_SELECTOR_CHECK_SECONDS` (15 minutes by default). A new version is downloaded, checked against the fields the parser reads, and switched to in memory with no restart.

- Readiness shows the active set: `lodestone.selectors.revision`, with `source` `upstream` or `bundled`.
- A switch logs one "Lodestone selectors updated" line with `from` and `to`.
- A version that fails its download or checks logs "Lodestone selector revision rejected; the active set stays", with the reason, and the next check tries again. A rejection that persists means the selector format changed upstream and the parser needs a fix release.
- After a restart, the set bundled with the release runs until the first check, moments later.

Nothing needs doing when selectors switch. `LODESTONE_SELECTOR_CHECK_SECONDS=0` keeps the bundled set, for example on a host that can't reach GitHub.

## Issue reports

With `GITHUB_REPORTS_TOKEN` and your own `GITHUB_REPORTS_REPO` set, TaruBot opens issues in that GitHub repository. Use a **private** repository: reports carry members' details.

**What opens an issue:**

- `/issue` from any member: one per member every 10 minutes, and 20 per server a day.
- Every error-level report: unexpected failures in commands, events, startup and the job worker.
- Every job that ends failed at error level.
- Repeated trouble, checked every five minutes: a linked FC whose roster hasn't been accepted for 12 hours, and no Lodestone answer for an hour while requests keep failing.

**How reports are grouped:**

- Automatic reports share one issue per fingerprint of what failed and where. Repeats are counted, and a comment posts the count with the newest context at most hourly.
- A repeat after you close the issue opens a new one that links the old. Close an issue once it's fixed, so a recurrence shows up as new.
- Each day allows at most 10 new automatic issues and 50 automatic comments; the rest wait for the next day. `/issue` reports don't count toward these.
- Issues carry the labels `tarubot-report`, `source:user|error|job|trouble`, and `env:production` (or `env:devbot` from a development deployment with `TEST_GUILD_ID` set).

**What a report contains:** the version and readiness; the Lodestone's reachability, cooldown and selectors; active and recently failed jobs; the server's settings and roster state; for member reports, the member's links, main character, nickname state, guest and officer standing, recent work and audit; and the newest log records. Known secret shapes (tokens, authorization headers, passwords in URLs, PEM blocks, ping URLs) and the deployment's own secret values are removed first.

**Delivery.** Reports are saved in the database first, then sent by background jobs, so a GitHub outage loses nothing. Without a token, reports stay saved and are sent once a token is set and the bot restarts. A refused token (401, 403 or 404) fails the delivery job with `configuration`: fix the token or repository, then [retry the job](#jobs-that-need-attention).

## Heartbeat

The optional heartbeat catches what issue reports can't, because they come from inside the bot: the host is down, the container is gone, the process hangs, or the bot stays unready.

1. Create a check at [healthchecks.io](https://healthchecks.io) with a period of 5 minutes and a grace time of about 10 minutes, and point its alerts wherever you'll see them.
2. Put its ping URL in `.env` as `HEALTHCHECKS_PING_URL=https://hc-ping.com/<your-check-uuid>`, and recreate the bot with `docker compose up -d --wait`.

While readiness is fully green, the bot pings every five minutes, with a one-line status (version, pending and blocked work, failing FCs, the Lodestone cooldown, the selectors). It never sends a failure ping: an unready bot stays silent, and the check's grace time decides when that alerts, so an update restart or a Discord reconnect doesn't. A failed ping is retried a minute later and logged once as a warning.

Keep the URL private: anyone who has it can ping your check and hide an outage. Pause the check before planned maintenance longer than the grace time.
