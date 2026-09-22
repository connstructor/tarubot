# Version history

The current application version is **1.7.0**, with `package.json` as the source of truth. `/version` reads the manifest included in its compiled build and obtains commit history independently from GitHub's `main` branch.

## 1.7.0 — Version and GitHub history command

- Add `/version [commits]` for any human guild member; show five commits by default, up to ten.
- Show the installed SemVer, linked short commit IDs, and commit titles.
- Mark signed commits with **✅** only when GitHub reports a valid verified signature.
- Share/cache bounded GitHub requests, and retain version output during GitHub outages or rate limits.

## Retrospective development milestones

These numbers are assigned now to the completed work stages to establish a meaningful SemVer baseline. Earlier working snapshots used the placeholder `1.0.0`; these entries describe development milestones, not previously published releases or tags.

| Version | Completed milestone |
| --- | --- |
| 1.0.0 | Core bot: ownership, membership, nicknames, guest workflow, ledger, PostgreSQL import/recovery, and containers |
| 1.1.0 | Dynamically discovered commands, events, components, and typed service injection |
| 1.2.0 | Independent Nodestone/selector HEAD tracking and checked update workflow |
| 1.3.0 | Role setup, officer/leader rank projection, explicit officer overrides, and startup test plans |
| 1.4.0 | Public development-guild interaction replies |
| 1.5.0 | Automatic role grouping and hierarchy reconciliation |
| 1.5.1 | Correct consecutive role blocks and reuse of existing Member/Guest role IDs |
| 1.6.0 | Nodestone submodule-backed builds, source fingerprints, and clean-clone verification |
| 1.7.0 | Installed-version and verified GitHub commit-history command |

## Increment policy

- **Major:** incompatible changes to supported commands, configuration, or persisted-data contracts.
- **Minor:** backward-compatible functionality and supported operational capabilities.
- **Patch:** backward-compatible corrections without a new feature contract.
- Git identity corrections, signatures, and repository publication alone do not change application behavior and therefore do not require a version bump.

Future changes update `package.json`, the Bun-generated lockfile when affected, and this changelog together. Released versions identify the running build; the latest GitHub commits can include work newer than that build.
