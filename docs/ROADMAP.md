# Taru major-version roadmap

Owner-approved direction, recorded on **2026-09-23**. Finish settling v2 and bring Taru online before beginning the later milestones. These are planned outcomes; dates, detailed feature inventories, and implementation technology remain to be decided.

| Version | Milestone | Intended outcome |
| --- | --- | --- |
| **v2 — Current work** | Production-ready bot | Complete stabilization, operational features, live acceptance, recovery rehearsal, and production cutover. Taru is online and supportable. |
| **v3 — Planned** | Rank-aware web dashboard | People can view bot status and information appropriate to their rank in the Free Company. This phase focuses on viewing information. |
| **v4 — Planned** | Interactive dashboard | Add dashboard actions and take over functionality such as reaction-role workflows. |
| **v5 — Planned** | ModMail | Bring ModMail functionality into Taru. |
| **v6 — Planned** | Expanded Lodestone profiles | Add richer Lodestone profile functionality comparable to Kupo Bot or Ser Aymeric. |

## Continuity across versions

- v2 already uses Lodestone for ownership verification and accepted FC roster/rank evidence. v6 expands the profile-facing feature set.
- The dashboard should reuse the established verified identity, FC membership/rank evidence, and authorization rules so Discord and the web agree about access. A displayed rank or role is not a substitute for the applicable authorization checks.
- As dashboard actions arrive, preserve the application's transactional decisions, audit history, and durable delivery/recovery model.
- Define exact authentication, rank-to-information rules, dashboard actions, ModMail behavior, and profile features when planning their respective milestones. The roadmap alone does not authorize resource provisioning or deployment.

## Resume current work

- [SESSION_HANDOFF.md](SESSION_HANDOFF.md): observed source, published-image, and running-bot state; immediate next steps.
- [OPEN_ITEMS.md](OPEN_ITEMS.md): the requirements-backed v2 release checklist.
- [MIGRATION.md](MIGRATION.md): production import and cutover procedure.

**Sequence:** stable bot → visibility → self-service → private support → expanded character features.
