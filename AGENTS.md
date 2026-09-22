# Repository workflow

- Work within this repository. Use Bun for installation, scripts, tests, and builds.
- Initialize `vendor/nodestone` with `git submodule update --init --recursive` before installing/building. Advance it through `bun run nodestone:update`; commit its pointer, lockfile, and revision metadata together after verification.
- Keep commands, gateway events, and components in their existing discoverable modules. Add explanatory comments to first-party code, tooling, and tests.
- Run the checks appropriate to each change. `bun run typecheck`, `bun run lint`, `bun run format:check`, and `bun run build` cover source quality. `bun run test:unit` and `bun run test:contract` cover local behavior; `bun run test:docker` runs the complete suite with disposable PostgreSQL and the locally supplied `tarubot_backup.sql` fixture.
- Do not edit migrations already applied to a running database; add a migration for schema changes.
- DevBot uses `docker compose -f docker-compose.yml -f docker-compose.devbot.yml ...` and database `tarubot_dev`. Update `test-plans/current.json` before starting a new development test session.

## Versioning

Every coherent change set must increment the SemVer in `package.json`. This applies to source, configuration, tooling, tests, documentation, and maintenance work. Use a major increment for incompatible changes, a minor increment for backward-compatible features, and a patch increment for compatible fixes or maintenance. Group related edits under one version increment rather than incrementing separately for each file.

Update `CHANGELOG.md` in the same commit, regenerate `bun.lock` when affected, and synchronize version references such as the current startup test plan. Build and deploy the new version when updating the running bot. The current implementation is the major-version-2 rewrite.

## Git history

The owner requests frequent local commits to track changes and iterations. Commit each coherent, verified change or milestone rather than accumulating the entire session. Use concise imperative messages that explain the change; preserve actual chronology rather than inventing historical phases.

Before committing, inspect status, staged and unstaged diffs, and recent history. Stage intended source, tests, and documentation explicitly. Keep credentials, `.env`, supplied database dumps, backups, generated output, and local coding-tool state out of Git. The documented `.env.example` is safe to track.

Do not push, rewrite history, skip hooks, or change Git configuration unless explicitly requested.
