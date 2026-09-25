# Nodestone sidecar contract

## Upstream tracking and reproducible builds

The owner selected a Docker sidecar after the published `@xivapi/nodestone@0.2.8` distribution failed its import gate: its declared `lib/index.js` and `types/index.d.ts` files are absent. The preceding published release imports, but has parser/URL behaviors incompatible with the required contract.

Nodestone is the **`vendor/nodestone` Git submodule** from `xivapi/nodestone`; the parent repository pins its tested commit. The manifest's `nodestone-upstream` alias points to that local checkout. The update workflow advances the submodule to upstream **HEAD**. Selectors remain an independent `#HEAD` Git dependency on `xivapi/lodestone-css-selectors`, because Lodestone CSS changes may require a selector update without a Nodestone code release. The initially verified revisions were:

- Nodestone: `xivapi/nodestone@5b7eec64008ba40175ac0ff24f7f44ee1093f77e`.
- Selectors: `xivapi/lodestone-css-selectors@1e9dd659b5d518150f2a793139b3f7167d739e9b`.

Initialize a checkout with `git submodule update --init --recursive` **before `bun install` or Docker builds**. Fresh clones can use `git clone --recurse-submodules REPOSITORY_URL`. The Docker build copies the initialized submodule and compiles directly from its `src/` directory.

`bun.lock` records the local dependency graph and selector revision, while `sidecar/upstream-revisions.json` records both full commit identities and a SHA-256 fingerprint of the parser's manifest/source files. The build checks the submodule commit when Git metadata is available, and always checks its source fingerprint, including inside Docker where repository metadata is excluded. These checks prevent a stale or different parser checkout from being mislabeled. `scripts/build-sidecar.ts` bundles the four parser classes and selector assets into the worker; TaruBot uses the HTTP adapter in `src/infrastructure/nodestone/client.ts`.

### Live selectors (2.19.0)

The owner decided on 2026-09-25 that `xivapi/lodestone-css-selectors` **always runs at its latest version**. The sidecar no longer waits for a release to pick up new selectors:

- **Loading.** The build rewrites Nodestone's static selector imports into runtime loads (`rewriteSelectorImports` in `sidecar/transforms.ts`). Each parser worker reads the *active* selector set when it starts (`sidecar/selector-runtime.ts`), and every request runs in a fresh worker, so a new set applies from the next request with no rebuild or restart. The build checks that all 9 selector files Nodestone references load this way, and writes them, at the lockfile's commit, to `dist/sidecar/selectors-baseline.json` as the bundled fallback.
- **Following upstream.** On every upstream check (at startup, then every `NODESTONE_UPSTREAM_CHECK_SECONDS`, 15 minutes by default), a new selector HEAD goes to `SelectorStore.activate()` (`sidecar/selectors.ts`). It downloads the 9 files from `raw.githubusercontent.com`, pinned to that commit, and validates each: a definition needs a non-empty `selector` string and correctly typed options, and every definition and group of the bundled copy, at any depth, must still exist as the same kind. It then writes the set to `NODESTONE_SELECTORS_DIR` (default `<tmpdir>/tarubot-selectors`) and switches the `active.json` pointer atomically. It keeps the set it replaced until the next activation, because a worker reads the pointer and then the set it names.
- **Regexes aren't compiled during validation.** Nodestone translates and applies them per column, and upstream already ships one it can't compile (achievements' `ENTRY.NAME`), which only affects that column.
- **Failures and restarts.** A download or validation failure keeps the active set and logs `selectors_rejected` once per revision; a switch logs `selectors_updated` (from and to). A restarted container adopts the set it already activated only if that set is still there and passes the same validation; otherwise it logs `selectors_not_restored` with the reason, runs the bundled set, and downloads HEAD again at the first check.
- **Health.** `/health` reports `selectors: {revision, source: upstream|bundled, activatedAt, bundled}`, and the upstream `lodestone-css-selectors` component's `deployed` is the live revision.
- **Worker environment.** Parser workers receive the process environment explicitly. A Bun worker otherwise sees only the environment from process start, which would miss the selector directory.

Parser **code** (`xivapi/nodestone`) stays release-managed, through the update workflow below, which also refreshes the bundled selector fallback.

### Keeping the parser and the bundled selectors current

```sh
# Read-only check: nonzero exit status means the checkout or selector lock is behind HEAD.
bun run nodestone:check

# Advance the submodule and selectors, update metadata, and verify build/parser contracts.
bun run nodestone:update

# Perform the same update checks, rebuild the sidecar image, and deploy it.
bun run nodestone:update --deploy
```

The running sidecar checks upstream at startup and every 15 minutes by default (2.19.0; hourly before). `/health` includes a cached `upstream` status (`checking`, `current`, `update_available`, or `unavailable`) and deployed/latest commits for each repository. Changes are reported in structured logs. Health probes themselves make no upstream requests, and GitHub availability does not disable otherwise working parsing.

For the parser, the monitor **detects** updates; the update command advances source for a verified PR. Selectors it **activates** itself (above). Merge the passing PR and pull its published images on registry-based deployments. The `--deploy` variant performs an explicit source build through `docker-compose.build.yml` for local development. The updater refuses to overwrite a dirty submodule. Failed compatibility checks stop deployment and identify the parser/fixture changes needed. Commit the updated **submodule pointer**, lockfile, and build metadata together after verification.

`sidecar/transforms.ts` contains checked, narrow source-compatibility changes. Each targeted replacement must match exactly once, so an upstream change fails the build for review:

1. Preserve regex captures and raw scalar text, including large IDs and explicit zero, for adapter validation.
2. Preserve null/empty distinctions and expose malformed rows instead of silently dropping them.
3. Reject a missing roster/search root.
4. Preserve underlying transport error categories and retry metadata.
5. Encode search query values exactly once and normalize the first-page previous marker.
6. Suppress upstream query logging.

Nodestone owns selectors and page parsing. The thin sidecar HTTP layer preserves parser results as an untrusted envelope; TaruBot validates every required application fact. The sidecar's request bridge supplies only the validated `params` and `query` fields used by these parsers.

## HTTP API

The service is private to the Compose network. `POST /v1/parse` accepts one of:

```json
{"operation":"fc","id":"9232097761132958152"}
{"operation":"members","id":"9232097761132958152","page":1}
{"operation":"profile","id":"11815704","biography":true}
{"operation":"search","name":"Tepo Stitcha","world":"Diabolos","page":1}
```

Success: `{ "ok": true, "data": ... }`.

Failure: `{ "ok": false, "code": "not_found|unavailable|rate_limited|busy|private|invalid_response|incomplete", "retryAfter": 0 }`.

- `rate_limited`: the Lodestone answered 429, or the gate is still cooling down from one; `retryAfter` is the remaining cooldown in seconds.
- `busy`: every parser slot is taken (HTTP 429 with `retryAfter: 1`). It is the sidecar's own capacity, not Lodestone throttling. A stopping sidecar answers 503 `unavailable`.
- `private`: a character page answered with the Lodestone's own "Access Restricted" page (HTTP 403 carrying its `ldst__error` window markup), which it serves for a private profile. The bot reports it as `private_profile`. Any other 403, such as an edge or firewall block, is `unavailable`.

Responses are uncached. Verification always requests biography data through a new network operation, independently of persisted display caches. Concurrent requests for the same profile operation can share an in-flight acquisition.

## Bounds and validation

| Setting | Default | Scope |
| --- | --- | --- |
| `PAGE_REGION` | `na` | Validated `na`, `eu`, `fr`, `de`, or `jp`; set before parser import |
| `LODESTONE_CONCURRENCY` | 2 | Sidecar active parser operations; range 1–4 |
| `LODESTONE_START_MS` | 1,000 | Minimum spacing between actual transport starts |
| `LODESTONE_TIMEOUT_MS` | 15,000 | Underlying fetch deadline |
| `LODESTONE_BODY_BYTES` | 2,000,000 | Maximum streamed upstream page size |
| `LODESTONE_REQUEST_TIMEOUT_MS` | 35,000 | Bot-to-sidecar request deadline |
| `LODESTONE_JOB_TIMEOUT_MS` | 300,000 | Complete search/roster job deadline |
| `LODESTONE_ATTEMPTS` | 3 | Maximum attempts for retryable transport failures |
| `LODESTONE_MAX_PAGES` | 100 | Search/roster pagination bound |
| `NODESTONE_RESPONSE_BYTES` | 8,000,000 | Maximum streamed sidecar response size |
| `NODESTONE_UPSTREAM_CHECK_SECONDS` | 900 | Background checks of both upstream repositories; minimum 300, or 0 for offline operation |
| `NODESTONE_SELECTORS_DIR` | `<tmpdir>/tarubot-selectors` | Where live selector sets are written; parser workers read the active one (2.19.0) |

**Lodestone gate (2.17.0).** Start spacing and a shared cooldown live in `sidecar/gate.ts`. The first Lodestone 429 closes the gate for every request: new starts are refused locally with the remaining cooldown, without contacting the Lodestone. The cooldown starts at 15 s and doubles on each consecutive 429 up to 5 min, or follows a longer Retry-After of up to 15 min. Any other Lodestone answer resets the escalation. `/health` reports `lodestone: {cooldownSeconds, strikes}`, and each 429 logs one `lodestone_throttled` line.

**Client retries (2.17.0).** Within one request the bot retries only `unavailable` (the sidecar unreachable or stopping) and `busy`, up to `LODESTONE_ATTEMPTS`. It does not retry `rate_limited`: the sidecar would refuse again until the cooldown ends. Instead, the job queue waits the `retryAfter` without spending an attempt, and a command tells the user when to try again.

Each isolated parser worker has a 30-second execution deadline. Underlying fetches use abort signals; cancellation also terminates the worker. The main bot remains responsive to Discord acknowledgement deadlines. Retryable failures use exponential backoff/jitter and usable upstream Retry-After metadata.

The adapter:

- Accepts canonical string IDs or positive safe integers, rejecting already-unsafe numeric IDs.
- Decodes display entities while retaining canonical Unicode text.
- Requires valid identity fields, unique IDs, consistent page progression, and matching distinct counts.
- Rechecks FC identity and count after the crawl.
- Accepts pager-less single/empty rosters only when an independently validated FC count exactly establishes completeness.
- Distinguishes affirmative empty search results from malformed or incomplete search output.

`tests/contract` exercises the compiled parsers, normalization, error preservation, simultaneous requests, actual request-start spacing, and cancellation. A live smoke run also exercised all four operations in the production image. Repeat both fixture and live checks when changing Bun, Nodestone, selector revisions, or transformations.
