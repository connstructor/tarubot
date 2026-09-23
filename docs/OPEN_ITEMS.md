# Delivery backlog

Reviewed against `REQUIREMENTS.md`, the implementation, automated coverage, and recorded DevBot sessions on 2026-09-22. GitHub had no open issues or pull requests when reviewed; this document records the remaining delivery work.

## Established baseline

- All declared command families are implemented, including `/version`: **19 roots / 40 paths**.
- The 2.11.1 full automated suite passed **115 tests / 1,109 assertions** with both supplied and synthetic migration inputs, including a large-guild REST request-budget regression.
- Application and maintenance persistence use Drizzle with exact-value mappings and shared transaction clients. Catalog parity, policy/audit/outbox rollback, concurrent queue fencing, and capability aggregates passed PostgreSQL verification; the versioned live smoke remains to record.
- Opt-in lobby/member/staff visibility and registered-visitor Guest access are implemented with migration 003, SDK-effective permission tests, durable recovery snapshots, and PostgreSQL restart/revocation coverage. Live onboarding verification is the next session.
- DevBot 2.10.1 was deployed after a backup/restore comparison and migration rehearsal. Administrator is now off, the separate officer-chat was created and managed successfully, and compiled 2.10.2 preflight passed with the configured community-updates channel/category excluded. Full human visibility verification remains.
- The App Platform spec creates an inline PostgreSQL 18 dev database, with private parser routing and provider-CA TLS support. Offline doctl validation and deployment/TLS invariants passed; account-backed creation and operational rehearsal remain to be performed by the operator.
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
| Lobby onboarding | Deploy the community-scope fix, run `/setup officers:#officer-chat`, verify community resources remain outside policy, and exercise visibility, drift, restart, and visitor revocation with non-owner/non-Administrator users. Migration 003 and command registration are already deployed on DevBot. | **ACCESS-01–05**; `test-plans/current.json` |
| Guest applications | `/apply`; approve/deny via commands and buttons; original buttons after restart; deleted review-message repair; blocked DMs; deny/reapply cooldown; grant/revoke/rejoin; visible delivery outcomes. | **GUEST-01–09, AC-12–13** |
| Ledger | Initialize the isolated DevBot account; deposit/withdraw/adjust; balance/history pagination; ordinary-member versus officer authorization; blocked notification and retry without a second financial mutation; historical account access after unlink/relink. | **LEDGER-01–11, AC-15–17** |
| Character workflows | By-name/world search and selection, private autocomplete, officer assignment, offline local unassignment, multiple characters, primary selection, and expired/replaced proof through actual interactions. | **CHAR-01–05, VERIFY-01–06, AC-03–06** |
| Nicknames | Non-owner writes, primary changes, manual-override suspension, re-enable baseline, restoration, and imported-user opt-in. Record the happy path explicitly even where a normal write may already have occurred during claim testing. | **NICK-01–06, AC-14** |
| Officer/rank authorization | Actual rank-derived Officer access, manual grant/revoke precedence, ordinary-user denials, private autocomplete restrictions, manager-only setup/delegation, and rejected non-officer forced refreshes. | **AUTH-01–03** and approved staff-rank amendment |
| Membership/configuration transitions | Drift repair; joins/departures/rejoins; FC unlink/relink; role replacement/clearing; stale/failed acquisition; controlled departure-confirmation scenarios retaining unrelated roles and durable history. | **CFG-04–06, ROLE-01–06, SYNC-09–17, AC-07–11** |
| Version command | `commits:1` and `commits:10` through Discord; ordinary non-officer access; link clicks and badge appearance. Owner invocation and live backend retrieval have passed. | Approved `/version` amendment |
| Recovery | Restart with pending guest/ledger work, reconnects, permission loss/restoration, and graceful shutdown while decisions/effects are in flight. | **DB-03–06, OPS-07–09, AC-20–22** |
| App Platform | Fill secrets, provision the selected inline dev database/app, confirm TLS and internal routing, register commands, and rehearse the documented single-writer update and backup procedure. | **DEPLOY-DO-01**; `docs/APP_PLATFORM.md` |

## Production delivery gates

1. **Least-privilege rehearsal:** finish representative onboarding, role, nickname, guest, and ledger operations with the documented permissions. Administrator has been removed; hierarchy, command/member checks, and the new officer-room management have passed. **OPS-12 / AC-23**.
2. **Final source capture and migration:** stop the old writer, obtain the final consistent legacy dump and complete production Discord snapshot, reconcile counts/balances, and import with effects disabled. Preserve current guest holders through imported grants and retain nicknames/ownership provenance. **MIG-01–11**.
3. **Cutover preview and activation:** validate production resources/intents, acquire a fresh complete roster, inspect role/nickname previews and departure protection, register the production commands, then activate one writer and run representative smoke checks. **MIG-12**.
4. **Current-state recovery rehearsal:** repeat backup/restore verification using the current schema and representative post-import ledger/link/guest work; establish backup/WAL or equivalent replay procedures that retain acknowledged decisions. The recorded early rehearsal preceded later schema additions. **MIG-13 / OPS-13**.
5. **Operational ownership and acceptance:** arrange recurring backups, upstream-update execution, monitoring/alert response, and close each remaining acceptance item with evidence. Update the older checklist in `VERIFICATION.md` as sessions complete. **DEL-02 / DEL-04**.

## Recommended delivery order

1. Merge/publish the verified 2.11.1 release and update DevBot; migration 003 is already installed. App Platform deployment is a separate operator-run workflow.
2. Run the DevBot lobby/staff/registered-visitor session, including retained persistence and least-privilege visibility checks.
3. Guest and ledger end-to-end sessions, while completing operational alerting/telemetry.
4. Officer authorization, nickname lifecycle, and remaining membership/character scenarios.
5. Least-privilege and interruption/recovery rehearsal.
6. Production capture, import preview, and coordinated cutover.

PR validation, required CodeQL security/code-quality analysis, and post-merge GHCR publication are defined in `.github/workflows/ci.yml`, `codeql.yml`, and `publish.yml`, with synthetic PostgreSQL fixtures and AMD64/ARM64 image builds. Publication and pull-only DevBot deployment were verified for 2.8.3; subsequent releases follow the same checked PR/publication/deployment flow. This automation complements the live acceptance and cutover work above.
