# Repository workflow

- Work within this repository. Use Bun for installation, scripts, tests, and builds (the documentation site in `site/` is the one exception; see below).
- The bot parses Lodestone pages in process with TaruBot's own parser (`src/infrastructure/lodestone/`; since 2.20.0 there is no Nodestone, and since 2.21.0 no sidecar). Its selectors follow `xivapi/lodestone-css-selectors` HEAD live; `bun run selectors:update` refreshes the bundled set. Commit the lockfile and `src/infrastructure/lodestone/upstream-revisions.json` together after verification.
- Keep commands, gateway events, and components in their existing discoverable modules. Add explanatory comments to first-party code, tooling, and tests.
- Run the checks appropriate to each change. `bun run typecheck`, `bun run lint`, `bun run format:check`, and `bun run build` cover source quality. `bun run test:unit` and `bun run test:contract` cover local behavior; `bun run test:docker` runs the complete suite with disposable PostgreSQL and the locally supplied `tarubot_backup.sql` fixture.
- Do not edit migrations already applied to a running database; add a migration for schema changes.
- Use Drizzle ORM and `src/infrastructure/postgres/schema.ts` for application persistence. Bind transaction work with `orm(client)`; keep state, audit, and outbox writes on that client. Numbered SQL migrations remain the schema authority; raw SQL is reserved for migration/control statements, session locks, probes, and catalog-based restore verification. See `docs/PERSISTENCE.md` for exact-value and query conventions.
- Normal Compose deployments pull GHCR images. DevBot adds `-f docker-compose.devbot.yml` and uses database `tarubot_dev`; append `-f docker-compose.build.yml` for local source builds and editable test plans. Update `test-plans/current.json` before starting a new development test session.
- Reader-facing documentation lives in the Starlight site in `site/src/content/docs/`, published to GitHub Pages (`.github/workflows/pages.yml`). `site/` is the one exception to "Use Bun": run its commands from `site/` with pnpm on Node, both pinned in `site/package.json` (`pnpm install --frozen-lockfile`, `pnpm run build`), and add no root scripts for it. Pages use placeholders only and never carry production or DevBot IDs, member or character data, the FC's name, host, cluster, bucket or key names, secrets or ping URLs. Update the relevant page in the same change set as the behavior; `tests/unit/docs-site.test.ts` enforces the checkable parts. Don't merge a site change while "Documentation site / Build" is red. `docs/` holds contributor detail and maintainer records.
- Production runs on the Linode Docker host (`docker-compose.production.yml`, docs/HOSTING.md) against owner-provisioned Linode managed PostgreSQL. App Platform was retired in 2.21.0; docs/APP_PLATFORM.md is only the record. Nothing here authorizes creating or changing cloud resources.
- Production deploys run through the Deploy production workflow (`.github/workflows/deploy.yml`, with `ops/deploy.sh` on the host) and need the owner's own approval of the `production` environment in GitHub; a chat go-ahead doesn't replace it. Agents never approve, reject or bypass a deployment, never create or hold the deploy key, never change the deployment environments, their secrets or variables, or `DEPLOY_ENABLED`, and start the workflow only when the owner asks in that session.

## Versioning

Every coherent change set must increment the SemVer in `package.json`. This applies to source, configuration, tooling, tests, documentation, and maintenance work. Use a major increment for incompatible changes, a minor increment for backward-compatible features, and a patch increment for compatible fixes or maintenance. Group related edits under one version increment rather than incrementing separately for each file.

Update `CHANGELOG.md` in the same commit, regenerate `bun.lock` when affected, and synchronize version references such as the current startup test plan. Build and deploy the new version when updating the running bot. The current implementation is the major-version-2 rewrite.

## Git history

The owner requests frequent local commits to track changes and iterations. Commit each coherent, verified change or milestone rather than accumulating the entire session. Use concise imperative messages that explain the change; preserve actual chronology rather than inventing historical phases.

Use feature branches and pull requests for all future work. PRs run CI and CodeQL; merge to `main` after the required build, test, security, and code-quality checks pass. Merges trigger container builds/publication. Do not commit directly to `main` or bypass required checks. Sign commits with the configured SSH signing key (`~/.ssh/id_git`, `gpg.format=ssh`); if signing fails, stop and ask the owner rather than silently creating an unsigned commit.

Before committing, inspect status, staged and unstaged diffs, and recent history. Stage intended source, tests, and documentation explicitly. Keep credentials, `.env`, supplied database dumps, backups, generated output, and local coding-tool state out of Git. The documented `.env.example` is safe to track.

Do not push, rewrite history, skip hooks, or change Git configuration unless explicitly requested.
