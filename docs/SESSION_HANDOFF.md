# Session handoff — v2 release readiness

**Snapshot: 2026-09-23, updated 2026-09-24. Start here next session.** This records the observed repository, publication, and DevBot state; recheck them before making changes. [OPEN_ITEMS.md](OPEN_ITEMS.md) is the detailed requirements-backed checklist, and [ROADMAP.md](ROADMAP.md) records the owner's v2–v6 plan.

## 1. Where we stopped

The core v2 functionality is implemented and tested. The table below is the original 2026-09-23 snapshot; the updates after it bring it to the current state. The owner's 2.14.0 reply session ran on 2026-09-24, and **2.15.0** ships its fixes and the owner's decisions, with the fixes from an adversarial review round (`07af9d8`). The next milestone, each step with the owner's go-ahead, is pushing 2.15.0 and opening its PR, then publication and the DevBot rollout (migration 006 and command re-registration), followed by its live session. After that come 2.16.0 (OPS-10/OPS-11), the remaining acceptance checks, and the production cutover.

| Layer | State at handoff |
| --- | --- |
| Latest merged feature | **2.12.0**, [PR #6](https://github.com/connstructor/tarubot/pull/6), merged on 2026-09-23 at 05:46:39 UTC |
| Merge commit | `db062bdbb9fc502d62a214f8a56692e418b8875b` |
| Signed feature commit | `5365511c05c8acee48a164c2b4765ee890438bc1` — Add unverified guest application forms in 2.12.0 |
| PR checks | Source/behavior checks, both container builds, CI result, CodeQL, and GitGuardian all passed |
| Image publication | [Run 35823822742](https://github.com/connstructor/tarubot/actions/runs/35823822742) succeeded for the merge; matching bot/sidecar **2.12.0** images are published |
| This documentation checkout | **2.12.1**, branch `docs/v2-release-handoff`, based on the merge above; publication is a separate future step |
| Running DevBot and sidecar | **2.11.1**, revision `1de878ef6c314cd83ac26bf7513d5db64210bcad` |
| Running database | `tarubot_dev`, schema **`003_guild_access.sql`** |
| Schema required by 2.12.x | **`004_guest_application_form.sql`**, not yet applied to DevBot |
| Production cutover | Not performed |

The handoff's documentation version is not evidence of a deployed image; each version must finish its own checked PR and publication before it is deployed. The current source's App Platform template tracks 2.15.0 as required by repository versioning, and its startup plan is the 2.15.0 session, to run after the 2.15.0 rollout.

**Update later on 2026-09-23:** DevBot then ran the published 2.12.1 images on schema 004, new guest reviews go to officer-chat, and the first unverified-visitor approval passed; see [DEV_GUILD.md](DEV_GUILD.md). The table above is the original snapshot.

**Update, 2.13.0:**
- **Branch.** `feat/launch-policy-2.13.0` started from `main` at `341c6ed` (2.12.3, PR #10). It implements the owner's launch decisions of 2026-09-23, recorded in [REQUIREMENTS.md](../REQUIREMENTS.md) under "Approved launch amendments", and adds migration `005_launch_access_policy.sql`.
- **Status.** Merged ([PR #11](https://github.com/connstructor/tarubot/pull/11), `2e3f27c`), published, and deployed to DevBot on schema 005 on 2026-09-23 (backup, rehearsal, migration, registration and guard refusals in [DEV_GUILD.md](DEV_GUILD.md#2130-rollout--2026-09-23)). The layout-switch and multi-character union checks remain. The closed-applications refusal passed in the 2.14.0 reply session.
- **Cutover.** The production cutover follows the rewritten [MIGRATION.md](MIGRATION.md) on App Platform with the managed PostgreSQL cluster. It was planned on a release at or above 2.15.0; since 2026-09-24 the floor is **2.16.0**, because OPS-10/OPS-11 moved there (see the 2.15.0 update).
- **Owner action.** Done: the DevBot `.env` `DATABASE_URL` names `…/tarubot_dev`, which the DevBot tool profile requires (it refuses `…/tarubot`).

**Update, 2.14.0:**
- **Branch.** `feat/reply-presenters-2.14.0` started from `main` at `2e3f27c` (2.13.0, PR #11). It replaces every JSON reply with the owner-approved embeds ([REPLIES.md](REPLIES.md)). No migration: the schema stays `005_launch_access_policy.sql`.
- **Status.** Merged ([PR #12](https://github.com/connstructor/tarubot/pull/12), `0e60f21`) on 2026-09-24. Publish run 35948831624 first failed on the sidecar spacing test in the amd64 build; re-running the failed jobs published `ghcr.io/connstructor/tarubot:2.14.0` and `tarubot-nodestone:2.14.0` and promoted `latest`. Deployed to DevBot at 02:58:17 UTC with no migration, commands re-registered (19 roots / 41 paths, matching the image) and the startup plan posted as message `1552514500140335215` ([DEV_GUILD.md](DEV_GUILD.md#2140-rollout--2026-09-24)).
- **Reply session.** Pending at the rollout. It ran later that day on the new machine (see the update after 2.14.1).

**Update, 2.14.1:**
- **Branch.** `ci/claude-review-foreground-2.14.1` starts from `main` at `0e60f21` (2.14.0, PR #12). CI and tests only: no runtime source change, no migration, no command change, so DevBot stays on 2.14.0.
- **Claude review.** Reviews had ended green in about 40 seconds with nothing posted: since Claude Code 2.1.198 a subagent starts in the background, and `claude-code-action` stops reading at the first result, which arrived while the plugin's gating agent still ran (run 35948050785). The review step now sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, prints the transcript only with debug logging, and fails in a new "Check that the review finished" step when the review was cut short. Its own PR gets no real review (the action skips a PR that changes its workflow); verify it on the next ready, same-repository PR to `main` as described in [OPEN_ITEMS.md](OPEN_ITEMS.md).
- **Sidecar test.** The spacing contract test measures on the monotonic clock with a 10 ms tolerance, fixing the flake that failed the first 2.14.0 publish attempt.
- **Status.** Merged ([PR #13](https://github.com/connstructor/tarubot/pull/13), `a28ad6c`) on 2026-09-24 and published by run 35958526053. DevBot stayed on 2.14.0, since 2.14.1 changes no runtime code.

**Update, machine move and the 2.14.0 reply session (2026-09-24):**
- **New machine.** DevBot and this repository moved to a new Linux machine; the repository is at `/home/connstruct/src/tarubot`. `tarubot_dev` was restored from `.cache/backups/tarubot_dev-handoff-0e60f21.dump`, and `check-restore.js` passed at `005_launch_access_policy.sql` for all 26 tables. DevBot 2.14.0 started at 03:52:47 UTC with clean readiness (including `writerLease`) and command read-back, and posted plan message `1552528212054249474` ([DEV_GUILD.md](DEV_GUILD.md#machine-move--2026-09-24)).
- **Docker.** Docker on this machine needs the `docker` group. The session ran Compose through `sg docker` (for example, `sg docker -c 'docker compose -f docker-compose.yml -f docker-compose.devbot.yml ps'`).
- **Reply session.** The owner ran it from 04:00 to 05:04 UTC. It covered all seven plan steps, including the paused pass (restart with `ENABLE_EFFECTS=false`, then restore; 7 held jobs requeued). Every failure's Ref and Code matched the log. It found nine deviations, D1–D9; the owner decided each one, and 2.15.0 ships them. The review-message conversion couldn't be confirmed live, because that needs a new application and the forms are on hold. Details, message IDs and the decision table are in [DEV_GUILD.md](DEV_GUILD.md#2140-reply-session--2026-09-24).
- **DevBot state.** DevBot runs 2.14.0 on schema 005 with effects on. Guest applications are open with reviews in officer-chat (revision 13). PigeonMuffin's officer access is still revoked from the session; restore it on 2.15.0 with `/officer reset`.

**Update, 2.15.0 (current version):**
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
- **Status.** Not yet pushed, merged, published or deployed. After the review fixes, type checking, lint, formatting, the build and `ci:version` passed, as did the unit (1,099) and contract (18) suites and the full container run with both the supplied dump and the synthetic CI fixture (1,207 tests / 36,688 assertions each, with 90 PostgreSQL integration tests). [VERIFICATION.md](VERIFICATION.md) has the evidence.
- **Owner approvals next.** Each needs the owner's go-ahead: push the branch and open the 2.15.0 PR; the DevBot rollout with migration 006, including the stopped-writer backup, restore check and migration rehearsal; guild command re-registration (19 roots / 43 paths); and the 2.15.0 DevBot session.
- **Open owner questions.** The owner ruled on 2026-09-24 that everything discussed, including `/officer reset` and `/guest reset`, is in launch scope. Still open: should the late-joiner report list a late joiner whose only grants `/guest reset` ended (it currently leaves them out, consistent with grandfathering, which counts those grants)? Should the [REPLIES.md deviations table](REPLIES.md#deviations-from-approved) keep its rows that compare against reply-spec states rather than drawn cards? [OPEN_ITEMS.md](OPEN_ITEMS.md#owner-approvals-and-questions-2150) tracks them.
- **Release plan.** OPS-10/OPS-11 (officer alerts and telemetry, and a restyled `officer.notify`) move to **2.16.0**. The production cutover requires a published release at or above **2.16.0**.

**Local handoff checkpoint (historical, 2026-09-23):** the documentation and release-reference changes were validated on `docs/v2-release-handoff`. The first signing attempt required a local GPG unlock (commits are now signed with the SSH key described below). That branch had not been pushed or given a PR at the checkpoint.

### Verified runtime observations

These observations are from the original snapshot. A fresh read-only check confirmed all three local containers healthy. Bot readiness reported database/Discord connected, effects enabled, public development replies enabled, **zero pending/blocked work**, and zero degraded FCs. The guild-scoped database query also found no queued/running/blocked/failed/disabled jobs.

- Guild revision **10**, active, effects enabled, onboarding enabled.
- Two active character ownership links.
- The development ledger account remains uninitialized: `balance = NULL`, `sequence = 0`.
- The 2.11.1 setup access job `8df5614c-3c95-44bb-b3d9-e5c90df4b436` previously completed for 11 managed channels. The owner reported that the rest looked good; exhaustive human visibility/recovery acceptance is still outstanding.
- Last posted running-image plan: [message 1552179968069472363 in #chat](https://discord.com/channels/1040379370159743139/1040379370931507252/1552179968069472363).

Since then, revision 11 moved guest reviews to officer-chat and the 2.12.3 session initialized the ledger. The 2.14.0 rollout check on 2026-09-24 found readiness 200 (database, writer lease, Discord and effects true; nothing pending or blocked; no degraded FCs), one writer-lease holder and no warn or error log lines. The reply session closed and reopened guest applications (revisions 12 and 13). When effects were restored at 05:03:49 UTC on the new machine, readiness was 200 with effects on, the writer lease held, nothing pending or blocked, one lease holder, and no warn or error lines. The latest plan is [message 1552546091290067046](https://discord.com/channels/1040379370159743139/1040379370931507252/1552546091290067046).

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
| Test member (officer by rank) | `289803961693765632` — PigeonMuffin (Wyra Riyuh `38804790`); officer access revoked in the 2.14.0 session, to restore with `/officer reset` |
| Test visitor | `1010097911566180445` — pazzberry, the 2.12.1 applicant; holds Guest after the session's `/guest revoke` and `/guest grant` |
| Startup-plan destination | `1040379370931507252` — chat |
| Excluded community-updates channel | `1040379572358746144` — moderator-only |
| Excluded parent category | `1040381910863593492` — Admin |

The last Discord permission check confirmed **Administrator disabled** and the documented eight explicit bot permissions, with all four managed roles below the bot. Use non-owner/non-Administrator humans for visibility and successful nickname-write tests. The owner opted out of nickname management after exercising Discord's owner restriction.

Keep these owner-approved decisions intact:

- **Manual guest applications are for unverified visitors only.** Trusted verified/imported/assigned non-FC users retain automatic Guest eligibility in every guild under the freshness policy (ROLE-07), with or without onboarding; FC members retain Member precedence. Access is the union over a user's linked characters. Explicit Guest revocation remains authoritative.
- **Launch decisions (2026-09-23):**
  - Production uses App Platform with the managed cluster, and exactly one database writer (the writer lease).
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

1. Read [../AGENTS.md](../AGENTS.md) and [../CLAUDE.md](../CLAUDE.md), inspect `git status`/history and the latest signed commit, and fetch remote state; local `main` may lag `origin/main`. Check whether `feat/reply-session-fixes-2.15.0` was pushed, and whether its PR was opened, merged and published. Raise the open owner questions from the 2.15.0 update above if they are still unanswered.
2. When the owner asks, push the branch and open the 2.15.0 PR. Confirm the Claude review fix on it: "Check that the review finished" shows `started_in_background` 0 and every spawned subagent completed, and `claude[bot]` posts inline comments or "No issues found" ([OPEN_ITEMS.md](OPEN_ITEMS.md) has the fallbacks). Merge once CI, CodeQL and the review pass, then confirm that publication produced the 2.15.0 images.
3. Roll 2.15.0 out to DevBot with the owner's go-ahead for each step (CLAUDE.md "Updating DevBot"):
   1. Stop `tarubot` and back up to `.cache/backups/tarubot_dev-before-2.15.0-<sha>.dump`.
   2. Restore into `tarubot_dev_restore_test` and run `check-restore.js` from the 2.14.0 build, or from the 2.15.0 build with `--schema-version 005_launch_access_policy.sql`.
   3. Rehearse migration 006 with `migrate.js --restore-rehearsal`; it must print `Schema ready.`
   4. Run `migrate.js` against `tarubot_dev`, then `up -d --wait tarubot nodestone` with `TARUBOT_IMAGE_TAG=2.15.0`.
   5. Re-register the guild commands and confirm 19 roots / 43 paths with `commands.js list`.
   6. Check readiness (including `writerLease`), the logs, and the plan posted in #chat.
4. With the owner, run the 2.15.0 session from [../test-plans/current.json](../test-plans/current.json). It checks every D1–D9 fix live and restores PigeonMuffin's officer access with `/officer reset`. Record message IDs, Refs, Codes and deviations in [DEV_GUILD.md](DEV_GUILD.md) and [OPEN_ITEMS.md](OPEN_ITEMS.md).
5. Finish the earlier DevBot checks that remain: from the 2.13.0 plan (message `1552411775201316946`), the layout switch and the union through `/assign` with numeric IDs. The 2.12.3 `/assign`/`/unassign`, Member/Guest removals and drift repair also remain. The 2.14.0 session covered the closed `/apply`, Guest revoke and grant, `/ledger adjust` and the non-officer denials.
6. Deliver 2.16.0 (OPS-10/OPS-11 officer alerts and telemetry, and a restyled `officer.notify`).
7. Then provision the managed database and follow [MIGRATION.md](MIGRATION.md) for the rehearsal and the cutover, using a published release at or above **2.16.0**.

Useful read-only starting checks from the repository:

```sh
git status --short --branch
git fetch origin
git log --oneline -10
gh pr list --repo connstructor/tarubot --state all --limit 5
gh run view 35958526053 --repo connstructor/tarubot
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
- [ ] **2.15.0 (reply-session fixes, migration 006):** push the branch, open the PR and confirm the Claude review there; merge and publish; roll out to DevBot with the backup, restore check, migration rehearsal and migration; re-register guild commands (19 roots / 43 paths).
- [ ] **P1 — Officer operational alerts (OPS-11 / DB-07), 2.16.0:** aggregate material access changes, repeated role/nickname/guest/ledger delivery failures, and recovery notices; throttle per guild/run. Existing roster summaries do not cover all of these.
- [ ] **P1 — Telemetry (OPS-10), 2.16.0:** complete operation/job durations, queue age, retry details, and guild/FC/run context while retaining redaction.
- [ ] **P2 — Burst handling:** rehearse role-event coalescing and member-enumeration backoff at representative guild size; fix any remaining rate-limit/recovery problems.

### Live acceptance

- [x] **Replies (2.14.0):** the owner's reply session, including the pass with Discord changes paused (2026-09-24). Deviations D1–D9 are resolved in 2.15.0. The live review-message conversion waits for a new application.
- [ ] **Replies (2.15.0):** the 2.15.0 session in `test-plans/current.json` after the rollout, including restoring PigeonMuffin's officer access with `/officer reset`.
- [ ] **Guest forms (on hold until after launch):** submit as an unverified visitor; inspect both answers; approve/deny as an officer; verify role/DM outcomes, duplicate submissions, denial cooldown, stale forms after rejoin, original buttons after restart, deleted-review repair, blocked DMs, and denial of visitor self-approval.
- [ ] **Visibility/access:** ordinary accounts exercise newcomer, Member, Guest, Officer, and FC Leader visibility; verify automatic registered-visitor access, revocation/rejoin, private-area retention, excluded community resources, drift repair, and restart behavior.
- [ ] **Ledger:** initialize the isolated test account; deposit/withdraw/adjust; check exact balances/history and officer/private-read authorization; retry blocked notifications without a second financial mutation; verify account history across FC unlink/relink.
- [ ] **Characters and authorization:** name/world selection, private autocomplete, officer assignment, offline unassignment, multiple links/primary selection, expired/replaced proofs, rank-derived Officer access, grant/revoke precedence, and manager-only operations.
- [ ] **Nicknames:** successful non-owner writes, primary changes, manual-override suspension, re-enable baseline, restoration, and imported-user opt-in.
- [ ] **Membership/configuration transitions:** joins/departures/rejoins, FC and role rebinding, stale/failed acquisition, and two-observation departure handling without losing unrelated roles/history.
- [ ] **Version UI:** ordinary-user access, count boundaries, links, and signature badges.
- [ ] **Recovery:** restart with pending guest/ledger work, permission loss/restoration, database/Discord reconnects, and shutdown with work in flight.

### Hosting, recovery, and production cutover

- [ ] Establish recurring backups and operational ownership for alerts, failures, and upstream updates.
- [ ] Rehearse backup/restore on the current schema with representative ledger/link/guest/job state. Recovery must retain acknowledged decisions newer than the original legacy import; establish WAL/PITR or an equivalent replay/reconciliation procedure.
- [ ] Provision the owner-authorized **Managed PostgreSQL cluster** `tarubot-pg` (database/user `tarubot`, public-schema grants, trusted sources) and create the worker-free `foundation` app; prove verified TLS, the pre-deploy migration, internal Nodestone routing, backups/PITR plus independent exports, and single-writer updates ([APP_PLATFORM.md](APP_PLATFORM.md)). The spec and its phases are validated offline, but no DO resources have been created.
- [ ] In the production maintenance window, stop the legacy writer and freeze managed-role changes; obtain a fresh consistent dump and complete production Discord snapshot.
- [ ] Import with effects disabled, reconcile actual counts/balances, and preserve ownership, existing guest grants, nicknames, and provenance. The supplied historical fixture is rehearsal input, not automatically the final production state.
- [ ] Validate production identities/permissions/configuration, acquire a fresh roster, review role/nickname deltas, and resolve blocked resources before activation.
- [ ] Follow the rewritten [MIGRATION.md](MIGRATION.md) runbook (E0 conventions, E1 preconditions, E2 rehearsal, E3 window W1–W16, E4 recovery limits). Activate with the confirmed grandfathering checksum, then register the global commands, clear guild leftovers, start the single worker, and run the smoke checks and officer configuration.

## 5. Evidence and implementation pointers

Latest complete behavioral run of a released feature: **2.14.0 — 1,172 tests / 35,507 assertions** with both the supplied dump and synthetic CI fixture (1,069 unit, 18 contract, 85 PostgreSQL integration). Type checking, lint, formatting, build, SemVer validation, offline App Platform validation, and the merged PR's CI/security/container checks passed. [VERIFICATION.md](VERIFICATION.md) records the 2.14.1 run and the earlier ones; automated runs do not constitute live acceptance. The unreleased **2.15.0** source, with the review fixes, passed **1,206 tests / 36,647 assertions** in its full container run with the supplied dump (1,098 unit, 18 contract, 90 PostgreSQL integration). VERIFICATION.md records the review round and, once it finishes, the synthetic-fixture run.

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
| Production tooling and hosting | `src/config/deployment.ts`, `scripts/commands.ts`, `scripts/discord-inspect.ts`, `src/discord/inspection.ts`, `scripts/app-spec.ts`, `.do/app.yaml`, `production.env.example`; the writer lease in `src/application/lifecycle.ts` |
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

Take a fresh backup for the next migration (006, in the 2.15.0 rollout). Keep `.env`, supplied dumps, backups, generated output, and coding-tool state out of Git.

## 6. Repository workflow reminders

- Repository: `/home/connstruct/src/tarubot` (Linux, since 2026-09-24); GitHub: `connstructor/tarubot`. Work within this repository. Docker here needs the `docker` group; without it, run Docker commands through `sg docker -c '…'`.
- Use Bun and the existing discovered command/event/component modules. Initialize `vendor/nodestone` before installing/building. Nodestone updates go through `bun run nodestone:update` and include the submodule pointer, lockfile, and revision metadata together.
- Every coherent change, including documentation, increments SemVer/changelog and synchronized version references. Use feature branches and PRs; never commit directly to main or bypass required checks.
- Commit verified milestones with the configured SSH signing key. Do not push, rewrite history, or change Git configuration without explicit authorization.
- Signing key: `~/.ssh/id_git` (ED25519 `SHA256:Y7SmEUtV87C2xwDvDSYNS/f/BV3gT3yt2tkxCKkJTcc`, with `gpg.format=ssh`, verified locally through `~/.ssh/allowed_signers`). It must also be registered on GitHub as a *Signing Key* so pushed commits show Verified; check verification on the PR before merging. If signing fails, ask the owner; never substitute an unsigned commit. Check the latest commit with:

  ```sh
  git log --show-signature -1
  ```

- Applied migrations are immutable. Use Drizzle and `orm(client)` for application transactions, keeping state/audit/outbox together and remote I/O outside those transactions.
- DevBot always uses `-f docker-compose.devbot.yml` and database `tarubot_dev`; pin matching published bot/sidecar tags. Source builds explicitly add `-f docker-compose.build.yml`. Never point destructive tests at DevBot; test databases end in `_test`.
- The old stash `On feat/lobby-access: WIP lobby access before Drizzle persistence migration` was in the previous machine's clone; `git stash list` is empty in this one. That feature was subsequently integrated; if the stash turns up, do not reapply it blindly or discard it without permission.
- Start future major-version work only after v2 is settled and Taru is online, unless the owner reprioritizes. See [ROADMAP.md](ROADMAP.md).

## Suggested next-session prompt

> Read AGENTS.md, CLAUDE.md, and docs/SESSION_HANDOFF.md. Check the 2.15.0 branch (feat/reply-session-fixes-2.15.0) or its pull request, its publication, and the running DevBot state (2.14.0 on schema 005 on the Linux machine; use sg docker if the shell lacks the docker group). Raise the open owner questions in docs/OPEN_ITEMS.md (launch scope of the resets, late joiners after /guest reset, the REPLIES deviation-table framing). When the owner asks, push the branch, open the 2.15.0 pull request and confirm there that the Claude review finishes and posts; merge and publish it once its checks pass. With the owner's go-ahead, roll it out to DevBot: backup, restore check with --schema-version 005_launch_access_policy.sql, migrate.js --restore-rehearsal, migrate (006), deploy, and re-register the guild commands (19 roots / 43 paths). Then run the 2.15.0 session from test-plans/current.json, including restoring PigeonMuffin's officer access with /officer reset, and finish the remaining 2.13.0 DevBot checks (the layout switch and the multi-character union). Then deliver 2.16.0 (OPS-10/OPS-11). Follow docs/MIGRATION.md for the managed-cluster rehearsal and cutover with a published release at or above 2.16.0. Preserve automatic registered Guest access, excluded community resources, and the owner's launch and reply-session decisions in REQUIREMENTS.md and docs/DEV_GUILD.md. Keep the future roadmap in docs/ROADMAP.md for after the v2 launch.
