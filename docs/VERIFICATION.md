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

The latest full behavioral regression for **2.10.0** passed **102 tests**: 52 unit, 16 contract, and 34 PostgreSQL integration tests (**978 assertions** per full container run on 2026-09-22). The complete suite passed with both the supplied dump and the synthetic CI fixture. Strict type checking, lint, formatting, the compiled build, and SemVer/changelog validation also passed. Workflow/actionlint and registry/local-build Compose validation passed during the preceding CI/CD change set. The command inventory contains 40 paths across 19 root commands; runtime discovery includes 14 event modules. Current delivery work is tracked in [OPEN_ITEMS.md](OPEN_ITEMS.md).

Drizzle regression checks independently compare all **25 application table mappings** to the migrated PostgreSQL catalog (column inventory, types, nullability, and defaults). Actual driver round trips preserve unsigned 64-bit external IDs, signed-bigint maximum money, sequences beyond JavaScript's safe-integer range, UTC millisecond instants, and scalar/nested JSON including JSON null. One transaction's policy, audit, and outbox rows are invisible to pooled reads and roll back together. Concurrent queue claims skip a separately locked row; a superseding reconciliation generation discards stale results, respects retry due time, and completes under a fresh lease. Capability aggregates handle empty scopes and shared FCs without double-counting. The injected import-failure test checks PostgreSQL's error through Drizzle's `cause`.

Application and maintenance persistence uses the shared typed ORM boundary. The current image requires `SCHEMA_VERSION=003_guild_access.sql`; the preceding migrations remain immutable. The 2.10.0 live deployment/onboarding session is described in `test-plans/current.json`; channel enforcement and the least-privilege visibility matrix still require that live check. See [PERSISTENCE.md](PERSISTENCE.md) and [SETUP.md](SETUP.md) for the query, migration, and activation contracts.

Onboarding coverage uses actual Discord.js member/channel objects and controlled REST responses to verify the newcomer, Member, Guest, Officer, FC Leader, bot, owner, and Administrator visibility matrix across text, voice, category, announcement, stage, forum, and media channels. Parent visibility is checked for threads. Provisioning tests verify lobby/officer room reuse and creation, ambiguity/authorization failures, original parent retention, explicit bot permissions, and no-op enforcement. PostgreSQL tests exercise first-snapshot retention, private-area classification, partial-failure/restart recovery, role replacement, setup exclusion, activation/revision fences, missing-room readback, channel-event deduplication, and refresh child accounting. Registered-visitor tests cover fresh/unknown/stale evidence, revocation/rejoin, Member precedence, unlink, FC-less registration, opt-in defaults, and cross-guild isolation.

Coverage includes repeat setup, server-manager boundaries, rank-derived officer access, explicit revocation precedence, indirect-delegation prevention, custom leader titles, complete responsibility-separated session messages, and scoped public replies. Layout regressions cover consecutive blocks, full-hierarchy readback rejecting interleaving, partial configurations, unrelated-role ordering, Discord's tied raw positions, effect activation, mutual exclusion with setup, configuration revision fencing, self-generated role-event convergence, and refresh child-job accounting. Role-selection tests cover canonical names across prefixes, explicit configured IDs, ambiguous/deleted bindings, and SDK-backed reuse/renaming without recreating roles or changing permissions.

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
| ACCESS-01–04 | SDK permission/provisioning tests and PostgreSQL policy/recovery/registration tests; live non-Administrator onboarding session pending |

## Live Discord gate

The development application and guild are now configured. Human interaction and least-privilege tests remain in this checklist:

1. Register guild-scoped commands and compare the deployed inventory to the discovered `src/commands/**/*.command.ts` modules.
2. Verify self/officer authorization, private autocomplete, and rejected non-officer `force:true` requests. Public development-guild replies have been read back successfully; other guilds retain the command's declared visibility.
3. Real profile-token verification and publication delay have passed for Shion Tsuji. Test expired/replaced proof, officer assignment, and offline local unassignment.
4. Test two linked characters, managed-role drift, join/leave/rejoin, FC unlink/relink, and replacement/clearing of managed roles while preserving unrelated roles.
5. Submit an application, restart the bot, use its original review controls, delete/recreate a review message, deny/reapply after cooldown, and test blocked DMs.
6. Verify first-link defaults and imported-user opt-in. Test canonical renames, manual nicknames, restoration, and guild-owner/hierarchy failures.
7. Record a test-ledger deposit/withdrawal/correction, interrupt notification delivery after commit, and confirm one financial entry plus recoverable delivery.
8. Revoke a bot permission, inspect the scoped blocked result, restore it, and verify recovery. Exercise database/Discord reconnects and graceful shutdown.
9. Capture the complete production snapshot, inspect the cutover preview, and activate only after resolving its diagnostics.

Production command registration, Discord role/nickname effects, and production import publication require the operator's credentials and cutover window. The code and automated fixture checks do not substitute for that deployment gate.
