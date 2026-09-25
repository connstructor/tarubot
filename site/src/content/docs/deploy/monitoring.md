---
title: Monitoring
description: Health probes, logs, background jobs, Lodestone refreshes, issue reports and the optional heartbeat.
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

Officers see outstanding and failed work in `/sync status`. Blocked work (a permission, the role order, a deleted channel) resumes by itself once an officer fixes the cause and changes any `/config` setting, or the same work is queued again.

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
