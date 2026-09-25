# CI/CD and container delivery

## Branch → pull request → merge → publish

1. Create a feature branch. Increment SemVer and update `CHANGELOG.md` for each coherent change set.
2. Open a PR against `main`. **CI** runs version/changelog validation, type checking, lint/format checks, compilation, all unit/contract/PostgreSQL integration tests, and both runtime image builds for `linux/amd64` and `linux/arm64`.
3. Merge after the required **CI result** check and the **CodeQL** code-scanning gate pass. The **Protect Main** ruleset requires `CI result` from GitHub Actions on an up-to-date branch, signed commits, and no new high-severity security alerts or error-level CodeQL results. CodeQL analyzes both JavaScript/TypeScript and GitHub Actions workflows on PRs, main updates, and a weekly schedule with the `security-extended` query suite, plus the `code-quality` suite for JavaScript/TypeScript (the Actions query pack has no quality queries); it excludes upstream/generated dependencies. GitHub's separate Code Quality product is not available for this repository, so quality results report through code scanning.
4. **Publish containers** revalidates the merged commit, builds both image targets, and pushes them to GHCR. Pull requests have read-only repository permissions; only publication jobs receive `packages: write`.

Actions are pinned to full commits, and the repository's Actions settings require full-SHA pins. Dependabot proposes updates to those pins and their version comments. No checkout needs submodules since 2.20.0, which replaced Nodestone with a first-party parser; since 2.21.0 there is one image, because that parser runs inside the bot. No checkout persists its credentials. Registry login uses the workflow's `GITHUB_TOKEN`; no stored publishing PAT or Discord/database production credentials are needed by CI.

The **Validate version and changelog** step runs last in the checks job. A PR without a version increment still fails, but only after every other step of that job has reported; the container builds depend on that job, so they run once the version commit is pushed.

## Claude review and assistant

- **Claude Code Review** (`claude-code-review.yml`) reviews ready, same-repository PRs to `main` with the code-review plugin and posts inline comments. It skips drafts, fork PRs, and runs started by bots, and a newer push cancels an unfinished review. It is advisory, never a required check. The review step sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` so every subagent runs in the foreground. Since Claude Code 2.1.198 a subagent starts in the background unless Claude asks otherwise, and the action stops reading at the first result; without the variable that result arrived before the review had finished, so reviews passed in about 40 seconds with nothing posted ([anthropics/claude-code-action#1499](https://github.com/anthropics/claude-code-action/issues/1499)). The full transcript (`show_full_output`) prints to the public Actions log only when debug logging is on: a re-run with debug logging, or the repository's `ACTIONS_STEP_DEBUG` secret or variable. Never set that secret or variable repository-wide. The next step, **Check that the review finished**, prints the turns, duration, cost, subagent counts and permission denials from the action's execution file. It fails the job when a subagent started in the background or never reported back, or when there is no result message, since each means the review was cut short. The review also skips, reporting success, on a PR that changes the workflow file itself, because the action only runs a workflow identical to the default branch's copy.
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
| Documentation site (`site/package.json`, `site/pnpm-lock.yaml`; pnpm) | Monthly, after a 7-day cooldown (14 for majors) | Astro, Starlight and the links validator grouped in one PR, at most 1 open | A green **Documentation site / Build** on the PR; version commit |

`tests/unit/runtime-pins.test.ts` fails until the Bun runtime pins and the two PostgreSQL images agree, so a half-finished runtime or database update cannot pass CI.

Dependabot does not manage:

- `lodestone-css-selectors`. The bot follows its HEAD live; refresh the bundled set with `bun run selectors:update` on a feature branch. (Nodestone was removed in 2.20.0.)
- The CI PostgreSQL service image in `ci.yml`, because Dependabot reads only `uses:` lines in workflows.
- PostgreSQL major versions. A new major image starts an empty cluster, so plan the upgrade as a migration.

Until GitHub's Dependabot updater can read Bun 1.4 lockfiles ([dependabot-core#16026](https://github.com/dependabot/dependabot-core/issues/16026)), the Bun packages job fails with `DependencyFileNotSupported`. The advisory **Dependency audit** workflow runs `bun audit` against every locked package, including transitive ones, weekly and on PRs that change `package.json` or `bun.lock`. Until Dependabot recovers, apply package updates through a normal feature branch.

### Completing a Dependabot pull request

1. Read the linked release notes and the results of the checks that ran before the version check.
2. Check out the branch with `gh pr checkout <number>`, then run `bun install --frozen-lockfile`. For a site update, also run `cd site && pnpm install --frozen-lockfile`.
3. Make the changes listed for that row in the table above.
4. Raise the version and record it: increment `package.json` above `main` (a patch for compatible updates, minor or major when behavior or compatibility changes), add a `## X.Y.Z — Dependency updates` entry and the current-version sentence to `CHANGELOG.md`, and update the version references in `test-plans/current.json` and the current-version statements in `docs/CONFIGURATION.md` and `docs/PERSISTENCE.md`.
5. Run `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run build`, `bun run test:unit`, and `bun run test:contract`. For a site update, also run `pnpm run build` in `site/`, which checks every internal link and anchor.
6. Commit with a signed, imperative message such as `Release dependency updates in 2.12.3`. Do not include `[dependabot skip]`, which lets Dependabot force-push over the commit.
7. Push to the Dependabot branch and merge once **CI result** and **CodeQL** pass.

After that push, Dependabot stops rebasing the PR. If `main` moves first, merge `main` into the branch and raise the version above the new base; `@dependabot recreate` discards the maintainer commit. When several Dependabot PRs are open, merge their branches into one maintainer branch and release them with a single version increment; Dependabot then closes its own PRs as up to date.

## Documentation site

The reader-facing documentation is an [Astro Starlight](https://starlight.astro.build) site in `site/`, published to GitHub Pages at <https://deconfined.github.io/tarubot/>. It is a standalone pnpm package on Node: `site/package.json` pins pnpm (`packageManager`) and Node (`engines.node`), and `site/pnpm-lock.yaml` locks its three dependencies (`astro`, `@astrojs/starlight` and `starlight-links-validator`). The bot, its lockfile, its image and CI stay on Bun; pnpm refuses to run in the repository root, which pins Bun.

**`pages.yml` ("Documentation site")** is the only workflow that builds it:

- **Pull requests** that touch `site/**` or the workflow get a **Build** job: `pnpm install --frozen-lockfile` and `pnpm run build`, which fails on a broken internal link or `#anchor`. It is **advisory**: not part of `CI result` and not required by the ruleset, so an Astro or npm outage never blocks a bot fix. Don't merge a site change while it is red.
- **`main`** rebuilds the site on the same paths, uploads it as the Pages artifact and deploys it through the `github-pages` environment, which accepts only `main`. A failed deploy leaves the last good site live.
- **Manual dispatch** from `main` redeploys the current content; from any other branch it only builds. To redeploy, dispatch from `main` rather than re-running an old run, which would publish old content.

The required gate for page content is `tests/unit/docs-site.test.ts`, in CI's checks job and the image build. It needs no site dependencies: it reads the pages as text and checks the command reference (every path, option and example), every `.env.example` setting, every reply code, the invite's permission integer, repository links, the site package's pnpm-only shape, and public content (no real IDs, private hosts, secrets or retired component names).

**Enabling Pages** is a one-time owner step: Settings → Pages → Source **GitHub Actions**, and under Settings → Environments, `github-pages` allowing only `main`.

**Updating the site's dependencies** by hand, on a feature branch: `cd site && pnpm update --latest`, check that `@astrojs/starlight` and `starlight-links-validator` still accept each other's and Astro's peer ranges, run `pnpm audit` and `pnpm run build`, then release with a version commit like any Dependabot update. pnpm 12 runs no dependency build script unless `site/pnpm-workspace.yaml` allows it; esbuild's is declined there, because its optional platform package supplies the binary.

## Security reporting and scanning

`.github/SECURITY.md` routes vulnerability reports to GitHub private vulnerability reporting. Secret scanning with push protection and the GitGuardian PR check cover credentials. Dependabot alerts cover published advisories for the direct `package.json` dependencies in the dependency graph, and the **Dependency audit** workflow covers every locked Bun package. SHA-pinned actions receive no alerts, so review action advisories when the monthly Actions update arrives. Dismiss a code-scanning false positive individually with a written justification rather than disabling its query, so the query still protects future code.

The workflows also support manual dispatch. A matching `vMAJOR.MINOR.PATCH` tag can publish a release snapshot. Only `main` advances `latest`, so publishing an older tag cannot move that tag backward. Version tags must match the manifest; PR/main changes must advance the base version. Published versions omit SemVer build metadata (`+...`) and fit Docker's 128-character tag limit so their registry tag is exactly the manifest version.

Distinct source commits have independent, non-cancelling publication and reusable-CI concurrency groups. This avoids discarding an older version when merges arrive during a build. Only latest-tag promotion is serialized, after version/SHA images have completed; its current-main check prevents stale runs from moving latest backward.

## Published images and tags

| Image | Purpose |
| --- | --- |
| `ghcr.io/deconfined/tarubot` | Discord bot and one-shot application tools |

The image supports AMD64 and ARM64. Until 2.20.0 a second image, `ghcr.io/deconfined/tarubot-nodestone`, held the Lodestone parser service; since 2.21.0 the parser runs inside the bot, and that image is no longer published (its old tags stay in GHCR). Each successful publication supplies:

- `latest` for the newest passing `main` publication.
- The manifest SemVer, for example `2.8.3`.
- `sha-FULL_COMMIT_SHA` for the exact published source commit.

OCI labels identify source, revision, and version. Build provenance and SBOM attestations accompany the images. Both versioned images must publish successfully before the final job advances their `latest` tags. Registry tag changes are separate operations; use a shared version/SHA tag when selecting an exact matched pair.

After the first publication, make both packages public in GitHub Packages if deployment hosts should pull anonymously. Otherwise authenticate Docker to `ghcr.io` with a credential that has package read access. Repository visibility and package visibility are separate settings.

## Deploy without a source checkout

A host needs only `docker-compose.yml` and an `.env` based on `.env.example`: the published image carries the compiled bot, its migrations and its tools. Installing, pinning a release, migrating, registering commands and updating are on the documentation site's [install](../site/src/content/docs/deploy/install.md) and [operations](../site/src/content/docs/deploy/operations.md) pages; production's own procedure is [HOSTING.md](HOSTING.md). Image publication never restarts a deployment or changes its database by itself.

## Local source builds

Contributors can select the build override:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml build
```

For the existing DevBot database and editable startup plan:

```sh
docker compose -f docker-compose.yml -f docker-compose.devbot.yml -f docker-compose.build.yml up -d --build --wait
```

That override uses `tarubot:local`. Registry deployments use the plan packaged in the image; the source-build override mounts `test-plans/` for local editing.

To refresh the bundled selectors, run `bun run selectors:update` on a feature branch, merge its passing PR, then pull the resulting published image. The running bot already follows the selectors' HEAD.

## PostgreSQL test data

The checks also validate the Compose models, and the managed-privileges integration test runs every migration with only the documented managed-cluster grants. (Until 2.21.0 they also derived and validated the App Platform phases; see [APP_PLATFORM.md](APP_PLATFORM.md).)

CI runs the full integration suite with deterministic **synthetic** data generated under `.cache/ci/legacy.sql`. It exercises the migration schema, fixture counts, ownership links, known/unknown opening balances, and the same persistence/recovery scenarios without uploading the supplied database dump.

Reproduce that path locally:

```sh
bun run test:fixture
LEGACY_FIXTURE_PATH=.cache/ci/legacy.sql bun run test:docker
```

`bun run test:docker` without the override continues to use the locally supplied `tarubot_backup.sql` acceptance fixture. The supplied-dump rehearsal remains part of migration acceptance; synthetic CI input is never a production import artifact. Both inputs stay outside container image layers.
