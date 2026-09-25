# TaruBot Requirements

- **Status:** Draft for owner review
- **Prepared:** 2026-09-21
- **Amended:** 2026-09-23 (owner launch decisions; see "Approved launch amendments"); 2026-09-24 (owner reply-session decisions; see "Approved reply-session amendments"); 2026-09-24 (owner hosting decision; see "Approved hosting amendment"); 2026-09-24 (owner Lodestone decisions; see "Approved Lodestone amendments"); 2026-09-24 (owner issue-reporting decisions; see "Approved issue-reporting amendments"); 2026-09-25 (hosting follow-up; see "Approved hosting amendment")
- **Deliverable:** A TypeScript Discord bot for Final Fantasy XIV Free Companies

### Approved implementation amendments (2026-09-21)

The owner requested `/version [commits]` for any guild user. It displays the installed SemVer and the latest requested number of GitHub commit IDs, links, and titles from `deconfined/tarubot`; show ✅ next to an ID only when GitHub confirms its signature is valid and verified. Default to five commits and bound requests to ten. Record versioned development milestones and retain local version output when GitHub is unavailable.

This implementation is a complete rewrite of TaruBot and uses major version **2**. `package.json` defines its current version, with development milestones recorded in `CHANGELOG.md`. Every coherent change set must increment SemVer appropriately: major for incompatible changes, minor for compatible features, and patch for compatible fixes or maintenance, including documentation and tests.

The owner requires a feature-branch/PR/merge delivery workflow. Pull requests run build and test checks; merges to `main` build and publish both TaruBot and Nodestone images to GHCR. Normal Compose deployments pull published images, with explicit source-build overrides retained for development.

The owner requested non-ephemeral output in the development server so other testers can observe the session. `PUBLIC_TEST_RESPONSES` overrides response visibility for the configured test guild, including command/component success and error replies. Operation authorization and other guilds' default presentation policy remain independently enforced.

The owner additionally requested a development startup announcement in `#chat`, containing the current session's actions grouped by human tester, coding assistant, and bot. The owner requested `/setup` to create/reuse Member, Guest, Officer, and FC Leader roles; the Officer role grants bot-only officer-command access. An optional configured in-game FC rank may derive Officer eligibility from accepted roster evidence. Explicit officer grants/revocations and changes to this authority mapping require a server manager with Manage Roles. This is a specific extension of the original rank-mapping scope, not a general arbitrary role-mapping system.

The owner additionally requested automatic separate member-list display for those four configured roles and descending hierarchy **FC Leader → Officer → Member → Guest** in one consecutive block, without unrelated roles interleaved. Setup must reuse existing canonical roles, including unprefixed Member and Guest roles, before creating new ones; it may rename adopted roles while retaining their IDs, permissions, and assignments. Durable layout reconciliation applies this presentation policy at startup, setup, role-configuration changes, role events, and guild refresh, respecting current effect activation, Discord hierarchy, and the guild's role-layout switch (CFG-07).

On 2026-09-22 the owner required ongoing tracking of the latest upstream Nodestone code and CSS selectors, and subsequently required Nodestone as a Git submodule for solution builds. `vendor/nodestone` supplies the parser source through a local dependency; selectors remain an independent Git dependency. A checked update workflow follows both upstream HEADs and advances the submodule pointer, lockfile, and build metadata; deployed images retain exact revision identities and parser-source fingerprints for reproducibility. The sidecar periodically reports upstream freshness so parser dependencies are not silently left on old revisions.

The owner additionally requires modular extension points: command definitions/handlers and gateway event handlers live in separate discoverable modules, loaded dynamically rather than listed in a central dispatch switch. Command deployment and runtime use the same discovered definitions. First-party code, scripts, tests, and supported configuration formats must carry explanatory comments; strict JSON configuration has companion documentation.

The owner approved Bun throughout (package management, tooling, tests, and production runtime), reuse of the existing production Discord application, and interpreting legacy timezone-naïve timestamps as UTC. Runtime versions are pinned in `package.json` and the container definitions. Production first-party code remains compiled ESM with explicit type checking.

The owner subsequently selected a source-built Nodestone Docker sidecar after the published npm package failed its compatibility gate. This supersedes in-process/published-package mandates in Sections 1, 9, 11, 13, and 14. The normal services are now `tarubot`, `nodestone`, and `postgres`; TaruBot accesses Nodestone through a typed HTTP adapter. Nodestone source and selector revisions must be pinned, with any sidecar compatibility changes documented and contract-tested. Lossless IDs, validated completeness, bounded/cancellable upstream work, and all domain invariants remain mandatory.

### Approved launch amendments (2026-09-23)

The owner approved these decisions for the production cutover of guild `1036062273631952955` (linked FC `9232097761132958152`). They supersede conflicting text elsewhere in this document. The referenced numbered requirements carry the normative detail.

**Production hosting.** (Superseded the same day by the "Approved hosting amendment"; the single-writer rule and the authorization rule stand.) Production runs on DigitalOcean App Platform, attached to a separately provisioned DigitalOcean Managed PostgreSQL cluster instead of the inline dev database (DEPLOY-DO-01). Exactly one bot process writes to that database, enforced by a PostgreSQL writer lease (MIG-13). The owner holds the production Discord application `965294750741692416`, whose Server Members intent is enabled. The production application is removed from the development guild `1040379370159743139` before cutover and must not be installed there. Each of the following is a separately authorized operator step: provisioning the cluster, creating or updating the app, changing trusted sources, resetting tokens, and registering production commands. Generating or validating a specification authorizes none of them.

**Production token before the window.** Before the maintenance window, the production token may be used only for read-only REST inspection (OPS-14) and for dress-rehearsal runs (the Discord snapshot, roster acquisition, and preview) against a disposable rehearsal database while the legacy bot is still running. The token is reset at the start of the window, after the legacy process stops (MIG-13).

**Multi-character access (standing rule).** A user may verify, be assigned, or be imported with several characters. Access is the union over the user's active trusted links:
- Any linked character with confirmed membership in the guild's linked FC makes the user a Member.
- Any such character holding the configured FC officer rank gives the Officer role and its bot-only officer authority.
- A user with at least one trusted link and no FC-member character is automatically a Guest.

This registered-user Guest applies in every configured guild, whether or not lobby onboarding (`/setup`, ACCESS-01) is enabled; onboarding governs only channel visibility. A pending `/claim` confers nothing (ROLE-07).

**First-activation grandfathering.** At the first activation of an imported guild, every human then in the server who does not qualify for Member receives a durable `grandfathered` guest grant. It behaves exactly like an approved grant: it lasts until an explicit `/guest revoke`, and FC Member precedence still applies. (Revised on 2026-09-24: `/guest reset` also ends it, as it ends every active grant. A grant that `/guest reset` ended before first activation still counts there as an existing grant, so its holder receives no `grandfathered` grant; see MIG-14.) It is created exactly once, with its own provenance and audit, from a complete Discord enumeration and settled roster evidence (no linked FC character still awaiting departure confirmation), and only for the plan whose checksum the operator confirmed from the read-only preview. Existing approved, manual, and imported grants are not duplicated. Afterwards the normal rules apply: later newcomers receive nothing automatically unless ROLE-07 or an officer decision applies, and humans who joined between the enumeration and go-live are reported for an officer decision (MIG-14).

**Role layout switch.** Managed-role presentation is a per-guild setting (CFG-07). This covers separate member-list display and the consecutive FC Leader → Officer → Member → Guest block. Imported guilds, including the production guild, launch with it off; every other guild, including DevBot's existing guild and guilds first configured by `/setup` or `/config`, has it on. A server manager may change it later.

**Launch configuration.** Guest applications (`/apply`) are closed at launch, and `/apply` refuses with a visitor-facing explanation before its form opens. The importer records but does not apply the legacy review channel (`1196246221682131017`), and first activation never opens applications implicitly. Lobby onboarding stays off: `/setup` is not run in the production guild at launch, because it would also enable onboarding, open `/apply`, and adopt Officer-role holders. (Revised on 2026-09-24: applications now have their own switch, and the importer keeps the legacy review channel with that switch off instead of leaving the channel unset. Applications remain closed at launch; see "Approved reply-session amendments".)

**Officer authority at launch.** Officer authority comes from the in-game rank: `/config officer_rank rank:Officer` maps it, and the legacy Officer role is bound with `/config roles officer role:… adopt_holders:false`, so its current holders receive no manual officer grants. Exceptions use explicit `/officer grant`. Without the option, binding an Officer role keeps its existing behavior of adopting current human holders as audited manual grants; the choice is audited either way, and manager authority is unchanged.

**Deferred guest-application form.** The guest application form and its officer review are deferred until after launch. This covers GUEST-01–GUEST-07, the application-specific parts of GUEST-08 and GUEST-09, AC-12, AC-13, and "approval" in the pre-activation smoke test. The implemented behavior and its automated tests remain; launch does not depend on their live acceptance. Officer `/guest grant`, `/guest revoke`, and `/guest status` remain in launch scope, and so do `/guest reset` and `/officer reset` with everything else the 2026-09-24 amendments add (owner decision, 2026-09-24: "everything we've discussed is in launch scope").

**Pre-launch releases.** The 2.12.3 queue-logging patch, the 2.14.0 reply-presentation release (owner-approved embeds replacing every JSON reply), and the 2.15.0 operational telemetry and officer-alert release (OPS-10, OPS-11) come before go-live. The cutover uses a published release at or above 2.15.0. (Revised on 2026-09-24: 2.15.0 ships the reply-session decisions below, OPS-10 and OPS-11 move to 2.16.0, and the cutover uses a published release at or above 2.16.0.) (Revised again on the evening of 2026-09-24, to launch that day: 2.16.0 ships the deployment safeguards instead, and OPS-10/OPS-11 move to 2.17.0, after launch. The cutover floor stays 2.16.0.)

**Production tooling.** Production maintenance tools run from a build of the deployed release, with an explicitly supplied production environment file and never the development `.env`. They verify deployment identity before any I/O (OPS-14) and leave no guild-scoped commands for the production application (UX-04).

### Approved reply-session amendments (2026-09-24)

The owner made these decisions during the 2.14.0 reply session on DevBot, which compared every reply with the approved mockups. Release 2.15.0 implements them. They supersede conflicting text elsewhere in this document, including the 2026-09-23 amendments above. The referenced numbered requirements carry the normative detail.

**Guest-application switch.** Whether guest applications are open is a per-guild switch, separate from the review channel (CFG-08). The owner's reason: "The channel setting should be separate from whether applications are enabled." `/apply` is open only when the switch is on and both a review channel and a Guest role are set (GUEST-02). `/config guest_applications` takes `enabled:true|false`, `channel:#…`, and `unset_channel:true` in any combination, except a channel together with `unset_channel:true`. Switching applications off refuses only new `/apply` submissions; applications already waiting stay reviewable. `/setup` switches applications on, first validating a kept review channel it is about to open, as switching on with `/config` does.

The importer keeps the legacy review channel (`1196246221682131017`) and stores the switch off (MIG-03). The 2026-09-23 rule that the legacy review channel must not open `/apply` is therefore enforced by the switch, no longer by leaving the channel unset. Reopening after launch is `/config guest_applications enabled:true`. Activation still never opens applications implicitly. `activate.js --guest-applications open|closed` sets the switch and keeps the channel; without the flag, the switch keeps its imported value (off). Guest applications stay closed at launch, lobby onboarding stays off, and the 2026-09-23 deferral of the application form is unchanged.

**No implied change.** A reply never implies a change that did not happen (UX-02). The owner's words: "Don't imply a change where no change occurred." `/main` naming the current main character, and `/nickname` turning sync on or off when it already is, save nothing, queue no reconciliation, and reply that nothing changed. Resuming nickname sync that a manual nickname suspended is still a change. `/config officer_rank` naming the saved rank, or `unset_rank:true` when no rank is set, likewise replies that nothing changed and advances no configuration revision, audits nothing, and queues no repair pass.

**An example for every option.** Every input failure that names an option shows an example of a valid value for it, and every option of every registered command has one (UX-05). The owner's words: "If there's a parameter to input, it should provide an example."

**Ledger entry number or ID.** `/ledger adjust entry:` accepts the entry number that history, receipts, and posts show (`5` or `#5`, resolved in the current FC account) or the entry ID (LEDGER-07). The owner's words: "Allow it to accept the integer, or the UUID. It's obvious which one is provided."

**Member suggestions.** Every member option autocompletes server members. A pasted user ID or mention is still accepted, so a user who has left stays nameable by ID (UX-06).

**Main character after a re-link.** A new trusted link becomes the member's main character when they have no main and no other active link, for example after removing every link. Unlike a first link, it keeps their nickname-sync setting. Imported users keep their imported state (NICK-01, NICK-06).

**Server owner's nickname.** Discord lets no bot change the server owner's nickname. Reconciliation skips the owner's nickname instead of leaving blocked work that no officer can fix (NICK-05).

**"Unset", not "clear".** No `/config` option is named `clear`. The owner's reason: "Clear sounds like you're erasing the channel's history." Channel settings use `unset_channel:true` (`/config ledger`, `officer_notifications`, and `guest_applications`), role settings use `unset_role:true` (`/config roles …`), and the officer rank uses `unset_rank:true` (`/config officer_rank`). Unsetting stops TaruBot using the channel, role, or rank; the Discord channel or role and its history stay.

**Reset commands.** `/officer` and `/guest` gain a third option beside grant and revoke, one that "removes any override and goes back to membership/rank logic":
- `/officer reset member reason` removes the member's officer grant or revocation, so the configured in-game rank decides again (ROLE-07). Like a grant or revocation, it needs a server manager, whose highest role must be above a bound Officer role (AUTH-03). Like a revocation, it works for someone who has left.
- `/guest reset member reason` lifts a Guest revocation and ends every active grant of any provenance (approved, manual, imported, grandfathered), so FC membership (current or former) and registered characters decide Guest again (ROLE-02, GUEST-08). Ended grants are kept as history and never confer Guest.

Both are audited and reconcile the member. With nothing to remove, they change nothing and audit nothing. They bring the command surface to 19 roots and 43 paths (AC-23).

**Release order.** 2.15.0 ships these decisions with migration `006_guest_application_switch.sql`. The operational telemetry and officer-alert release (OPS-10, OPS-11) moves from 2.15.0 to 2.16.0, and the cutover uses a published release at or above 2.16.0. **Launch-day revision (owner decision, 2026-09-24):** to go live that day, 2.16.0 ships the deployment safeguards of the approved deploy-workflow proposal (a migration guard that takes the writer lease for pending migrations, a schema re-check once a bot holds the lease, and the stale-command card for undeclared subcommands and options), OPS-10/OPS-11 follow in 2.17.0 after launch, and the cutover floor stays 2.16.0. Option names, descriptions, and autocomplete changed, so commands are registered again after 2.15.0 is deployed (UX-04).

### Approved hosting amendment (2026-09-24)

The cutover went live on App Platform, and then every profile refresh failed there. The Lodestone answers DigitalOcean's addresses with HTTP 403, so Nodestone on App Platform could not refresh profiles, verify claims or read rosters. The owner chose to move production that evening rather than proxy its traffic. This amendment supersedes the "Production hosting" launch amendment and DEPLOY-DO-01 as the production target.

**Production host.** Production runs on a Linode Docker host with `docker-compose.production.yml`: the published GHCR bot and Nodestone images, pinned to one release, with no bundled database. It is attached to the owner-provisioned Linode managed PostgreSQL cluster `tarubot-pgsql` (PostgreSQL 18, database and user `tarubot`) over verified TLS on its direct port. Connection pools are never used. The single-writer lease (MIG-13), the production tool profile, and the rule that every provider, token and registration change is a separately authorized owner step all stand unchanged. Updates are a `git pull`, a pinned image tag, and Compose. A release with a migration stops the bot first and takes an independent backup ([docs/HOSTING.md](docs/HOSTING.md)).

**Follow-up (owner decision, 2026-09-25).** The owner asked whether App Platform for the bot and database, with Nodestone elsewhere behind an API key, would be more robust. Nodestone's outgoing address is a single point either way, and the split would add a public, authenticated endpoint and a second provider, so the owner kept production on the Linode host and asked that it be made robust and disposable:
- rebuildable from Git and an encrypted copy of `.env` kept off the host, with a rebuild runbook;
- alerting from outside the host: the issue reporter, plus a heartbeat that notices a silent host;
- a deploy workflow over SSH from GitHub Actions;
- confirmed managed-database backup retention and point-in-time recovery, with scheduled off-site encrypted dumps.

**App Platform.** The App Platform spec, its phases and their CI validation stay in the repository as the record and as a fallback, in case DigitalOcean's addresses are admitted again. DEPLOY-DO-01 remains satisfied, but it no longer describes production. The approved GitHub deploy-workflow proposal targeted App Platform. It is on hold until it is re-planned for the Compose host.

### Approved Lodestone amendments (2026-09-24)

After the move to Linode, `/sync status` filled with failed profile refreshes, and several failures were for the same character. The investigation found that the scheduler retried failing profiles about every 30 seconds, which deepened the Lodestone's rate limiting; that a deleted character's 404 was retried like an outage; and that a private profile was reported as the Lodestone being down. The owner asked that a character the Lodestone no longer has be unclaimed automatically ("if a character ID isn't found, we should force unclaim/delete it") and decided to "require two 404s before unlinking, just in case". Release 2.17.0 implements these decisions. They refine SYNC-03, NODE-08 and NODE-10.

**Deleted characters (the two-404 rule).** When the Lodestone answers "not found" for a linked character's profile refresh, TaruBot records that first 404 and changes nothing else. A second 404 at least one hour later ends every active link to the character, in every guild:
- each unlink is audited as automatic, with no human actor;
- the owner is reconciled: a main character is cleared for a nickname restore, and access is recomputed from the remaining links and grants;
- officers get a notice naming the character and the owner.

Any sighting in between voids the first 404: a profile read, a private profile, or a roster listing. History is kept: the character row and the ended link remain.

**Private profiles.** The Lodestone answers a private character profile with its own "Access Restricted" page (HTTP 403). That is an answer about the character, not an outage. Links stay, and the refresh waits for the normal profile interval instead of retrying. An interactive command that reads the profile says it is private and asks for it to be made public. An edge or firewall block, such as DigitalOcean's, is still an outage.

**Throttling.** After a Lodestone 429, the sidecar refuses every start for one shared cooldown instead of letting each queued request reach the Lodestone. The cooldown is 15 seconds, doubles on each consecutive 429 up to 5 minutes, and gives way to a longer Retry-After of up to 15 minutes. A rate-limited job waits out the cooldown without spending an attempt. A throttled roster crawl is recorded for `/sync status` but sends officers no "degraded" notice. The sidecar's own full capacity is reported as `busy`, not as Lodestone throttling.

**Refresh pacing.** Scheduled profile refreshes of one character are at least an hour apart, whatever the outcome. Periodic scheduling never pulls a job that is backing off forward, and a startup catch-up is spread over a minute.

**Release order.** 2.17.0 ships these decisions with migration `007_profile_checks.sql`. The GitHub issue reporter and `/issue` follow in 2.18.0, then OPS-10/OPS-11.

### Approved issue-reporting amendments (2026-09-24)

The owner asked for "an 'unexpected behavior handler' that will auto-open a GitHub issue when something goes wonky, and include as much context as possible", and for "an /issue command … that accepts a user comment, same data state collection". Their answers set the policy below. Release 2.18.0 implements it with migration `008_issue_reports.sql`.

**Where reports go.** Reports open issues in the private repository `deconfined/tarubot-reports` (`GITHUB_REPORTS_REPO`). They use a fine-grained token limited to that repository's issues (`GITHUB_REPORTS_TOKEN`), which the running bot holds. Maintenance tools never do. Each issue is labelled `tarubot-report`, `source:…` and `env:production|devbot`, and its title starts with the environment.

**/issue.** Every member can report a problem in their own words. There is one report per member per 10 minutes, and at most 20 per server in any 24 hours; each refusal says when to try again. The reply says what the report carries. The member's text goes into the issue as a fenced block, so it can't @mention anyone on GitHub.

**Automatic reports.** Three kinds of trouble open issues:
- unexpected errors: every error-level report from interactions, events, the lifecycle and the queue worker;
- jobs that end failed at error level;
- repeated trouble: a linked FC's roster not accepted for 12 hours, or no Lodestone answer for an hour.

Each is grouped by a fingerprint of what failed and where, so the same trouble is one issue:
- repeats are counted, and a comment posts the count at most hourly;
- a repeat after the issue was closed opens a new issue that refers back to it;
- each day allows at most 10 new automatic issues and 50 comments.

The issue reporter never reports its own delivery failures.

**Context.** Each report carries, as far as each read succeeds:
- the deployment and version;
- readiness;
- the Lodestone's reachability and the sidecar's health;
- the queue's active work and recent failures;
- the server's TaruBot settings and FC roster state;
- for `/issue` and member-scoped work, the member's links, main, nickname state, guest and officer standing, recent work and audit;
- the newest log records.

Known secret shapes and the deployment's own secret values are removed from everything before it is stored.

**Durability.** A report is saved in PostgreSQL first and delivered by a job, so a GitHub outage loses nothing. Without a token, reports are saved and `/issue` says so. They are sent once a token is configured.

**Command surface.** `/issue` brings the command surface to 20 roots and 44 paths (AC-23). It must be registered after the deployment.

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
| Registered users without an FC character | Automatically Guest while at least one trusted link exists and no linked character is a confirmed FC member (ROLE-07) |
| Humans present at an imported guild's first activation who do not qualify for Member | Durable `grandfathered` guest grants, created once (MIG-14) |
| Other newcomers | An audited officer grant; approved applications once guest applications are switched on after launch (CFG-08) |
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
| Not an FC member; active approved, manual, imported, or grandfathered guest grant; guest access not revoked | Absent | Present |
| Not an FC member; confirmed former member of the currently linked FC; guest access not revoked | Absent | Present |
| Not an FC member; at least one active trusted link, every linked character confirmed outside the currently linked FC by accepted current evidence (or no FC linked); guest access not revoked | Absent | Present |
| Confirmed ineligible for both | Absent | Absent |
| FC membership uncertain | Preserve existing FC-derived access; new grants await fresh evidence | Preserve guest state, subject to explicit local grants/revocations and member-role precedence |

**ROLE-02.** Guest revocation overrides approved, manual, imported, and grandfathered grants, registered-user eligibility (ROLE-07), and former-member guest eligibility until an officer explicitly restores access. FC-member eligibility is evaluated independently and takes precedence. Persist and audit both revocation and restoration; restoring through an explicit grant creates a durable manual grant. `/guest reset` restores the automatic rules instead: it lifts the revocation without creating a grant and ends every active approved, manual, imported, and grandfathered grant, so FC membership (current or former) and registered-user eligibility (ROLE-07) decide Guest again (GUEST-08).

**ROLE-03.** A confirmed former member becomes a guest automatically. Unlinking a user's last qualifying character is an explicit local loss of member eligibility and may result in former-member guest access. Roster-driven former-member status requires the departure evidence defined in Section 6.

**ROLE-04.** Automatic character-based role and nickname reconciliation applies to human guild members. Retain a departing user's links, history, ledger attribution, and guest grants. Rejoining triggers reconciliation using current configuration and observations.

**ROLE-05.** The configured member and guest roles are authoritative bot-managed access roles for human users, including when someone assigns them manually. Reconcile these roles from persisted policy state. Apply individual role deltas limited to current or explicitly retired bot-managed role IDs, preserving every unrelated role.

**ROLE-06.** During a refresh failure, retain the last confirmed FC-derived access state. Explicit local actions, such as guest revocation or character unlink, remain available when their result can be established entirely from PostgreSQL state.

**ROLE-07.** Evaluate each user's access as the union over their active trusted links in the guild. Imported, officer-assigned, and profile-verified links participate equally; profile FC hints and pending challenges never do.
(1) **Member:** at least one linked character has confirmed membership in the currently linked FC. A character awaiting departure confirmation still qualifies (SYNC-10).
(2) **Officer:** when an Officer role and FC officer rank are configured, at least one linked character with confirmed membership holds that normalized rank in accepted roster evidence. An assignment made by a bot-only officer does not confer it, and explicit manager grants/revocations override the automatic result until `/officer reset` removes the override.
(3) **Guest (registered user):** the user has at least one active trusted link, and no linked character qualifies under (1) according to accepted current evidence. With no FC linked, one active trusted link suffices. This applies in every configured guild regardless of lobby onboarding.
Unknown or stale evidence, including a linked character not yet evaluated against an accepted roster, preserves a role already held but cannot create a new Member, Officer, or registered-user Guest role. Registered-user Guest is derived, not stored: removing the last active link removes that basis, while approved, manual, imported, and grandfathered grants and former-member eligibility keep their own rules. Revocation (ROLE-02) suppresses it, and Member precedence (ROLE-01) always applies. Onboarding (ACCESS-01–ACCESS-05) never changes which access roles a user receives.

## 4. Discord command contract

All commands are guild-only. Unless expressly identified as a channel notification, responses are ephemeral. Commands that require network or database work must acknowledge or defer before Discord's initial response deadline, normally within three seconds. Every `member` option suggests server members as the user types and also accepts a pasted user ID or mention (UX-06).

### 4.1 Authorization definitions

- **Guild user:** a current non-bot member of the invoking guild.
- **Officer:** a guild user with effective `ManageGuild` permission, including the guild owner/administrator through Discord's effective permissions.
- **Ledger member:** a guild user with confirmed FC-member eligibility; an officer may also perform these operations.
- **Self:** the invoking user within the invoking guild.

**AUTH-01.** Enforce permissions in the application operation as well as at the Discord command boundary. Every subcommand, autocomplete that reveals private records, and button interaction must enforce its own applicable authorization and guild scope.

**AUTH-02.** Use Discord command default permissions to control command availability and runtime authorization to enforce each operation's policy. Evaluate mixed-permission subcommands and `force` options explicitly. Every `force: true` request requires officer authorization regardless of cache freshness.

**AUTH-03.** Selecting or unsetting managed roles additionally requires effective `ManageRoles`. Selected roles must be below the actor's highest role unless the actor is the guild owner, and must always be manageable by the bot. Validate member/guest roles as access roles with `Administrator`, `ManageGuild`, and `ManageRoles` permissions disabled.

### 4.2 Configuration commands

| Command | Access | Contract |
| --- | --- | --- |
| `/config fc link fc_id` | Officer | Validate the FC, link it to this guild, and enqueue initial synchronization. An identical existing link is a no-op; a different existing link requires explicit unlinking first. |
| `/config fc unlink fc_id` | Officer | Require the supplied ID to match the currently linked FC. Remove that link locally without requiring Lodestone availability. |
| `/config roles member [role] [unset_role]` | Officer + role authorization | Set or unset the member-role configuration. |
| `/config roles guest [role] [unset_role]` | Officer + role authorization | Set or unset the guest-role configuration. |
| `/config roles officer [role] [unset_role] [adopt_holders]` | Server manager (Manage Server and Manage Roles) + role authorization | Set or unset the bot-only Officer role (approved staff-rank amendment). Binding a role grants its current human holders audited manual officer grants unless `adopt_holders:false`; the choice is audited. |
| `/config roles leader [role] [unset_role]` | Server manager (Manage Server and Manage Roles) + role authorization | Set or unset the FC Leader role. |
| `/config officer_rank [rank] [unset_rank]` | Server manager (Manage Server and Manage Roles) | Set the in-game FC rank that grants bot officer authority (ROLE-07), or unset it so that only manual officer grants apply. Naming the saved rank, or unsetting when no rank is set, changes nothing and says so (UX-02). |
| `/config ledger [channel] [unset_channel]` | Officer | Set or unset the ledger notification channel. |
| `/config officer_notifications [channel] [unset_channel]` | Officer | Set or unset the operational/officer notification channel. |
| `/config guest_applications [enabled] [channel] [unset_channel]` | Officer | Switch guest applications on or off, and set or unset their review channel, in one audited revision (CFG-08). Switching on validates the review channel that will take applications; switching off keeps waiting applications reviewable. |
| `/config role_layout enabled` | Server manager (Manage Server and Manage Roles; AUTH-03 hierarchy checks when enabling) | Turn automatic managed-role display and ordering on or off for this guild (CFG-07). Off never changes any role's hoist flag or position; enabling queues one layout pass. |
| `/config show` | Officer | Display configuration, enabled/blocked capabilities, linked FC, and relevant freshness/status information. |
| `/config validate` | Officer | Check stored roles/channels, current bot permissions/hierarchy, and configuration consistency without mutating access. |
| `/setup [fc_id] [prefix] [officer_rank] [lobby] [officers]` | Server manager (Manage Server, Manage Roles, and Manage Channels) | Create or reuse the four access roles and the lobby and officer rooms, and enable onboarding (ACCESS-01). It also switches guest applications on, using the officer room as the review channel when none is set (CFG-08), and adopts the Officer role's current holders. Not run in the production guild at launch. |
| `/officer grant member reason` | Server manager (Manage Server and Manage Roles; AUTH-03 hierarchy checks on the bound Officer role, if any) | Record an audited officer grant for a current member, overriding the rank-derived result (ROLE-07). Works before an Officer role is bound. |
| `/officer revoke member reason` | Server manager (Manage Server and Manage Roles; AUTH-03 hierarchy checks on the bound Officer role, if any) | Record an audited officer revocation, overriding the rank-derived result; works for a user who has left. |
| `/officer reset member reason` | Server manager (Manage Server and Manage Roles; AUTH-03 hierarchy checks on the bound Officer role, if any) | Remove the member's officer grant or revocation, so the configured in-game rank decides again (with no rank set, only manual officer grants confer officer authority); works for a user who has left. Audited; with no override to remove, nothing changes. |

For the set/unset commands (`/config roles …`, `/config ledger`, `/config officer_notifications`, and `/config officer_rank`), require exactly one of a value or the command's unset option (`unset_role:true`, `unset_channel:true`, or `unset_rank:true`). `/config guest_applications` requires at least one of `enabled`, `channel`, and `unset_channel`, and refuses `channel` together with `unset_channel`. No `/config` option is named `clear` (2026-09-24 amendment). Unsetting stops TaruBot using the channel, role, or rank and deletes no Discord channel or role; an unset managed role is still removed from its holders by the retired-role cleanup (CFG-04). Validation failures retain the saved configuration and return a corrective instruction.

**CFG-01.** IDs or canonical Lodestone URLs may identify an FC. Extract the ID from an allowed Lodestone host and the expected FC path, validate it, and resolve it through the configured Nodestone adapter.

**CFG-02.** Roles must be distinct, existing, assignable guild roles; exclude `@everyone`, integration-managed roles, and the bot's own role from selection. Channels must be guild text channels belonging to the guild and supporting the required messages/embeds.

**CFG-03.** Check required bot permissions and hierarchy before saving configuration. Recheck them before effects because permissions and role positions can change later. A deleted/misconfigured resource must block only affected operations and produce an actionable diagnostic.

**CFG-04.** Persist configuration revisions. Configuration changes must enqueue reconciliation. Superseded managed roles require durable cleanup of the retired role IDs; preserve unrelated roles. Unsetting a role stops its future assignment and schedules its cleanup.

**CFG-05.** Unlinking an FC removes FC-derived member access and the automatic former-member eligibility associated with that link. With no FC linked, every user with an active trusted link qualifies as a registered Guest under ROLE-07, subject to revocation. Explicit approved, manual, imported, and grandfathered guest grants remain guild-scoped and continue to apply. Record unlinking as a configuration event, retaining existing membership history.

**CFG-06.** Preserve character links, historical membership, ledger accounts/entries, and audit records when unlinking an FC. Relinking the same FC reuses its history and ledger account. Linking a different FC resolves that FC's separate guild-scoped account.

**CFG-07.** Persist a per-guild role-layout switch. When it is on, TaruBot keeps the configured managed roles displayed separately and in one consecutive FC Leader → Officer → Member → Guest block (see the 2026-09-21 amendment). When it is off, TaruBot MUST NOT change any role's display (hoist) or position: layout work completes as skipped; startup, rejoin, role events, configuration, and refresh schedule no layout work; and roles created by `/setup` keep Discord's default display. Role assignment is unaffected.
Starting values: guilds created by the legacy import start with the switch off. Every other guild starts with it on, including guilds first created by `/setup` or `/config` and guilds managed live before migration 005. `/setup` never changes the switch.
`/config role_layout enabled:<true|false>` requires a server manager with Manage Server and Manage Roles, plus AUTH-03 hierarchy checks for each managed role when enabling. A change is audited and advances the configuration revision; repeating the current value changes nothing. Enabling queues one layout pass. Disabling leaves the current display and order unchanged, and a pass already running stops before its next write. The read-only cutover preview reports the switch and the hoist/position changes that enabling it would make.

**CFG-08.** Persist a per-guild guest-application switch, separate from the review channel (2026-09-24 amendment). Guest applications are open only when the switch is on and both a review channel and a Guest role are configured; `/apply`'s pre-form check, submission, activation, and the read-only preview use this one rule (GUEST-02).
`/config guest_applications` takes `enabled:true|false`, `channel:#…`, and `unset_channel:true` in any combination, except a channel together with `unset_channel:true`. It saves them in one configuration revision, audits each changed setting, and enqueues reconciliation like other configuration changes. A request that matches the saved state changes nothing and says so. Before saving, it validates any channel named in the request and, when the request switches applications on, the stored review channel that will then take them, including a legacy channel the import kept (CFG-02). A request that only switches applications off or unsets the channel validates nothing, so a deleted channel never blocks closing. If the saved settings change between that validation and the save, so that applications would take a channel that was not validated, nothing is saved and the reply asks the officer to run the command again. Switching on without a review channel or Guest role saves the switch but leaves `/apply` closed. Switching off refuses only new `/apply` submissions; applications already waiting stay reviewable (GUEST-04).
Starting values: migration 006 turned the switch on for guilds that already had a review channel and were not awaiting first activation, and off everywhere else. A guild created later starts with it off. `/setup` turns it on (ACCESS-01). The legacy import keeps the legacy review channel with the switch off (MIG-03). Activation changes the switch only on an explicit choice (`open` requires a configured review channel), keeps the channel either way, and validates the review channel only when applications will be open. `/config show` reports the switch together with the review channel it keeps, and `/config validate` reports a review-channel check only while applications are on.

### 4.3 Character commands

| Command | Access | Contract |
| --- | --- | --- |
| `/claim [character] [forename] [surname] [world]` | Self | Resolve a character and create a pending profile-token verification challenge. |
| `/verify character` | Self | Verify the caller's pending challenge for this character. A persistent verification button may invoke the same operation. |
| `/unclaim character` | Self | Remove the caller's active local link using stored identity, without depending on Lodestone availability. |
| `/assign member reason [character] [forename] [surname] [world]` | Officer | Make an audited, trusted manual assignment to a current non-bot guild member. |
| `/unassign member character reason` | Officer | Remove that user's local character link. Stored owner IDs must remain usable after the user leaves Discord. |
| `/characters [member]` | Self; officer for another user | List local links, provenance/status, canonical names/worlds, primary character, and known FC information. |
| `/main character` | Self | Select an active trusted linked character as the guild-specific primary character. Naming the current primary character changes nothing and says so. |
| `/nickname enabled` | Self | Enable or disable bot-managed character nicknames for this guild. Repeating the current setting changes nothing and says so; resuming management that a manual nickname suspended is a change. |

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
| `/apply` | Guild user | Submit a guest application when applications are open in this guild (the guest-application switch is on and a review channel and Guest role are configured; CFG-08) and the user has no active trusted link, lacks member/guest access, and has no pending application; otherwise explain why. While applications are closed, refuse before the form opens. Closed at launch (see Approved launch amendments). |
| `/guest approve application` | Officer | Approve a pending application through the same operation used by its review button. |
| `/guest deny application [reason]` | Officer | Deny a pending application through the same operation used by its review button. |
| `/guest grant member reason` | Officer | Grant guest access manually, with an audit record; can explicitly restore revoked guest access. |
| `/guest revoke member reason` | Officer | Persistently revoke guest eligibility and cancel unresolved applications for that user. |
| `/guest reset member reason` | Officer | Lift the user's guest revocation and end every active guest grant of any provenance, keeping the ended grants as history, so the automatic rules decide Guest again (ROLE-02). Audited; with nothing to remove, nothing changes. |
| `/guest status [member]` | Self; officer for another user | Show application, grant, revocation, and automatic-guest status within this guild. |
| `/ledger deposit amount note` | Ledger member | Record a positive deposit. |
| `/ledger withdraw amount note` | Officer | Record a positive withdrawal if sufficient recorded funds exist. |
| `/ledger balance [fc_id]` | Ledger member; officer for historical FC | Show the initialized/unknown balance and relevant delivery status. |
| `/ledger history [fc_id] [before]` | Ledger member; officer for historical FC | Paginate durable entries using a stable cursor. |
| `/ledger initialize balance note` | Officer | Set the opening balance of an uninitialized current guild/FC ledger exactly once. |
| `/ledger adjust balance note [entry]` | Officer | Append a correction bringing the recorded balance to the specified value; optionally reference the corrected entry by its entry number (`5` or `#5`) or its entry ID (LEDGER-07). |
| `/ping` | Guild user | Report Discord gateway latency with an appropriate label. |
| `/channel` | Guild user | Report the current channel's ID, name, and type. |
| `/version [commits]` | Guild user | Show the installed SemVer and recent GitHub commit IDs, links, titles, and verified-signature badges. |

**UX-01.** Bound input sizes and honor Discord message, embed, autocomplete, and component limits. Escape user-controlled display content and set an explicit allowed-mentions policy, defaulting to no parsed mentions. Authorize any intended recipient mention separately from user-supplied text.

**UX-02.** Distinguish committed application state from pending Discord effects. Long jobs must remain inspectable after an interaction token expires. Use completion wording only for confirmed successful effects, and queued/blocked wording for work awaiting delivery. Never imply a change that did not occur: a request that matches the saved state gets a reply saying that nothing changed, never a change receipt (2026-09-24 amendment). Examples include `/main` naming the current main character, `/nickname` repeating its setting, `/config officer_rank` naming the saved rank (or `unset_rank:true` with none set), `/config guest_applications` or `/config role_layout` matching the saved state, and `/officer reset` or `/guest reset` with nothing to remove.

**UX-03.** Represent an unconfigured guild explicitly and return setup instructions. Read-only commands use read-only persistence operations; configuration is created through authorized configuration commands.

**UX-04.** Register the declared command set through an explicit deployment operation. Support guild-scoped registration for development and intended production registration. Reconcile the bot's registered commands to exactly the command set defined in Section 4. Production registers the declared set in global scope and leaves no guild-scoped commands for the production application. Command maintenance tooling reads back every scope. It clears leftover guild-scoped commands in a named guild only after a dry run and a fingerprint-bound confirmation, and never clears the global scope.

**UX-05.** An input failure caused by an option's value names that option and shows an example of a valid value for it. An input failure that no option value caused names no option and shows no example, which would only repeat the failed command: `/nickname enabled:true` without a main character names `/main` as the step to take instead. Every option of every registered command path has an example, including ID options such as `/ledger adjust entry`, `/sync status run_id`, and `/guest approve|deny application`; automated checks fail on any option without one (2026-09-24 amendment).

**UX-06.** Every member option autocompletes current human server members by display name, username, global name, or nickname, with the user ID as the submitted value. This covers `/characters`, `/assign`, `/unassign`, `/guest status|grant|revoke|reset`, and `/officer grant|revoke|reset`. A pasted user ID or mention is still accepted, so a user who has left the server stays nameable by ID (CHAR-03). Where a member may name only themselves, they are offered only themselves. Suggestions grant nothing: each operation still authorizes its actor and target (AUTH-01) (2026-09-24 amendment).

## 5. Character verification and nickname behavior

### 5.1 Verification protocol

**VERIFY-01.** Generate at least 128 bits of cryptographic randomness for each challenge. Bind it to the guild, Discord user, character ID, issuance time, and expiry. The default lifetime is 30 minutes. A replacement challenge invalidates the previous challenge for that same tuple.

**VERIFY-02.** Present an exact token and instructions for placing it in the character's public Lodestone biography. Verification succeeds when a fresh profile obtained through Nodestone for the bound character ID contains that exact token and the stored challenge remains valid.

**VERIFY-03.** Persist the token hash, retaining plaintext only for its ephemeral presentation and in-memory comparison. Redact tokens, full biographies, and interaction credentials from logs. An unexpired challenge remains usable across a process restart. Authorize every verification component against its stored challenge.

**VERIFY-04.** Challenge completion must atomically check expiry/consumption and tuple binding, enforce ownership uniqueness, create the trusted link, and consume the challenge. Concurrent attempts resolve to one committed ownership decision and a deterministic result for every other attempt.

**VERIFY-05.** Keep pending challenges separate from trusted ownership and its role/nickname effects. Several users may attempt proof of an available character; only successful challenge completion establishes ownership. Bound pending-request volume per user and globally. Retain retryable challenge state after a network failure until expiry.

**VERIFY-06.** Account for Lodestone publication delay. Show pending/not-yet-visible status and permit bounded retries until expiry. Verification must fetch a fresh profile independently of the application profile cache. Existing trusted links remain durable during profile unavailability.

### 5.2 Nicknames

**NICK-01.** Store primary-character selection and nickname preferences per `(guild, user)`. For a new user with no prior links, the first successfully trusted link becomes the initial primary character and enables nickname management. Thereafter the selection changes through `/main` or removal of the selected link. A new trusted link also becomes the primary character when the user has no primary character and no other active link, for example after removing every link; it keeps the user's nickname-management setting. With management on, the new primary character's nickname replaces a restore still pending from removing the previous primary (NICK-04), as `/main` does; with management off, that restore stands. Imported users keep their imported state (NICK-06).

**NICK-02.** The generated nickname is the canonical full character name. Format it within Discord's nickname length limits using Unicode-safe truncation when necessary, and retain the complete canonical name in PostgreSQL.

**NICK-03.** Track the pre-management nickname and the last nickname successfully written by the bot. An independent nickname change suspends automatic nickname management for that user. Explicit re-enablement establishes a new management baseline.

**NICK-04.** Disabling management or unlinking the primary character restores the saved pre-management nickname when the current nickname still matches the last bot-written value. Otherwise retain the current nickname. Unlinking the primary clears the selection and returns instructions for selecting another character.

**NICK-05.** Renames/world changes must update cached identity attributes. A managed nickname follows a confirmed primary-character name update. Report bot permission/hierarchy limitations as scoped blocked effects while retaining the character link. Discord lets no bot change the guild owner's nickname, so reconciliation never writes or restores it, drops any pending nickname write or restore for the owner, and never blocks on it; replies to the owner say so instead of promising a nickname change (2026-09-24 amendment).

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

**GUEST-02.** `/apply` requires the guest-application switch to be on and a valid guest role and review channel (CFG-08). Persist the application and its review-message work together. The review message identifies the applicant, submission time, and application ID and provides approval/denial controls. Return the pending application for duplicate requests, or explain existing member/guest eligibility. An unregistered newcomer gains guest eligibility through an explicit officer grant or, while applications are open, approval. A user with an active trusted link receives it through ROLE-07 and is directed away from `/apply`. When applications are closed (switched off, or without a review channel or Guest role), `/apply` refuses with a visitor-facing explanation before its form opens, and again if a form opened earlier is submitted.

**GUEST-03.** Support `pending`, `approved`, `denied`, `cancelled`, and `superseded` application outcomes. Approval/denial must atomically transition only a pending application. Concurrent/repeated decisions return the single committed outcome.

**GUEST-04.** Review buttons must resolve durable application identifiers from PostgreSQL and work after restarts. Validate guild, application/message identity, actor permissions, and current applicant state on every click before invoking the authorized decision operation. Switching applications off (CFG-08) refuses only new submissions; pending applications stay reviewable through their review controls and `/guest approve|deny`.

**GUEST-05.** At decision time, cancel a pending application if the applicant has left or its guild-join context is obsolete. Supersede a pending application if the applicant became an FC member. Retain committed decisions as audit outcomes; effect execution independently rechecks current membership and applies the role precedence in ROLE-01.

**GUEST-06.** Approval creates a durable guest grant and reconciliation work in one transaction. Queue a best-effort DM for approval/denial identifying the guild and outcome, with the decision reason when supplied. Track application outcome, grant state, role-delivery status, and DM-delivery status separately. Retain the decision during delivery failures and expose failed role delivery as retryable or blocked work; `/guest status` provides the applicant's durable outcome.

**GUEST-07.** Retain review history in PostgreSQL, update the review message with its outcome, and disable completed controls. Recreate a missing review message or handle the application through its command ID. Message repair operates from the durable application record.

**GUEST-08.** Persist approved, manual, imported, and grandfathered grants with provenance. Guest revocation must be durable and auditable. An officer's subsequent explicit approval/grant may restore access. Denied applicants may reapply after a configurable cooldown, defaulting to 24 hours. Any existing revocation remains effective until explicit restoration or `/guest reset`. `/guest reset` ends grants instead of deleting them: an ended grant records when, by whom, and why it ended, confers nothing, and no longer appears in `/guest status`. First-activation grandfathering still counts it as an existing grant, so its holder receives no `grandfathered` grant (MIG-14).

**GUEST-09.** Approved/manual/imported/grandfathered grants survive the user's departure from Discord and can apply on rejoin unless revoked or ended by `/guest reset`. Cancel pending applications on an observed departure and require a matching stored guild-join context at decision time. On rejoin, evaluate existing grants and history under current policy.

## 8. Gil ledger

**LEDGER-01.** A ledger account belongs to `(guild, FC)`. Its account ID remains stable when that guild temporarily unlinks/relinks the FC. Guilds observing the same FC have distinct, independently authorized ledger accounts.

**LEDGER-02.** An account is either uninitialized or has an exact, nonnegative balance. New accounts and imported unknown balances require explicit initialization. A known zero balance is initialized state. Enforce a single initialization per account, including under concurrent requests.

**LEDGER-03.** Accept deposits and withdrawals from 1 through 999,999,999 gil. Use Discord integer options for this bounded range and convert to exact arithmetic at the boundary. Initialization and target-balance adjustments accept validated decimal strings sufficient for PostgreSQL `bigint` range.

**LEDGER-04.** Record immutable entries containing account, monotonically ordered account sequence, operation type, signed delta, resulting balance, actor, source guild, note, timestamp, originating interaction/idempotency key, and optional correction reference. Opening entries may have zero delta; deposits and withdrawals have strictly positive input amounts and appropriately signed deltas.

**LEDGER-05.** Notes are required for mutations: trim surrounding whitespace and require 1 through 1,000 UTF-16 code units, with Discord presentation limits also validated. Store the complete accepted note and render it under the allowed-mentions policy. Deposits require ledger-member authorization; withdrawals, initialization, and adjustments require officer authorization.

**LEDGER-06.** In one PostgreSQL transaction, enforce the idempotency key, lock/serialize the account, validate initialization/range/funds, insert the entry, update the balance, and enqueue its notification. Competing withdrawals are evaluated in account order against the resulting available balance, retaining the nonnegative-balance invariant.

**LEDGER-07.** Record corrections as additional signed entries referencing immutable history. `/ledger adjust` records the difference between the current and supplied target balance with an explanation. An identical target is a no-op. A referenced prior entry must belong to the same account. An officer names it by entry number (`5` or `#5`) or entry ID; a number resolves within the current account, and a number or ID that is not in that account is refused as not found.

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

**ACCESS-01.** Explicit `/setup` enables a persisted guild-scoped channel policy and provisions/reuses distinct lobby and officer text rooms alongside the four access roles. Require current Manage Server, Manage Roles, and Manage Channels for setup. Existing guilds remain opted out until that action; enforce the bot's channel and role capabilities before mutation. `/setup` also switches guest applications on, using the officer room as the review channel when none is set (CFG-08).

**ACCESS-02.** Role-less newcomers see the lobby; ordinary Members/Guests see ordinary channels and not the lobby. Officers and FC Leaders see the lobby, ordinary channels, and staff areas. Preserve existing private areas as staff-only. Apply visibility to every non-thread guild channel type and categories, with threads inheriting their parent's visibility. Discord owner/Administrator bypass remains intrinsic.

**ACCESS-03.** Own channel visibility overwrites explicitly, retain unrelated permission bits, persist first-observed ACL/parent/default-permission snapshots, and repair drift through deduplicated durable work. Bind writes to current activation/configuration/job ownership, verify the full resulting policy, retain recovery across partial failure/restart, and include channel work in refresh status.

**ACCESS-04.** Registered-user Guest (ROLE-07) is computed identically whether onboarding is enabled or disabled. In enabled guilds, the resulting Member/Guest/Officer/FC Leader roles also select lobby, ordinary, and staff visibility; disabled guilds receive no channel-visibility work. Preserve explicit Guest revocation, FC Member precedence, guild isolation, and conservative treatment of unknown/stale evidence. Derived registration must not recreate a revoked durable grant.

**ACCESS-05.** Exclude Discord's configured community-updates channel and its parent category from onboarding ownership, room selection, permission preflight, new snapshots, and mutations. Use a separate officer chat. Recheck exclusions before writes and reconcile changed community bindings. Preserve the guild visibility default if lowering it would change an excluded area's inherited visibility; use explicit managed-channel gates in that case.

### Database and durable work

**DEPLOY-DO-01.** (Not the production target since the 2026-09-24 hosting amendment; still maintained and validated.) Supply an App Platform spec that uses matching published GHCR images for a single bot worker, an internal-only Nodestone service, and a pre-deploy migration job. Attach it to the owner-provisioned DigitalOcean Managed PostgreSQL cluster named in the spec (`production: true`, a dedicated non-admin database and user), through provider-bound runtime credentials and verified TLS with the cluster's CA. Never bind a connection pool. Creating the app must not start a bot writer: the first deployment omits the worker, which is introduced only at activation. A bot process holds a PostgreSQL writer lease on its direct connection before it starts work, so an overlapping deployment waits for the previous writer instead of running beside it (MIG-13). Document the provider prerequisites, the backup/PITR window and independent exports, trusted-source access for maintenance tools, and an update procedure that retains database identity and stops the previous writer before migrations or replacement startup. Validate every deployment phase's configuration without creating cloud resources in tests or CI.

**DB-01.** PostgreSQL is the runtime database. Use Drizzle ORM for typed application persistence over the node-postgres driver, with table mappings and inferred record types maintained alongside explicit versioned SQL migrations. The migrations own foreign keys, unique constraints, indexes, domains, and triggers; already-applied migrations are immutable. Bind ORM work inside an application transaction to its exact checked-out client. Retain narrowly scoped parameterized PostgreSQL control/locking SQL and catalog-based restore verification. Application startup checks the required schema version and checksum.

The physical schema may use different names, but it must represent these logical records and constraints:

| Logical records | Required scope/invariants |
| --- | --- |
| Guild configuration | Guild ID, nullable FC/role/channel IDs, role-layout and guest-application switches, configuration revision, active/disabled state |
| Discord users and guild-user state | Stable user identity; per-guild presence and nickname/primary preferences |
| FCs and characters | Shared public identity/display caches; observation/freshness metadata |
| Character links | Guild, character, owner, active/inactive state, provenance, actor/time; one active owner per guild/character |
| Verification challenges | Bound tuple, token hash, expiry, consumption/replacement state |
| Sync runs and roster snapshots | FC, requested/attempted/completed state, completeness evidence, version, counts/errors |
| Membership observations/history | Pending departures and confirmed periods; guild/user/FC historical eligibility |
| Guest applications/grants/revocations | Durable state machines and one pending application per guild/user; grants ended by `/guest reset` retained with end time, actor, and reason |
| Ledger accounts/entries | Guild/FC account uniqueness, known/unknown state, ordered immutable entries, idempotency |
| Jobs/outbound effects | Durable payload/version, deduplication key, attempts, due time, lease/status, delivery IDs/errors |
| Audit and import provenance | Actor/source, guild, target, decision, timestamps, source checksum/keys and reconciliation results |

**DB-02.** Use short transactions containing database operations for application decisions. Perform Discord and Lodestone I/O outside those transactions. Connect committed decisions to subsequent delivery through persisted work.

**DB-03.** Protect financial operations, ownership claims, application decisions, and snapshot publication with database-enforced invariants that hold under concurrent interactions and process restarts.

**DB-04.** Publish application state and the jobs/outbox records needed to project it in the same transaction. Use PostgreSQL-backed work/outbox persistence within the two-service deployment.

**DB-05.** Jobs require deduplication, bounded retry, due times, recoverable leases, and explicit succeeded/blocked/terminal-failure outcomes. Publication and effect execution require current job ownership plus the applicable state/configuration version; expired workers relinquish their results for recomputation.

**DB-06.** Reconciliation effects derive current desired state. Ledger notifications refer to an immutable committed entry. Store enough information to inspect and retry delivery independently of its committed application decision.

**DB-07.** Audit officer assignments/unassignments, configuration changes, guest decisions/grants/revocations/resets, officer grants/revocations/resets, verification provenance changes, ledger mutations, and migration actions. Record cache acquisition and update results as operational history, with aggregated officer notifications where appropriate.

**DB-08.** Removing the bot from a guild deactivates its work while retaining its history. A documented retention policy may prune expired challenges and bounded diagnostic payloads. Retain ledger entries, active links/grants, and membership evidence required by access policy.

## 11. Containers, configuration, and operations

**OPS-01.** Provide a project-root multi-target `Dockerfile` and `docker-compose.yml`. The normal long-running services are `tarubot`, `nodestone`, and `postgres`; the source-built Nodestone sidecar has a private HTTP endpoint.

**OPS-02.** The bot image must use a multi-stage reproducible build, run as a non-root user, contain compiled application code and required runtime dependencies/assets, and execute Bun directly with proper signal handling. Install runtime dependencies from the committed lockfile during image construction and retain their required package assets in the final image.

**OPS-03.** PostgreSQL must use a named persistent volume mounted at the correct location for its selected image major. Its port is private to the Compose network by default. Use Compose DNS for connectivity; TaruBot requires outbound access to Discord and Lodestone.

**OPS-04.** Include `.dockerignore`, `.env.example`, and documented install/build/run commands. Build the image from the application, its declared runtime dependencies, and required assets. Keep data-import inputs, credentials, local environment files, and repository metadata outside the image. Supply tokens/database credentials through runtime configuration or mounted secrets.

**OPS-05.** Validate configuration before accepting work. Document, at minimum, Discord token/application ID, PostgreSQL connection settings, environment/log level, Lodestone region, sync/profile intervals, verification expiry, request/retry/concurrency bounds, and health-check configuration. Configuration errors identify the setting and expected format using redacted values.

**OPS-06.** Provide explicit commands for schema migration, data import, application-command registration, build, start, type checking, linting, formatting checks, unit tests, and integration tests. Run migration/registration as one-shot operations using the bot image or its documented tooling.

**OPS-07.** The bot must require the expected schema version. Serialize migration execution and report incompatible schema/configuration clearly. Support dependency-ready startup ordering and runtime reconnection/retry behavior.

**OPS-08.** Provide local process liveness and application readiness/capability status. Readiness reflects initialization, database/schema availability, the database writer lease (MIG-13), and Discord connectivity. Report Lodestone outages as degraded synchronization while allowing available local/ledger capabilities to operate. Health probes use local/dependency connection state independently of scheduled Lodestone acquisition.

**OPS-09.** On termination, stop accepting new work, stop scheduling, settle or safely abandon short transactions, release/recover leases, and close Discord/database resources within the documented container stop period. Restart resumes committed work using its idempotency keys and durable decision state.

**OPS-10.** Use structured logs with operation/run IDs, guild/FC context where appropriate, durations, result categories, retry information, and actionable permission/configuration errors. Track successful refresh age, failures, queue depth/age, reconciliation outcomes, and blocked notification work. Apply redaction to credentials, proof tokens, and profile bodies.

**OPS-11.** Use the officer notification channel for operational summaries, material membership changes, repeated synchronization/delivery failures, and recovery notices. Aggregate and rate-limit messages per guild/run, including during large roster changes and prolonged outages.

**OPS-12.** Document Discord setup using the `Guilds` and privileged `GuildMembers` intents, application command installation, and explicit channel/role permissions. Require `ManageRoles`, `ManageNicknames` for enabled nickname management, and the channel viewing/sending/embedding/history permissions needed by configured destinations. Use this explicit permission set with bot `Administrator` permission disabled.

**OPS-13.** Provide PostgreSQL backup/restore instructions and a tested operational recovery procedure. State which commands need a maintenance window and how to observe blocked jobs, stale snapshots, and failed Discord effects.

**OPS-14.** Production and rehearsal maintenance tools run from a build of the deployed release, with an explicitly supplied environment file and never the development `.env`. Before any Discord or database I/O, each tool verifies that its application ID, test-guild scope, target guilds, and database endpoints all belong to exactly one deployment profile (production, production rehearsal, or DevBot). It refuses mixed identities without printing credentials, and a rehearsal never writes to Discord. A read-only production inspection reports the production application's intents, guilds, guild permissions (with and without Administrator), managed-role hierarchy, and destination-channel access.

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

**MIG-03.** Import every valid identity and ownership record, including unclaimed characters and users absent from Discord. For the supplied fixture, this includes 40 FCs, 4,251 characters, 241 users, and 161 ownership links. Normalize empty optional role/channel IDs to null. Validate all foreign-key relationships and report conflicts explicitly. Import the legacy guest-application review channel with the guest-application switch off (CFG-08). Imported guilds start with guest applications closed, the role-layout switch off (CFG-07), and grandfathering pending (MIG-14).

**MIG-04.** The input schema associates ownership with users and balances with FCs. For the supplied single-guild fixture, map its 161 ownership links and all 40 FC ledger states to the sole configured guild. Create 40 guild/FC ledger accounts: 36 known opening balances, including explicit zeros, and four uninitialized accounts. Enable mutations for the currently linked account.

Record the mapping in the import report. For a multi-guild input, require an explicit ownership/account mapping that assigns each source balance once and identifies the destination guilds for each ownership record.

**MIG-05.** Mark supplied ownership links as trusted `imported_link` provenance. Record the input keys/checksum and import time. Self-service claims created through the application use profile-token verification provenance.

**MIG-06.** Retain input FC/character relationships as historical cache facts. Create imported historical membership for a `(guild, user, FC)` when the mapped user owns a supplied character whose `fc` matches that guild's linked FC. Record the supporting ownership, character, and guild input keys as evidence.

**MIG-07.** Retain input timestamps as provenance and initialize successful live-synchronization state as pending. Require an explicit source timezone for the input's timezone-naïve datetime values, retain their raw values, and report UTC conversion. Obtain a fresh complete roster before enforcing membership-derived changes.

For imported member-role holders with matching imported FC-membership evidence, apply the two-observation departure confirmation before the first roster-driven demotion. Existing access remains in place during validation; new member grants require fresh roster evidence.

**MIG-08.** Convert each known balance into one immutable import opening entry with input provenance. For the supplied fixture, verify the configured FC's opening balance is exactly 349,279,945. Null balances create uninitialized accounts. Account transaction history starts with its opening entry and subsequent application-recorded entries.

**MIG-09.** Capture a complete live Discord snapshot of human holders of the configured guest role at cutover. Create explicit `imported_guest` grants with guild/user/role IDs, capture time, and snapshot provenance. Require successful complete capture before publishing the grandfathered guest population. Grandfathering of the other humans present at first activation follows MIG-14.

Snapshot users absent from the SQL dump create additional user/guild-user records. Report these additions separately from SQL input counts. Character ownership comes from imported links or subsequent verified/manual assignments; the Discord snapshot supplies presence and role state.

**MIG-10.** Initialize imported users with an unset primary character and nickname management disabled, retaining current Discord nicknames. Application review history for a newly imported guild begins with requests submitted through `/apply` after an officer opens applications. Give users instructions for primary selection, nickname opt-in, and how visitors obtain Guest while applications are closed (verify a character, or ask an officer for `/guest grant`).

**MIG-11.** Make import execution idempotent using input fingerprints and stable source-record identities. Re-running the same import resolves to the same links, opening entries, history, and guest grants while retaining subsequent application decisions. Report conflicting input changes for an explicit mapping/import decision.

### 12.3 Activation and recovery

**MIG-12.** Document and verify this sequence:

1. Rehearse schema creation and import against a disposable PostgreSQL instance using the supplied fixture.
2. Stop the legacy process and prevent its restart, reset the production token, freeze managed-role edits, and retain a final consistent input snapshot and checksums.
3. Capture a complete Discord snapshot for imported grants, validation, and the reconciliation preview.
4. Confirm that no bot writer holds the database, run versioned PostgreSQL migrations and the validated import, and retain the import report. Verify that effects, onboarding, the role-layout switch, and guest applications start off and that grandfathering is pending.
5. Validate current channels, roles, bot permissions/hierarchy, gateway intents, existing command registrations, and configured FC identity using the read-only production inspection.
6. Obtain two complete FC snapshots at least 60 seconds apart, so that imported members absent from the live roster are confirmed as departed, then produce a read-only preview. It covers role/nickname actions, registered-user Guest additions, pending departures, the first-activation grandfathering plan (counts, sample IDs, checksum), and the role-layout switch. Resolve reported input/configuration issues before enabling effects. Activation must follow the last acquisition within the roster freshness interval; any later acquisition requires a new preview and checksum.
7. Record a provider point-in-time-recovery marker and take an independent logical backup.
8. Activate with the reviewed grandfathering checksum; activation writes only to PostgreSQL. Then register exactly the declared command set, clear leftover guild-scoped commands, and read every scope back. Start exactly one application writer, verify representative claim/access/ledger operations, configure officer authority, review humans who joined after activation's enumeration, and monitor queued or blocked work.

The numeric values in Section 12.1 define the supplied acceptance fixture. For another input snapshot, derive IDs, counts, and balances from that input and reconcile its import report accordingly.

**MIG-13.** Maintain one authorized application writer during activation and recovery. Retain input snapshots and PostgreSQL backups. Document recovery before activation and after live transactions have been accepted. Post-activation recovery must retain acknowledged ledger entries, links, and decisions through compatible database restoration or reconciliation/replay of exported changes, then resume pending durable work. Reset the legacy application token after the legacy process stops and before any v2 gateway connection in the window. On App Platform, the worker component is added only after activation. A PostgreSQL writer lease enforces the single writer: each bot process holds a session advisory lock on a direct connection for its lifetime, and a second process waits, unready, until it is released. Before migration, import, activation, or restoration, the operator confirms that no process holds it. A database restore does not revert Discord role changes a writer already applied; recovery after effects began compares current roles with the cutover snapshot and resolves differences explicitly.

**MIG-14.** At an imported guild's first activation, completely enumerate current Discord membership. In the transaction that enables effects, create a `grandfathered` guest grant for each human who is not Member-eligible under ROLE-01/ROLE-07, according to the fresh accepted roster required for activation (a roster accepted after the import, with no linked FC character awaiting departure confirmation).
- Exclude bots, revoked users, and users with an existing grant (evaluation basis `existing_grant`): an active approved, manual, or imported grant, or any grant that `/guest reset` ended, which still counts although it confers nothing. Never clear a revocation.
- Record guild/user IDs, enumeration time, accepted roster time, evaluation basis, and the plan checksum. The checksum covers the guild, the import fingerprint, the latest accepted roster snapshot, and the planned user IDs; it excludes timestamps, roles, and nicknames.
- The read-only preview reports the plan (counts, sample IDs, checksum) and can write it to a file. Activation writes only a plan whose checksum the operator confirmed; otherwise it rolls back unchanged and reports the users added and removed relative to the reviewed plan file.
- Persist a guild-level completion marker so the run happens exactly once. Guilds not created by the import are never grandfathered.
- Audit each grant and the run, retaining the enumeration time.
- Once the writer is live, a read-only report lists present humans who joined after that enumeration and hold neither a guest grant nor an active trusted link; officers decide an explicit grant for each.
Grandfathered grants behave exactly like approved grants (ROLE-02, GUEST-08, GUEST-09).

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
| AC-08 | Confirmed former members and registered users with no FC character become guests in every configured guild, with onboarding enabled or disabled. Later unregistered newcomers gain access through an officer grant (or approval while applications are open). Guest revocation survives refresh/restart/rejoin until an explicit grant or `/guest reset`, and current FC-member eligibility takes precedence over guest state. |
| AC-09 | A failed/stale refresh retains existing FC-derived access and the successful-snapshot timestamp while reporting degraded state. A validated empty roster follows the same departure confirmation rules as other complete observations. |
| AC-10 | A run records complete Discord member enumeration, scopes work to humans, and reports individual skipped/blocked outcomes while continuing eligible work. Repeated reconciliation applies only necessary managed-role/nickname deltas. |
| AC-11 | Configuration unlink verifies the linked FC ID and works offline. Role replacement/unsetting cleans up retired managed roles while preserving unrelated roles. Effects use the current applicable configuration/version. |
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
| AC-22 | Docker images build reproducibly, Compose validates, PostgreSQL data survives container recreation, and the bot recovers from database/Discord reconnects. Health probes operate independently of Lodestone acquisition. Graceful shutdown and backup restoration are exercised. A second bot process against the same database waits for the writer lease, stays unready, and takes over only after the first releases it or loses its session. |
| AC-23 | The deployed command inventory matches Section 4, and the bot operates with the intents and explicit permissions specified in OPS-12 (20 root commands / 44 paths since 2.18.0, including `/config role_layout`, `/officer reset`, `/guest reset`, and `/issue`). |
| AC-24 | A user with several trusted links becomes Member when any is a confirmed FC member, receives Officer when any holds the configured rank (except through a bot-only officer's assignment), and is Guest when none is in the FC, with onboarding enabled or disabled. Unknown/stale evidence creates no new role, removing the last link removes derived Guest, and onboarding-disabled guilds receive no channel-visibility work. |
| AC-25 | First activation of an imported guild grandfathers exactly the previewed set of current non-member humans, once; reruns and later activations add nothing. Bots, Member-eligible users, existing grant holders (including users whose grant `/guest reset` ended), and revoked users are excluded. A mismatched plan checksum, a stale roster, or a linked FC character awaiting departure confirmation rolls activation back unchanged. Grandfathered grants survive refresh/restart/rejoin, yield to Member precedence and explicit revocation, and can be restored by an explicit grant. |
| AC-26 | With the role-layout switch off, startup, activation, setup, role configuration, role events, refresh, and requeued work make no hoist/position writes, and layout work completes as skipped. Enabling it (manager-only, audited, revision-fenced) queues one pass that converges; disabling during a pass supersedes it before any further write. |
| AC-27 | An imported guild activates with guest applications closed (legacy review channel kept with the guest-application switch off), onboarding off, and the role-layout switch off, and `/apply` refuses with a visitor-facing explanation before its form opens. Production tools refuse mixed application/guild/database identities and development `.env` leakage, and after registration no guild-scoped commands remain for the production application. |
| AC-28 | The guest-application switch is independent of the review channel (CFG-08). `/apply` is open only with the switch on and both a review channel and a Guest role set. Switching off keeps the channel and leaves pending applications reviewable, and a request matching the saved state changes nothing. Switching on validates the review channel that will take applications, including a stored legacy channel, while switching off or unsetting the channel validates nothing. `/setup` switches applications on, an import keeps the legacy channel with the switch off, migration 006 switches on only guilds that already had a review channel and were not awaiting first activation, and activation changes the switch only on an explicit choice. |
| AC-29 | `/officer reset` removes an officer grant or revocation, so the configured rank decides again, including for a user who has left; like grant and revoke, it refuses a manager other than the guild owner whose highest role is not above a bound Officer role. `/guest reset` lifts a revocation and ends every active grant of any provenance; ended grants stay as history, confer nothing, are left out of `/guest status`, and still exclude the user from first-activation grandfathering. Both are audited and reconcile the member, and with nothing to remove they change nothing and audit nothing. |
| AC-30 | `/main` naming the current main and `/nickname` repeating the current setting save nothing, queue no reconciliation, and reply that nothing changed. `/config officer_rank` naming the saved rank, or unsetting when none is set, replies that nothing changed without a revision bump, audit, or repair pass. Every option of every registered command path has an input-failure example. `/ledger adjust entry` accepts `5`, `#5`, or the entry ID within the current account. Member options suggest server members and still accept pasted IDs and mentions. After a non-imported user removes every link, their next link becomes the main without changing nickname sync. Reconciliation never writes, restores, or blocks on the guild owner's nickname. |

Before production activation, perform a smoke test of command registration, proof/assignment, member/guest transitions (including multi-character union and officer guest grant/revoke), nickname handling, and ledger delivery in a dedicated configured test guild. Automated checks use dedicated test credentials and guild identifiers.

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
