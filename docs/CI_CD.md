# CI/CD and container delivery

## Branch → pull request → merge → publish

1. Create a feature branch. Increment SemVer and update `CHANGELOG.md` for each coherent change set.
2. Open a PR against `main`. **CI** runs version/changelog validation, type checking, lint/format checks, compilation, all unit/contract/PostgreSQL integration tests, and both runtime image builds for `linux/amd64` and `linux/arm64`.
3. Merge after **CI result** and the required **CodeQL** security/code-quality results pass. CodeQL analyzes both JavaScript/TypeScript and GitHub Actions workflows on PRs, main updates, and a weekly schedule; it excludes upstream/generated dependencies.
4. **Publish containers** revalidates the merged commit, builds both image targets, and pushes them to GHCR. Pull requests have read-only repository permissions; only publication jobs receive `packages: write`.

Actions are pinned to full commits. Checkouts include the exact Nodestone submodule revision and do not persist checkout credentials. Registry login uses the workflow's `GITHUB_TOKEN`; no stored publishing PAT or Discord/database production credentials are needed by CI.

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

CI runs the full integration suite with deterministic **synthetic** data generated under `.cache/ci/legacy.sql`. It exercises the migration schema, fixture counts, ownership links, known/unknown opening balances, and the same persistence/recovery scenarios without uploading the supplied database dump.

Reproduce that path locally:

```sh
bun run test:fixture
LEGACY_FIXTURE_PATH=.cache/ci/legacy.sql bun run test:docker
```

`bun run test:docker` without the override continues to use the locally supplied `tarubot_backup.sql` acceptance fixture. The supplied-dump rehearsal remains part of migration acceptance; synthetic CI input is never a production import artifact. Both inputs stay outside container image layers.
