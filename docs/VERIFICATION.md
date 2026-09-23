# Verification and remaining deployment gate

## Completed local verification — 2026-09-21

- **49 tests passed**: 16 unit, 11 contract, and 22 PostgreSQL integration tests; 198 assertions in the full container run.
- Module tests cover recursive discovery, invalid/duplicate exports, typed service requirements, multiple/once-only event handlers, listener cleanup, empty feature groups, and source/compiled inventory parity. Extracted guild-event operations are exercised against PostgreSQL.
- Strict TypeScript checking, first-party ESM/explicit-any linting, and formatting checks passed.
- Both production images built from a clean frozen-lockfile installation. The bot image runs as UID 1000 with compiled JavaScript; the SQL backup and `.env` are excluded.
- The import dry run matched all supplied fixture counts and the exact 349,279,945-gil configured opening balance.
- All four parser operations succeeded against live Lodestone in the sidecar. A complete live Woven Souls crawl validated **105 distinct members across three pages**, including the metadata recheck.
- PostgreSQL backup/restore preserved every row in all **24 application/schema tables**, as well as sequence state, triggers, and constraints. The same comparison passed after PostgreSQL container recreation using the named volume.
- The sidecar exited with code 0 on SIGTERM and returned healthy after restart.

Live registration, gateway connection/restart, complete member enumeration, hierarchy validation, and bot-owned message delivery were subsequently checked with DevBot. See [DEV_GUILD.md](DEV_GUILD.md) for the session results and remaining human/least-privilege checks.

## Upstream-tracking verification — 2026-09-22

- **52 automated tests passed**: 19 unit, 11 contract, and 22 PostgreSQL integration tests; 204 assertions.
- Both source dependencies follow upstream HEAD. The refresh command updated/checked the lockfile and full revision metadata, then passed build, type, and contract checks.
- The deployed sidecar's hourly monitor reported both upstream repositories current. Tests cover selector-only updates, failed freshness checks, and strict lockfile revision extraction.

## Automated suites

The latest full behavioral regression for **2.12.3** passed **143 tests**: 82 unit, 16 contract, and 45 PostgreSQL integration tests (**1,274 assertions** per full container run). The complete suite passed with both the supplied dump and the synthetic CI fixture. Strict type checking, lint, formatting, the compiled build, and SemVer/changelog checks also passed. The synchronized App Platform spec passed the pinned offline doctl schema check; registry/local-build Compose validation passed in the preceding deployment milestone. Workflow/actionlint validation was recorded during the preceding CI/CD work. The command inventory contains 40 paths across 19 root commands; runtime discovery includes 15 event modules and two component namespaces. Current delivery work is tracked in [OPEN_ITEMS.md](OPEN_ITEMS.md).

The **2.12.1 documentation/handoff milestone** passed the compiled build, type checking, lint, formatting, SemVer checks, and pinned offline App Platform validation. Its targeted startup-plan, App Platform, and version-presentation tests passed **7 tests / 55 assertions**.

The **2.12.2 workflow and code-scanning milestone** also passed actionlint 1.7.12 (except its not-yet-supported `concurrency.queue` key, which GitHub documents) and zizmor 1.30.1, whose only finding is the intentional local reusable-workflow reference. Its new tests cover Lodestone display-text normalization and Bun runtime/PostgreSQL image pin agreement; the Docker image build ran them in its unit stage.

The **2.12.3 queue-logging patch** adds DB-free outcome classification tests (levels, statuses, attempt refunds, and the continuous-wait escalation threshold) and PostgreSQL regressions for a lost-but-unreclaimed lease (nothing written, reclaimed as a counted attempt), supersession cause text, wait-streak escalation that ignores row age, success-result merging that carries only `applied`, the retained Guest delta after a gateway-echo supersession, and roster lease loss that no longer marks Lodestone degraded.

Drizzle regression checks independently compare all **25 application table mappings** to the migrated PostgreSQL catalog (column inventory, types, nullability, and defaults). Actual driver round trips preserve unsigned 64-bit external IDs, signed-bigint maximum money, sequences beyond JavaScript's safe-integer range, UTC millisecond instants, and scalar/nested JSON including JSON null. One transaction's policy, audit, and outbox rows are invisible to pooled reads and roll back together. Concurrent queue claims skip a separately locked row; a superseding reconciliation generation discards stale results, respects retry due time, and completes under a fresh lease. Capability aggregates handle empty scopes and shared FCs without double-counting. The injected import-failure test checks PostgreSQL's error through Drizzle's `cause`.

Application and maintenance persistence uses the shared typed ORM boundary. The 2.12.x source requires `SCHEMA_VERSION=004_guest_application_form.sql`; the preceding migrations remain immutable. PR #6 and 2.12.0 image publication completed successfully. DevBot runs the published 2.12.1 images on schema 004 after a stopped-writer backup and an exact restore/migration rehearsal on 2026-09-23; readiness, command registration, and the first unverified-visitor approval passed. The current `test-plans/current.json` tracks 2.12.3 and covers the launch-scope ledger, authorization, assignment, role-removal, and Guest grant/revoke testing (guest forms are on hold); exhaustive human visibility/recovery checks remain. See [SESSION_HANDOFF.md](SESSION_HANDOFF.md), [DEV_GUILD.md](DEV_GUILD.md), [PERSISTENCE.md](PERSISTENCE.md), and [SETUP.md](SETUP.md).

Guest-form coverage uses real Discord.js command/modal/button parsing and acknowledgement methods. It checks immediate modal opening for cached/raw guilds, scope/bot/DM failures, fresh submission actors, user/guild bindings, officer-only decisions, answer limits/escaping, and deleted-message repair with persisted answers and disabled completed controls. PostgreSQL scenarios cover duplicate submissions, restart, role delivery after approval, stale/raced joins, denial cooldown, legacy nullable answers, registered-visitor supersession/revocation, and atomic rollback of answers/audit/outbox.

Onboarding coverage uses actual Discord.js member/channel objects and controlled REST responses to verify the newcomer, Member, Guest, Officer, FC Leader, bot, owner, and Administrator visibility matrix across text, voice, category, announcement, stage, forum, and media channels. Parent visibility is checked for threads. Provisioning tests verify lobby/officer room reuse and creation, ambiguity/authorization failures, original parent retention, explicit bot permissions, and no-op enforcement. PostgreSQL tests exercise first-snapshot retention, private-area classification, partial-failure/restart recovery, role replacement, setup exclusion, activation/revision fences, missing-room readback, channel-event deduplication, and refresh child accounting. The Codex explicit-deny regression reproduced Member/Guest exposure before the fix; SDK and persisted-policy assertions now retain staff-only classification for Member, Guest, other-role, and member-specific denies while an overwrite-free default-closed channel remains ordinary. Registered-visitor tests cover fresh/unknown/stale evidence, revocation/rejoin, Member precedence, unlink, FC-less registration, opt-in defaults, and cross-guild isolation.

Coverage includes repeat setup, server-manager boundaries, rank-derived officer access, explicit revocation precedence, indirect-delegation prevention, custom leader titles, complete responsibility-separated session messages, and scoped public replies. Layout regressions cover consecutive blocks, full-hierarchy readback rejecting interleaving, partial configurations, unrelated-role ordering, Discord's tied raw positions, effect activation, mutual exclusion with setup, configuration revision fencing, self-generated role-event convergence, and refresh child-job accounting. Role-selection tests cover canonical names across prefixes, explicit configured IDs, ambiguous/deleted bindings, and SDK-backed reuse/renaming without recreating roles or changing permissions.

Community-scope regressions exclude inaccessible or misleadingly named configured update rooms and their categories from provisioning, snapshots, and writes. They reject reserved bindings, recheck settings/parent changes during an operation, preserve inherited visibility defaults, and block incomplete metadata. PostgreSQL verifies that protected records are not created or mutated and that repeat reconciliation remains a no-op.

The request-budget regression runs the real `GuildAccess.reconcile` loop with Discord.js fixtures and PostgreSQL for 82 managed channels plus protected community resources. A converged pass performs exactly two full channel-list reads and zero target reads/writes; repairing one drifted channel still uses two full lists, with only that target read before/after its single write. Gateway binding/parent changes, disconnection, and missing protected metadata invalidate the scoped pass. Full final inventory verification remains in place; changing the shared everyone default adds at most one extra catalogue read.

App Platform checks verify automatic inline dev-database creation, matching release images, one bot instance, internal-only parser routing, and component-scoped secrets/bindings. Native node-postgres parsing tests verify that an explicit provider CA retains certificate verification over URL SSL switches, with credentials and ordinary parameters preserved. The pinned doctl 1.169.0 image validates `.do/app.yaml` under `--network none --schema-only`. These are local/configuration checks; no DO app or database has been provisioned or exercised in a real account.

Version-command coverage verifies ordinary-user access, count bounds, compiled manifest identity, canonical commit links, verified-signature badges, Unicode/Markdown embed limits, shared request caching, and version availability during GitHub rate limits, transport errors, and malformed responses.

The Nodestone submodule integration passed the explicit HEAD-update workflow, local builds, and both runtime image builds with frozen-lockfile installation. A fresh `--recurse-submodules` clone independently passed frozen installation, compilation, type checking, and all 38 unit/11 contract tests, leaving both repositories clean. Parser fingerprint tests cover absent initialization, changed source/manifest inputs, and Git-free Docker validation. The upstream checkout remained clean at its recorded commit. The deployed sidecar reported ready and current against both upstream repositories.

Live role readback also verified the corrected consecutive block, reuse of the original Member/Guest IDs with permissions retained, both verified members' access, removal of the empty setup-created duplicates, and no-op layout convergence. See [DEV_GUILD.md](DEV_GUILD.md) for IDs and the current startup-plan message.

- `tests/unit`: module discovery/lifecycle contracts, exact IDs/money, access precedence, Unicode-safe nicknames, departure timing, command inventory, SQL decoding, and snapshot completeness validation.
- `tests/contract`: the compiled pinned Nodestone parsers, all four operations, entity/Unicode normalization, ID agreement, zero/unknown distinctions, complete roster acquisition, malformed roots, transport failures/retry metadata, request concurrency/spacing, and cancellation.
- `tests/integration`: real PostgreSQL import reconciliation, ownership races, hash-only verification after service restart, local unlink, guest decision races, join-context changes, revocation durability, two-observation import protection, stale-refresh retention, nickname restoration/manual overrides, exact ledger transactions, notification retry, import rollback/idempotence, cross-guild isolation, schema/ORM parity and codecs, transaction isolation, concurrent work claims/generation fencing, capability aggregates, and expired lease recovery.

Run `bun run test:docker` for the complete fixture/database suite. `bun run typecheck`, `bun run lint`, and `bun run format:check` cover first-party source, tooling, and tests. The image build independently repeats type checking and unit/contract tests after a clean frozen-lockfile installation.

The supplied dump is a migration acceptance fixture, supplied to test containers separately from the images. Public CI generates an invented equivalent-shape input through `test:fixture`; it does not receive the private dump. Production activation uses a complete real Discord snapshot. Synthetic SQL and snapshots are exclusively test fixtures. See [CI_CD.md](CI_CD.md) for the PR checks and post-merge publication flow.

## Acceptance traceability

| Criteria | Verification |
| --- | --- |
| AC-01 | Bun/ESM strict build; source-built sidecar import/assets and parser calls in production image |
| AC-02 | ID and money unit tests; actual fixture import and PostgreSQL bigint boundary tests |
| AC-03 | Search URL/Unicode contracts; complete-page normalization and exact-match application logic; test-guild selection smoke |
| AC-04–06 | Proof persistence/concurrency and local unlink integration; permission/ownership checks; live biography-publication smoke |
| AC-07–09 | Departure/access unit policy plus accepted/failed roster publication integration, imported-member protection |
| AC-10–11 | Per-user delta reconciliation, complete-enumeration gateway checks, configuration revisions/retired-role cleanup; live hierarchy/drift smoke |
| AC-12–13 | Application/decision races, durable review IDs, forged-message rejection, changed join context, delivery state; live buttons/DM smoke |
| AC-14 | Grapheme truncation and nickname restoration/manual override integration; guild-owner hierarchy smoke |
| AC-15–17 | Account locking/idempotency, initialization/overflow, immutable history, notification recovery, cross-guild account tests |
| AC-18–19 | Full supplied fixture, source provenance, default preferences, atomic rollback and repeat-import retention |
| AC-20 | Lease fencing and durable-decision retry tests; operational process restart/recovery rehearsal |
| AC-21 | Compiled-parser error fixtures, concurrency/spacing, actual transport cancellation and worker termination |
| AC-22 | Clean Docker builds, Compose validation, PostgreSQL volume recreation and backup/restore rehearsal; live Discord reconnect smoke |
| AC-23 | Exact 40 command-path inventory test across 19 root commands; explicit registration and test-guild permission/intent smoke |
| ACCESS-01–05 | SDK permission/provisioning/community-scope tests and PostgreSQL policy/recovery/registration tests; limited-permission room management and read-only scope preflight passed; full human onboarding session pending |
| DEPLOY-DO-01 | Offline provider schema validation, spec invariants, and native driver TLS-option tests; account-backed deployment remains operator-run |

## Live Discord gate

The development application and guild are now configured. Human interaction and least-privilege tests remain in this checklist:

1. Register guild-scoped commands and compare the deployed inventory to the discovered `src/commands/**/*.command.ts` modules.
2. Verify self/officer authorization, private autocomplete, and rejected non-officer `force:true` requests. Public development-guild replies have been read back successfully; other guilds retain the command's declared visibility.
3. Real profile-token verification and publication delay have passed for Shion Tsuji. Test expired/replaced proof, officer assignment, and offline local unassignment.
4. Test two linked characters, managed-role drift, join/leave/rejoin, FC unlink/relink, and replacement/clearing of managed roles while preserving unrelated roles.
5. Set the guest-review destination to officer-chat. Submit the `/apply` form as an unverified visitor, inspect both answers, restart the bot, use its original officer controls, delete/recreate a review message, deny/reapply after cooldown, and test blocked DMs. Verify repeated submissions preserve answers, old joins cannot submit, and verified non-FC access remains automatic.
6. Verify first-link defaults and imported-user opt-in. Test canonical renames, manual nicknames, restoration, and guild-owner/hierarchy failures.
7. Record a test-ledger deposit/withdrawal/correction, interrupt notification delivery after commit, and confirm one financial entry plus recoverable delivery.
8. Revoke a bot permission, inspect the scoped blocked result, restore it, and verify recovery. Exercise database/Discord reconnects and graceful shutdown.
9. Capture the complete production snapshot, inspect the cutover preview, and activate only after resolving its diagnostics.

Production command registration, Discord role/nickname effects, and production import publication require the operator's credentials and cutover window. The code and automated fixture checks do not substitute for that deployment gate.
