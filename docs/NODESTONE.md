# Nodestone sidecar contract

## Upstream tracking and reproducible builds

The owner selected a Docker sidecar after the published `@xivapi/nodestone@0.2.8` distribution failed its import gate: its declared `lib/index.js` and `types/index.d.ts` files are absent. The preceding published release imports, but has parser/URL behaviors incompatible with the required contract.

The package manifest follows **HEAD** of both `xivapi/nodestone` and `xivapi/lodestone-css-selectors`. Selectors are tracked independently because Lodestone CSS changes may require a selector update without a Nodestone code release. The initially verified revisions were:

- Nodestone: `xivapi/nodestone@5b7eec64008ba40175ac0ff24f7f44ee1093f77e`.
- Selectors: `xivapi/lodestone-css-selectors@1e9dd659b5d518150f2a793139b3f7167d739e9b`.

`bun.lock` records the resolved dependency snapshot, while `sidecar/upstream-revisions.json` records its full commit identities. These files are refreshed by `bun run nodestone:update`; ordinary builds remain reproducible from that checked snapshot. `scripts/build-sidecar.ts` verifies the metadata against the lockfile and bundles the four parser classes and selector assets into the worker. TaruBot uses the HTTP adapter in `src/infrastructure/nodestone/client.ts`.

### Keeping selectors current

```sh
# Read-only check: nonzero exit status means the lockfile is behind upstream HEAD.
bun run nodestone:check

# Resolve current HEAD, update the lock/build metadata, compile, and run compatibility tests.
bun run nodestone:update

# Perform the same update checks, rebuild the sidecar image, and deploy it.
bun run nodestone:update --deploy
```

The running sidecar checks upstream at startup and hourly by default. `/health` includes a cached `upstream` status (`checking`, `current`, `update_available`, or `unavailable`) and deployed/latest commits for each repository. Changes are reported in structured logs. Health probes themselves make no upstream requests, and GitHub availability does not disable otherwise working parsing.

The monitor **detects** updates; the update-and-deploy command **installs** them. Schedule that command from the project directory in your deployment environment for automatic roll-forward. Failed compatibility checks stop deployment and identify the parser/fixture changes needed. Commit updated lock/build metadata with the corresponding tested source changes.

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

Failure: `{ "ok": false, "code": "not_found|unavailable|rate_limited|invalid_response|incomplete", "retryAfter": 0 }`.

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
| `NODESTONE_UPSTREAM_CHECK_SECONDS` | 3,600 | Background checks of both upstream repositories; minimum 300, or 0 for offline operation |

Each isolated parser worker has a 30-second execution deadline. Underlying fetches use abort signals; cancellation also terminates the worker. The main bot remains responsive to Discord acknowledgement deadlines. Retryable failures use exponential backoff/jitter and usable upstream Retry-After metadata.

The adapter:

- Accepts canonical string IDs or positive safe integers, rejecting already-unsafe numeric IDs.
- Decodes display entities while retaining canonical Unicode text.
- Requires valid identity fields, unique IDs, consistent page progression, and matching distinct counts.
- Rechecks FC identity and count after the crawl.
- Accepts pager-less single/empty rosters only when an independently validated FC count exactly establishes completeness.
- Distinguishes affirmative empty search results from malformed or incomplete search output.

`tests/contract` exercises the compiled parsers, normalization, error preservation, simultaneous requests, actual request-start spacing, and cancellation. A live smoke run also exercised all four operations in the production image. Repeat both fixture and live checks when changing Bun, Nodestone, selector revisions, or transformations.
