# CI/CD and container delivery

## Branch → pull request → merge → publish

1. Create a feature branch. Increment SemVer and update `CHANGELOG.md` for each coherent change set.
2. Open a PR against `main`. **CI** runs version/changelog validation, type checking, lint/format checks, compilation, all unit/contract/PostgreSQL integration tests, and both runtime image builds for `linux/amd64` and `linux/arm64`.
3. Merge after the required **CI result** check and the **CodeQL** code-scanning gate pass. The **Protect Main** ruleset requires `CI result` from GitHub Actions on an up-to-date branch, signed commits, and no new high-severity security alerts or error-level CodeQL results. CodeQL analyzes both JavaScript/TypeScript and GitHub Actions workflows on PRs, main updates, and a weekly schedule with the `security-extended` query suite, plus the `code-quality` suite for JavaScript/TypeScript (the Actions query pack has no quality queries); it excludes upstream/generated dependencies. GitHub's separate Code Quality product is not available for this repository, so quality results report through code scanning.
4. **Publish containers** revalidates the merged commit, builds both image targets, and pushes them to GHCR. Pull requests have read-only repository permissions; only publication jobs receive `packages: write`.

Actions are pinned to full commits, and the repository's Actions settings require full-SHA pins. Dependabot proposes updates to those pins and their version comments. CI and publication checkouts include the exact Nodestone submodule revision; the CodeQL, dependency-audit, and Claude workflows skip it because they do not build the parser. No checkout persists its credentials. Registry login uses the workflow's `GITHUB_TOKEN`; no stored publishing PAT or Discord/database production credentials are needed by CI.

The **Validate version and changelog** step runs last in the checks job. A PR without a version increment still fails, but only after every other step of that job has reported; the container builds depend on that job, so they run once the version commit is pushed.

## Claude review and assistant

- **Claude Code Review** (`claude-code-review.yml`) reviews ready, same-repository PRs to `main` with the code-review plugin and posts inline comments. It skips drafts, fork PRs, and runs started by bots, and a newer push cancels an unfinished review. It is advisory, never a required check. It also skips, reporting success, on a PR that changes the workflow file itself, because the action only runs a workflow identical to the default branch's copy.
- **Claude Code** (`claude.yml`) answers `@claude` in issues, PR comments, and reviews written by the owner, members, or collaborators; the action separately requires write access. Requests for the same issue or PR queue instead of running in parallel. The assistant commits through the GitHub API so its commits are signed and verified. Those commits write Claude's copy of each changed file onto the branch's current tip without checking for newer pushes, so do not push to a branch while an `@claude` run on it is in progress, and check an issue run's PR for reverted `main` changes. Do not ask `@claude` to change code on a fork PR: its commits go to a same-named branch in this repository, not to the fork.

Both authenticate with the `CLAUDE_CODE_OAUTH_TOKEN` repository secret and exchange the job's OIDC token for a short-lived Claude GitHub App token, which posts comments and pushes. The workflow `GITHUB_TOKEN` stays read-only.

## Dependency updates

Dependabot (`.github/dependabot.yml`) proposes updates, and a maintainer completes them. It cannot raise the SemVer or write the changelog, so **Validate version and changelog** fails on every Dependabot PR until a maintainer pushes the version commit. Publication checks the version again on `main`.

| Updates | Schedule | Pull requests | Maintainer adds |
| --- | --- | --- | --- |
| Bun packages (`package.json`, `bun.lock`) | Weekly | Minor and patch updates grouped; majors and `drizzle-orm` separately; at most 3 open | Version commit, plus `bun run format` if a Biome update changes formatting, and the README stack table when a listed package moves |
| Bun runtime (`oven/bun` in the `Dockerfile`) | Monthly | One per Bun release | The same Bun version in `packageManager`, `engines.bun`, `@types/bun`, and the README stack table; a regenerated `bun.lock`; version commit |
| PostgreSQL (`docker-compose.yml`) | Monthly | Minor updates only | The same image in `.github/workflows/ci.yml` `services.postgres` and the README stack table; version commit |
| GitHub Actions | Monthly, after a 7-day cooldown; no security updates, because GitHub raises no Dependabot alerts for SHA-pinned actions | All actions in one PR | Version commit |

`tests/unit/runtime-pins.test.ts` fails until the Bun runtime pins and the two PostgreSQL images agree, so a half-finished runtime or database update cannot pass CI.

Dependabot does not manage:

- The Nodestone submodule and `lodestone-css-selectors`. Update them with `bun run nodestone:update` on a feature branch.
- The CI PostgreSQL service image and the digest-pinned `digitalocean/doctl` image in `ci.yml`, because Dependabot reads only `uses:` lines in workflows.
- PostgreSQL major versions. A new major image starts an empty cluster, so plan the upgrade as a migration.

Until GitHub's Dependabot updater can read Bun 1.4 lockfiles ([dependabot-core#16026](https://github.com/dependabot/dependabot-core/issues/16026)), the Bun packages job fails with `DependencyFileNotSupported`. The advisory **Dependency audit** workflow runs `bun audit` against every locked package, including transitive ones, weekly and on PRs that change `package.json` or `bun.lock`. Until Dependabot recovers, apply package updates through a normal feature branch.

### Completing a Dependabot pull request

1. Read the linked release notes and the results of the checks that ran before the version check.
2. Check out the branch with `gh pr checkout <number>`, then run `git submodule update --init --recursive` and `bun install --frozen-lockfile`.
3. Make the changes listed for that row in the table above.
4. Raise the version and record it: increment `package.json` above `main` (a patch for compatible updates, minor or major when behavior or compatibility changes), add a `## X.Y.Z — Dependency updates` entry and the current-version sentence to `CHANGELOG.md`, set `tag: &release` in `.do/app.yaml`, and update the version references in `test-plans/current.json` and the current-version statements in `docs/APP_PLATFORM.md`, `docs/CONFIGURATION.md`, and `docs/PERSISTENCE.md`.
5. Run `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run build`, `bun run test:unit`, and `bun run test:contract`.
6. Commit with a signed, imperative message such as `Release dependency updates in 2.12.3`. Do not include `[dependabot skip]`, which lets Dependabot force-push over the commit.
7. Push to the Dependabot branch and merge once **CI result** and **CodeQL** pass.

After that push, Dependabot stops rebasing the PR. If `main` moves first, merge `main` into the branch and raise the version above the new base; `@dependabot recreate` discards the maintainer commit. When several Dependabot PRs are open, merge their branches into one maintainer branch and release them with a single version increment; Dependabot then closes its own PRs as up to date.

## Security reporting and scanning

`.github/SECURITY.md` routes vulnerability reports to GitHub private vulnerability reporting. Secret scanning with push protection and the GitGuardian PR check cover credentials. Dependabot alerts cover published advisories for the direct `package.json` dependencies in the dependency graph, and the **Dependency audit** workflow covers every locked Bun package. SHA-pinned actions receive no alerts, so review action advisories when the monthly Actions update arrives. Dismiss a code-scanning false positive individually with a written justification rather than disabling its query, so the query still protects future code.

The workflows also support manual dispatch. A matching `vMAJOR.MINOR.PATCH` tag can publish a release snapshot. Only `main` advances `latest`, so publishing an older tag cannot move that tag backward. Version tags must match the manifest; PR/main changes must advance the base version. Published versions omit SemVer build metadata (`+...`) and fit Docker's 128-character tag limit so their registry tag is exactly the manifest version.

Distinct source commits have independent, non-cancelling publication and reusable-CI concurrency groups. This avoids discarding an older version when merges arrive during a build. Only latest-tag promotion is serialized, after version/SHA images have completed; its current-main check prevents stale runs from moving latest backward.

## Published images and tags

| Image | Purpose |
| --- | --- |
| `ghcr.io/connstructor/tarubot` | Discord bot and one-shot application tools |
| `ghcr.io/connstructor/tarubot-nodestone` | Isolated Lodestone parser service |

Both images support AMD64 and ARM64. Each successful publication supplies:

- `latest` for the newest passing `main` publication.
- The manifest SemVer, for example `2.8.3`.
- `sha-FULL_COMMIT_SHA` for the exact published source commit.

OCI labels identify source, revision, and version. Build provenance and SBOM attestations accompany the images. Both versioned images must publish successfully before the final job advances their `latest` tags. Registry tag changes are separate operations; use a shared version/SHA tag when selecting an exact matched pair.

After the first publication, make both packages public in GitHub Packages if deployment hosts should pull anonymously. Otherwise authenticate Docker to `ghcr.io` with a credential that has package read access. Repository visibility and package visibility are separate settings.

## Deploy without a source checkout

The host needs `docker-compose.yml` and an `.env` based on `.env.example`. Add the DevBot overlay only for the development identity/database. Parser sources, Bun dependencies, and the build toolchain are already inside the published images.

For an initialized deployment:

```sh
docker compose pull
docker compose up -d --wait
```

The default is `latest`. To pin a matched release, set `TARUBOT_IMAGE_TAG=2.8.3` or `sha-FULL_COMMIT_SHA` in `.env`, then pull and recreate. `TARUBOT_IMAGE` and `NODESTONE_IMAGE` can override complete references, including immutable `@sha256:` digests.

Fresh installations still need explicit schema migration and command registration; see [README.md](../README.md#configure-and-start). Follow the migration runbook when an upgrade changes the schema. Image publication does not automatically restart deployment hosts or modify their databases.

## Local source builds

Contributors can select the build override:

```sh
git submodule update --init --recursive
docker compose -f docker-compose.yml -f docker-compose.build.yml build
```

For the existing DevBot database and editable startup plan:

```sh
docker compose -f docker-compose.yml -f docker-compose.devbot.yml -f docker-compose.build.yml up -d --build --wait
```

That override uses `tarubot:local` and `tarubot-nodestone:local`. Registry deployments use the plan packaged in the image; the source-build override mounts `test-plans/` for local editing.

`bun run nodestone:update --deploy` is an explicit source-checkout operation and uses the build override for the sidecar. For registry deployments, update/verify the submodule and selectors on a feature branch, merge its passing PR, then pull the resulting published images.

## PostgreSQL test data

The checks also derive the worker-free `foundation` and `maintenance` App Platform phases with `scripts/app-spec.ts` into `.cache/ci/app-platform/`, then validate `.do/app.yaml` and both derived files using a version/digest-pinned doctl container with networking disabled. This validates the App Platform schema without credentials or resource creation. Unit checks keep its image references in step with the package version and verify attachment of the managed PostgreSQL cluster (no pool or private-URL binding, a CA wherever the database URL is bound), the single effect-enabled worker, private routing, and credential scope; the managed-privileges integration test runs every migration with only the documented managed-cluster grants. See [APP_PLATFORM.md](APP_PLATFORM.md).

CI runs the full integration suite with deterministic **synthetic** data generated under `.cache/ci/legacy.sql`. It exercises the migration schema, fixture counts, ownership links, known/unknown opening balances, and the same persistence/recovery scenarios without uploading the supplied database dump.

Reproduce that path locally:

```sh
bun run test:fixture
LEGACY_FIXTURE_PATH=.cache/ci/legacy.sql bun run test:docker
```

`bun run test:docker` without the override continues to use the locally supplied `tarubot_backup.sql` acceptance fixture. The supplied-dump rehearsal remains part of migration acceptance; synthetic CI input is never a production import artifact. Both inputs stay outside container image layers.
