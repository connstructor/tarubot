# Session handoff — v2 release readiness

**Snapshot: 2026-09-23, updated 2026-09-24 after the production cutover. Start here next session.** This records the observed repository, publication, and DevBot state; recheck them before making changes. [OPEN_ITEMS.md](OPEN_ITEMS.md) is the detailed requirements-backed checklist, and [ROADMAP.md](ROADMAP.md) records the owner's v2–v6 plan.

## 1. Where we stopped

The core v2 functionality is implemented and tested. The table below is the original 2026-09-23 snapshot; the updates after it bring it to the current state. The owner's 2.14.0 reply session ran on 2026-09-24, and **2.15.0** ships its fixes and the owner's decisions, with the fixes from an adversarial review round (`07af9d8`). 2.15.0 is merged, published and deployed to DevBot (migration 006, 19 roots / 43 paths). The owner then renamed the GitHub account `connstructor` to `deconfined`, and **2.15.1** follows the rename. 2.15.1 is merged and published, and the 2.15.0 DevBot session is done. The owner approved the App Platform deploy-workflow proposal and wants v2 live on 2026-09-24, so **2.16.0** ships its deployment safeguards (Release A), OPS-10/OPS-11 move to 2.17.0 after launch, and the production cutover follows 2.16.0's publication and DevBot check. **The cutover ran on 2026-09-24 with 2.16.0.** Production went live on App Platform, then moved that evening to a Linode Docker host with Linode managed PostgreSQL, because the Lodestone refuses DigitalOcean's addresses. **2.16.1** brings the repository in line with that ([HOSTING.md](HOSTING.md)). After launch, 2.17.0 (Lodestone hardening), 2.18.0 and 2.18.1 (issue reports) were deployed to DevBot and production, and production ran **2.18.1** until 2.21.0. 2.19.0 (live selectors) and 2.20.0 (TaruBot's own parser) are merged; **2.21.0** moves the parser into the bot, removes the sidecar and retires App Platform. 2.21.0 carried all three to DevBot and production on 2026-09-25; 2.22.0 added the healthchecks.io heartbeat (deployed), 2.23.0 adds the rebuild runbook and the encrypted settings copy, and **2.24.0** the daily encrypted off-site database dumps.

| Layer | State at handoff |
| --- | --- |
| Latest merged feature | **2.12.0**, [PR #6](https://github.com/deconfined/tarubot/pull/6), merged on 2026-09-23 at 05:46:39 UTC |
| Merge commit | `db062bdbb9fc502d62a214f8a56692e418b8875b` |
| Signed feature commit | `5365511c05c8acee48a164c2b4765ee890438bc1` — Add unverified guest application forms in 2.12.0 |
| PR checks | Source/behavior checks, both container builds, CI result, CodeQL, and GitGuardian all passed |
| Image publication | [Run 35823822742](https://github.com/deconfined/tarubot/actions/runs/35823822742) succeeded for the merge; matching bot/sidecar **2.12.0** images are published |
| This documentation checkout | **2.12.1**, branch `docs/v2-release-handoff`, based on the merge above; publication is a separate future step |
| Running DevBot and sidecar | **2.11.1**, revision `1de878ef6c314cd83ac26bf7513d5db64210bcad` |
| Running database | `tarubot_dev`, schema **`003_guild_access.sql`** |
| Schema required by 2.12.x | **`004_guest_application_form.sql`**, not yet applied to DevBot |
| Production cutover | Not performed |

The handoff's documentation version is not evidence of a deployed image; each version must finish its own checked PR and publication before it is deployed. The current source's App Platform template tracks 2.15.1 as required by repository versioning, and its startup plan is the 2.15 session (2.15.0 or later), which DevBot posted on 2.15.0.

**Update later on 2026-09-23:** DevBot then ran the published 2.12.1 images on schema 004, new guest reviews go to officer-chat, and the first unverified-visitor approval passed; see [DEV_GUILD.md](DEV_GUILD.md). The table above is the original snapshot.

**Update, 2.13.0:**
- **Branch.** `feat/launch-policy-2.13.0` started from `main` at `341c6ed` (2.12.3, PR #10). It implements the owner's launch decisions of 2026-09-23, recorded in [REQUIREMENTS.md](../REQUIREMENTS.md) under "Approved launch amendments", and adds migration `005_launch_access_policy.sql`.
- **Status.** Merged ([PR #11](https://github.com/deconfined/tarubot/pull/11), `2e3f27c`), published, and deployed to DevBot on schema 005 on 2026-09-23 (backup, rehearsal, migration, registration and guard refusals in [DEV_GUILD.md](DEV_GUILD.md#2130-rollout--2026-09-23)). The layout-switch and multi-character union checks remain. The closed-applications refusal passed in the 2.14.0 reply session.
- **Cutover.** The production cutover follows the rewritten [MIGRATION.md](MIGRATION.md) on App Platform with the managed PostgreSQL cluster. It was planned on a release at or above 2.15.0; since 2026-09-24 the floor is **2.16.0**, which ships the deployment safeguards (see the 2.16.0 update); OPS-10/OPS-11 follow in 2.17.0 after launch.
- **Owner action.** Done: the DevBot `.env` `DATABASE_URL` names `…/tarubot_dev`, which the DevBot tool profile requires (it refuses `…/tarubot`).

**Update, 2.14.0:**
- **Branch.** `feat/reply-presenters-2.14.0` started from `main` at `2e3f27c` (2.13.0, PR #11). It replaces every JSON reply with the owner-approved embeds ([REPLIES.md](REPLIES.md)). No migration: the schema stays `005_launch_access_policy.sql`.
- **Status.** Merged ([PR #12](https://github.com/deconfined/tarubot/pull/12), `0e60f21`) on 2026-09-24. Publish run 35948831624 first failed on the sidecar spacing test in the amd64 build; re-running the failed jobs published `ghcr.io/deconfined/tarubot:2.14.0` and `tarubot-nodestone:2.14.0` and promoted `latest`. Deployed to DevBot at 02:58:17 UTC with no migration, commands re-registered (19 roots / 41 paths, matching the image) and the startup plan posted as message `1552514500140335215` ([DEV_GUILD.md](DEV_GUILD.md#2140-rollout--2026-09-24)).
- **Reply session.** Pending at the rollout. It ran later that day on the new machine (see the update after 2.14.1).

**Update, 2.14.1:**
- **Branch.** `ci/claude-review-foreground-2.14.1` starts from `main` at `0e60f21` (2.14.0, PR #12). CI and tests only: no runtime source change, no migration, no command change, so DevBot stays on 2.14.0.
- **Claude review.** Reviews had ended green in about 40 seconds with nothing posted: since Claude Code 2.1.198 a subagent starts in the background, and `claude-code-action` stops reading at the first result, which arrived while the plugin's gating agent still ran (run 35948050785). The review step now sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, prints the transcript only with debug logging, and fails in a new "Check that the review finished" step when the review was cut short. Its own PR got no real review (the action skips a PR that changes its workflow); 2.15.0's PR #14 confirmed the fix (11 foreground subagents, all completed, and `claude[bot]` posted).
- **Sidecar test.** The spacing contract test measures on the monotonic clock with a 10 ms tolerance, fixing the flake that failed the first 2.14.0 publish attempt.
- **Status.** Merged ([PR #13](https://github.com/deconfined/tarubot/pull/13), `a28ad6c`) on 2026-09-24 and published by run 35958526053. DevBot stayed on 2.14.0, since 2.14.1 changes no runtime code.

**Update, machine move and the 2.14.0 reply session (2026-09-24):**
- **New machine.** DevBot and this repository moved to a new Linux machine; the repository is at `/home/connstruct/src/tarubot`. `tarubot_dev` was restored from `.cache/backups/tarubot_dev-handoff-0e60f21.dump`, and `check-restore.js` passed at `005_launch_access_policy.sql` for all 26 tables. DevBot 2.14.0 started at 03:52:47 UTC with clean readiness (including `writerLease`) and command read-back, and posted plan message `1552528212054249474` ([DEV_GUILD.md](DEV_GUILD.md#machine-move--2026-09-24)).
- **Docker.** Docker on this machine needs the `docker` group. The session ran Compose through `sg docker` (for example, `sg docker -c 'docker compose -f docker-compose.yml -f docker-compose.devbot.yml ps'`).
- **Reply session.** The owner ran it from 04:00 to 05:04 UTC. It covered all seven plan steps, including the paused pass (restart with `ENABLE_EFFECTS=false`, then restore; 7 held jobs requeued). Every failure's Ref and Code matched the log. It found nine deviations, D1–D9; the owner decided each one, and 2.15.0 ships them. The review-message conversion couldn't be confirmed live, because that needs a new application and the forms are on hold. Details, message IDs and the decision table are in [DEV_GUILD.md](DEV_GUILD.md#2140-reply-session--2026-09-24).
- **DevBot state.** After the session DevBot ran 2.14.0 on schema 005 with effects on; since 13:01:55 UTC it runs 2.15.0 on schema 006 (see the 2.15.0 update). Guest applications are open with reviews in officer-chat (revision 13). PigeonMuffin's revoke from the session was replaced by a manual grant at 05:06 UTC; the 2.15.0 session's `/officer reset` removed it, so he is an officer by rank with no override.

**Update, 2.15.0:**
- **Branch.** `feat/reply-session-fixes-2.15.0` starts from `main` at `a28ad6c` (2.14.1, PR #13). Its commits ship D1–D9 and two review rounds ([CHANGELOG.md](../CHANGELOG.md)):
  - `3ed8ec2` Show stored FC tags once in 2.15.0 (D1);
  - `2452f82` Reply "no change" when /main or /nickname repeats the saved state (D2);
  - `b87cab7` Accept entry numbers in /ledger adjust and give every option an Example (D3, D4);
  - `b87e504` Suggest server members on every member option (D5);
  - `8c3a66b` Make a re-link the main again and skip the owner's nickname (D6, D7);
  - `55a1327` Separate the guest-application switch from the review channel (D8: `/config guest_applications enabled|channel|unset_channel`, and no `/config` option named `clear`);
  - `d36d3d9` Add /officer reset and /guest reset to return to the automatic rules (D9);
  - `07af9d8` Address the 2.15.0 review findings;
  - `2016bd6` Address the second 2.15.0 review round;
  - a documentation commit for all of the above.
- **Review round.** Before the PR, an adversarial review workflow examined the change set through six lenses, with three verifiers per finding. `07af9d8` fixes every confirmed finding: grandfathering counts grants `/guest reset` ended as existing grants; `/officer reset` runs the Officer-role hierarchy check that grant and revoke run; switching guest applications on validates the channel that will take them, including a stored legacy one, and rechecks it under the row lock; with sync on, a re-link that becomes the main clears the unlink's pending nickname restore, and the owner skip also drops a pending restore; `/config officer_rank` naming the saved rank is a no-change reply with no revision bump; and four replies were reworded. A second round reviewed the fixes and the whole branch; `2016bd6` fixes its findings (`/setup` validates a kept review channel it switches on; the officer-rank no-op keeps the Heads-up; the preview skips the owner's nickname; `/main` with sync off keeps a pending restore). [VERIFICATION.md](VERIFICATION.md#automated-suites) has the details.
- **Schema and commands.** Migration `006_guest_application_switch.sql` is the new `SCHEMA_VERSION` (2.14.x required 005). The command surface is 19 roots / 43 paths. Option names, descriptions and autocomplete changed, so guild commands must be re-registered after the deploy.
- **Status.** Merged ([PR #14](https://github.com/deconfined/tarubot/pull/14), `974bd27`) on 2026-09-24 after every check passed; its Claude review confirmed the 2.14.1 fix (11 foreground subagents, all completed, and `claude[bot]` posted). Publish run 36002040486 published both images. Deployed to DevBot at 13:01:55 UTC with migration 006, commands re-registered (19 roots / 43 paths) and the startup plan posted as message `1552666419064479837` ([DEV_GUILD.md](DEV_GUILD.md#2150-rollout--2026-09-24)). Before the PR, type checking, lint, formatting, the build and `ci:version` passed, as did the unit (1,099) and contract (18) suites and the full container run with both the supplied dump and the synthetic CI fixture (1,207 tests / 36,688 assertions each, with 90 PostgreSQL integration tests). [VERIFICATION.md](VERIFICATION.md) has the evidence.
- **Owner approvals.** The owner approved the PR, the merge, the DevBot rollout with migration 006 and the command re-registration on 2026-09-24. The 2.15.0 DevBot session, run by the owner, is next.
- **Open owner questions.** The owner ruled on 2026-09-24 that everything discussed, including `/officer reset` and `/guest reset`, is in launch scope. Still open: should the late-joiner report list a late joiner whose only grants `/guest reset` ended (it currently leaves them out, consistent with grandfathering, which counts those grants)? Should the [REPLIES.md deviations table](REPLIES.md#deviations-from-approved) keep its rows that compare against reply-spec states rather than drawn cards? [OPEN_ITEMS.md](OPEN_ITEMS.md#owner-approvals-and-questions-2150) tracks them.
- **Release plan.** OPS-10/OPS-11 (officer alerts and telemetry, and a restyled `officer.notify`) moved to 2.16.0, and then, on the owner's launch-day decision, to **2.17.0 after launch**. The production cutover requires a published release at or above **2.16.0**, which ships the deployment safeguards.

**Update, 2.15.1:**
- **Rename.** On 2026-09-24 the owner renamed the GitHub account `connstructor` to `deconfined`; the repository is `deconfined/tarubot`. The ruleset, the Actions secret and the Actions settings came across unchanged. Git, web and API URLs under the old name keep redirecting unless a new holder of the name creates a repository called `tarubot`; DevBot 2.15.0's `/version` still reads the old name through that redirect. GHCR paths moved with the account without a redirect: `ghcr.io/deconfined/tarubot:2.15.0` and `tarubot-nodestone:2.15.0` serve the digests DevBot runs, and `ghcr.io/connstructor/…` answers 403.
- **Branch.** `chore/repository-rename-2.15.1` starts from `main` at `974bd27` (2.15.0, PR #14). It points Compose's default images, the App Platform registry, `package.json` (which `/version` reads), SECURITY.md, the tests and the docs at `deconfined`, and adds a test that the spec and Compose pull the images `publish.yml` publishes. No migration and no command change; DevBot stays on 2.15.0. Compose's configuration hash includes the image name, so the first `up` from a 2.15.1 or later checkout recreates `tarubot` and `nodestone` from the same digests even with `TARUBOT_IMAGE_TAG=2.15.0`. That is a restart (the gateway reconnects and the startup plan is posted again), so it needs the owner's go-ahead and belongs with the next DevBot update; read-only checks (`ps`, `logs`, readiness) leave the containers running.
- **Local remote.** With the owner's go-ahead, this clone's `origin` was changed to `https://github.com/deconfined/tarubot.git` on 2026-09-24 and fetches cleanly. Do the same in any other clone (`git remote set-url origin https://github.com/deconfined/tarubot.git`), then check it with `git remote -v`.
- **Owner action.** Register `connstructor` again as a placeholder account, and create no `tarubot` repository under it, so nobody else can publish images or a repository under the old name and the old-name redirects keep working.
- **Status.** Merged ([PR #15](https://github.com/deconfined/tarubot/pull/15), `529990f`) and published by run 36039049542 as `ghcr.io/deconfined/tarubot:2.15.1` and `tarubot-nodestone:2.15.1`. DevBot stayed on 2.15.0.

**Update, 2.16.0:**
- **Why.** The owner approved the App Platform deploy-workflow proposal ([proposals/app-platform-deploy-workflow.md](proposals/app-platform-deploy-workflow.md)) and wants v2 live on 2026-09-24. 2.16.0 is the proposal's Release A: the safeguards that make migrations, restarts and command registration safe to automate later. OPS-10/OPS-11 move to 2.17.0 after launch; the cutover floor stays 2.16.0.
- **Branch.** `feat/release-a-2.16.0` starts from `main` at `529990f` (2.15.1, PR #15).
- **Migration guard.** `Database.migrate` applies every pending file in one transaction and, when anything is pending, takes the writer lease with a transaction-scoped lock, waiting up to `MIGRATE_WRITER_WAIT_SECONDS` (90) for a stopping bot and then refusing (`busy`, naming the holder). With nothing pending it ignores the lease. `migrate.js` prints the lease and commit times, the restore point.
- **Schema re-check.** `ApplicationLifecycle.prepare` checks the schema again once it holds the lease.
- **Undeclared shapes.** The router answers a subcommand or option the release doesn't declare with the stale card, and autocomplete with no suggestions (`src/bot/shape.ts`).
- **Deferred to Release B.** `commands.js declared`/`check` and the `app-spec.ts` image rules, which only the deploy workflow uses.
- **Status.** Merged ([PR #16](https://github.com/deconfined/tarubot/pull/16), `c812d4d`) and published by run 36057348161. It was deployed to DevBot at 20:55 UTC: stopped-writer backup, exact restore at 006, no migration, and no re-registration. Then `migrate.js` ran beside the running bot and changed nothing, and the startup plan was posted as message `1552785518171787365`. The owner's smoke test passed ([DEV_GUILD.md](DEV_GUILD.md#2160-rollout--2026-09-24)).

**Update, the production cutover and the move to Linode (2026-09-24):**
- **Cutover.** Run with 2.16.0 following [MIGRATION.md](MIGRATION.md): foundation app at 21:18 UTC, rehearsal, window 21:50–22:02, activation at 22:00:39 (plan `aaef7f2f…`, 2 grandfathered grants, 3 role changes), 19 roots / 43 paths registered globally, and the worker ready at 22:02. [The record](MIGRATION.md#record-of-the-2026-09-24-cutover) has the steps and evidence.
- **Lodestone block.** On App Platform every profile refresh failed: the Lodestone answers DigitalOcean's addresses with HTTP 403. The owner chose a Linode Docker host with Linode managed PostgreSQL. The move (22:38–22:40 UTC, about 90 s down) stopped the App Platform worker, copied the database with `pg_dump`/`pg_restore`, and verified it with `check-restore.js`. Production now runs `docker-compose.production.yml` on `tarubot@tarubot.deconfined.com` ([HOSTING.md](HOSTING.md)). REQUIREMENTS.md records the "Approved hosting amendment".
- **After the move.** One lease holder on Linode, and reconciliation caught up. The first profile burst hit Lodestone 429s. Investigating those found a retry storm: the 30-second scheduler pulls a backing-off profile job's `due_at` to now, and re-creates the job each time one fails. It also found that a 404 is retried like an outage, and that a private profile's 403 is reported as `unavailable`. 2.17.0 fixes these. The owner approved it, and asked that characters the Lodestone no longer has be unclaimed automatically, after two 404s ([OPEN_ITEMS.md](OPEN_ITEMS.md#implementation-work)).

**Update, 2.16.1:**
- **Branch.** `chore/linode-hosting-2.16.1` starts from `main` at `c812d4d` (2.16.0, PR #16). No migration, no command change, and no bot behavior change.
- **Tool guard.** The production profile accepts the Linode cluster's direct port 27520, and refuses its 27521 pool and the `akmadmin` login. DigitalOcean's 25060 and `doadmin` rules stay until that cluster is deleted. Until 2.16.1, production tools refused the Linode database, which blocked `retry.js` and `preview.js --late-joiners`.
- **Production Compose file.** `docker-compose.production.yml` runs the bot and Nodestone only, with the release pinned by a required `TARUBOT_IMAGE_TAG`, required database and token settings, and bounded logs. A unit test checks it against `docker-compose.yml`, and CI validates it.
- **Docs.** HOSTING.md (new), the MIGRATION.md cutover record, the superseded notes and the `app:` trusted-source correction in APP_PLATFORM.md, the REQUIREMENTS.md hosting amendment, and CLAUDE.md, README.md and OPERATIONS.md.
- **Status.** Merged ([PR #17](https://github.com/deconfined/tarubot/pull/17), `1655adc`; the Claude review's HOSTING.md finding was fixed in `b556b28`) and published by run 36072940021. Deployed to production at 23:39 UTC and to DevBot at 23:40 UTC ([DEV_GUILD.md](DEV_GUILD.md#2161-rollout--2026-09-24)). The host clone now tracks `main`. The late-joiner report found none, and the planned profile retries were unnecessary.

**Update, 2.17.0:**
- **Branch.** `feat/lodestone-hardening-2.17.0` starts from `main` at `1655adc` (2.16.1, PR #17). It implements the owner's Lodestone decisions of 2026-09-24 (REQUIREMENTS.md "Approved Lodestone amendments") and adds migration `007_profile_checks.sql`. There are no command changes.
- **Retry storm.** The scheduler uses `scheduleJob` (`ON CONFLICT DO NOTHING`), so it never pulls a job that is backing off forward. It also stamps `characters.profile_retry_at` an hour ahead, so each character is refreshed at most hourly, whatever the outcome.
- **Two-404 rule.** A profile 404 completes the job. The first is recorded in `profile_missing_at`. One at least an hour later ends every active link through `/unclaim`'s `endLink`, audited with a null actor, with an officer notice per link. Any sighting in between clears the mark.
- **Private profiles.** The sidecar's `private` becomes `private_profile`. The refresh waits for the profile interval, links stay, and commands show "Lodestone profile is private".
- **Throttling.** The sidecar's `LodestoneGate` refuses starts during a shared cooldown after a 429 (15 s, doubling to 5 min). `rate_limited` is a waiting code, the client no longer retries it, and a full sidecar answers `busy`.
- **Status.** Merged ([PR #18](https://github.com/deconfined/tarubot/pull/18), `baa9d3c`) and published by run 36077621763. On 2026-09-25 it was deployed with migration 007 to DevBot at 00:33 UTC and to production at 00:34 UTC (about 31 s down) ([DEV_GUILD.md](DEV_GUILD.md#2170-rollout--2026-09-25)). The two private profiles now complete as private. 35999242 had already been unlinked by an officer.
- **Hosting follow-up (owner decision, 2026-09-25).** The owner kept production on the Linode host rather than splitting it across App Platform and Linode, and asked that the host be made robust and disposable. That means a rebuild runbook, an encrypted `.env` copy off the host, a heartbeat, confirmed backups with off-site dumps, and an SSH deploy workflow (REQUIREMENTS.md, hosting amendment).

**Update, 2.18.0:**
- **Branch.** `feat/issue-reporter-2.18.0` starts from `main` at `baa9d3c` (2.17.0, PR #18). It adds migration `008_issue_reports.sql` and `/issue` (20 roots, 44 paths), so commands need registering after the deploy.
- **Issue reports.** Reports go to the private repository `deconfined/tarubot-reports`, using `GITHUB_REPORTS_TOKEN`:
  - `/issue` for every member, limited to one per 10 minutes and 20 per server per day;
  - automatic reports of error-level failures, failed jobs, and repeated trouble (a roster stale for 12 hours, the Lodestone unreachable for an hour).

  Automatic reports are grouped by fingerprint, repeats are commented at most hourly, a recurrence after a close opens a new issue, and each day allows 10 automatic issues and 50 comments. Reports are saved in `issue_reports` before delivery and carry redacted context ([OPERATIONS.md](OPERATIONS.md#issue-reports)).
- **Token.** The owner created the repository and an Issues-only token for it, saved as `~/tarubot-cutover/github-reports.token` (0600). The token was also pasted in chat, so it should be regenerated once the reporter runs. DevBot's `.env` needs `GITHUB_REPORTS_TOKEN` (owner action), and the production host's `.env` gets it at the deploy.
- **Status.** Merged ([PR #19](https://github.com/deconfined/tarubot/pull/19), `98552d9`) after three review rounds, which found five real bugs, all fixed. Published by run 36088537989. On 2026-09-25 it was deployed with migration 008 to DevBot at 03:07 UTC and to production at 03:09 UTC (about 30 s down), with `/issue` registered in DevBot's guild and globally ([DEV_GUILD.md](DEV_GUILD.md#2180-rollout--2026-09-25)). Both `.env` files hold `GITHUB_REPORTS_TOKEN`. The owner's test `/issue` opened issue #1 in `deconfined/tarubot-reports`.

**Update, 2.18.1:**
- **Why.** The owner's test report worked but was hard to read. A code fence that started mid-line (`Sidecar health: ```json`) made GitHub render everything after it as code. Readiness and sidecar health were raw JSON, times were raw ISO strings, booleans read `true`/`false`, the log records were raw pino JSON dominated by 30-second `Capability status` lines, and a member's report ended with an occurrence count.
- **Change.** Single records are now two-column tables, times read `YYYY-MM-DD HH:MM:SS UTC`, and booleans read yes/no. The sidecar is a table with an upstream-component table, and log lines are compact, without the routine noise. Member reports carry no occurrence footer. Every fence starts its own line, and a test enforces it. A sample was checked through GitHub's Markdown renderer.
- **Status.** Merged ([PR #20](https://github.com/deconfined/tarubot/pull/20), `6a3973d`, after one review round) and deployed on 2026-09-25 to DevBot (03:58 UTC) and production (03:59 UTC). The owner then rotated the reports token, and both `.env` files and containers were updated. Test report #3 was delivered as issue #2 and rendered correctly.

**Update, 2.19.0:**
- **Why.** The owner: "xivapi/lodestone-css-selectors should ALWAYS be the latest version available." The sidecar ran `1e9dd65`, while upstream was at `a96d68b`, because `bun.lock` pinned the selectors and the build bundled them.
- **Change.**
  - Selectors now load at runtime in each parser worker.
  - The upstream monitor activates each new HEAD after downloading it at that commit and validating it structurally. The checks run every 15 minutes, and failures keep the active set.
  - The bundled copy is the fallback, now `a96d68b`.
  - `/health` and issue reports show the live revision.
  - Parser workers now get the process environment explicitly.
- **Next (owner request).** Drop Nodestone and parse with the selectors directly (2.20.0), then the robust, disposable host and SSH deploys.
- **Status.** Merged ([PR #21](https://github.com/deconfined/tarubot/pull/21), `e6558af`) on 2026-09-25 after two review rounds (restore and nested-key validation, the cleanup race, a bounded download reader). Not deployed separately: 2.21.0 carries it.

**Update, 2.20.0:**
- **Why.** The owner: "get rid of Nodestone entirely, pull xivapi/lodestone-css-selectors for ourselves, and do the parsing internally."
- **Change.**
  - `sidecar/lodestone.ts` is a first-party, selector-driven parser on linkedom, and the worker fetches through the server's gate.
  - Removed: the Nodestone submodule, its patches (`transforms.ts`), `axios` and `regex-translator`.
  - The upstream monitor follows only the selectors, and `selectors:check` and `selectors:update` replace `nodestone:*`.
  - The service, image and env names are unchanged.
- **Parity.** The 2.19.0 Nodestone build and this build gave identical output and URLs on 6 live pages in 7 cases (profile ± biography, FC, member pages 1 and 3, search hit, empty search), and the new worker is about twice as fast. The image built and parsed live pages.
- **Also.** A new selector set only has to keep the columns the parser reads (`PARSED_KEYS`), at any depth.
- **Status.** Merged ([PR #22](https://github.com/deconfined/tarubot/pull/22), `632936a`) on 2026-09-25 after CI and the Claude review passed. Not deployed separately: 2.21.0 carries it.

**Update, 2.21.0:**
- **Why.** The owner asked what the sidecar still bought once the parser was TaruBot's own, then decided: "Remove the sidecar. I would rather reduce complexity and places where things can break." With the sidecar gone App Platform could not serve as a fallback, and the owner chose to retire it too.
- **Change.**
  - The Lodestone adapter runs in the bot (`src/infrastructure/lodestone/`). The bot fetches each page under the same network policy (region, gate, body bound, private-profile detection) and hands a fresh worker the page and the operation's selector files; the worker only parses and is terminated at the deadline.
  - Parse slots wait instead of refusing as `busy`. The live selectors are held in memory; nothing is written to disk.
  - Removed: the `nodestone` Compose service and image, the HTTP API, `NODESTONE_URL` and the other `NODESTONE_*`/`PAGE_REGION` settings (now `LODESTONE_*`), the worker build step (linkedom and the selectors are runtime dependencies), and App Platform's spec, phase tool, tests and CI check.
  - `/health/ready` carries a `lodestone` object (gate, slots, selectors, upstream), and issue reports read it directly.
- **Deploy.** A restart with `up -d --wait --remove-orphans` (removes the old sidecar container). No migration and no command change. It brings 2.19.0 and 2.20.0.
- **Status.** Merged ([PR #23](https://github.com/deconfined/tarubot/pull/23), `220a99f`) and deployed on 2026-09-25 to DevBot (11:41 UTC) and production (11:42 UTC) with `--remove-orphans`; both run one `tarubot` container. The operator clone is at 2.21.0 and the cutover sidecar container was stopped ([DEV_GUILD.md](DEV_GUILD.md#2210-rollout--2026-09-25)).

**Update, 2.22.0:**
- **Why.** The robust, disposable host (owner decision, 2026-09-25) needs alerting from outside the host. The owner signed up for healthchecks.io.
- **Change.** `src/application/heartbeat.ts` pings `HEALTHCHECKS_PING_URL` every five minutes while readiness is fully green, with a one-line status body. It sends no failure pings (the check's grace decides), retries a failed ping after a minute, and logs a failure streak once. Issue reports redact ping URLs. Empty turns it off (DevBot, CI).
- **Owner's check.** "TaruBot production": period 5 minutes, grace 10 minutes, Pushover for down. The URL lives in `~/tarubot-cutover/healthchecks-production.url` and goes into the host's `.env` ([HOSTING.md](HOSTING.md#heartbeat)).
- **Status.** Merged ([PR #24](https://github.com/deconfined/tarubot/pull/24), `dfa6c5b`) and deployed on 2026-09-25 to DevBot (heartbeat off) and production (12:33 UTC, heartbeat on); the owner confirmed good pings.

**Update, 2.23.0:**
- **Why.** The robust, disposable host needs a way back when the host is gone: a rebuild runbook and an off-host copy of its settings. The owner declined Terraform for now ("too much trouble at least at this stage").
- **Change.** `scripts/host-env-backup.ts` (`bun run host:env-backup`) reads the host's `.env` over SSH and encrypts it with `age` for `ops/age-recipients.txt`, writing only the encrypted copy; HOSTING.md gains "Settings copy" and an 11-step "Rebuilding the host".
- **Found.** `sshd` offered password login (though `tarubot` had no password); the owner made it key-only the same day, confirmed from outside. No Linode Cloud Firewall is attached; that stays an owner item in OPEN_ITEMS.md.
- **Status.** Merged ([PR #25](https://github.com/deconfined/tarubot/pull/25), `9cf2afd`) after one review round (quote-aware setting names, verify-then-rename). Nothing to deploy.

**Update, 2.24.0:**
- **Why.** The last piece of the backup layer: off-site dumps. The owner chose Linode Object Storage over B2 ("not really worried about Akamai going down"): bucket `tarubot-backups`, key `tarubot-backup-key` limited to it, and a second healthchecks check "TaruBot backups".
- **Change.**
  - `ops/backup.sh` dumps through the production Compose file's profile-only `backup` service, streams into `age`, uploads to `daily/` (and `monthly/` on the 1st) with curl SigV4, and uploads an encrypted `.env` to `env/`. It pings healthchecks with start, success or the failed step.
  - Retention (`ops/bucket-lifecycle.xml`: 30 days, monthly 365) is applied to the bucket.
  - The host's `.env` holds the storage settings, which the bot never sees.
- **Proven.** A run from a scratch copy on the host uploaded a 381,594-byte dump. It decrypted and restored into a throwaway PostgreSQL 18 with all 27 table counts identical to production.
- **Deploy.** A pull on the host (the bot needn't restart), then the crontab line from HOSTING.md.
- **Status.** Merged ([PR #26](https://github.com/deconfined/tarubot/pull/26)) after three review rounds (logging off for the dump service, which the first test run's plaintext briefly reached in Docker's log; the region setting expected).

**Update, 2.24.1:**
- **Why.** The owner saw many errors in `/sync status`. They were 167 profile-refresh failures from the first night (App Platform refusals, the 429 storm, the deleted character). All had later succeeded, and nothing had failed since 2.17.0, but the work list had no age limit.
- **Change.** The work list leaves out a failure once the same dedupe key later succeeded. In production that hides all 167.
- **Status.** Merged ([PR #27](https://github.com/deconfined/tarubot/pull/27), `8a580de`) after one review round: failures are timestamped, and `retry.js` clears the stamp. Deployed on 2026-09-25 to DevBot and production (14:30 UTC) together with 2.24.0's host step: the pull, the backup crontab line and a first run from the real path.

**Update, 2.24.2:**
- **Why.** The owner asked to address the two open CodeQL alerts.
- **Change.**
  - #7: the parser worker ignores any message with an origin; Bun gives a parent's messages an empty one.
  - #8: `isDefinition` checks null before `typeof`.
- **Status.** Merged ([PR #28](https://github.com/deconfined/tarubot/pull/28), `4a64609`). A restart deploys it.

**Update, 2.24.3 (current version):**
- **Why.** Issue #29: production officers got "FC roster accepted: …" for every roster read, and the degraded line could repeat about once a minute during an outage. The owner decided in two rounds on the issue (REQUIREMENTS.md "Approved officer-notice amendments").
- **Change.**
  - The roster line posts only in DevBot's test guild.
  - The degraded notice has its own key per guild and FC, is held 5 minutes, repeats at most daily while the FC keeps failing, and is closed unposted if the roster recovers first or the FC is unlinked.
  - One recovery line follows a posted degraded notice.
  - The job rows are the notice history: no migration and no in-memory state.
- **Release order (agreed 2026-09-25).** #29 is 2.24.3, #30 2.25.0 (migration 009), #32 2.26.0, and #31 2.27.0 later (migration 010). The SSH deploy workflow's 2.25.0 reservation is dropped; it takes the next free minor after #31.
- **Status.** Branch `feat/roster-notices-2.24.3`; not yet pushed. The fast checks pass; the PostgreSQL suite (`test:docker`) is still to run. A restart deploys it, with no registration ([DEV_GUILD.md](DEV_GUILD.md#2243-rollout-planned)).

**Local handoff checkpoint (historical, 2026-09-23):** the documentation and release-reference changes were validated on `docs/v2-release-handoff`. The first signing attempt required a local GPG unlock (commits are now signed with the SSH key described below). That branch had not been pushed or given a PR at the checkpoint.

### Verified runtime observations

These observations are from the original snapshot. A fresh read-only check confirmed all three local containers healthy. Bot readiness reported database/Discord connected, effects enabled, public development replies enabled, **zero pending/blocked work**, and zero degraded FCs. The guild-scoped database query also found no queued/running/blocked/failed/disabled jobs.

- Guild revision **10**, active, effects enabled, onboarding enabled.
- Two active character ownership links.
- The development ledger account remains uninitialized: `balance = NULL`, `sequence = 0`.
- The 2.11.1 setup access job `8df5614c-3c95-44bb-b3d9-e5c90df4b436` previously completed for 11 managed channels. The owner reported that the rest looked good; exhaustive human visibility/recovery acceptance is still outstanding.
- Last posted running-image plan: [message 1552179968069472363 in #chat](https://discord.com/channels/1040379370159743139/1040379370931507252/1552179968069472363).

Since then, revision 11 moved guest reviews to officer-chat and the 2.12.3 session initialized the ledger. The 2.14.0 rollout check on 2026-09-24 found readiness 200 (database, writer lease, Discord and effects true; nothing pending or blocked; no degraded FCs), one writer-lease holder and no warn or error log lines. The reply session closed and reopened guest applications (revisions 12 and 13). When effects were restored at 05:03:49 UTC on the new machine, readiness was 200 with effects on, the writer lease held, nothing pending or blocked, one lease holder, and no warn or error lines. The 2.15.0 rollout on 2026-09-24 found readiness 200 (database, writer lease, Discord and effects true), the lease acquired on the first attempt, and no warn or error lines; migration 006 backfilled the dev guild's guest-application switch on and left revision 13. The latest plan is [message 1552666419064479837](https://discord.com/channels/1040379370159743139/1040379370931507252/1552666419064479837).

## 2. Development identities and policy decisions

| Resource | ID / setting |
| --- | --- |
| DevBot application/user | `943291473477128243` |
| Development guild | `1040379370159743139` |
| Owner | `725369723964882976` |
| Original Member role | `1042089882677420172` — DevBot Member |
| Original Guest role | `1042089887798677545` — DevBot Guest |
| Officer role | `1551979211391115405` |
| FC Leader role | `1551979217087103137` |
| Lobby | `1552181036492791818` |
| Officer room | `1552149138148433930` — officer-chat |
| Current guest-review destination | `1552149138148433930` — officer-chat, since revision 11 (previously `1040379861153357995`, dev); closed and reopened at revisions 12–13 in the 2.14.0 reply session |
| Test member (officer by rank) | `289803961693765632` — PigeonMuffin (Wyra Riyuh `38804790`); no override since the 2.15.0 session's `/officer reset` (the 2.14.0 session's revoke was followed by a manual grant). To test as a non-officer, `/officer revoke` him and `/officer reset` afterwards |
| Test visitor | `1010097911566180445` — pazzberry, the 2.12.1 applicant; holds Guest after the session's `/guest revoke` and `/guest grant` |
| Startup-plan destination | `1040379370931507252` — chat |
| Excluded community-updates channel | `1040379572358746144` — moderator-only |
| Excluded parent category | `1040381910863593492` — Admin |

The last Discord permission check confirmed **Administrator disabled** and the documented eight explicit bot permissions, with all four managed roles below the bot. Use non-owner/non-Administrator humans for visibility and successful nickname-write tests. The owner opted out of nickname management after exercising Discord's owner restriction.

Keep these owner-approved decisions intact:

- **Manual guest applications are for unverified visitors only.** Trusted verified/imported/assigned non-FC users retain automatic Guest eligibility in every guild under the freshness policy (ROLE-07), with or without onboarding; FC members retain Member precedence. Access is the union over a user's linked characters. Explicit Guest revocation remains authoritative.
- **Launch decisions (2026-09-23):**
  - Production uses App Platform with the managed cluster, and exactly one database writer (the writer lease). *(Hosting superseded the same day: the Linode host, [HOSTING.md](HOSTING.md); App Platform retired in 2.21.0.)*
  - First activation of the imported guild grants a durable `grandfathered` Guest to every non-member present, once.
  - The role-layout switch is off for imported guilds and on for DevBot.
  - `/apply` and onboarding are off at launch, and `/setup` is not run in production. From 2.15.0 the import keeps the legacy review channel with the guest-application switch off; reopening after launch is `/config guest_applications enabled:true`, which validates that stored channel first, so a legacy channel that is gone needs `channel:#…` in the same call.
  - Officers come from the in-game rank, with the legacy Officer role bound `adopt_holders:false`.
  - The production app leaves the dev guild before cutover. Guest-form acceptance is deferred until after launch.
- **Reply-session decisions (2026-09-24, 2.15.0):**
  - Never imply a change where none occurred: a request matching the saved state gets a no-change reply, never a change receipt (UX-02). The `/main` and `/nickname` repeats, `/config officer_rank` naming the saved rank, a matching `/config guest_applications` request and a reset with nothing to remove get `= NO CHANGE` cards and save and queue nothing.
  - Every option has an Example on its input failure.
  - Every member option autocompletes server members, and IDs and mentions are still accepted.
  - A new link becomes the main when the member has no main and no other active link, and imported members keep their state.
  - Guest applications have a switch separate from the review channel. No `/config` option is named `clear` (`unset_channel`, `unset_role`, `unset_rank`).
  - `/officer reset` and `/guest reset` return to the rank and membership rules, and ended grants are kept as history.
- The modal asks for a short introduction and why the visitor wants to join/how they found the community, 10–300 characters each. Officers use durable Approve/Deny buttons or commands. Submission alone grants no access.
- The bot owns managed lobby/member/staff visibility. **Leave the configured community-updates channel and Admin category alone.** Their exclusion is by Discord resource IDs, not names.
- Preserve the original Member/Guest role IDs and consecutive Leader → Officer → Member → Guest grouping.
- An FC Leader role gives staff visibility, not automatic bot officer command authority. Sensitive setup/delegation retains manager checks.
- Public interaction replies are intentionally enabled in DevBot. Production uses private defaults; form answers are omitted from ordinary confirmation/status/decision replies.

## 3. First actions next session

1. Read [../AGENTS.md](../AGENTS.md) and [../CLAUDE.md](../CLAUDE.md), inspect `git status`/history, and fetch remote state. Check whether 2.18.0 (`feat/issue-reporter-2.18.0`) was pushed, merged and published.
2. With the owner's go-ahead, deploy 2.18.0 to DevBot and to production with the migration procedure ([HOSTING.md](HOSTING.md#updating-to-a-release)). Put `GITHUB_REPORTS_TOKEN` in the host's `.env`, then register the commands (production `register.js --global`, DevBot's guild) and read them back. Then check that a test `/issue` opens an issue in `deconfined/tarubot-reports`.
3. Remind the owner of the open items in [OPEN_ITEMS.md](OPEN_ITEMS.md#production-after-the-cutover): W14 and W15, the DigitalOcean cleanup, rotating the legacy MariaDB login, DevBot's `GITHUB_REPORTS_TOKEN`, and regenerating the reports token.
4. Deploy 2.24.2 if it isn't yet, then merge and deploy 2.24.3 (#29; restarts). Then #30 (2.25.0), #32 (2.26.0) and later #31 (2.27.0), in the agreed release order. The robust, disposable host (owner decision, 2026-09-25) still needs the SSH deploy workflow from GitHub Actions, which takes the next free minor after #31; the heartbeat (2.22.0), rebuild runbook and settings copy (2.23.0) and daily backups (2.24.0) are done.
5. After that, OPS-10/OPS-11.

Useful read-only starting checks from the repository:

```sh
git status --short --branch
git remote -v
git fetch origin
git log --oneline -10
gh pr list --repo deconfined/tarubot --state all --limit 5
gh run list --repo deconfined/tarubot --workflow publish.yml --limit 3
docker compose -f docker-compose.yml -f docker-compose.devbot.yml ps
docker compose -f docker-compose.yml -f docker-compose.devbot.yml exec -T tarubot bun -e 'const r = await fetch("http://127.0.0.1:3000/health/ready"); console.log(await r.json());'
```

If your shell isn't in the `docker` group, run each `docker` command through `sg docker -c '…'`, as the 2026-09-24 session did.

## 4. v2 release to-dos

### Release and implementation

- [x] Merge the guest-form feature and publish 2.12.0 images.
- [x] Deploy migration 004 and a matching published release to DevBot (2.12.1); register commands and select officer-chat for new reviews.
- [x] Merge and publish 2.13.0 (launch policy, migration 005) and 2.14.0 (reply embeds), and deploy both to DevBot.
- [x] Merge and publish 2.14.1 (Claude review in the foreground, sidecar test clock; PR #13, run 35958526053). No DevBot deploy needed.
- [x] Merge and publish 2.15.0 (reply-session fixes, migration 006; PR #14, `974bd27`, publish run 36002040486, where the Claude review fix was confirmed), and roll it out to DevBot with the backup, restore check, migration rehearsal and migration, re-registering the guild commands (19 roots / 43 paths).
- [x] **2.15.1 (GitHub account rename to `deconfined`):** merged and published (PR #15, `529990f`).
- [x] **2.16.0 (deployment safeguards):** merged and published (PR #16, `c812d4d`), deployed to DevBot, and used for the production cutover.
- [x] **2.16.1 (Linode hosting):** merged and published (PR #17, `1655adc`), deployed to production and DevBot.
- [x] **P1 — 2.17.0 Lodestone hardening:** merged (PR #18, `baa9d3c`), published, and deployed to DevBot and production on 2026-09-25 with migration 007.
- [ ] **P1 — 2.18.0 issue reporter:** implemented on `feat/issue-reporter-2.18.0` (migration 008, `/issue`). Push, PR, merge and publish, then deploy and register commands.
- [ ] **P1 — Robust and disposable host** (owner decision, 2026-09-25).
- [ ] **P1 — Officer operational alerts (OPS-11 / DB-07), after launch:** aggregate material access changes, repeated role/nickname/guest/ledger delivery failures, and recovery notices; throttle per guild/run. Existing roster summaries do not cover all of these.
- [ ] **P1 — Telemetry (OPS-10), after launch:** complete operation/job durations, queue age, retry details, and guild/FC/run context while retaining redaction.
- [ ] **P2 — Burst handling:** rehearse role-event coalescing and member-enumeration backoff at representative guild size; fix any remaining rate-limit/recovery problems.

### Live acceptance

- [x] **Replies (2.14.0):** the owner's reply session, including the pass with Discord changes paused (2026-09-24). Deviations D1–D9 are resolved in 2.15.0. The live review-message conversion waits for a new application.
- [x] **Replies (2.15.0):** the 2.15.0 session on 2026-09-24. D1, D2, D4, D7 and D9 were confirmed live, `/officer reset` returned PigeonMuffin to his rank, and the owner accepted the remaining steps ([DEV_GUILD.md](DEV_GUILD.md#2150-session--2026-09-24)).
- [ ] **Guest forms (on hold until after launch):** submit as an unverified visitor; inspect both answers; approve/deny as an officer; verify role/DM outcomes, duplicate submissions, denial cooldown, stale forms after rejoin, original buttons after restart, deleted-review repair, blocked DMs, and denial of visitor self-approval.
- [ ] **Visibility/access:** ordinary accounts exercise newcomer, Member, Guest, Officer, and FC Leader visibility; verify automatic registered-visitor access, revocation/rejoin, private-area retention, excluded community resources, drift repair, and restart behavior.
- [ ] **Ledger:** initialize the isolated test account; deposit/withdraw/adjust; check exact balances/history and officer/private-read authorization; retry blocked notifications without a second financial mutation; verify account history across FC unlink/relink.
- [ ] **Characters and authorization:** name/world selection, private autocomplete, officer assignment, offline unassignment, multiple links/primary selection, expired/replaced proofs, rank-derived Officer access, grant/revoke precedence, and manager-only operations.
- [ ] **Nicknames:** successful non-owner writes, primary changes, manual-override suspension, re-enable baseline, restoration, and imported-user opt-in.
- [ ] **Membership/configuration transitions:** joins/departures/rejoins, FC and role rebinding, stale/failed acquisition, and two-observation departure handling without losing unrelated roles/history.
- [ ] **Version UI:** ordinary-user access, count boundaries, links, and signature badges.
- [ ] **Recovery:** restart with pending guest/ledger work, permission loss/restoration, database/Discord reconnects, and shutdown with work in flight.

### Hosting, recovery, and production cutover

- [x] Provision the managed cluster, create the foundation app, rehearse, and run the cutover ([MIGRATION.md](MIGRATION.md#record-of-the-2026-09-24-cutover)). Activation, global registration and the worker all completed on 2026-09-24.
- [x] Move production to the Linode Docker host and Linode managed PostgreSQL ([HOSTING.md](HOSTING.md)).
- [ ] W14 smoke checks and W15 officer configuration (owner).
- [ ] Late-joiner report and profile-job retries (needs 2.16.1).
- [ ] DigitalOcean cleanup: the app, then the cluster and its trusted-source rule (owner).
- [ ] Establish recurring off-site backups and restore rehearsals for the Linode cluster, and ownership of alerts, failures and upstream updates.

## 5. Evidence and implementation pointers

Latest complete behavioral run of a released feature: **2.15.0 — 1,207 tests / 36,688 assertions** with both the supplied dump and the synthetic CI fixture (1,099 unit, 18 contract, 90 PostgreSQL integration). Type checking, lint, formatting, build, SemVer validation, and the merged PR's (#14) CI checks, including the offline App Platform validation, security scans and container builds, passed. The **2.15.1** account-rename change passed **1,208 tests / 36,692 assertions** with both inputs (1,100 unit, 18 contract, 90 PostgreSQL integration). [VERIFICATION.md](VERIFICATION.md) records these runs, the review rounds and the earlier ones; automated runs do not constitute live acceptance.

The 2.12.1 maintenance change passed build, type checking, lint, formatting, SemVer checks, pinned offline App Platform validation, and the targeted startup-plan/App Platform/version tests (**7 tests / 55 assertions**).

| Work | Start here |
| --- | --- |
| Form opening/submission | `src/commands/guests/apply.command.ts`, `src/components/guest-application.component.ts`, `src/discord/guest-application.ts` |
| Application persistence/decisions | `Service.apply`, `Service.decide` in `src/application/service.ts`; `migrations/004_guest_application_form.sql` |
| Officer controls and review repair | `src/components/guest-review.component.ts`, `src/discord/gateway.ts`, `src/jobs/dispatch.ts` |
| Modal acknowledgement and authorization | `src/bot/command.ts`, `src/bot/router.ts` |
| Operational alerts/telemetry | `src/application/synchronization.ts`, `src/application/metrics.ts`, `src/jobs/queue.ts`, `src/jobs/dispatch.ts`, `src/main.ts` |
| Access policy | `src/application/access-facts.ts`, `src/application/guild-access.ts`, `src/discord/guild-access.ts`, `src/domain/policy.ts` |
| Persistence boundary | `src/infrastructure/postgres/schema.ts`, `database.ts`, `connection.ts`; [PERSISTENCE.md](PERSISTENCE.md) |
| Launch policy and cutover (2.13.0) | `src/application/activation.ts`, `src/application/grandfathering.ts`, `src/domain/grandfathering.ts`, `scripts/preview.ts`, `scripts/activate.ts`; the layout gate in `src/jobs/dispatch.ts`; `migrations/005_launch_access_policy.sql` |
| Production tooling and hosting | `src/config/deployment.ts`, `scripts/commands.ts`, `scripts/discord-inspect.ts`, `src/discord/inspection.ts`, `docker-compose.production.yml`, `production.env.example`; the writer lease in `src/application/lifecycle.ts` |
| Guest-application switch and resets (2.15.0) | `src/domain/guest-application.ts`, `src/commands/configuration/config.command.ts`, `Service.guestReset` in `src/application/service.ts`, `officerReset` in `src/application/role-administration.ts`, `src/commands/configuration/officer.command.ts`, `src/commands/guests/guest.command.ts`; `migrations/006_guest_application_switch.sql` |
| Member autocomplete and input Examples (2.15.0) | `src/discord/autocomplete.ts`, `src/discord/selectors.ts`, `src/discord/presenters/failure.ts`; `tests/unit/member-autocomplete.test.ts`, `tests/unit/failure-reply.test.ts` |
| Regression evidence | `tests/unit/guest-application.test.ts`, `tests/integration/persistence.test.ts`, [VERIFICATION.md](VERIFICATION.md) |

Known pre-rollout backups, local and ignored:

- `.cache/backups/tarubot_dev-before-2.10.1-0744cfb.dump`
- `.cache/backups/tarubot_dev-before-2.11.1-1de878e.dump`
- `.cache/backups/tarubot_dev-before-2.12.1-da7ed72.dump`
- `.cache/backups/tarubot_dev-before-2.12.3-341c6ed.dump`
- `.cache/backups/tarubot_dev-before-2.13.0-2e3f27c.dump`
- `.cache/backups/tarubot_dev-before-2.14.0-0e60f21.dump`
- `.cache/backups/tarubot_dev-handoff-0e60f21.dump` (restored on the new machine on 2026-09-24)
- `.cache/backups/tarubot_dev-before-2.15.0-974bd27.dump` (schema 005, before migration 006)

Take a fresh backup before every DevBot update. Keep `.env`, supplied dumps, backups, generated output, and coding-tool state out of Git.

## 6. Repository workflow reminders

- Repository: `/home/connstruct/src/tarubot` (Linux, since 2026-09-24); GitHub: `deconfined/tarubot` (the account was `connstructor` until 2026-09-24; images are `ghcr.io/deconfined/*`, and the old image paths no longer resolve). `origin` should use `https://github.com/deconfined/tarubot.git`. Work within this repository. Docker here needs the `docker` group; without it, run Docker commands through `sg docker -c '…'`.
- Use Bun and the existing discovered command/event/component modules. There is no submodule (since 2.20.0) and no sidecar (since 2.21.0). Refresh the bundled selectors with `bun run selectors:update`, committing the lockfile and `src/infrastructure/lodestone/upstream-revisions.json` together.
- Every coherent change, including documentation, increments SemVer/changelog and synchronized version references. Use feature branches and PRs; never commit directly to main or bypass required checks.
- Commit verified milestones with the configured SSH signing key. Do not push, rewrite history, or change Git configuration without explicit authorization.
- Signing key: `~/.ssh/id_git` (ED25519 `SHA256:Y7SmEUtV87C2xwDvDSYNS/f/BV3gT3yt2tkxCKkJTcc`, with `gpg.format=ssh`, verified locally through `~/.ssh/allowed_signers`). It must also be registered on GitHub as a *Signing Key* so pushed commits show Verified; check verification on the PR before merging. If signing fails, ask the owner; never substitute an unsigned commit. Check the latest commit with:

  ```sh
  git log --show-signature -1
  ```

- Applied migrations are immutable. Use Drizzle and `orm(client)` for application transactions, keeping state/audit/outbox together and remote I/O outside those transactions.
- DevBot always uses `-f docker-compose.devbot.yml` and database `tarubot_dev`; pin the published bot tag. Source builds explicitly add `-f docker-compose.build.yml`. Never point destructive tests at DevBot; test databases end in `_test`.
- The old stash `On feat/lobby-access: WIP lobby access before Drizzle persistence migration` was in the previous machine's clone; `git stash list` is empty in this one. That feature was subsequently integrated; if the stash turns up, do not reapply it blindly or discard it without permission.
- Start future major-version work only after v2 is settled and Taru is online, unless the owner reprioritizes. See [ROADMAP.md](ROADMAP.md).

## Suggested next-session prompt

> Read AGENTS.md, CLAUDE.md, and docs/SESSION_HANDOFF.md. TaruBot v2 has been live in Woven Souls since 2026-09-24. It runs on the Linode Docker host `tarubot@tarubot.deconfined.com` with Linode managed PostgreSQL (docs/HOSTING.md); 2.17.0 is deployed there and on DevBot. Check whether 2.18.0 (`feat/issue-reporter-2.18.0`: `/issue` and automatic issue reports to the private `deconfined/tarubot-reports`, migration 008) was merged and published. With the owner's go-ahead, deploy it with the migration procedure, add `GITHUB_REPORTS_TOKEN` to the host's `.env`, register the commands, and confirm a test `/issue` opens an issue. Then make the host robust and disposable as the owner decided on 2026-09-25: a rebuild runbook, an encrypted off-host `.env` copy, a heartbeat, backups, and an SSH deploy workflow. Raise the owner's open items in docs/OPEN_ITEMS.md. Preserve the owner's decisions in REQUIREMENTS.md.
