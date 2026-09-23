# TaruBot Requirements

- **Status:** Draft for owner review
- **Prepared:** 2026-09-21
- **Deliverable:** A TypeScript Discord bot for Final Fantasy XIV Free Companies

### Approved implementation amendments (2026-09-21)

The owner requested `/version [commits]` for any guild user. It displays the installed SemVer and the latest requested number of GitHub commit IDs, links, and titles from `connstructor/tarubot`; show ✅ next to an ID only when GitHub confirms its signature is valid and verified. Default to five commits and bound requests to ten. Record versioned development milestones and retain local version output when GitHub is unavailable.

This implementation is a complete rewrite of TaruBot and uses major version **2**. `package.json` defines its current version, with development milestones recorded in `CHANGELOG.md`. Every coherent change set must increment SemVer appropriately: major for incompatible changes, minor for compatible features, and patch for compatible fixes or maintenance, including documentation and tests.

The owner requires a feature-branch/PR/merge delivery workflow. Pull requests run build and test checks; merges to `main` build and publish both TaruBot and Nodestone images to GHCR. Normal Compose deployments pull published images, with explicit source-build overrides retained for development.

The owner requested non-ephemeral output in the development server so other testers can observe the session. `PUBLIC_TEST_RESPONSES` overrides response visibility for the configured test guild, including command/component success and error replies. Operation authorization and other guilds' default presentation policy remain independently enforced.

The owner additionally requested a development startup announcement in `#chat`, containing the current session's actions grouped by human tester, coding assistant, and bot. The owner requested `/setup` to create/reuse Member, Guest, Officer, and FC Leader roles; the Officer role grants bot-only officer-command access. An optional configured in-game FC rank may derive Officer eligibility from accepted roster evidence. Explicit officer grants/revocations and changes to this authority mapping require a server manager with Manage Roles. This is a specific extension of the original rank-mapping scope, not a general arbitrary role-mapping system.

The owner additionally requested automatic separate member-list display for those four configured roles and descending hierarchy **FC Leader → Officer → Member → Guest** in one consecutive block, without unrelated roles interleaved. Setup must reuse existing canonical roles, including unprefixed Member and Guest roles, before creating new ones; it may rename adopted roles while retaining their IDs, permissions, and assignments. Durable layout reconciliation applies this presentation policy at startup, setup, role-configuration changes, role events, and guild refresh, respecting current effect activation and Discord hierarchy.

On 2026-09-22 the owner required ongoing tracking of the latest upstream Nodestone code and CSS selectors, and subsequently required Nodestone as a Git submodule for solution builds. `vendor/nodestone` supplies the parser source through a local dependency; selectors remain an independent Git dependency. A checked update workflow follows both upstream HEADs and advances the submodule pointer, lockfile, and build metadata; deployed images retain exact revision identities and parser-source fingerprints for reproducibility. The sidecar periodically reports upstream freshness so parser dependencies are not silently left on old revisions.

The owner additionally requires modular extension points: command definitions/handlers and gateway event handlers live in separate discoverable modules, loaded dynamically rather than listed in a central dispatch switch. Command deployment and runtime use the same discovered definitions. First-party code, scripts, tests, and supported configuration formats must carry explanatory comments; strict JSON configuration has companion documentation.

The owner approved Bun throughout (package management, tooling, tests, and production runtime), reuse of the existing production Discord application, and interpreting legacy timezone-naïve timestamps as UTC. Runtime versions are pinned in `package.json` and the container definitions. Production first-party code remains compiled ESM with explicit type checking.

The owner subsequently selected a source-built Nodestone Docker sidecar after the published npm package failed its compatibility gate. This supersedes in-process/published-package mandates in Sections 1, 9, 11, 13, and 14. The normal services are now `tarubot`, `nodestone`, and `postgres`; TaruBot accesses Nodestone through a typed HTTP adapter. Nodestone source and selector revisions must be pinned, with any sidecar compatibility changes documented and contract-tested. Lossless IDs, validated completeness, bounded/cancellable upstream work, and all domain invariants remain mandatory.

## 1. Purpose and interpretation

TaruBot connects a Final Fantasy XIV Free Company (FC) with its Discord server. It associates Discord users with game characters, observes FC membership through Lodestone, and manages Discord access accordingly. It also supports guest applications, character-based nicknames, and a manually maintained FC gil ledger.

This document is a standalone implementation contract defining TaruBot's behavior, architecture, data interfaces, deployment, and acceptance criteria. Numbered requirements, command contracts, and acceptance criteria are mandatory unless explicitly labeled as recommendations. **MUST** requirements are mandatory. **SHOULD** requirements may be departed from only with a documented reason that preserves the stated behavior and invariants.

### 1.1 Sources of authority

- **Lodestone, accessed through Nodestone:** observed character identity, names, worlds, FC metadata, and FC rosters.
- **PostgreSQL:** character links, verification provenance, guild configuration, access grants, membership history, ledger transactions, pending work, and audit history.
- **Discord:** current guild membership, effective permissions, role/channel existence, observed roles and nicknames, and notification delivery results.
- **Ledger users:** reported gil movements and opening balances. The ledger is a human-maintained accounting record of the FC's gil.

Synchronization combines Lodestone observations with PostgreSQL policy state to determine Discord access. Character ownership is established through the verification, assignment, and import policies below; FC membership is established through accepted roster observations.

### 1.2 Confirmed product decisions

| Decision | Required policy |
| --- | --- |
| Application language | TypeScript, strict mode, modern ECMAScript, native ESM |
| Module format | TaruBot-owned source, scripts, configuration code, and output use ESM; dependencies may use CommonJS |
| Discord library | Discord.js v14 |
| Database | PostgreSQL |
| Application runtime/tooling | Bun throughout, with exact versions and compiled production ESM |
| Lodestone integration | Source-built Nodestone Docker sidecar, accessed through a typed HTTP adapter |
| Runtime containers | TaruBot, Nodestone, and PostgreSQL |
| New self-service character claims | Verify a token in the character's Lodestone biography |
| Imported character links | Trust the supplied ownership links with explicit import provenance |
| Former FC members | Automatically eligible for guest access after confirmed departure |
| Guest-role holders at cutover | Create explicit imported guest grants from a complete Discord snapshot |
| Other guests | Require an approved application or an audited officer grant |
| Channel operations | Read-only channel metadata through `/channel` |

### 1.3 Scope boundaries

**SCOPE-01.** Implement the configuration, character ownership, membership synchronization, nickname, guest application, ledger, and utility operations defined in Section 4.

**SCOPE-02.** Channel functionality consists of metadata queries through `/channel` and configured destinations for application messages. Voice-channel conversation controls and color/status workflows are outside the application scope.

**SCOPE-03.** Nodestone owns Lodestone page acquisition and parsing. TaruBot accesses its results through the typed adapter defined in Section 9, which owns normalization, validation, and application-facing error handling.

**SCOPE-04.** Support independently configured Discord guilds. Each guild may link to at most one FC at a time. Guilds observing the same FC maintain independent permissions, character links, guest grants, and ledger accounts.

**SCOPE-05.** Public character/FC caches and roster fetches may be shared. Authority-bearing application data must be guild-scoped. Every private read and mutation must authorize the actor against the guild that owns the target record.

**SCOPE-06.** A web dashboard, in-game automation, arbitrary FC-rank-to-Discord-role mappings, and production high-availability/sharding infrastructure are outside this release. The initial deployment is one active bot instance with restart-safe persistence.

## 2. Runtime, language, and project standards

**TECH-01.** Use the latest stable TypeScript release and an exact stable Bun release at implementation time, recording exact versions in the repository/build configuration. Use Bun for dependency management, tooling, tests, and production execution. Pin a supported PostgreSQL release; PostgreSQL 18 is the planning baseline.

**TECH-02.** The first-party package must declare `"type": "module"`. TypeScript must use `target: ESNext`, `module: NodeNext`, and `moduleResolution: NodeNext`. The pinned Bun runtime must support the JavaScript features actually emitted and used.

**TECH-03.** Enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, and `verbatimModuleSyntax`. Use explicit type-only imports and Node-compatible relative import extensions. Build and type checking must cover first-party application code, scripts, and tests.

**TECH-04.** Author application code, scripts, tests, and executable configuration as ESM, using ESM imports/exports and `.ts`, `.js`, or `.mjs` files as appropriate. Import dependencies using ESM syntax or dynamic `import()`. CommonJS inside a separately packaged third-party dependency is acceptable. Apply first-party module-format checks to the application/tooling boundary.

**TECH-05.** Treat external data and caught exceptions as `unknown` until validated. Use runtime schemas, type narrowing, and explicit optional/error states to establish their application types. Enforce strict typing with an explicit-`any` lint rule. A narrow, documented assertion at Nodestone's request-type compatibility boundary is permitted as described in Section 9.

**TECH-06.** Production must execute compiled JavaScript. Use a committed dependency lockfile, deterministic installation/build commands, exact dependency revisions, and versioned or digest-pinned production images.

**TECH-07.** Use first-party layers with clear responsibilities: domain policy, application operations, Discord interaction handling, Nodestone adaptation, PostgreSQL persistence, background work, and configuration/observability. Domain policy must be testable without a Discord connection or live Lodestone requests.

## 3. Core domain invariants

### 3.1 Identifiers and values

**DATA-01.** Discord snowflakes, character IDs, and FC IDs must be canonical positive decimal strings throughout application interfaces, persistence, logs, and serialized jobs. Use PostgreSQL text columns with positive-decimal validation sufficient for unsigned 64-bit external identifiers. For example, `9232097761132958152` is a valid FC ID that must round-trip exactly through every boundary.

**DATA-02.** At the dependency boundary, accept a canonical decimal-string ID or normalize a positive safe-integer ID to that representation. Return a typed invalid-data result for any other numeric value. Successful identity resolution requires a lossless value from the source.

**DATA-03.** Store names, tags, worlds, and data centers as Unicode display attributes associated with stable IDs. Store a character's canonical full name explicitly. Database text capacity must accommodate complete valid source values; command-specific input limits are validated separately. Preserve canonical spelling and punctuation.

**DATA-04.** Application timestamps must use PostgreSQL `timestamptz` and represent UTC instants. Separate observation time, successful synchronization time, application decision time, and notification delivery time.

**DATA-05.** Gil is integral. Use PostgreSQL `bigint` for known ledger balances and signed entry deltas, and JavaScript `bigint` or an equivalently exact integer representation for arithmetic. Configure database value decoding for exact arithmetic. Serialize large monetary values as decimal strings.

### 3.2 Character links and membership

**DOMAIN-01.** A Discord user may link several characters within a guild. A character may have at most one active linked owner within that guild. Enforce this in PostgreSQL, including under concurrent requests. Links in different guilds are independent.

**DOMAIN-02.** A trusted active link has one of these provenance types: successful profile-token verification, audited officer assignment, or trusted data import. Only trusted active links participate in access eligibility.

**DOMAIN-03.** A user is eligible for the member role when at least one trusted linked character has confirmed membership in the guild's currently linked FC, established through accepted roster observations.

**DOMAIN-04.** Historical FC membership requires a trusted user-character link and an accepted observation of that character in the FC, or imported membership evidence meeting Section 12. Store the link and observation provenance supporting the historical record.

**DOMAIN-05.** Membership history must survive a character unlink, a confirmed FC departure, bot restarts, and a user leaving Discord. Scope former-member eligibility to `(guild, FC)` and evaluate it against the guild's current FC link.

### 3.3 Desired access

**ROLE-01.** Apply the following precedence to non-bot guild members:

| State | Member role | Guest role |
| --- | --- | --- |
| Confirmed FC member | Present | Absent |
| Not an FC member; active approved, manual, or imported guest grant; guest access not revoked | Absent | Present |
| Not an FC member; confirmed former member of the currently linked FC; guest access not revoked | Absent | Present |
| Confirmed ineligible for both | Absent | Absent |
| FC membership uncertain | Preserve existing FC-derived access; new grants await fresh evidence | Preserve guest state, subject to explicit local grants/revocations and member-role precedence |

**ROLE-02.** Guest revocation overrides approved/manual/imported grants and former-member guest eligibility until an officer explicitly restores access. FC-member eligibility is evaluated independently and takes precedence. Persist and audit both revocation and restoration.

**ROLE-03.** A confirmed former member becomes a guest automatically. Unlinking a user's last qualifying character is an explicit local loss of member eligibility and may result in former-member guest access. Roster-driven former-member status requires the departure evidence defined in Section 6.

**ROLE-04.** Automatic character-based role and nickname reconciliation applies to human guild members. Retain a departing user's links, history, ledger attribution, and guest grants. Rejoining triggers reconciliation using current configuration and observations.

**ROLE-05.** The configured member and guest roles are authoritative bot-managed access roles for human users, including when someone assigns them manually. Reconcile these roles from persisted policy state. Apply individual role deltas limited to current or explicitly retired bot-managed role IDs, preserving every unrelated role.

**ROLE-06.** During a refresh failure, retain the last confirmed FC-derived access state. Explicit local actions, such as guest revocation or character unlink, remain available when their result can be established entirely from PostgreSQL state.

## 4. Discord command contract

All commands are guild-only. Unless expressly identified as a channel notification, responses are ephemeral. Commands that require network or database work must acknowledge or defer before Discord's initial response deadline, normally within three seconds.

### 4.1 Authorization definitions

- **Guild user:** a current non-bot member of the invoking guild.
- **Officer:** a guild user with effective `ManageGuild` permission, including the guild owner/administrator through Discord's effective permissions.
- **Ledger member:** a guild user with confirmed FC-member eligibility; an officer may also perform these operations.
- **Self:** the invoking user within the invoking guild.

**AUTH-01.** Enforce permissions in the application operation as well as at the Discord command boundary. Every subcommand, autocomplete that reveals private records, and button interaction must enforce its own applicable authorization and guild scope.

**AUTH-02.** Use Discord command default permissions to control command availability and runtime authorization to enforce each operation's policy. Evaluate mixed-permission subcommands and `force` options explicitly. Every `force: true` request requires officer authorization regardless of cache freshness.

**AUTH-03.** Selecting or clearing managed roles additionally requires effective `ManageRoles`. Selected roles must be below the actor's highest role unless the actor is the guild owner, and must always be manageable by the bot. Validate member/guest roles as access roles with `Administrator`, `ManageGuild`, and `ManageRoles` permissions disabled.

### 4.2 Configuration commands

| Command | Access | Contract |
| --- | --- | --- |
| `/config fc link fc_id` | Officer | Validate the FC, link it to this guild, and enqueue initial synchronization. An identical existing link is a no-op; a different existing link requires explicit unlinking first. |
| `/config fc unlink fc_id` | Officer | Require the supplied ID to match the currently linked FC. Remove that link locally without requiring Lodestone availability. |
| `/config roles member [role] [clear]` | Officer + role authorization | Set or clear the member-role configuration. |
| `/config roles guest [role] [clear]` | Officer + role authorization | Set or clear the guest-role configuration. |
| `/config ledger [channel] [clear]` | Officer | Set or clear the ledger notification channel. |
| `/config officer_notifications [channel] [clear]` | Officer | Set or clear the operational/officer notification channel. |
| `/config guest_applications [channel] [clear]` | Officer | Set or clear the guest application review channel. |
| `/config show` | Officer | Display configuration, enabled/blocked capabilities, linked FC, and relevant freshness/status information. |
| `/config validate` | Officer | Check stored roles/channels, current bot permissions/hierarchy, and configuration consistency without mutating access. |

For set/clear commands, require exactly one of a value or `clear: true`. Validation failures retain the saved configuration and return a corrective instruction.

**CFG-01.** IDs or canonical Lodestone URLs may identify an FC. Extract the ID from an allowed Lodestone host and the expected FC path, validate it, and resolve it through the configured Nodestone adapter.

**CFG-02.** Roles must be distinct, existing, assignable guild roles; exclude `@everyone`, integration-managed roles, and the bot's own role from selection. Channels must be guild text channels belonging to the guild and supporting the required messages/embeds.

**CFG-03.** Check required bot permissions and hierarchy before saving configuration. Recheck them before effects because permissions and role positions can change later. A deleted/misconfigured resource must block only affected operations and produce an actionable diagnostic.

**CFG-04.** Persist configuration revisions. Configuration changes must enqueue reconciliation. Superseded managed roles require durable cleanup of the retired role IDs; preserve unrelated roles. Clearing a role stops its future assignment and schedules its cleanup.

**CFG-05.** Unlinking an FC removes FC-derived member access and automatic former-member eligibility associated with that link. Explicit approved/manual/imported guest grants remain guild-scoped and can continue to apply. Record unlinking as a configuration event, retaining existing membership history.

**CFG-06.** Preserve character links, historical membership, ledger accounts/entries, and audit records when unlinking an FC. Relinking the same FC reuses its history and ledger account. Linking a different FC resolves that FC's separate guild-scoped account.

### 4.3 Character commands

| Command | Access | Contract |
| --- | --- | --- |
| `/claim [character] [forename] [surname] [world]` | Self | Resolve a character and create a pending profile-token verification challenge. |
| `/verify character` | Self | Verify the caller's pending challenge for this character. A persistent verification button may invoke the same operation. |
| `/unclaim character` | Self | Remove the caller's active local link using stored identity, without depending on Lodestone availability. |
| `/assign member reason [character] [forename] [surname] [world]` | Officer | Make an audited, trusted manual assignment to a current non-bot guild member. |
| `/unassign member character reason` | Officer | Remove that user's local character link. Stored owner IDs must remain usable after the user leaves Discord. |
| `/characters [member]` | Self; officer for another user | List local links, provenance/status, canonical names/worlds, primary character, and known FC information. |
| `/main character` | Self | Select an active trusted linked character as the guild-specific primary character. |
| `/nickname enabled` | Self | Enable or disable bot-managed character nicknames for this guild. |

**CHAR-01.** For claim/assignment, require exactly one selector form: `character` as a positive ID/canonical character-profile URL, or the complete `forename`, `surname`, `world` triple. Reject incomplete or conflicting selector forms.

**CHAR-02.** Search must use full name and world, normalize comparison whitespace/Unicode/case consistently, and compare exact identity attributes. Return the unique exact match, require explicit selection among multiple exact matches, or report a complete no-match result. Expose incomplete and failed searches as separate outcomes.

**CHAR-03.** Commands operating on existing links must support stable IDs and autocomplete from PostgreSQL, displaying the stored name/world. Unclaim, unassign, and primary selection must work after a character rename, world transfer, or Lodestone outage. Removal must verify the stored owner before changing anything.

**CHAR-04.** Reclaiming/reassigning a character already linked to the same user is idempotent. Return an ownership conflict when a different active owner exists. Reassignment consists of explicit authorized unlinking followed by creation of a new trusted link.

**CHAR-05.** Commit successful local link changes independently of Discord role/nickname delivery. Enqueue affected-user reconciliation in the same transaction and report side effects as queued, applied, or blocked. Verified ownership remains durable throughout delivery retries.

### 4.4 Membership, guest, ledger, and utility commands

| Command | Access | Contract |
| --- | --- | --- |
| `/refresh [force]` | Guild user; officer for force | Refresh when due, or reconcile from usable cached data. Return the run ID, freshness/cooldown, and queued/completed/blocked result. |
| `/sync status [run_id]` | Guild user for their own requests; officer for guild-wide status | Inspect authorized refresh/reconciliation results and pending/blocked work, including after the initiating interaction expires. |
| `/apply` | Guild user | Submit a guest application if the user lacks member/guest access and has no pending application. |
| `/guest approve application` | Officer | Approve a pending application through the same operation used by its review button. |
| `/guest deny application [reason]` | Officer | Deny a pending application through the same operation used by its review button. |
| `/guest grant member reason` | Officer | Grant guest access manually, with an audit record; can explicitly restore revoked guest access. |
| `/guest revoke member reason` | Officer | Persistently revoke guest eligibility and cancel unresolved applications for that user. |
| `/guest status [member]` | Self; officer for another user | Show application, grant, revocation, and automatic-guest status within this guild. |
| `/ledger deposit amount note` | Ledger member | Record a positive deposit. |
| `/ledger withdraw amount note` | Officer | Record a positive withdrawal if sufficient recorded funds exist. |
| `/ledger balance [fc_id]` | Ledger member; officer for historical FC | Show the initialized/unknown balance and relevant delivery status. |
| `/ledger history [fc_id] [before]` | Ledger member; officer for historical FC | Paginate durable entries using a stable cursor. |
| `/ledger initialize balance note` | Officer | Set the opening balance of an uninitialized current guild/FC ledger exactly once. |
| `/ledger adjust balance note [entry]` | Officer | Append a correction bringing the recorded balance to the specified value; optionally reference the corrected entry. |
| `/ping` | Guild user | Report Discord gateway latency with an appropriate label. |
| `/channel` | Guild user | Report the current channel's ID, name, and type. |
| `/version [commits]` | Guild user | Show the installed SemVer and recent GitHub commit IDs, links, titles, and verified-signature badges. |

**UX-01.** Bound input sizes and honor Discord message, embed, autocomplete, and component limits. Escape user-controlled display content and set an explicit allowed-mentions policy, defaulting to no parsed mentions. Authorize any intended recipient mention separately from user-supplied text.

**UX-02.** Distinguish committed application state from pending Discord effects. Long jobs must remain inspectable after an interaction token expires. Use completion wording only for confirmed successful effects, and queued/blocked wording for work awaiting delivery.

**UX-03.** Represent an unconfigured guild explicitly and return setup instructions. Read-only commands use read-only persistence operations; configuration is created through authorized configuration commands.

**UX-04.** Register the declared command set through an explicit deployment operation. Support guild-scoped registration for development and intended production registration. Reconcile the bot's registered commands to exactly the command set defined in Section 4.

## 5. Character verification and nickname behavior

### 5.1 Verification protocol

**VERIFY-01.** Generate at least 128 bits of cryptographic randomness for each challenge. Bind it to the guild, Discord user, character ID, issuance time, and expiry. The default lifetime is 30 minutes. A replacement challenge invalidates the previous challenge for that same tuple.

**VERIFY-02.** Present an exact token and instructions for placing it in the character's public Lodestone biography. Verification succeeds when a fresh profile obtained through Nodestone for the bound character ID contains that exact token and the stored challenge remains valid.

**VERIFY-03.** Persist the token hash, retaining plaintext only for its ephemeral presentation and in-memory comparison. Redact tokens, full biographies, and interaction credentials from logs. An unexpired challenge remains usable across a process restart. Authorize every verification component against its stored challenge.

**VERIFY-04.** Challenge completion must atomically check expiry/consumption and tuple binding, enforce ownership uniqueness, create the trusted link, and consume the challenge. Concurrent attempts resolve to one committed ownership decision and a deterministic result for every other attempt.

**VERIFY-05.** Keep pending challenges separate from trusted ownership and its role/nickname effects. Several users may attempt proof of an available character; only successful challenge completion establishes ownership. Bound pending-request volume per user and globally. Retain retryable challenge state after a network failure until expiry.

**VERIFY-06.** Account for Lodestone publication delay. Show pending/not-yet-visible status and permit bounded retries until expiry. Verification must fetch a fresh profile independently of the application profile cache. Existing trusted links remain durable during profile unavailability.

### 5.2 Nicknames

**NICK-01.** Store primary-character selection and nickname preferences per `(guild, user)`. For a new user with no prior links, the first successfully trusted link becomes the initial primary character and enables nickname management. Thereafter the selection changes through `/main` or removal of the selected link.

**NICK-02.** The generated nickname is the canonical full character name. Format it within Discord's nickname length limits using Unicode-safe truncation when necessary, and retain the complete canonical name in PostgreSQL.

**NICK-03.** Track the pre-management nickname and the last nickname successfully written by the bot. An independent nickname change suspends automatic nickname management for that user. Explicit re-enablement establishes a new management baseline.

**NICK-04.** Disabling management or unlinking the primary character restores the saved pre-management nickname when the current nickname still matches the last bot-written value. Otherwise retain the current nickname. Unlinking the primary clears the selection and returns instructions for selecting another character.

**NICK-05.** Renames/world changes must update cached identity attributes. A managed nickname follows a confirmed primary-character name update. Report bot permission/hierarchy limitations, including the guild owner, as scoped blocked effects while retaining the character link.

**NICK-06.** Imported users start with an unset primary character and nickname management disabled, retaining their current Discord nickname. They can select a primary character and enable management explicitly.

## 6. Synchronization and reconciliation

### 6.1 Scheduling and acquisition

**SYNC-01.** Schedule a complete roster refresh for each actively linked FC every six hours by default, with jitter and startup catch-up. Fetch a shared FC once per refresh even if multiple guilds link to it. Limit scheduled roster acquisition to actively linked FCs.

**SYNC-02.** Trigger targeted reconciliation after successful claims/assignments/unlinks, primary or nickname preference changes, guest decisions/revocations, guild member joins, relevant configuration changes, and managed-role drift. Ignore or coalesce the bot's own resulting Discord events to avoid feedback loops.

**SYNC-03.** Refresh display profiles for trusted linked characters of currently present users on a bounded schedule, defaulting to daily, and on explicit identity/verification operations. Deduplicate shared profile fetches. Store profile FC hints separately from the accepted roster evidence used for access decisions.

**SYNC-04.** A normal `/refresh` before the six-hour roster interval expires may reuse a fresh accepted roster while reconciling Discord state. `force: true` is officer-only and bypasses that freshness interval, not global concurrency/rate limits or an existing refresh lock.

**SYNC-05.** New verified links whose membership cannot be established from fresh cache may request a coalesced early refresh. Departure-confirmation fetches may also run before the periodic interval. Default minimum FC refresh separation is 60 seconds; callers must receive an honest queued/cooldown result.

**SYNC-06.** Acquire a complete roster before publishing membership changes:

1. Fetch and validate FC identity, metadata, and advertised roster count.
2. Fetch every required roster page through Nodestone, with bounded pagination and resource usage.
3. Validate required member identity fields, unique character IDs, page progression, consistent pagination, and total distinct member count.
4. Recheck FC identity/count to detect changes during the crawl. Retry inconsistent observations while retaining the accepted snapshot.
5. Atomically publish an accepted snapshot and its successful observation time, or retain the previous accepted snapshot on failure.

Treat a multi-page crawl as a time-bounded observation. Record its acquisition interval and completeness checks; atomicity applies to publication of the validated observation in PostgreSQL.

**SYNC-07.** A missing page, repeating page, pagination cycle, malformed ID, missing required field, inconsistent count, maintenance response, timeout, or parser failure invalidates the candidate snapshot. Retain the accepted snapshot and record a typed, retryable or terminal acquisition result.

**SYNC-08.** A genuinely empty roster is valid only with affirmative, validated empty/count evidence for the expected FC. Represent missing count/pagination evidence as unknown. Support single-page and empty-page normalization through explicit, tested Nodestone contracts.

### 6.2 Membership transitions

**SYNC-09.** Positive membership may be established from one fresh, complete accepted snapshot. A roster-driven departure of a previously confirmed character requires absence in two complete accepted snapshots at least 60 seconds apart. Schedule confirmation work when needed. Reappearance resets pending departure; only complete accepted observations advance confirmation state.

**SYNC-10.** For users with several trusted characters, remove member eligibility only when none remains confirmed or awaiting departure confirmation. Persist pending/confirmed transition state and resume that state after restart.

**SYNC-11.** Evaluate a newly linked character against a fresh accepted roster. A match establishes current membership; an absent character leaves that link ineligible for current membership. Historical eligibility is evaluated independently using the evidence defined in DOMAIN-04 and Section 12.

**SYNC-12.** When usable current evidence is unavailable, preserve existing FC-derived access and expose stale/degraded status to officers. New member-role grants wait for fresh evidence, and roster-driven demotions wait for confirmed departure evidence.

**SYNC-13.** Update `last_successful_roster_at` only when publishing a complete accepted snapshot. Track attempted/failed acquisition times and Discord reconciliation progress as separate states and timestamps.

### 6.3 Applying Discord effects

**SYNC-14.** Obtain complete Discord guild-member coverage using supported fetching/pagination, recording whether enumeration completed. Scope reconciliation to human users who remain in the guild, and record individual departure/skipped outcomes while continuing the run.

**SYNC-15.** Apply only necessary role deltas and respect Discord.js REST rate-limit handling. Before applying work, recheck current configuration, the member's presence, and current desired state. Supersede or recompute work whose governing configuration or snapshot has changed.

**SYNC-16.** Serialize conflicting effects for a `(guild, user)` and make repeated reconciliation idempotent. Track partially applied role transitions and retry them toward current desired state. Expose role projection as an eventually consistent operation with per-effect completion status.

**SYNC-17.** Missing permissions, missing roles/channels, or hierarchy failures must be scoped, diagnosable blocked work. Continue reconciling other users/capabilities. Resume blocked work when its configuration or permissions change; apply bounded backoff to transient failures.

## 7. Guest applications and grants

**GUEST-01.** Persist applications with guild, applicant, current guild-join context, creation time, review channel/message IDs, state, reviewer, decision time, and optional reason. Enforce at most one pending application per `(guild, user)` in PostgreSQL.

**GUEST-02.** `/apply` requires a valid guest role and review channel. Persist the application and its review-message work together. The review message identifies the applicant, submission time, and application ID and provides approval/denial controls. Return the pending application for duplicate requests, or explain existing member/guest eligibility. A newcomer gains guest eligibility through approval or an explicit officer grant.

**GUEST-03.** Support `pending`, `approved`, `denied`, `cancelled`, and `superseded` application outcomes. Approval/denial must atomically transition only a pending application. Concurrent/repeated decisions return the single committed outcome.

**GUEST-04.** Review buttons must resolve durable application identifiers from PostgreSQL and work after restarts. Validate guild, application/message identity, actor permissions, and current applicant state on every click before invoking the authorized decision operation.

**GUEST-05.** At decision time, cancel a pending application if the applicant has left or its guild-join context is obsolete. Supersede a pending application if the applicant became an FC member. Retain committed decisions as audit outcomes; effect execution independently rechecks current membership and applies the role precedence in ROLE-01.

**GUEST-06.** Approval creates a durable guest grant and reconciliation work in one transaction. Queue a best-effort DM for approval/denial identifying the guild and outcome, with the decision reason when supplied. Track application outcome, grant state, role-delivery status, and DM-delivery status separately. Retain the decision during delivery failures and expose failed role delivery as retryable or blocked work; `/guest status` provides the applicant's durable outcome.

**GUEST-07.** Retain review history in PostgreSQL, update the review message with its outcome, and disable completed controls. Recreate a missing review message or handle the application through its command ID. Message repair operates from the durable application record.

**GUEST-08.** Persist approved, manual, and imported grants with provenance. Guest revocation must be durable and auditable. An officer's subsequent explicit approval/grant may restore access. Denied applicants may reapply after a configurable cooldown, defaulting to 24 hours. Any existing revocation remains effective until explicit restoration.

**GUEST-09.** Approved/manual/imported grants survive the user's departure from Discord and can apply on rejoin unless revoked. Cancel pending applications on an observed departure and require a matching stored guild-join context at decision time. On rejoin, evaluate existing grants and history under current policy.

## 8. Gil ledger

**LEDGER-01.** A ledger account belongs to `(guild, FC)`. Its account ID remains stable when that guild temporarily unlinks/relinks the FC. Guilds observing the same FC have distinct, independently authorized ledger accounts.

**LEDGER-02.** An account is either uninitialized or has an exact, nonnegative balance. New accounts and imported unknown balances require explicit initialization. A known zero balance is initialized state. Enforce a single initialization per account, including under concurrent requests.

**LEDGER-03.** Accept deposits and withdrawals from 1 through 999,999,999 gil. Use Discord integer options for this bounded range and convert to exact arithmetic at the boundary. Initialization and target-balance adjustments accept validated decimal strings sufficient for PostgreSQL `bigint` range.

**LEDGER-04.** Record immutable entries containing account, monotonically ordered account sequence, operation type, signed delta, resulting balance, actor, source guild, note, timestamp, originating interaction/idempotency key, and optional correction reference. Opening entries may have zero delta; deposits and withdrawals have strictly positive input amounts and appropriately signed deltas.

**LEDGER-05.** Notes are required for mutations: trim surrounding whitespace and require 1 through 1,000 UTF-16 code units, with Discord presentation limits also validated. Store the complete accepted note and render it under the allowed-mentions policy. Deposits require ledger-member authorization; withdrawals, initialization, and adjustments require officer authorization.

**LEDGER-06.** In one PostgreSQL transaction, enforce the idempotency key, lock/serialize the account, validate initialization/range/funds, insert the entry, update the balance, and enqueue its notification. Competing withdrawals are evaluated in account order against the resulting available balance, retaining the nonnegative-balance invariant.

**LEDGER-07.** Record corrections as additional signed entries referencing immutable history. `/ledger adjust` records the difference between the current and supplied target balance with an explanation. An identical target is a no-op. A referenced prior entry must belong to the same account.

**LEDGER-08.** Require a linked FC and a valid configured ledger channel before accepting a financial mutation. If delivery fails after the transaction commits, retain the transaction and mark delivery pending/blocked. Return the durable entry ID, delivery state, and a route to inspect or retry notification work independently.

**LEDGER-09.** Ledger-channel notifications include stable entry ID/sequence, actor, operation, amount, note, resulting balance, and event time. Preserve per-account notification order. PostgreSQL is authoritative even when a message is deleted or duplicate notification delivery occurs after an ambiguous network acknowledgement.

**LEDGER-10.** Enforce exactly-once financial mutation per idempotency key. Deliver notifications through a durable at-least-once outbox, using supported deduplication and stored Discord message IDs. Associate every delivery attempt and any duplicate visible notification with the same immutable entry.

**LEDGER-11.** Balance/history default to the currently linked account. Officers may inspect historical accounts belonging to their own guild by FC ID, including while no FC is linked. Authorize normal-user reads against current ledger membership and the current account; authorize historical reads against guild ownership and officer permission.

## 9. Nodestone dependency contract

### 9.1 Source-built sidecar integration

**NODE-01.** Run Nodestone's parsers in an isolated Docker sidecar with outbound HTTPS access to Lodestone. TaruBot accesses a validated HTTP envelope through a single typed adapter. The sidecar uses these parser exports from pinned upstream source:

| Nodestone export | Use | Expected raw result shape to validate |
| --- | --- | --- |
| `CharacterSearch` | Full-name/world search, one page at a time | A root `List` and `Pagination`, with explicit no-results handling where supported |
| `Character` | Canonical profile attributes and biography verification | Direct profile fields such as `Name`, `World`, `DC`, `FreeCompany`, and `Bio` |
| `FreeCompany` | FC identity, display metadata, and roster count | Direct fields including `ID`, `Name`, `Tag`, `World`, `DC`, and the validated member-count field |
| `FCMembers` | One FC roster page | A root `List` and `Pagination` |

Validate these raw shapes against the selected Nodestone package version and convert them into the adapter's normalized application types.

**NODE-02.** Track upstream HEAD of the Nodestone source and selector repositories independently. The checked update workflow must refresh their resolved lockfile/build metadata and rebuild the sidecar. Record exact revisions for each reproducible deployment, periodically check upstream freshness, and document/contract-test compatibility transformations against the selected source.

**NODE-03.** The first implementation milestone must verify a clean Bun installation/build, typed ESM HTTP integration, runtime asset resolution, and all four parser operations for the selected source revision. Run these checks in the intended production images and repeat them when upgrading the dependency.

**NODE-04.** Construct the minimal typed `params`/`query` data required by the parser API in a dedicated request bridge. If the dependency's `Request` declaration requires a compatibility assertion, confine it to that bridge and document the fields supplied. Validate inputs before invocation and expose only application-owned types to domain operations.

**NODE-05.** Normalize results into string IDs, canonical full names, world/DC, optional FC identity, validated counts/page metadata, and plain display text as needed. Associate a requested profile with its validated input ID and check agreement with any returned ID. Include observation time and sufficient completeness metadata for the consuming operation.

### 9.2 Normalization and execution

**NODE-06.** The adapter and installed dependency must jointly satisfy this data contract:

- Identifiers are lossless canonical decimal strings as defined in DATA-01 and DATA-02.
- Explicit zero, confirmed absence, unknown values, and invalid data are distinct results.
- Pagination identifies the current page and total pages with positive integers. Next/previous page values are either valid page numbers or explicit end-of-sequence markers.
- Search names, worlds, and other query values are encoded exactly once as query values.
- Transport outcomes retain useful categories and available status/retry metadata, including when a request receives no HTTP response.
- Display fields are normalized from the parser's output to application text with the expected Unicode/entity semantics.

Contract fixtures must cover every normalization rule used for roster completeness, profile identity, and ownership verification. Document adapter normalization for the selected dependency release and verify it during dependency upgrades.

**NODE-07.** Configure library environment inputs, including its import-time `PAGE_REGION` setting, before loading affected modules. Default to the NA/English Lodestone region. Validate allowed region values and keep language-dependent selector expectations explicit.

**NODE-08.** Bound actual network work and parsing/resource consumption. Default to two concurrent Lodestone operations, at least one second between request starts, a 15-second per-request network deadline, and at most three attempts for retryable failures. Honor a usable upstream retry-after indication and apply exponential backoff with jitter.

**NODE-09.** Configure an overall job deadline and pagination/body-size bounds. A timeout must cancel underlying network work or terminate its isolated execution worker. Keep Discord interaction processing responsive during parsing; use a bounded worker pool within the bot container if needed. Scope HTTP configuration to the Nodestone integration.

**NODE-10.** Expose operation-specific outcomes such as not found, unavailable, rate limited, invalid response, and incomplete result. Retain trusted links during profile unavailability and accepted roster/configuration state during FC acquisition failures. Accept additional upstream fields while validating every required application fact.

**NODE-11.** Select the fields needed by each operation, including its required root/entry/pagination data. Fetch FC metadata at the crawl boundaries required by SYNC-06 and member pages through `FCMembers`. Limit profile requests to identity/display fields and biography data required for verification.

## 10. Persistence, transactions, and durable effects

### Approved onboarding extension

**ACCESS-01.** Explicit `/setup` enables a persisted guild-scoped channel policy and provisions/reuses distinct lobby and officer text rooms alongside the four access roles. Require current Manage Server, Manage Roles, and Manage Channels for setup. Existing guilds remain opted out until that action; enforce the bot's channel and role capabilities before mutation.

**ACCESS-02.** Role-less newcomers see the lobby; ordinary Members/Guests see ordinary channels and not the lobby. Officers and FC Leaders see the lobby, ordinary channels, and staff areas. Preserve existing private areas as staff-only. Apply visibility to every non-thread guild channel type and categories, with threads inheriting their parent's visibility. Discord owner/Administrator bypass remains intrinsic.

**ACCESS-03.** Own channel visibility overwrites explicitly, retain unrelated permission bits, persist first-observed ACL/parent/default-permission snapshots, and repair drift through deduplicated durable work. Bind writes to current activation/configuration/job ownership, verify the full resulting policy, retain recovery across partial failure/restart, and include channel work in refresh status.

**ACCESS-04.** In enabled guilds, derive Guest for active trusted registered owners who are not eligible FC members, using accepted current membership evidence; registration suffices when no FC is linked. Preserve explicit Guest revocation, FC Member precedence, guild isolation, and conservative treatment of unknown/stale evidence. Derived registration must not recreate a revoked durable grant.

### Database and durable work

**DB-01.** PostgreSQL is the runtime database. Use Drizzle ORM for typed application persistence over the node-postgres driver, with table mappings and inferred record types maintained alongside explicit versioned SQL migrations. The migrations own foreign keys, unique constraints, indexes, domains, and triggers; already-applied migrations are immutable. Bind ORM work inside an application transaction to its exact checked-out client. Retain narrowly scoped parameterized PostgreSQL control/locking SQL and catalog-based restore verification. Application startup checks the required schema version and checksum.

The physical schema may use different names, but it must represent these logical records and constraints:

| Logical records | Required scope/invariants |
| --- | --- |
| Guild configuration | Guild ID, nullable FC/role/channel IDs, configuration revision, active/disabled state |
| Discord users and guild-user state | Stable user identity; per-guild presence and nickname/primary preferences |
| FCs and characters | Shared public identity/display caches; observation/freshness metadata |
| Character links | Guild, character, owner, active/inactive state, provenance, actor/time; one active owner per guild/character |
| Verification challenges | Bound tuple, token hash, expiry, consumption/replacement state |
| Sync runs and roster snapshots | FC, requested/attempted/completed state, completeness evidence, version, counts/errors |
| Membership observations/history | Pending departures and confirmed periods; guild/user/FC historical eligibility |
| Guest applications/grants/revocations | Durable state machines and one pending application per guild/user |
| Ledger accounts/entries | Guild/FC account uniqueness, known/unknown state, ordered immutable entries, idempotency |
| Jobs/outbound effects | Durable payload/version, deduplication key, attempts, due time, lease/status, delivery IDs/errors |
| Audit and import provenance | Actor/source, guild, target, decision, timestamps, source checksum/keys and reconciliation results |

**DB-02.** Use short transactions containing database operations for application decisions. Perform Discord and Lodestone I/O outside those transactions. Connect committed decisions to subsequent delivery through persisted work.

**DB-03.** Protect financial operations, ownership claims, application decisions, and snapshot publication with database-enforced invariants that hold under concurrent interactions and process restarts.

**DB-04.** Publish application state and the jobs/outbox records needed to project it in the same transaction. Use PostgreSQL-backed work/outbox persistence within the two-service deployment.

**DB-05.** Jobs require deduplication, bounded retry, due times, recoverable leases, and explicit succeeded/blocked/terminal-failure outcomes. Publication and effect execution require current job ownership plus the applicable state/configuration version; expired workers relinquish their results for recomputation.

**DB-06.** Reconciliation effects derive current desired state. Ledger notifications refer to an immutable committed entry. Store enough information to inspect and retry delivery independently of its committed application decision.

**DB-07.** Audit officer assignments/unassignments, configuration changes, guest decisions/grants/revocations, verification provenance changes, ledger mutations, and migration actions. Record cache acquisition and update results as operational history, with aggregated officer notifications where appropriate.

**DB-08.** Removing the bot from a guild deactivates its work while retaining its history. A documented retention policy may prune expired challenges and bounded diagnostic payloads. Retain ledger entries, active links/grants, and membership evidence required by access policy.

## 11. Containers, configuration, and operations

**OPS-01.** Provide a project-root multi-target `Dockerfile` and `docker-compose.yml`. The normal long-running services are `tarubot`, `nodestone`, and `postgres`; the source-built Nodestone sidecar has a private HTTP endpoint.

**OPS-02.** The bot image must use a multi-stage reproducible build, run as a non-root user, contain compiled application code and required runtime dependencies/assets, and execute Bun directly with proper signal handling. Install runtime dependencies from the committed lockfile during image construction and retain their required package assets in the final image.

**OPS-03.** PostgreSQL must use a named persistent volume mounted at the correct location for its selected image major. Its port is private to the Compose network by default. Use Compose DNS for connectivity; TaruBot requires outbound access to Discord and Lodestone.

**OPS-04.** Include `.dockerignore`, `.env.example`, and documented install/build/run commands. Build the image from the application, its declared runtime dependencies, and required assets. Keep data-import inputs, credentials, local environment files, and repository metadata outside the image. Supply tokens/database credentials through runtime configuration or mounted secrets.

**OPS-05.** Validate configuration before accepting work. Document, at minimum, Discord token/application ID, PostgreSQL connection settings, environment/log level, Lodestone region, sync/profile intervals, verification expiry, request/retry/concurrency bounds, and health-check configuration. Configuration errors identify the setting and expected format using redacted values.

**OPS-06.** Provide explicit commands for schema migration, data import, application-command registration, build, start, type checking, linting, formatting checks, unit tests, and integration tests. Run migration/registration as one-shot operations using the bot image or its documented tooling.

**OPS-07.** The bot must require the expected schema version. Serialize migration execution and report incompatible schema/configuration clearly. Support dependency-ready startup ordering and runtime reconnection/retry behavior.

**OPS-08.** Provide local process liveness and application readiness/capability status. Readiness reflects initialization, database/schema availability, and Discord connectivity. Report Lodestone outages as degraded synchronization while allowing available local/ledger capabilities to operate. Health probes use local/dependency connection state independently of scheduled Lodestone acquisition.

**OPS-09.** On termination, stop accepting new work, stop scheduling, settle or safely abandon short transactions, release/recover leases, and close Discord/database resources within the documented container stop period. Restart resumes committed work using its idempotency keys and durable decision state.

**OPS-10.** Use structured logs with operation/run IDs, guild/FC context where appropriate, durations, result categories, retry information, and actionable permission/configuration errors. Track successful refresh age, failures, queue depth/age, reconciliation outcomes, and blocked notification work. Apply redaction to credentials, proof tokens, and profile bodies.

**OPS-11.** Use the officer notification channel for operational summaries, material membership changes, repeated synchronization/delivery failures, and recovery notices. Aggregate and rate-limit messages per guild/run, including during large roster changes and prolonged outages.

**OPS-12.** Document Discord setup using the `Guilds` and privileged `GuildMembers` intents, application command installation, and explicit channel/role permissions. Require `ManageRoles`, `ManageNicknames` for enabled nickname management, and the channel viewing/sending/embedding/history permissions needed by configured destinations. Use this explicit permission set with bot `Administrator` permission disabled.

**OPS-13.** Provide PostgreSQL backup/restore instructions and a tested operational recovery procedure. State which commands need a maintenance window and how to observe blocked jobs, stale snapshots, and failed Discord effects.

## 12. Data import and activation

### 12.1 Import inputs

The importer accepts a MySQL-compatible SQL dump, such as the supplied `tarubot_backup.sql`, with this input schema. The supplied fixture uses MariaDB 11.8.6 dump syntax.

| Input table | Fields and relationships |
| --- | --- |
| `freecompany` | `fc_id`: string primary key; `name`, `tag`, `world`: strings; `gil_balance`: nullable integer; `last_updated`: nullable timezone-naïve datetime |
| `gamecharacter` | `char_id`: string primary key; `owner`: nullable reference to `member.discord_id`; `fc`: nullable reference to `freecompany.fc_id`; `forename`, `surname`, `world`: strings |
| `member` | `discord_id`: string primary key |
| `guild` | `guild_id`: string primary key; `fc`: nullable reference to `freecompany.fc_id`; `member_role_id`, `guest_role_id`, `ledger_channel_id`, `officer_notifications_channel_id`, `guest_application_channel_id`: string IDs, with empty values representing unconfigured fields |

The supplied acceptance fixture has these expected values:

| Input fact | Expected count or value |
| --- | --- |
| `freecompany` | 40 rows |
| `gamecharacter` | 4,251 rows |
| `member` | 241 rows |
| `guild` | 1 row |
| Non-null `gamecharacter.owner` links | 161 |
| Null FC gil balances | 4 |
| Configured FC's recorded balance | 349,279,945 gil |

The SQL input provides identity records, ownership links, guild configuration, cached FC associations, and balance snapshots. A separate complete Discord snapshot provides current guild presence, configured-role holders, and current nicknames. Fresh Nodestone acquisition provides current game membership. Initialize application-specific state from these inputs according to the following policies.

### 12.2 Import contract

**MIG-01.** Provide a documented one-shot import operation accepting an input file path. Decode the SQL dump through a tested MySQL/MariaDB dump reader or isolated staging database, supporting escaped quoted values, Unicode, nulls, directives, and schema/data ordering. Map validated input records into the PostgreSQL model defined in Section 10. Temporary import infrastructure is scoped to this one-shot operation.

**MIG-02.** Provide a read-only dry run reporting input counts, relationships, mappings, invalid values, normalization, opening balances, and proposed access bootstrap actions. Validate in staging and publish through transactions so live state consists of a complete accepted import or its pre-import state.

**MIG-03.** Import every valid identity and ownership record, including unclaimed characters and users absent from Discord. For the supplied fixture, this includes 40 FCs, 4,251 characters, 241 users, and 161 ownership links. Normalize empty optional role/channel IDs to null. Validate all foreign-key relationships and report conflicts explicitly.

**MIG-04.** The input schema associates ownership with users and balances with FCs. For the supplied single-guild fixture, map its 161 ownership links and all 40 FC ledger states to the sole configured guild. Create 40 guild/FC ledger accounts: 36 known opening balances, including explicit zeros, and four uninitialized accounts. Enable mutations for the currently linked account.

Record the mapping in the import report. For a multi-guild input, require an explicit ownership/account mapping that assigns each source balance once and identifies the destination guilds for each ownership record.

**MIG-05.** Mark supplied ownership links as trusted `imported_link` provenance. Record the input keys/checksum and import time. Self-service claims created through the application use profile-token verification provenance.

**MIG-06.** Retain input FC/character relationships as historical cache facts. Create imported historical membership for a `(guild, user, FC)` when the mapped user owns a supplied character whose `fc` matches that guild's linked FC. Record the supporting ownership, character, and guild input keys as evidence.

**MIG-07.** Retain input timestamps as provenance and initialize successful live-synchronization state as pending. Require an explicit source timezone for the input's timezone-naïve datetime values, retain their raw values, and report UTC conversion. Obtain a fresh complete roster before enforcing membership-derived changes.

For imported member-role holders with matching imported FC-membership evidence, apply the two-observation departure confirmation before the first roster-driven demotion. Existing access remains in place during validation; new member grants require fresh roster evidence.

**MIG-08.** Convert each known balance into one immutable import opening entry with input provenance. For the supplied fixture, verify the configured FC's opening balance is exactly 349,279,945. Null balances create uninitialized accounts. Account transaction history starts with its opening entry and subsequent application-recorded entries.

**MIG-09.** Capture a complete live Discord snapshot of human holders of the configured guest role at cutover. Create explicit `imported_guest` grants with guild/user/role IDs, capture time, and snapshot provenance. Require successful complete capture before publishing the grandfathered guest population.

Snapshot users absent from the SQL dump create additional user/guild-user records. Report these additions separately from SQL input counts. Character ownership comes from imported links or subsequent verified/manual assignments; the Discord snapshot supplies presence and role state.

**MIG-10.** Initialize imported users with an unset primary character and nickname management disabled, retaining current Discord nicknames. Application review history for a newly imported guild begins with requests submitted through `/apply`. Provide users with instructions for primary selection, nickname opt-in, and guest applications.

**MIG-11.** Make import execution idempotent using input fingerprints and stable source-record identities. Re-running the same import resolves to the same links, opening entries, history, and guest grants while retaining subsequent application decisions. Report conflicting input changes for an explicit mapping/import decision.

### 12.3 Activation and recovery

**MIG-12.** Document and verify this sequence:

1. Rehearse schema creation and import against a disposable PostgreSQL instance using the supplied fixture.
2. Establish a write-free capture window for the input database and managed Discord roles; retain a final consistent input snapshot and checksums.
3. Capture Discord role/configuration/nickname information needed for imported grants, validation, and the reconciliation preview.
4. Run versioned PostgreSQL migrations and the validated import; retain the import report.
5. Validate current channels, roles, bot permissions/hierarchy, and configured FC identity.
6. Register exactly the declared command set.
7. Obtain a fresh complete FC snapshot and produce a read-only preview of role/nickname actions. Resolve reported input/configuration issues before enabling effects.
8. Activate TaruBot as the application writer, verify representative claim/access/ledger operations, and monitor queued or blocked work.

The numeric values in Section 12.1 define the supplied acceptance fixture. For another input snapshot, derive IDs, counts, and balances from that input and reconcile its import report accordingly.

**MIG-13.** Maintain one authorized application writer during activation and recovery. Retain input snapshots and PostgreSQL backups. Document recovery before activation and after live transactions have been accepted. Post-activation recovery must retain acknowledged ledger entries, links, and decisions through compatible database restoration or reconciliation/replay of exported changes, then resume pending durable work.

## 13. Verification and acceptance criteria

Verification must cover observable behavior, policy invariants, concurrency, and recovery. Use deterministic clocks/IDs where needed, real PostgreSQL for persistence integration tests, and controlled Discord/Lodestone fixtures for normal CI.

| ID | Acceptance scenario |
| --- | --- |
| AC-01 | First-party production code, tests, and scripts type-check/build as ESM with the required strict flags. After a clean package-manager installation, the compiled bot imports the published Nodestone package, resolves its required runtime assets, and invokes its parser API within the production image. |
| AC-02 | The FC ID `9232097761132958152` round-trips exactly through input, dependency adaptation, PostgreSQL, jobs, logs, and responses. Unsafe numeric IDs produce typed invalid-data outcomes. Large ledger values retain exact arithmetic and serialization. |
| AC-03 | Character search distinguishes exact match, ambiguity, no results, incomplete pagination, and upstream failure. Names with spaces, apostrophes, hyphens, and supported Unicode are correctly encoded and displayed. |
| AC-04 | A self-claim progresses from pending challenge to trusted link only with valid bound proof. Mismatched, expired, replaced, and consumed challenges return the specified failure state. Pending verification survives restart. |
| AC-05 | Competing claims/assignments resolve to at most one active owner per guild/character. Repeated same-owner operations are idempotent, and every private read/mutation enforces target-guild authorization. |
| AC-06 | Unclaim/unassign resolves stored identity during a Lodestone outage and after a rename/transfer, verifies the target owner, commits the local link change, and queues reconciliation. |
| AC-07 | One complete accepted roster establishes positive membership. Any remaining qualifying character retains member eligibility. Two properly separated complete absence observations confirm departure; invalid/incomplete acquisition retains the prior accepted state. |
| AC-08 | Confirmed former members become guests; newcomers gain access through approval/manual grant. Guest revocation survives refresh/restart/rejoin, and current FC-member eligibility takes precedence over guest state. |
| AC-09 | A failed/stale refresh retains existing FC-derived access and the successful-snapshot timestamp while reporting degraded state. A validated empty roster follows the same departure confirmation rules as other complete observations. |
| AC-10 | A run records complete Discord member enumeration, scopes work to humans, and reports individual skipped/blocked outcomes while continuing eligible work. Repeated reconciliation applies only necessary managed-role/nickname deltas. |
| AC-11 | Configuration unlink verifies the linked FC ID and works offline. Role replacement/clearing cleans up retired managed roles while preserving unrelated roles. Effects use the current applicable configuration/version. |
| AC-12 | Guest review buttons work after restart and authorize each actor/guild. Simultaneous approve/deny actions resolve to one committed outcome. Concurrent/duplicate applications resolve to one pending record. |
| AC-13 | Applicant departure, promotion to FC membership, deleted review messages, failed role writes, and blocked DMs preserve a correct durable application/grant state with visible delivery outcomes. |
| AC-14 | Primary selection and nickname preferences are deterministic. Manual nicknames and guild-owner/hierarchy limitations are respected. Ownership remains committed if nickname application fails. |
| AC-15 | Simultaneous ledger mutations retain account order, exact nonnegative balances, and one entry per idempotency key. Unknown balances transition through a single concurrency-safe initialization. |
| AC-16 | Notification failure after ledger commit retains one durable entry and retryable delivery. Ambiguous acknowledgements and any duplicate messages remain associated with that same entry. Corrections append signed history. |
| AC-17 | Ledger operations authorize the owning guild/account. Unlink/relink resolves the same guild/FC account; linking a different FC resolves its distinct account and balance. |
| AC-18 | Import verifies the fixture counts, 161 trusted imported links, 36 known opening accounts, four unknown accounts, exact configured-FC balance, Unicode/IDs/nulls, explicit timestamp handling, and separately reported Discord-snapshot additions. |
| AC-19 | Re-running an import is idempotent and retains subsequent application decisions. Import publication is complete or rolled back. Guest-role holders receive explicit imported grants, and primary-character preferences use the specified initialization defaults. |
| AC-20 | Crashes after commit, during roster acquisition, during approval, and during notification delivery resume persisted work with the same committed application decisions, entry identities, and confirmed membership evidence. |
| AC-21 | Lodestone operations obey concurrency/rate/deadline bounds, terminate timed-out underlying work, and keep Discord interaction acknowledgement responsive. Library fixtures cover missing selectors, explicit zero, malformed numbers, 404, maintenance, rate limits, and network exceptions. |
| AC-22 | Docker images build reproducibly, Compose validates, PostgreSQL data survives container recreation, and the bot recovers from database/Discord reconnects. Health probes operate independently of Lodestone acquisition. Graceful shutdown and backup restoration are exercised. |
| AC-23 | The deployed command inventory matches Section 4, and the bot operates with the intents and explicit permissions specified in OPS-12. |

Before production activation, perform a smoke test of command registration, proof/assignment, member/guest transitions, approval, nickname handling, and ledger delivery in a dedicated configured test guild. Automated checks use dedicated test credentials and guild identifiers.

## 14. Implementation deliverables and completion gates

**DEL-01.** Deliver first-party TypeScript source, ESM package/build configuration, a committed lockfile, versioned SQL migrations, the tested data importer, the Nodestone adapter, Discord command registration, background processing, automated tests/fixtures, and the container/operational artifacts described above.

**DEL-02.** Provide a README/runbook covering fresh installation, package-manager dependency installation, environment setup, Discord permissions, development/test-guild operation, migration/cutover, backup/restore, dependency upgrades, and diagnosis/recovery of blocked work.

**DEL-03.** Recommended implementation sequence:

1. Verify installation, ESM import, runtime assets, and the data contract of the selected published Nodestone package.
2. Establish strict project boundaries, PostgreSQL migrations, domain invariants, and configuration validation.
3. Implement verification, character/configuration commands, durable jobs, roster acquisition, and role/nickname reconciliation.
4. Implement durable guest workflows and the transactional ledger.
5. Implement/rehearse migration and grandfathering, then complete container/operational recovery checks.
6. Satisfy the acceptance matrix and review the cutover preview before production effects are enabled.

**DEL-04.** Completion requires passing type checking, lint/format checks, meaningful unit/integration/contract tests, container build/configuration checks, and the documented test-guild/activation verification. A clean build must install dependencies and their required runtime assets from the committed package manifest and lockfile, then compile the first-party source.
