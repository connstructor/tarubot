# Delivery backlog

Reviewed against `REQUIREMENTS.md`, the implementation, automated coverage, and recorded DevBot sessions through 2026-09-23. This document records the remaining delivery work.

Start a new session with [SESSION_HANDOFF.md](SESSION_HANDOFF.md), which distinguishes merged source, published images, and the running DevBot. Future major-version scope is recorded separately in [ROADMAP.md](ROADMAP.md).

## Established baseline

- All declared command families are implemented, including `/version`: **19 roots / 41 paths** from 2.13.0 (`/config role_layout` added).
- **2.14.0** (branch `feat/reply-presenters-2.14.0`; not yet merged, published, or deployed) replaces every JSON reply with the owner-approved embeds: one house-style embed per command, button, form and pre-form reply, failures with `Code · Ref` footers that match the logs, and embed ledger posts, review messages and decision DMs ([REPLIES.md](REPLIES.md)). It adds no migration. Its full container run passed **1,172 tests / 35,507 assertions** with the supplied dump and with the synthetic CI fixture. The DevBot reply session, including a pass with Discord changes paused, is in `test-plans/current.json`.
- **2.13.0** (merged in PR #11 and published) implements the owner's 2026-09-23 launch decisions and the cutover tooling. Its full container run passed **278 tests / 2,843 assertions** with both the supplied dump and the synthetic CI fixture. It includes:
  - registered-user Guest in every guild, with the multi-character union (ROLE-07);
  - one-time grandfathered Guest grants at first activation, from a checksum-confirmed preview plan (MIG-14);
  - the per-guild role-layout switch (CFG-07);
  - imports that close `/apply`, with a refusal before the form opens;
  - `adopt_holders:false` for Officer-role binding;
  - the deployment-identity guard (OPS-14), command read-back and cleanup, and a read-only production inspection;
  - the managed-cluster App Platform spec with worker-free phases;
  - the PostgreSQL writer lease;
  - migration 005.
- The 2.12.3 full automated suite passed **143 tests / 1,274 assertions** with both supplied and synthetic migration inputs, including guest-form acknowledgement/persistence/review, large-guild REST request-budget, Lodestone display-text, runtime-pin, and queue outcome/lease/applied-delta regressions.
- 2.12.3 logs expected queue waits at debug (escalating to warn after 10 minutes of continuous waiting), reports lost leases separately from superseded inputs, and keeps role changes applied by superseded reconciliation passes.
- Application and maintenance persistence use Drizzle with exact-value mappings and shared transaction clients. Catalog parity, policy/audit/outbox rollback, concurrent queue fencing, and capability aggregates passed PostgreSQL verification; the versioned live smoke remains to record.
- Opt-in lobby/member/staff visibility is implemented with migration 003, SDK-effective permission tests, durable recovery snapshots, and PostgreSQL restart/revocation coverage. Registered-visitor Guest, originally tied to onboarding, applies in every guild from 2.13.0. DevBot's 2.11.1 setup enabled onboarding at revision 10; its 11-channel access job succeeded with community resources excluded.
- DevBot runs the published **2.13.0** images (revision `2e3f27c`) on schema 005, applied on 2026-09-23 at 20:09:55 UTC after a stopped-writer backup and an exact restore/migration rehearsal; the updated commands are registered (19 roots / 41 paths) and guest reviews go to officer-chat (revision 11). See [DEV_GUILD.md](DEV_GUILD.md#2130-rollout--2026-09-23). Administrator remains off, all four existing roles and officer-chat were reused, and the lobby was created. Full human visibility verification remains.
- The 2.12.0 guest-form feature is merged in [PR #6](https://github.com/connstructor/tarubot/pull/6), all checks passed, and matching images were published by [run 35823822742](https://github.com/connstructor/tarubot/actions/runs/35823822742). It adds an unverified-visitor modal, durable answer review, and migration 004 while retaining automatic verified Guest eligibility. The first unverified-visitor submission and officer approval passed on DevBot; the remaining form scenarios are listed below. 2.12.1 records the handoff/roadmap as documentation maintenance, and 2.12.2 hardens the workflows and code scanning.
- From 2.13.0, the App Platform spec attaches the owner-provisioned Managed PostgreSQL cluster `tarubot-pg` (database/user `tarubot`). It has private parser routing and provider-CA TLS, and derives worker-free `foundation`/`maintenance` phases. Offline doctl validation of all phases and the deployment/TLS invariants passed. Provisioning the cluster and creating the app are owner-authorized actions still to perform.
- Live setup, original-role reuse, consecutive hierarchy/hoisting, real ownership verification, Member/FC Leader delivery, public development replies, and a complete seven-job refresh have passed.
- The owner nickname restriction was exercised and cleared by opting out. It is an expected Discord limitation.
- Nodestone submodule builds, dependency-update checks, clean-clone installation, containers, fixture import, and an earlier backup/restore rehearsal have passed.
- `/version` registration, owner invocation, and compiled live GitHub retrieval/rendering have been checked. Ordinary-member invocation and count/link/badge visual confirmation remain part of the current test plan.

## Implementation work

| Priority | Open item | Requirement / evidence |
| --- | --- | --- |
| P1 | Complete officer operational notifications: aggregate material access changes, repeated role/nickname/guest/ledger delivery failures, and recovery notices, with per-guild/run throttling. | **OPS-11, DB-07**. `Synchronization.roster` currently emits roster acceptance/degraded messages; general queue failures go to logs/status through `Queue` and `src/main.ts`. |
| P1 | Complete operational telemetry: application/job duration, queue age, retry context, and consistent guild/FC/run context. | **OPS-10**. Current reporting has operation IDs, result/error categories, queue counts, and roster age, but does not cover all required measurements. |
| P2 | Harden and rehearse coalescing/backoff for bursts of role events and complete member enumeration. | **SYNC-02, SYNC-14–17**. Live role changes produced transient gateway rate-limit errors before recovering; exercise this at representative guild size. |

## Live acceptance still to record

These paths have implementation and automated coverage. The remaining work is to exercise the integrated Discord behavior and resolve any failures found.

| Area | Remaining checks | Requirements |
| --- | --- | --- |
| Lobby onboarding | Setup/access job succeeded on 2.11.1. Exercise visibility, drift, restart, and visitor revocation with non-owner/non-Administrator users; retain excluded community policy. | **ACCESS-01–05**; `docs/DEV_GUILD.md` |
| Guest applications | **On hold until after launch** (owner, 2026-09-23); imported guilds launch with `/apply` closed. One unverified-visitor submission and button approval passed on 2.12.1 in officer-chat. Deny, and decide through commands; exercise original buttons after restart, deleted review-message repair, blocked DMs, duplicate/stale forms, denial cooldown, grant/revoke/rejoin, and visible delivery outcomes. | **GUEST-01–09, AC-12–13**; `test-plans/current.json` |
| Ledger | Initialize the isolated DevBot account; deposit/withdraw/adjust; balance/history pagination; ordinary-member versus officer authorization; blocked notification and retry without a second financial mutation; historical account access after unlink/relink. | **LEDGER-01–11, AC-15–17** |
| Character workflows | By-name/world search and selection, private autocomplete, officer assignment, offline local unassignment, multiple characters, primary selection, and expired/replaced proof through actual interactions. | **CHAR-01–05, VERIFY-01–06, AC-03–06** |
| Nicknames | Non-owner writes, primary changes, manual-override suspension, re-enable baseline, restoration, and imported-user opt-in. Record the happy path explicitly even where a normal write may already have occurred during claim testing. | **NICK-01–06, AC-14** |
| Officer/rank authorization | Actual rank-derived Officer access, manual grant/revoke precedence, ordinary-user denials, private autocomplete restrictions, manager-only setup/delegation, and rejected non-officer forced refreshes. | **AUTH-01–03** and approved staff-rank amendment |
| Membership/configuration transitions | Drift repair; joins/departures/rejoins; FC unlink/relink; role replacement/clearing; stale/failed acquisition; controlled departure-confirmation scenarios retaining unrelated roles and durable history. | **CFG-04–06, ROLE-01–06, SYNC-09–17, AC-07–11** |
| Version command | `commits:1` and `commits:10` through Discord; ordinary non-officer access; link clicks and badge appearance. Owner invocation and live backend retrieval have passed. | Approved `/version` amendment |
| Recovery | Restart with pending guest/ledger work, reconnects, permission loss/restoration, and graceful shutdown while decisions/effects are in flight. | **DB-03–06, OPS-07–09, AC-20–22** |
| App Platform | Owner-authorized: provision the managed cluster, user, grants, and trusted sources; create the `foundation` app; prove TLS, migration, and the firewall rule; rehearse a fork-based restore and the single-writer update procedure; perform the activation deploy in the window. | **DEPLOY-DO-01**; `docs/APP_PLATFORM.md` |
| 2.13.0 on DevBot | Deployed on 2026-09-23 (backup, rehearsal, migration 005, registration and guard refusals are recorded in DEV_GUILD.md). Remaining: the layout-switch and multi-character union checks, and the closed-applications refusal. | **CFG-07, ROLE-07, OPS-14, AC-24–27** |
| 2.14.0 on DevBot | Deploy (no migration), re-register commands, and run the reply session in `test-plans/current.json`: compare every reply with the approved mockups, match each error's Ref and Code to the log, read back the ledger posts and the review message, and repeat the change receipts and sync views with `ENABLE_EFFECTS=false`. | **UX-01–03, LEDGER-08** |

## Production delivery gates

1. **Least-privilege rehearsal:** finish representative role, nickname, Guest grant/revoke, and ledger operations with the documented permissions. Administrator has been removed; hierarchy, command/member checks, and the new officer-room management have passed. **OPS-12 / AC-23**.
2. **Owner preconditions:** remove the production application from the development guild (done 2026-09-23; it returns 404 there); confirm where the legacy bot runs and how its supervisor restart is disabled; decide the Officer exceptions for `/officer grant`. **Approved launch amendments**.
3. **Managed database and dress rehearsal:** provision the cluster, user, grants, and trusted sources, and create the `foundation` app. Run the read-only production inspection and the rehearsal-profile rehearsal on `tarubot_rehearsal`, including a same-cluster restore check. Review the preview's Member removals, Guest additions, and grandfathering plan with the owner. **DEPLOY-DO-01 / OPS-14 / MIG-12**; [MIGRATION.md](MIGRATION.md) E1–E2.
4. **Window, capture, and import:** stop and disable the legacy bot; reset the production token; take the final dump and complete Discord snapshot; migrate and import with effects, onboarding, layout, and applications off and grandfathering pending. **MIG-01–11 / MIG-13**.
5. **Preview, backups, and activation:** acquire twice at least 60 seconds apart, review the preview, and confirm the grandfathering checksum. Record a PITR marker and take an independent verify-full export, then activate. **MIG-12 / MIG-14**.
6. **Commands and writer:** register the global set, clear leftover guild scopes, and require `commands.js list` to exit 0. Start the single worker with the `full` phase, run the smoke checks and the late-joiner report, then configure officers (`/config officer_rank`, then the `/officer grant` exceptions, then `/config roles officer … adopt_holders:false`, so exceptions never lose the role in between). **UX-04 / MIG-12**.
7. **Current-state recovery rehearsal:** repeat backup/restore verification on the managed cluster using the current schema and representative post-import work. Provider PITR within 7 days plus independent exports retain acknowledged decisions. **MIG-13 / OPS-13**.
8. **Operational ownership and acceptance:** arrange recurring exports, upstream-update execution, and monitoring/alert response, and close each remaining acceptance item with evidence. Update the older checklist in `VERIFICATION.md` as sessions complete. **DEL-02 / DEL-04**.

## Recommended delivery order

The owner put guest-form acceptance and lobby onboarding on hold until after launch (2026-09-23) and chose App Platform with a managed PostgreSQL cluster for production.

1. Finish the 2.12.3 launch-scope DevBot session (deployed 2026-09-23; ledger initialize/deposit/withdraw/history passed): `/ledger adjust`, non-officer denials, `/assign`/`/unassign`, Member/Guest removals and drift repair, and `/guest grant`/`/guest revoke`.
2. Release the cutover policy and tooling: onboarding-independent registered-visitor Guest, first-activation grandfathered Guest grants, a per-guild role-layout switch, `/apply` off at launch, production tool separation, legacy command cleanup, and the managed-database App Platform spec. **Merged and published in 2.13.0** (PR #11) and deployed to DevBot; the layout-switch, union and closed-applications checks remain.
3. Replace every JSON reply with the owner-approved embeds (2.14.0). **Implemented** on `feat/reply-presenters-2.14.0`; the DevBot reply session, merge and publication remain. Then complete operational alerting/telemetry (OPS-10/OPS-11, 2.15.0).
4. Provision the managed database and App Platform app, establish backups/PITR, and rehearse restore on production-shaped data.
5. Run the read-only dress rehearsal against the production guild, then the coordinated cutover.
6. After launch: guest-form acceptance, lobby onboarding, and the remaining nickname/character scenarios.

PR validation, required CodeQL security/code-quality analysis, and post-merge GHCR publication are defined in `.github/workflows/ci.yml`, `codeql.yml`, and `publish.yml`, with synthetic PostgreSQL fixtures and AMD64/ARM64 image builds. Publication and pull-only DevBot deployment were verified for 2.8.3; subsequent releases follow the same checked PR/publication/deployment flow. This automation complements the live acceptance and cutover work above.
