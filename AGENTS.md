# Repository workflow

- Work within this repository. Use Bun for installation, scripts, tests, and builds.
- Keep commands, gateway events, and components in their existing discoverable modules. Add explanatory comments to first-party code, tooling, and tests.
- Run the checks appropriate to each change. `bun run typecheck`, `bun run lint`, `bun run format:check`, and `bun run build` cover source quality. `bun run test:unit` and `bun run test:contract` cover local behavior; `bun run test:docker` runs the complete suite with disposable PostgreSQL and the locally supplied `tarubot_backup.sql` fixture.
- Do not edit migrations already applied to a running database; add a migration for schema changes.
- DevBot uses `docker compose -f docker-compose.yml -f docker-compose.devbot.yml ...` and database `tarubot_dev`. Update `test-plans/current.json` before starting a new development test session.

## Git history

The owner requests frequent local commits to track changes and iterations. Commit each coherent, verified change or milestone rather than accumulating the entire session. Use concise imperative messages that explain the change; preserve actual chronology rather than inventing historical phases.

Before committing, inspect status, staged and unstaged diffs, and recent history. Stage intended source, tests, and documentation explicitly. Keep credentials, `.env`, supplied database dumps, backups, generated output, and local coding-tool state out of Git. The documented `.env.example` is safe to track.

Do not push, rewrite history, skip hooks, or change Git configuration unless explicitly requested.
