---
title: Roadmap
description: TaruBot's planned major versions, from the current bot to a web dashboard, ModMail and richer Lodestone profiles.
---

TaruBot's major versions are planned outcomes. Dates, detailed feature lists and implementation technology are decided when each milestone is planned.

| Version | Milestone | Intended outcome |
| --- | --- | --- |
| **v2: Released; being stabilized** | Production-ready bot | Character verification, roster-based access, guest applications, nicknames and the gil ledger, running in production and supportable. |
| **v3: Planned** | Rank-aware web dashboard | People can view bot status and information appropriate to their rank in the Free Company. This phase focuses on viewing information. |
| **v4: Planned** | Interactive dashboard | Add dashboard actions and take over functionality such as reaction-role workflows. |
| **v5: Planned** | ModMail | Bring ModMail functionality into TaruBot. |
| **v6: Planned** | Expanded Lodestone profiles | Add richer Lodestone profile features, comparable to Kupo Bot or Ser Aymeric. |

**Sequence:** stable bot → visibility → self-service → private support → expanded character features.

## Continuity across versions

- v2 already uses the Lodestone for ownership verification and for FC roster and rank evidence. v6 expands the profile-facing features.
- The dashboard should reuse the established verified identity, FC membership and rank evidence, and authorization rules, so Discord and the web agree about access. A displayed rank or role is not a substitute for the authorization checks.
- As dashboard actions arrive, they keep the bot's transactional decisions, audit history, and durable delivery and recovery.
- Authentication, rank-to-information rules, dashboard actions, ModMail behavior and profile features are defined when their milestones are planned.
