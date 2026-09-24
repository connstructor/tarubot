# Session handoff — v2 release readiness

**Snapshot: 2026-09-23. Start here next session.** This records the observed repository, publication, and DevBot state; recheck them before making changes. [OPEN_ITEMS.md](OPEN_ITEMS.md) is the detailed requirements-backed checklist, and [ROADMAP.md](ROADMAP.md) records the owner's v2–v6 plan.

## 1. Where we stopped

The core v2 functionality is implemented and tested. The next live milestone is **deploying and testing the unverified-visitor application form**, followed by the remaining operational features, acceptance checks, and production cutover.

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

The handoff's documentation version is not evidence of a deployed image. **2.12.0 is already available for the guest-form rollout**; a later version must finish its own checked PR/publication first. The current source's startup plan and App Platform template track 2.12.3 as required by repository versioning.

**Update later on 2026-09-23:** DevBot now runs the published 2.12.1 images on schema 004, new guest reviews go to officer-chat, and the first unverified-visitor approval passed; see [DEV_GUILD.md](DEV_GUILD.md). The table above is the original snapshot.

**Update, 2.13.0:**
- **Branch.** `feat/launch-policy-2.13.0` started from `main` at `341c6ed` (2.12.3, PR #10). It implements the owner's launch decisions of 2026-09-23, recorded in [REQUIREMENTS.md](../REQUIREMENTS.md) under "Approved launch amendments", and adds migration `005_launch_access_policy.sql`.
- **Status.** Merged ([PR #11](https://github.com/connstructor/tarubot/pull/11), `2e3f27c`), published, and deployed to DevBot on schema 005 on 2026-09-23 (backup, rehearsal, migration, registration and guard refusals in [DEV_GUILD.md](DEV_GUILD.md#2130-rollout--2026-09-23)). The layout-switch, multi-character union and closed-applications checks remain.
- **Cutover.** The production cutover follows the rewritten [MIGRATION.md](MIGRATION.md) on App Platform with the managed PostgreSQL cluster, using a release at or above 2.15.0 (2.14.0 reply presentation, then 2.15.0 OPS-10/OPS-11).
- **Owner action.** Done: the DevBot `.env` `DATABASE_URL` names `…/tarubot_dev`, which the DevBot tool profile requires (it refuses `…/tarubot`).

**Update, 2.14.0 (current version):**
- **Branch.** `feat/reply-presenters-2.14.0` starts from `main` at `2e3f27c` (2.13.0, PR #11). It replaces every JSON reply with the owner-approved embeds ([REPLIES.md](REPLIES.md)). No migration: the schema stays `005_launch_access_policy.sql`.
- **Status.** Not yet merged, published, or deployed. Once published, deploy it to DevBot (no migration), re-register commands (the `/ledger history` `before` description changed) and run the reply session in `test-plans/current.json`, including the pass with Discord changes paused.

**Local handoff checkpoint:** the documentation and release-reference changes were validated on `docs/v2-release-handoff`. Check `git status` and the latest signed commit next session. The first signing attempt required a local GPG unlock (historical: commits are now signed with the SSH key described below). This documentation branch has not been pushed or given a PR at this checkpoint.

### Verified runtime observations

A fresh read-only check confirmed all three local containers healthy. Bot readiness reported database/Discord connected, effects enabled, public development replies enabled, **zero pending/blocked work**, and zero degraded FCs. The guild-scoped database query also found no queued/running/blocked/failed/disabled jobs.

- Guild revision **10**, active, effects enabled, onboarding enabled.
- Two active character ownership links.
- The development ledger account remains uninitialized: `balance = NULL`, `sequence = 0`.
- The 2.11.1 setup access job `8df5614c-3c95-44bb-b3d9-e5c90df4b436` previously completed for 11 managed channels. The owner reported that the rest looked good; exhaustive human visibility/recovery acceptance is still outstanding.
- Last posted running-image plan: [message 1552179968069472363 in #chat](https://discord.com/channels/1040379370159743139/1040379370931507252/1552179968069472363).

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
| Current guest-review destination | `1040379861153357995` — **dev**, still needs explicit rebinding |
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
  - `/apply` and onboarding are off at launch, and `/setup` is not run in production.
  - Officers come from the in-game rank, with the legacy Officer role bound `adopt_holders:false`.
  - The production app leaves the dev guild before cutover. Guest-form acceptance is deferred until after launch.
- The modal asks for a short introduction and why the visitor wants to join/how they found the community, 10–300 characters each. Officers use durable Approve/Deny buttons or commands. Submission alone grants no access.
- The bot owns managed lobby/member/staff visibility. **Leave the configured community-updates channel and Admin category alone.** Their exclusion is by Discord resource IDs, not names.
- Preserve the original Member/Guest role IDs and consecutive Leader → Officer → Member → Guest grouping.
- An FC Leader role gives staff visibility, not automatic bot officer command authority. Sensitive setup/delegation retains manager checks.
- Public interaction replies are intentionally enabled in DevBot. Production uses private defaults; form answers are omitted from ordinary confirmation/status/decision replies.

## 3. First actions next session

1. Read [../AGENTS.md](../AGENTS.md), inspect `git status`/history and the signed handoff commit, and fetch remote state. Continue from this handoff branch or its subsequently merged commit; local `main` may lag `origin/main`.
2. Confirm the selected rollout tag's publication. PR #6 and the 2.12.0 images are already complete; do not treat them as waiting on CI.
3. With authorization for the DevBot update, stop the writer, take a new database backup, rehearse/apply migration 004, and start matching bot/sidecar images. Register the updated slash commands. Follow [OPERATIONS.md](OPERATIONS.md), [SETUP.md](SETUP.md), and [DEV_GUILD.md](DEV_GUILD.md).
4. Before new applications, run:

   ```text
   /config guest_applications channel:#officer-chat
   /config validate
   ```

   Setup preserves existing notification destinations. Merely selecting officer-chat as the officer room did **not** move guest review out of #dev. Existing applications retain their original review channel.
5. Run the guest/access session from [../test-plans/current.json](../test-plans/current.json) using the plan matching the deployed release. Record application/job IDs, actual outcomes, and remaining issues in [DEV_GUILD.md](DEV_GUILD.md) and [OPEN_ITEMS.md](OPEN_ITEMS.md).
6. Complete operational alerts/telemetry and the remaining acceptance/recovery work below before production cutover.

Useful read-only starting checks from the repository:

```sh
git status --short --branch
git fetch origin
git log --oneline -10
gh pr view 6 --repo connstructor/tarubot
gh run view 35823822742 --repo connstructor/tarubot
docker compose -f docker-compose.yml -f docker-compose.devbot.yml ps
docker compose -f docker-compose.yml -f docker-compose.devbot.yml exec -T tarubot bun -e 'const r = await fetch("http://127.0.0.1:3000/health/ready"); console.log(await r.json());'
```

## 4. v2 release to-dos

### Release and implementation

- [x] Merge the guest-form feature and publish 2.12.0 images.
- [x] Deploy migration 004 and a matching published release to DevBot (2.12.1); register commands and select officer-chat for new reviews.
- [ ] **P1 — Officer operational alerts (OPS-11 / DB-07):** aggregate material access changes, repeated role/nickname/guest/ledger delivery failures, and recovery notices; throttle per guild/run. Existing roster summaries do not cover all of these.
- [ ] **P1 — Telemetry (OPS-10):** complete operation/job durations, queue age, retry details, and guild/FC/run context while retaining redaction.
- [ ] **P2 — Burst handling:** rehearse role-event coalescing and member-enumeration backoff at representative guild size; fix any remaining rate-limit/recovery problems.

### Live acceptance

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

Latest complete behavioral run: **2.12.0 — 127 tests / 1,196 assertions** with both the supplied dump and synthetic CI fixture (70 unit, 16 contract, 41 PostgreSQL integration). Type checking, lint, formatting, build, SemVer validation, offline App Platform validation, and the merged PR's CI/security/container checks passed. This 2.12.1 handoff is documentation/release-metadata maintenance; it does not constitute live acceptance.

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
| Regression evidence | `tests/unit/guest-application.test.ts`, `tests/integration/persistence.test.ts`, [VERIFICATION.md](VERIFICATION.md) |

Known pre-rollout backups, local and ignored:

- `.cache/backups/tarubot_dev-before-2.10.1-0744cfb.dump`
- `.cache/backups/tarubot_dev-before-2.11.1-1de878e.dump`

Take a fresh backup for the next migration. Keep `.env`, supplied dumps, backups, generated output, and coding-tool state out of Git.

## 6. Repository workflow reminders

- Repository: `/Users/connstruct/Documents/Projects/tarubot/new`; GitHub: `connstructor/tarubot`. Work within this repository.
- Use Bun and the existing discovered command/event/component modules. Initialize `vendor/nodestone` before installing/building. Nodestone updates go through `bun run nodestone:update` and include the submodule pointer, lockfile, and revision metadata together.
- Every coherent change, including documentation, increments SemVer/changelog and synchronized version references. Use feature branches and PRs; never commit directly to main or bypass required checks.
- Commit verified milestones with the configured SSH signing key. Do not push, rewrite history, or change Git configuration without explicit authorization.
- Signing key: `~/.ssh/id_git` (ED25519 `SHA256:Y7SmEUtV87C2xwDvDSYNS/f/BV3gT3yt2tkxCKkJTcc`, with `gpg.format=ssh`, verified locally through `~/.ssh/allowed_signers`). It must also be registered on GitHub as a *Signing Key* so pushed commits show Verified; check verification on the PR before merging. If signing fails, ask the owner; never substitute an unsigned commit. Check the latest commit with:

  ```sh
  git log --show-signature -1
  ```

- Applied migrations are immutable. Use Drizzle and `orm(client)` for application transactions, keeping state/audit/outbox together and remote I/O outside those transactions.
- DevBot always uses `-f docker-compose.devbot.yml` and database `tarubot_dev`; pin matching published bot/sidecar tags. Source builds explicitly add `-f docker-compose.build.yml`. Never point destructive tests at DevBot; test databases end in `_test`.
- The old stash `On feat/lobby-access: WIP lobby access before Drizzle persistence migration` still exists. That feature was subsequently integrated; do not reapply it blindly or discard it without permission.
- Start future major-version work only after v2 is settled and Taru is online, unless the owner reprioritizes. See [ROADMAP.md](ROADMAP.md).

## Suggested next-session prompt

> Read AGENTS.md, CLAUDE.md, and docs/SESSION_HANDOFF.md. Check the 2.14.0 branch or pull request, its publication, and the running DevBot state (2.13.0 on schema 005). Finish the remaining 2.13.0 DevBot checks (the layout switch, the multi-character union and the closed-applications refusal). After 2.14.0 is published, deploy it to DevBot (no migration), re-register commands, and run its reply session from test-plans/current.json, including the pass with Discord changes paused. Then deliver 2.15.0 (OPS-10/OPS-11), and follow docs/MIGRATION.md for the managed-cluster rehearsal and cutover. Preserve automatic registered Guest access, excluded community resources, and the owner's launch decisions in REQUIREMENTS.md. Keep the future roadmap in docs/ROADMAP.md for after the v2 launch.
