# Repository workflow

- Work within this repository. Use Bun for installation, scripts, tests, and builds.
- Initialize `vendor/nodestone` with `git submodule update --init --recursive` before installing/building. Advance it through `bun run nodestone:update`; commit its pointer, lockfile, and revision metadata together after verification.
- Keep commands, gateway events, and components in their existing discoverable modules. Add explanatory comments to first-party code, tooling, and tests.
- Run the checks appropriate to each change. `bun run typecheck`, `bun run lint`, `bun run format:check`, and `bun run build` cover source quality. `bun run test:unit` and `bun run test:contract` cover local behavior; `bun run test:docker` runs the complete suite with disposable PostgreSQL and the locally supplied `tarubot_backup.sql` fixture.
- Do not edit migrations already applied to a running database; add a migration for schema changes.
- Use Drizzle ORM and `src/infrastructure/postgres/schema.ts` for application persistence. Bind transaction work with `orm(client)`; keep state, audit, and outbox writes on that client. Numbered SQL migrations remain the schema authority; raw SQL is reserved for migration/control statements, session locks, probes, and catalog-based restore verification. See `docs/PERSISTENCE.md` for exact-value and query conventions.
- Normal Compose deployments pull GHCR images. DevBot adds `-f docker-compose.devbot.yml` and uses database `tarubot_dev`; append `-f docker-compose.build.yml` for local source builds and editable test plans. Update `test-plans/current.json` before starting a new development test session.
- `.do/app.yaml` attaches the owner-provisioned DigitalOcean Managed PostgreSQL cluster `tarubot-pg` (database/user `tarubot`); it never creates cloud databases. Keep its image versions synchronized with `package.json`; validate it and its derived foundation/maintenance phases with the pinned offline doctl check. Follow `docs/APP_PLATFORM.md` for provider prerequisites, secret handling, TLS, worker-free creation, and single-writer updates; generating/validating a spec does not authorize creating or changing cloud resources.

## Versioning

Every coherent change set must increment the SemVer in `package.json`. This applies to source, configuration, tooling, tests, documentation, and maintenance work. Use a major increment for incompatible changes, a minor increment for backward-compatible features, and a patch increment for compatible fixes or maintenance. Group related edits under one version increment rather than incrementing separately for each file.

Update `CHANGELOG.md` in the same commit, regenerate `bun.lock` when affected, and synchronize version references such as the current startup test plan. Build and deploy the new version when updating the running bot. The current implementation is the major-version-2 rewrite.

## Git history

The owner requests frequent local commits to track changes and iterations. Commit each coherent, verified change or milestone rather than accumulating the entire session. Use concise imperative messages that explain the change; preserve actual chronology rather than inventing historical phases.

Use feature branches and pull requests for all future work. PRs run CI and CodeQL; merge to `main` after the required build, test, security, and code-quality checks pass. Merges trigger container builds/publication. Do not commit directly to `main` or bypass required checks. Sign commits with the configured GPG key; if it is locked, request a local unlock rather than silently creating an unsigned commit.

Before committing, inspect status, staged and unstaged diffs, and recent history. Stage intended source, tests, and documentation explicitly. Keep credentials, `.env`, supplied database dumps, backups, generated output, and local coding-tool state out of Git. The documented `.env.example` is safe to track.

Do not push, rewrite history, skip hooks, or change Git configuration unless explicitly requested.
