# Version history

The current application version is **2.11.1**, with `package.json` as the source of truth. This codebase is a complete rewrite of the original TaruBot and therefore belongs to major version **2**. `/version` reads the manifest included in its compiled build and obtains commit history independently from GitHub's `main` branch.

## 2.11.1 — Bound channel reconciliation reads

- Reuse a single captured channel session per reconciliation instead of force-fetching the guild and complete channel list for every target.
- Use the connected Gateway cache for no-op detection and protected binding/parent fences, with targeted REST reads before and after changed-channel writes.
- Keep full initial/final inventory verification, with at most one additional catalogue check before lowering the shared everyone default.
- Add a real application/SDK/PostgreSQL request-count regression for an 82-channel managed guild, plus disconnected/missing-scope safety coverage.

## 2.11.0 — DigitalOcean App Platform deployment

- Add a GHCR-backed App Platform spec with one bot worker, internal Nodestone service, pre-deploy migration job, and a newly provisioned inline PostgreSQL 18 dev database.
- Bind database credentials and the provider CA at runtime; enforce certificate/hostname verification when `DATABASE_CA_CERT` is supplied, including over conflicting URL TLS flags.
- Validate the provider schema offline in CI and test release/credential/networking invariants and actual driver TLS option parsing.
- Document initial provisioning, secrets, command registration, dev-database limits, and phased single-writer updates with persistent database identity.

## 2.10.2 — Separate officer chat from community channels

- Exclude Discord's configured community-updates channel and its parent category from onboarding preflight, selection, snapshots, and permission writes, using IDs rather than channel names.
- Prefer/create `#officer-chat` as the separate officer room and reject reserved resources as onboarding bindings.
- Recheck protected scope before remote mutations and react to community binding changes. Preserve the everyone visibility default where changing it would affect an excluded area.
- Verify reserved-channel privacy and limited-permission setup with SDK, PostgreSQL, and read-only DevBot preflight checks; record the new live officer room.

## 2.10.1 — Preserve explicit channel privacy

- Treat any explicit View Channel deny as private-area evidence when everyone, Member, and Guest visibility are all absent, including role and member-specific denies after onboarding is enabled.
- Keep a channel with no visibility overwrites distinguishable as an ordinary default-closed channel.
- Add SDK-effective and PostgreSQL regressions covering Member, Guest, other-role, and member-specific privacy; retain the first snapshot and prevent Member/Guest grants.

## 2.10.0 — Lobby onboarding and channel access

- Extend `/setup` to create/reuse a newcomer lobby and officer room, with explicit channel selections and manager/channel permission checks.
- Enforce lobby, Member/Guest, and staff-only visibility across all non-thread channel types; threads inherit parent visibility. Officers and FC Leaders can see the lobby while ordinary Members/Guests cannot.
- Preserve first-observed channel permissions/parents and the original everyone permission bitfield; retain existing private areas as staff-only. Persist the opt-in policy in `003_guild_access.sql` using Drizzle.
- Reconcile channel creation, edits, deletion, startup, refresh, and role rebinding through durable, revision-fenced work with full readback and no-op convergence.
- Derive Guest access for trusted registered non-FC visitors, preserving revocation, FC Member precedence, stale-evidence safeguards, and guild isolation.
- Verify effective Discord.js permissions, provisioning/reuse, partial-failure recovery, snapshot durability, authorization, refresh accounting, and visitor access transitions.

## 2.9.0 — Drizzle persistence

- Map the existing PostgreSQL schema with Drizzle ORM and use typed queries for application persistence.
- Preserve exact external IDs, bigint money, UTC timestamps, and database-enforced invariants.
- Bind ORM operations to the same connection as transactional decisions and PostgreSQL locks.
- Retain the applied SQL migrations and explicit PostgreSQL-specific control statements.
- Convert roster/rank projection, role setup, gateway observations, work leases/outbox, capability metrics, import, and maintenance commands to the shared ORM boundary.
- Derive persisted record contracts from the mapped schema and verify mapping parity, scalar JSON, transaction isolation/rollback, and concurrent queue fencing against PostgreSQL.

## 2.8.4 — Dependabot maintenance

- Enable weekly Bun dependency-update pull requests.
- Keep dependency updates subject to the existing SemVer, changelog, CI, and CodeQL requirements before merge.

## 2.8.3 — Release publication review fixes

- Isolate publication and reusable verification by commit SHA so new merges cannot cancel an older version's image builds.
- Serialize only the mutable latest-tag promotion, retaining its current-main guard.
- Reject build metadata and oversized release versions instead of silently changing or colliding Docker tags.

## 2.8.2 — CodeQL and project licensing

- Analyze JavaScript/TypeScript and GitHub Actions workflows with CodeQL, including the repository's required security/code-quality results.
- License first-party TaruBot code under AGPL-3.0-only; include the license in runtime images and OCI metadata.
- Add source-code and license links to `/version` output.

## 2.8.1 — Cross-platform test startup budgets

- Give subprocess and parser-worker tests bounded startup headroom under ARM64 emulation.
- Preserve all module, parser, transport-spacing, and cancellation assertions while avoiding the default five-second test deadline for cold worker startup.

## 2.8.0 — Pull-request CI and published containers

- Validate PRs with version/changelog checks, source checks, the full PostgreSQL-backed test suite, and both multi-platform container builds.
- Generate an invented CI migration fixture while retaining the separate supplied-dump acceptance path.
- Build and publish TaruBot and Nodestone images to GHCR after `main` changes pass verification, using latest, SemVer, and full-commit tags.
- Default Compose to registry images; retain an explicit local source-build override and development database overlay.
- Adopt the feature-branch, PR, passing-CI, merge-to-main workflow.

## 2.7.1 — Versioning policy and delivery readiness

- Require an appropriate SemVer increment for every coherent change set, including documentation, tests, and maintenance.
- Present required Discord intents and bot permissions as name/reason tables in the setup guide.
- Record the requirements-backed implementation gaps, live acceptance checks, and production-delivery work in `docs/OPEN_ITEMS.md`.
- Record live version-command registration and GitHub signature/history verification.

## 2.7.0 — Version and GitHub history command

- Add `/version [commits]` for any human guild member; show five commits by default, up to ten.
- Show the installed SemVer, linked short commit IDs, and commit titles.
- Mark signed commits with **✅** only when GitHub reports a valid verified signature.
- Share/cache bounded GitHub requests, and retain version output during GitHub outages or rate limits.

## Retrospective development milestones

These numbers are assigned now to the completed work stages to establish a meaningful SemVer baseline. Earlier working snapshots used the placeholder `1.0.0`; these entries describe development milestones, not previously published releases or tags.

| Version | Completed milestone |
| --- | --- |
| 2.0.0 | Core rewrite: ownership, membership, nicknames, guest workflow, ledger, PostgreSQL import/recovery, and containers |
| 2.1.0 | Dynamically discovered commands, events, components, and typed service injection |
| 2.2.0 | Independent Nodestone/selector HEAD tracking and checked update workflow |
| 2.3.0 | Role setup, officer/leader rank projection, explicit officer overrides, and startup test plans |
| 2.4.0 | Public development-guild interaction replies |
| 2.5.0 | Automatic role grouping and hierarchy reconciliation |
| 2.5.1 | Correct consecutive role blocks and reuse of existing Member/Guest role IDs |
| 2.6.0 | Nodestone submodule-backed builds, source fingerprints, and clean-clone verification |
| 2.7.0 | Installed-version and verified GitHub commit-history command |
| 2.7.1 | Mandatory version increments and delivery-readiness tracking |
| 2.8.0 | Pull-request validation and GHCR container delivery |
| 2.8.1 | Bounded subprocess/worker test budgets for emulated image builds |
| 2.8.2 | CodeQL merge-gate integration and AGPL-3.0 licensing |
| 2.8.3 | Non-cancelling release publication and exact registry version tags |
| 2.8.4 | Weekly Bun dependency-update pull requests |
| 2.9.0 | Typed Drizzle persistence with exact-value, transaction, and queue regression coverage |
| 2.10.0 | Opt-in lobby/staff channel security and derived registered-visitor Guest access |
| 2.10.1 | Preserve private channels expressed through explicit role/member visibility denies |
| 2.10.2 | Protected community-update resources and separate officer chat |
| 2.11.0 | App Platform spec with automatic PostgreSQL provisioning and provider-CA support |
| 2.11.1 | Reconciliation-scoped inventories and bounded targeted Discord reads |

## Increment policy

- **Major:** incompatible changes to supported commands, configuration, or persisted-data contracts.
- **Minor:** backward-compatible functionality and supported operational capabilities.
- **Patch:** backward-compatible corrections or maintenance, including documentation, tests, and tooling changes without a new feature contract.
- Every coherent change set receives an appropriate version increment; related edits share that increment.

Future changes update `package.json`, the Bun-generated lockfile when affected, and this changelog together. Released versions identify the running build; the latest GitHub commits can include work newer than that build.
