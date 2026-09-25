# Lodestone sidecar

The sidecar reads the Lodestone for TaruBot. It fetches pages under strict bounds and parses them into the data the bot validates. It still runs as the Compose service `nodestone` and the image `tarubot-nodestone`, with the bot reaching it at `NODESTONE_URL`, but **it no longer uses Nodestone**.

## History

- **Until 2.19.x** the sidecar wrapped the `xivapi/nodestone` parser library. It was a `vendor/nodestone` Git submodule with seven source patches (`sidecar/transforms.ts`), an Axios adapter bridging its fetches into the sidecar's bounded transport, and a stubbed logger.
- **2.19.0** made the `xivapi/lodestone-css-selectors` selectors follow upstream HEAD live.
- **2.20.0** replaced Nodestone with TaruBot's own parser, at the owner's request: "get rid of Nodestone entirely, pull xivapi/lodestone-css-selectors for ourselves, and do the parsing internally". The submodule, the patches, `regex-translator`, `axios` and the Nodestone half of the update tooling were removed.
- **Parity.** Before the switch, the 2.19.0 Nodestone build and the 2.20.0 build parsed the same live pages through their workers with identical output and requested URLs. The pages were a profile (with and without the biography), an FC page, the first and last member pages (50 and 5 entries), a search hit and an empty search. The first-party worker took about half the time.

## The parser (`sidecar/lodestone.ts`)

The parser applies the selector definitions directly, with the semantics TaruBot relied on from Nodestone plus the fixes the sidecar used to patch into it:

- A definition selects one element, or all of them with `multiple`, and yields its `innerHTML` or an attribute (`''` when absent). Values stay raw strings, so large IDs and explicit zero survive and the bot's adapter decodes display text.
- A definition's `regex` yields its named groups, spread into the enclosing record (`SERVER` → `World`, `DC`). Python-style `(?P<name>` groups and `(?P=name)` references are translated to JavaScript. A regex column whose element is missing keeps its own `null` field.
- A group of definitions yields a record of its non-null results, or `null` when none matched. A group with a `ROOT` yields `{ List: [...] }`, one record per `ROOT` element, with malformed rows kept as `null` so the adapter sees them.
- The top-level `ROOT` narrows the page, and a page without it is invalid, never an empty roster. `ENTRY`'s list and `PAGE_INFO`'s groups spread into the result. Paginated pages turn the latter into `Pagination {Page, PageTotal, PageNext, PagePrev}`.
- Each operation reads a fixed set of keys (`pagePlan`): the profile's `NAME`, `SERVER`, `FREE_COMPANY` (and `BIO` only for proof verification); the FC's `ID`, `NAME`, `TAG`, `SERVER`, `ACTIVE_MEMBER_COUNT`; and `ROOT`, `ENTRY`, `PAGE_INFO` (plus `NO_RESULTS_FOUND` for searches) on member and search pages.
- URLs are built with query values encoded exactly once.

The parser is pure. The worker (`sidecar/worker.ts`) asks the server for the page, because the server is the only network policy authority: the region allowlist, start spacing, the 429 gate, body bounds and private-profile detection. The worker then parses the page with the active selector set. The server terminates the worker at its deadline, which also ends CPU-bound parsing. The only parser dependency is `linkedom`, bundled into the worker at build time.

### Live selectors (2.19.0)

The owner decided on 2026-09-25 that `xivapi/lodestone-css-selectors` **always runs at its latest version**:

- **Loading.** Each parser worker reads the *active* selector set when it starts (`sidecar/selector-runtime.ts`). Every request runs in a fresh worker, so a new set applies from the next request, with no rebuild or restart. The build writes the files the parser reads (`SELECTOR_FILES`: 6 files), at the lockfile's commit, to `dist/sidecar/selectors-baseline.json` as the bundled fallback.
- **Following upstream.** On every upstream check (at startup, then every `NODESTONE_UPSTREAM_CHECK_SECONDS`, 15 minutes by default), a new selector HEAD goes to `SelectorStore.activate()` (`sidecar/selectors.ts`). It downloads those files from `raw.githubusercontent.com`, pinned to that commit and each read at most 512 KiB into memory, and validates each: a definition needs a non-empty `selector` string and correctly typed options, and every definition and group of the bundled copy, at any depth, must still exist as the same kind. It then writes the set to `NODESTONE_SELECTORS_DIR` (default `<tmpdir>/tarubot-selectors`) and switches the `active.json` pointer atomically. It keeps the set it replaced until the next activation, because a worker reads the pointer and then the set it names.
- **Regexes aren't compiled during validation.** They are applied per column, and upstream already ships one that doesn't compile (achievements' `ENTRY.NAME`), which only affects that unused column.
- **Failures and restarts.** A download or validation failure keeps the active set and logs `selectors_rejected` once per revision; a switch logs `selectors_updated` (from and to). A restarted container adopts the set it already activated only if that set is still there and passes the same validation; otherwise it removes the pointer, so workers load the bundled set it then reports, logs `selectors_not_restored` with the reason, and downloads HEAD again at the first check. The status follows a switch as soon as the pointer moves; removing older sets afterwards is best effort.
- **Health.** `/health` reports `selectors: {revision, source: upstream|bundled, activatedAt, bundled}`, and the upstream component's `deployed` is the live revision.
- **Worker environment.** Parser workers receive the process environment explicitly. A Bun worker otherwise sees only the environment from process start.

### The bundled fallback

```sh
# Read-only: nonzero exit status means bun.lock's selector commit is behind upstream HEAD.
bun run selectors:check

# Advance the lockfile, record the commit in sidecar/upstream-revisions.json, rebuild and test.
bun run selectors:update

# The same, then rebuild and restart the local sidecar through docker-compose.build.yml.
bun run selectors:update --deploy
```

The build refuses a `sidecar/upstream-revisions.json` whose commit differs from what `bun.lock` resolved, so the fallback is never mislabeled. Commit the lockfile and the metadata together. Refreshing the fallback is housekeeping: the running sidecar already follows HEAD.

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
| `PAGE_REGION` | `na` | Validated `na`, `eu`, `fr`, `de`, or `jp`; the Lodestone the parser reads |
| `LODESTONE_CONCURRENCY` | 2 | Sidecar active parser operations; range 1–4 |
| `LODESTONE_START_MS` | 1,000 | Minimum spacing between actual transport starts |
| `LODESTONE_TIMEOUT_MS` | 15,000 | Underlying fetch deadline |
| `LODESTONE_BODY_BYTES` | 2,000,000 | Maximum streamed upstream page size |
| `LODESTONE_REQUEST_TIMEOUT_MS` | 35,000 | Bot-to-sidecar request deadline |
| `LODESTONE_JOB_TIMEOUT_MS` | 300,000 | Complete search/roster job deadline |
| `LODESTONE_ATTEMPTS` | 3 | Maximum attempts for retryable transport failures |
| `LODESTONE_MAX_PAGES` | 100 | Search/roster pagination bound |
| `NODESTONE_RESPONSE_BYTES` | 8,000,000 | Maximum streamed sidecar response size |
| `NODESTONE_UPSTREAM_CHECK_SECONDS` | 900 | Background checks of the selector repository; minimum 300, or 0 for offline operation (selectors stay at the bundled copy) |
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

`tests/unit/lodestone-parser.test.ts` pins each parsing rule. `tests/contract` exercises the compiled worker end to end: normalization, error preservation, private profiles, the gate, simultaneous requests, actual request-start spacing, cancellation, and a worker following an activated selector set. Repeat the live-page parity check when changing the parser or linkedom.
