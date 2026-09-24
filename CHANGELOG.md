# Version history

The current application version is **2.15.0**, with `package.json` as the source of truth. This codebase is a complete rewrite of the original TaruBot and therefore belongs to major version **2**. `/version` reads the manifest included in its compiled build and obtains commit history independently from GitHub's `main` branch.

## 2.15.0 — Reply session fixes, member autocomplete and the guest-application switch

The owner's 2.14.0 reply session on DevBot (2026-09-24) compared every reply with the approved mockups; this release ships its findings and the decisions the owner made during it. The officer alerts and telemetry planned as 2.15.0 (OPS-10/OPS-11) move to **2.16.0**, and the production cutover now requires a published release at or above 2.16.0.

- Show an FC's tag once. The Lodestone delivers tags with their guillemets (`«Souls»`) and the stored row keeps them, so `/config show`, `/config validate`, `/config fc link|unlink` and the ledger receipt footers rendered `Woven Souls ««Souls»»`. One helper, `fcTagText`, removes a surrounding pair before every presenter adds its own; bare tags render as before.
- Never imply a change where none occurred (owner decision). `/main` naming your current main replies "Already your main character", `/nickname enabled:true` while sync is already on replies "Nickname sync already on", and turning sync off when it is already off gets the approved "Nickname sync already off" card; each is an info or neutral `= NO CHANGE` card, and `Service.preferences` saves nothing and queues no reconciliation for them. Resuming sync that a manual nickname suspended is still a change.

## 2.14.1 — Foreground Claude reviews and sidecar test clock

A CI and test patch: no runtime source changes, no migration (the schema stays `005_launch_access_policy.sql`), and no command changes, so nothing needs re-registering. DevBot runs 2.14.0 and need not redeploy.

- Fix Claude Code Review runs that passed in about 40 seconds with nothing posted. Since Claude Code 2.1.198 a subagent starts in the background unless Claude asks otherwise. The plugin's gating agent started in the background, the main agent ended its turn to wait for it, and `claude-code-action` stops reading at the first result message, so the step passed while the gating agent was still running (run 35948050785; [anthropics/claude-code-action#1499](https://github.com/anthropics/claude-code-action/issues/1499)). The review step now sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so every subagent runs in the foreground and the only result arrives after the review finishes. The 2.14.1 PR's own review is skipped because it changes the workflow, so the fix can only be confirmed on the next ready, same-repository PR to `main` (see OPEN_ITEMS.md).
- Print the review transcript (`show_full_output`) only when debug logging is on: a re-run with debug logging, or the `ACTIONS_STEP_DEBUG` secret or variable. The temporary 2.13.0 setting printed it on every run into the public Actions log.
- Add a "Check that the review finished" step. It prints the turns, duration, cost, subagent counts and permission denials by tool from the action's execution file, and fails the job when a subagent started in the background or never reported back, or when the review produced no result message. It is skipped when the action produced no execution file, as on a pull request that changes the workflow.
- Measure transport start spacing in the sidecar contract test with `performance.now()`, the monotonic clock the sidecar reserves starts on, instead of `Date.now()`, allowing 10 ms for the in-process hop between reserving a start and calling the transport. The wall clock measured the enforced 1,000 ms gap as 999 ms in the amd64 image build of 2.14.0's publish run 35948831624, whose failed jobs were re-run and published. Unspaced starts land a few milliseconds apart, so the test still catches missing spacing.
- Record the DevBot 2.14.0 rollout (backup and exact restore, no migration, 19 roots / 41 paths, the startup plan) in DEV_GUILD.md, OPEN_ITEMS.md, VERIFICATION.md and SESSION_HANDOFF.md, describe the review workflow's new behavior in CI_CD.md, correct README.md's `/version` marker (`✓ verified` since 2.14.0) and DEV_GUILD.md's note on the production application, and keep the 2.14 reply session in `test-plans/current.json` for 2.14.0 or later.

## 2.14.0 — Embed replies instead of JSON

Every command, button, form and pre-form reply is now one private house-style embed ([REPLIES.md](docs/REPLIES.md)) instead of a JSON dump, and ledger posts, guest review messages and decision DMs are embeds too. No migration: the schema stays `005_launch_access_policy.sql`. Re-register commands after deploying, because the `/ledger history` `before` description and the `/config` channel options changed. Interaction logs change level and `code` for several failures; see the log changes below and [OPERATIONS.md](docs/OPERATIONS.md#reply-references-and-error-codes).

- Add a failure catalog (`src/domain/failures.ts`) that gives every thrown code one presentation category and log level, with an optional typed, presentation-safe detail on `Failure`. It catalogues the new codes `pending_proof`, `insufficient_funds`, `fc_linked` and `idempotency_conflict`.
- Log interaction failures by category: routine refusals at info (so a reply's reference stays findable at the default level), Lodestone, Discord and settings trouble at warn, and only failures without an approved explanation at error. Lifecycle, gateway-event, queue-worker and shutdown reports stay at error; job outcomes keep their 2.12.3 levels.
- Report logs gain `category`, `source` and `scope`. **Log change:** an error that is not an approved `Failure` now logs `code: "unexpected"` with its class in `source` (for example `DiscordAPIError[50013]` or `ZodError`); 2.13.0 logged the class name as the code. Raw Discord permission, unknown-member, rate-limit and server errors in interactions classify as blocked, forbidden and upstream failures instead of unexpected ones.
- Reword the note check as "Add a note of 1–1,000 characters." with a label, so reason and rank checks can name their own option, and add `sequenceCursor()` for ledger history cursors, so a bad `before` value can report an entry-number error instead of a balance error.
- Type every interaction-facing service result (`src/application/results.ts`) and add the data the new replies need: `effectsMode` (`live`, `awaiting_activation` or `deployment_disabled`) on every change result, including `/apply`; character identity, main-character and roster-freshness evidence on `/verify` and `/assign`; `already_assigned` for a repeated `/assign`; ended links, cleared mains and remaining links; the FC identity, ledger channel, corrected entry number and replayed post status on ledger receipts; exact history paging (`older`, `newer`, `total`, `above`, page-aligned deliveries); previous values, requeued jobs and holder samples on configuration changes; and application outcomes, decision details and the membership facts behind `/guest status`. The earlier result keys are unchanged, so the officer JSON files only gain fields. `/nickname enabled:false` for someone TaruBot never tracked is now a no-op instead of a refusal.
- **Log and job-diagnostic change:** failures thrown for these conditions use new codes and the approved wording, with a typed detail. `funds` becomes `insufficient_funds` (below zero only; passing the storable maximum is `input`); `pending` becomes `pending_proof`; missing links, members, applications, ledger entries and accounts, claims and FC links become `not_found` (they were `input` or `expired`); ambiguous role and channel choices become `ambiguous`, a second FC link `fc_linked` and idempotency-key collisions `idempotency_conflict` (they were `conflict` or `input`); an obsolete command, button, form, review message or join context becomes `stale` (it was `input` or `forbidden`). `funds` and `pending` leave the catalog. A malformed Lodestone ID in sidecar output is `invalid_response` ("Nodestone returned an invalid Lodestone ID.") rather than the input failure the ID check gives typed options, and a missing join time names its member ("Discord didn't include join details for <@id>."); in a full member-list read it is the member-list failure. A full member request that Discord rate limits or stops answering is the member-list failure too, logged at warn, instead of an unexpected error; the gateway no longer re-requests into another rate limit. A deleted, non-text or other-server channel is refused as "<#channel> is unavailable …" without the channel-permissions fix (a permission refusal keeps its wording), so ledger post states read "channel unavailable" for it; a text channel in the server that TaruBot can't view (Discord 50001 Missing Access) keeps the permissions refusal and its How to fix step. A ledger mutation that finds no ledger account for the linked FC is a broken invariant, logged as `unexpected` at error (2.13.0 logged `setup`), instead of pointing officers at fixes that do nothing. A job parked while `ENABLE_EFFECTS=false` stores "disabled: Discord changes are off for this deployment (ENABLE_EFFECTS=false)." instead of the activation wording.
- Restarting with `ENABLE_EFFECTS=true` requeues the work the dispatcher parked while effects were off, for every present guild whose own effects flag is on, so ledger posts, review messages, DMs and role updates held during a deployment-wide pause go out as receipts promise; an unactivated guild's work still waits for activation, and blocked work for its fix. Startup, activation and `/config` changes now requeue parked work one row per dedupe key, closing older duplicates as `skipped: superseded`; before, a key enqueued again while parked made the requeue violate the active-job index. A closed duplicate keeps its `applied` role changes, a sync run that tracked it tracks the row that carries its work instead (so an earlier run no longer reads Completed before that work runs), requeued rows drop their stored paused diagnostic (so they read `… QUEUED`, not "retrying after a Discord error"), and an enqueue that commits the same key mid-requeue makes the requeue retry from a savepoint instead of failing startup or the `/config` change. `jobs:retry` refuses a job whose work a newer queued, running or blocked job already carries, naming that job, instead of failing on the active-job index. With effects live, leftover paused work no longer promises an activation: members read "held from an earlier pause", and ledger officers, the officer `/guest status` record and the officer `/sync status` overview get the `/config` step that re-queues it instead of "Nothing to fix".
- `/apply` now counts as open only when both the review channel and the Guest role are set, in the pre-form check, at submission, in activation and in the preview tool, so a visitor is never shown a form that would be refused.
- Commands parse application, entry and run IDs, member options, name and world lengths and history cursors into input failures that name the option, instead of raising a raw validation error. `/ledger balance|history fc_id:` also accepts a Lodestone link.
- Application autocomplete lists the newest 25 pending applications as "display name · submitted date · short ID" and matches on the display name, user ID or application ID.
- Add the building blocks the new replies use, in `src/discord/presenters/`. They cover:
  - the house-style tones, status markers, health-check tokens and limits;
  - formatting that escapes user text for where it renders, keeps gil exact, and cuts text on grapheme boundaries;
  - a `Presented` message that only `reply()`, `post()` and `dataReply()` can build, and that enforces every Discord limit deterministically;
  - audiences derived from the authorization policy;
  - the approved job line (labels for members, raw kinds and diagnostics for officers, split across fields when long), the effects and roster-evidence fields, and provenance labels;
  - the approved buttons.
  One strict codec (`src/discord/custom-ids.ts`) builds and parses every button ID; the review buttons keep their format. Tests gain the reply catalog harness and a guard that keeps JSON on the officer details path and bans `JSON.stringify` and `json()` wherever replies are built.
- Answer every refusal and error with one approved embed from a single failure presenter instead of plain text ending in `Operation: <id>`. Each concept has one title and tone however it is reached, "Nothing was changed." where its approved copy says so ("Nothing was recorded." for ledger funds, the reuse sentence on `/setup`), one next step, and the footer `Code <code> · Ref <interaction ID>`, where Ref is the log `operation` field. Members, and replies sent before the actor is known, get member-safe wording; officers also see the affected role or channel and a diagnostic. Unexpected errors never show their text; after a command's work ran they say the request may have been saved, and ledger commands warn against recording twice. Officers see the affected role or channel on "Discord permissions need attention", with How to fix only when TaruBot's role position or channel permissions are the cause, and a configured role that was deleted now says so ("That role no longer exists in this server") in the card, `/config validate` and job diagnostics. `/setup`'s channel-permission refusal names Manage Channels. Officers running `/assign` see who owns a character on "Linked to another member"; members, and officers on their own `/claim` or `/verify`, never do. A retry-timed refusal says "Nothing was changed." before its "Try again …".
- Reply to `/apply` in a closed server with the approved "Guest applications are closed" embed before the form opens, adding the commands that open applications for people with Manage Server; a refused submission reuses the same card with its code and reference.
- Router: handlers receive the viewer and return presenter replies; a component can update its own message in place, only when that message is private or belongs to the presser; the interaction scope (for example `/ledger withdraw` or `button guest`) is logged with each failure; expired interactions and failures while sending a reply are logged at warn instead of rejecting, and an autocomplete that can no longer be answered is logged at warn with no fallback response.
- Character commands (`/claim`, `/verify`, `/unclaim`, `/characters`, `/main`, `/nickname`, `/assign` and `/unassign`) reply with the approved embeds instead of JSON. `/claim` shows the token as copyable text above the card (never inside it) with **Open Lodestone profile**, **Edit Character Profile** and **I've added it — verify now**, which checks in a new reply so the token message is never edited; the pending-token card's **Check again** re-checks in place, at most once every 15 seconds on the presser's own card. `/characters` shows IDs, link UUIDs and **Full details (JSON)** only when an officer names a member. Receipts say when roles and nicknames change, show `↻ WAITING` when the FC roster is stale, and become the pending "Saved, Discord changes paused" card while Discord changes are paused (awaiting activation or off for the deployment). The server owner's first `/verify` link says Discord doesn't let bots change the owner's nickname instead of promising the change, as `/main` does; both stay success, and only `/nickname enabled:true` by the owner is the warning caveat card. Officers' `/assign` and `/unassign` receipts show the member, character, reason (capped at 300 characters) and link, and a delegated officer's assignment notes that it can never grant the Officer role. Character autocomplete labels are cut on character boundaries.
- `/ledger` replies with the approved embeds instead of JSON. Receipts show the exact change, the new balance and entry number and when the entry will be posted; officers also see the previous balance, the post status, the entry UUID and the Ref, and a receipt saved while Discord changes are paused is the pending "Saved, Discord changes paused" card. An unchanged correction is "No correction needed" and a replayed interaction "Already recorded". `/ledger balance` never shows an unset opening balance as 0 gil; members see how many recent entries are still waiting to be posted, and officers see each recent post's state (collapsed runs of posted entries, blocked, waiting, paused or failed) with next steps only when something needs them, plus **Full details (JSON)**. **View history** opens `/ledger history` in a new reply, and its **Newer**, **Older** and **Latest** buttons page in place as whoever clicked; page numbers come from exact counts, so a hand-typed `before:` cursor still numbers and pages correctly. Officers' history pages add entry UUIDs, each post's state and a problem summary. Each **Posted** link uses the channel the post went to, which the dispatcher now records in the job result (no migration), so rebinding the ledger channel keeps earlier links working; posts made before 2.14.0 link through the configured channel. The `before` option now reads "Entry number from a previous page (e.g. 34)", so re-register commands after deploying.
- `/guest`, the `/apply` receipt, the review buttons, `/refresh`, `/sync status`, `/ping`, `/channel` and `/version` reply with the approved embeds instead of JSON. `/guest status` leads with how the member qualifies (confirmed FC membership, a revocation, a grant, former membership, a registered character, a roster check still due, a pending or denied application) and a Roles line that warns when the role update is blocked or failed; members never see officer reasons, reviewers or job details, only their own denial reason (capped at 300 characters). An officer who names a member gets the record view: the newest five grants and applications with review-message links, the latest three deliveries as job lines, and **Full details (JSON)**. Grant, revoke and decision receipts and a new application become the pending "Saved, Discord changes paused" card while Discord changes are paused, the application receipt saying when officers will see it, and review buttons answer "Recorded. The review message updates shortly." `/refresh` shows the run to track, when it starts and the last roster read (officers also see the mode, cooldown and force hint). `/sync status` shows members their refreshes and pending work, and officers the recent runs, outstanding work, what runs next and what needs attention (split across fields when long); the overview stays pending while work is in progress and turns warning only when blocked or failed work is all that's left. The new `sync` component serves **Check sync status**, and Full details covers the sync and guest views. `/version` marks verified commits with "· ✓ verified" instead of ✅, and the character profile refresh job gets a member-facing label.
- `/config`, `/setup` and `/officer` reply with the approved embeds instead of JSON. `/config validate` is a checklist of `[OK]`, `[WARN]`, `[FAIL]`, `[OFF]` and `[WAIT]` lines per section (the FC and its roster freshness, the access roles in layout order, the channels, onboarding, Discord changes, role layout and pending guest grandfathering), titled by its verdict: problems (error), warnings, ready for activation (pending) or all checks passed, each saying "Nothing was changed."; a review channel without a Guest role and `ENABLE_EFFECTS=false` now show as warnings. `/config show` summarizes every setting, collapsing unset roles or channels and listing next steps; it keeps one field per setting, so it may use up to 15 fields where other replies stay within 10. **Run health check** and **Re-check** re-run the check in place for the officer who clicked. `/config ledger`, `officer_notifications` and `guest_applications` offer only text channels, as `/setup` does. Change receipts name what was saved, the role they retired, the holders an Officer binding adopted (up to 20, then "+N more") and the work they queued; repeating the current setting is an info "= NO CHANGE" card, a leader or ledger channel without a linked FC and a review channel without a Guest role are warnings, and receipts for role, FC, channel, officer-rank, layout, setup and officer changes become the pending "Saved, Discord changes paused" card while Discord changes are paused. `/setup` lists each role and room as created or reused, with **Check sync status**, and while paused says channel access is secured once the pause ends; `/officer` notes a repeated grant or revoke, a member who has left, and a grant recorded before any Officer role is bound.
- Ledger channel posts, guest review messages and decision DMs are embeds, rendered by the gateway from the stored entry or application, so jobs no longer build message text. A ledger post reads `<Operation> · <amount>` (U+2212 for a negative change, an opening balance unsigned), colored by operation (deposit green, withdrawal and opening balance blurple, correction orange), with the full escaped note, the new balance (a correction shows the previous and new balance and the entry number it corrects), who recorded it, the entry number, `Entry <uuid>` in the footer and the entry's own time. Posts carry no text content and nothing per-attempt, so a retried post under the unchanged `ledger:<entry>` nonce is identical; posts made before 2.14.0 keep their old text. The review message is one embed, "Guest application" and then "Guest application · approved", "· denied", "· cancelled" or "· no longer needed", with the applicant, when they joined and applied, who decided and why, and both answers; its next update clears the pre-2.14.0 text, and Approve and Deny keep their IDs and are disabled once decided. The decision DM speaks to the applicant: approved, or not approved with the officers' reason (capped at 300 characters) and when they may apply again, naming the server when the bot has it cached. A decision DM job for an application that is neither approved nor denied now fails as `invalid_job` instead of sending. Officer notices stay escaped plain text until 2.15.0 redesigns them.
- Handlers return only presenter replies: `Command.execute` and `Component.execute` are typed to return a `Presented` (and `beforeModal` a `Presented` or `null`), and the router answers any other value as an unexpected failure instead of sending it. The pre-2.14.0 JSON dump (`src/discord/replies.ts`) is deleted, so JSON reaches Discord only as the officer **Full details (JSON)** file.
- Document the house style in `docs/REPLIES.md`: tones and the tone table, status markers and health-check tokens, content and audience rules, buttons and the JSON policy, the failure catalog, posts and their two exclusions, the deviations from the approved mockups and the resolutions record. `docs/OPERATIONS.md` gains interaction log levels and fields, reply references and error codes (with the renamed codes for queries that span releases) and status markers; `docs/MODULES.md` describes presenters, the custom-ID codec and presenter tests.
- Tests pin the house style across every catalogued reply: the tone table, `✓ DONE` only for succeeded jobs, paused views never promising queued Discord work, the approved "Check progress any time with /sync status" footer on every paused-save card, the retired catch-all titles and one pin for each of the 27 resolved inconsistencies. Every registered command path except `/apply` and `/version` is exercised through its presenter, every command stays ephemeral, the reply guard allows JSON only on the details path, and duplicate component prefixes fail discovery.
- Record the 2.13.0 DevBot rollout (backup and rehearsal, migration 005, 19 roots / 41 paths, the deployment-guard refusals) in DEV_GUILD.md, OPEN_ITEMS.md, VERIFICATION.md and SESSION_HANDOFF.md, add the 2.14.0 handoff state, and document SSH commit signing (`~/.ssh/id_git`) in SESSION_HANDOFF.md and CLAUDE.md.
- Replace the DevBot session plan with the 2.14.0 reply session, including a pass with Discord changes paused (`ENABLE_EFFECTS=false`) that checks the receipts imported guilds show at launch. DevBot has no unactivated guild, so the "ready for activation" verdict is covered by the unit catalog instead.

## 2.13.0 — Launch policy and cutover tooling

- Record the owner's 2026-09-23 launch decisions as requirement amendments: the multi-character union (any FC character gives Member, any officer-rank character gives Officer, linked characters outside the FC give Guest), first-activation grandfathering, the role-layout switch, `/apply` and onboarding off at launch, App Platform with a managed PostgreSQL cluster, and the guest-form deferral.
- Give registered visitors (trusted links, none in the FC) Guest in every guild, independent of lobby onboarding; channel visibility stays governed by onboarding alone.
- Add migration `005_launch_access_policy.sql`: the `grandfathered` grant provenance, a per-guild first-activation grandfathering marker, and `role_layout_enabled` (on by default, off for imported guilds; DevBot's guild keeps its layout).
- Grandfather every human who does not qualify as Member at an imported guild's first activation with a durable, approved-equivalent Guest grant, created once inside the activation transaction from a checksum-reviewed preview plan. Preview and activation refuse unsettled roster evidence (pending departures), report late joiners, and a repeated activation is a no-op unless `--requeue` is given.
- Gate every role hoist/order path behind `/config role_layout`, and let `/config roles officer adopt_holders:false` bind an Officer role without turning its holders into permanent grants; `/officer grant` now works before the role is bound.
- Start imported guilds with guest applications closed, and refuse `/apply` before its form opens when applications are closed.
- Hold a PostgreSQL single-writer lease before the bot logs in or starts work, check it on its own session, and exit for a supervisor restart if it is lost. Server-side TCP keepalive lets PostgreSQL free an orphaned lease within about a minute after a host loss or partition.
- Add a deployment-identity guard for every operator tool (DevBot, rehearsal and production profiles; exact database, host, user and CA rules; env-file leak checks), `scripts/commands.ts` for fingerprint-confirmed cleanup of leftover guild commands, a read-only production mode for `discord-inspect`, and identity checks in `register.js`.
- Attach the App Platform spec to an owner-provisioned managed PostgreSQL cluster, with foundation and maintenance phases derived by `scripts/app-spec.ts` and validated in CI; rewrite the cutover runbook (rehearsal, window order, abort limits, token handling) in docs/MIGRATION.md.
- Reject malformed user and character IDs as input errors instead of a raw `SyntaxError` (seen on DevBot `/assign` with a typed name), and add a working `CLAUDE.md` alongside the updated AGENTS.md.
- Temporarily print the Claude Code Review transcript (`show_full_output`) to diagnose reviews that post nothing on large pull requests; the assistant workflow is unchanged.
- Record the 2.12.3 DevBot rollout and launch-scope session so far, and the release sequence: 2.14.0 reply presentation, then 2.15.0 telemetry and officer alerts before cutover.

## 2.12.3 — Queue outcome logging and retained role changes

- Classify each failed or waiting job attempt once and log it by severity with timing and cause: expected waits at debug, escalating to warn after 10 minutes of continuous waiting; lost leases, blocks, and retries at warn; gone work at info; terminal failures at error. Row age alone never escalates, so activation-time echoes on re-queued rows stay quiet.
- Distinguish superseded reconciliation inputs (with the generation change) from a lost worker lease. A lost lease writes nothing, and a lost roster lease is no longer reported as Lodestone degradation.
- Keep an append-only `applied` list (newest 20) of role changes on `reconcile.user` results, so a pass superseded by the bot's own gateway echo no longer loses the evidence of what it applied; successful results carry only that key forward.
- Replace the paused guest-form session plan with the launch-scope DevBot session: ledger, non-officer denials, assignment, role removals and drift repair, and Guest grant/revoke.
- Record the owner's hold on guest-form acceptance and onboarding until after launch, the managed-database hosting choice, and the updated delivery order.

## 2.12.2 — Workflow and code-scanning hardening

- Release the Claude Code workflows added in PR #8, which merged without the required version increment and so left `main` unpublished.
- Pin `anthropics/claude-code-action` v1.0.231 and `actions/checkout` v7.0.1 by commit SHA in the Claude assistant and review workflows, resolving code-scanning alerts #3 and #4. Start `@claude` runs only for owner/member/collaborator mentions, drop the idle assignment trigger, skip fork review events, queue requests per issue or PR, and commit through the API so assistant commits are verified.
- Review only ready, same-repository PRs to `main` started by people; cancel superseded reviews, bound both jobs with timeouts, keep `GITHUB_TOKEN` read-only, and stop persisting checkout credentials.
- Remove CodeQL's experimental `analysis-kinds` input, which was ignored, logged errors, and will become fatal; run the `code-quality` query suite through code scanning instead, since GitHub Code Quality is unavailable for this repository. Record the exact CodeQL action version and let main/scheduled analyses finish instead of cancelling them.
- Make Lodestone tag stripping an explicit fixed point with identical output, resolving high-severity alert #1, and document that display text is not HTML-safe. Add direct `display()` tests.
- Replace the template Dependabot config with Bun, Bun runtime image, Compose PostgreSQL, and grouped GitHub Actions updates with cooldowns, excluding Nodestone-managed dependencies and PostgreSQL majors. Document how maintainers complete Dependabot PRs under the version policy.
- Record the DevBot 2.12.1 rollout on schema 004, the officer-chat review destination, the first approved unverified-visitor application, and the queue-logging follow-up it exposed.
- Add a unit test that keeps the Bun runtime pins and the CI/Compose PostgreSQL images in agreement, run the version check last in the CI checks job so dependency PRs report its other steps first, add an advisory `bun audit` workflow, comment GHCR write grants, and add a security policy that routes reports to private vulnerability reporting.

## 2.12.1 — Release handoff and future roadmap

- Record the next-session handoff with verified merged/published/deployed versions, DevBot identities and read-only health/persistence observations, policy decisions, and implementation pointers.
- Refresh the v2 release checklist after PR #6 and its image publication completed; retain the outstanding migration, live acceptance, operational features, recovery, and production cutover work.
- Document the owner's v3–v6 roadmap: rank-aware dashboard, interactive actions/reaction roles, ModMail, and expanded Lodestone profiles after v2 is settled and online.
- Link the handoff and roadmap from the README and synchronize the maintenance version in the startup plan and App Platform template.

## 2.12.0 — Officer-reviewed guest application forms

- Open `/apply` as a two-question modal for unverified visitors, with immediate form acknowledgement and freshly authenticated submissions bound to the user, guild, and current join.
- Persist bounded introduction/interest answers, submission audit, and review outbox atomically in additive migration `004_guest_application_form.sql`; repeated submissions retain the original pending application and answers.
- Show escaped answers beside persistent officer Approve/Deny buttons, including restart and deleted-message repair. Keep answers out of ordinary status/decision replies and distinguish legacy reviews without form answers.
- Preserve automatic verified non-FC Guest access, FC Member precedence, denial cooldown, explicit revocation, and existing grants. Verification while a form is pending supersedes manual approval.
- Cover real SDK acknowledgement/rendering, forged/stale context, concurrent decisions, persistence/rollback, cooldown, and registered-visitor behavior; update the live application-review test plan.

## 2.11.1 — Bound channel reconciliation reads

- Reuse a single captured channel session per reconciliation instead of force-fetching the guild and complete channel list for every target.
- Use the connected Gateway cache for no-op detection and protected binding/parent fences, with targeted REST reads before and after changed-channel writes.
- Keep full initial/final inventory verification, with at most one additional catalogue check before lowering the shared everyone default.
- Add a real application/SDK/PostgreSQL request-count regression for an 82-channel managed guild, plus disconnected/missing-scope safety coverage.

## 2.11.0 — DigitalOcean App Platform deployment

- Add a GHCR-backed App Platform spec with one bot worker, internal Nodestone service, pre-deploy migration job, and a newly provisioned inline PostgreSQL 18 dev database.
- Bind database credentials and the provider CA at runtime; enforce certificate/hostname verification when `DATABASE_CA_CERT` is supplied, including over conflicting URL TLS flags.
- Validate the provider schema offline in CI and test release/credential/networking invariants and actual driver TLS option parsing.
- Document initial provisioning, secrets, command registration, dev-database limits, and phased single-writer updates with persistent database identity.

## 2.10.2 — Separate officer chat from community channels

- Exclude Discord's configured community-updates channel and its parent category from onboarding preflight, selection, snapshots, and permission writes, using IDs rather than channel names.
- Prefer/create `#officer-chat` as the separate officer room and reject reserved resources as onboarding bindings.
- Recheck protected scope before remote mutations and react to community binding changes. Preserve the everyone visibility default where changing it would affect an excluded area.
- Verify reserved-channel privacy and limited-permission setup with SDK, PostgreSQL, and read-only DevBot preflight checks; record the new live officer room.

## 2.10.1 — Preserve explicit channel privacy

- Treat any explicit View Channel deny as private-area evidence when everyone, Member, and Guest visibility are all absent, including role and member-specific denies after onboarding is enabled.
- Keep a channel with no visibility overwrites distinguishable as an ordinary default-closed channel.
- Add SDK-effective and PostgreSQL regressions covering Member, Guest, other-role, and member-specific privacy; retain the first snapshot and prevent Member/Guest grants.

## 2.10.0 — Lobby onboarding and channel access

- Extend `/setup` to create/reuse a newcomer lobby and officer room, with explicit channel selections and manager/channel permission checks.
- Enforce lobby, Member/Guest, and staff-only visibility across all non-thread channel types; threads inherit parent visibility. Officers and FC Leaders can see the lobby while ordinary Members/Guests cannot.
- Preserve first-observed channel permissions/parents and the original everyone permission bitfield; retain existing private areas as staff-only. Persist the opt-in policy in `003_guild_access.sql` using Drizzle.
- Reconcile channel creation, edits, deletion, startup, refresh, and role rebinding through durable, revision-fenced work with full readback and no-op convergence.
- Derive Guest access for trusted registered non-FC visitors, preserving revocation, FC Member precedence, stale-evidence safeguards, and guild isolation.
- Verify effective Discord.js permissions, provisioning/reuse, partial-failure recovery, snapshot durability, authorization, refresh accounting, and visitor access transitions.

## 2.9.0 — Drizzle persistence

- Map the existing PostgreSQL schema with Drizzle ORM and use typed queries for application persistence.
- Preserve exact external IDs, bigint money, UTC timestamps, and database-enforced invariants.
- Bind ORM operations to the same connection as transactional decisions and PostgreSQL locks.
- Retain the applied SQL migrations and explicit PostgreSQL-specific control statements.
- Convert roster/rank projection, role setup, gateway observations, work leases/outbox, capability metrics, import, and maintenance commands to the shared ORM boundary.
- Derive persisted record contracts from the mapped schema and verify mapping parity, scalar JSON, transaction isolation/rollback, and concurrent queue fencing against PostgreSQL.

## 2.8.4 — Dependabot maintenance

- Enable weekly Bun dependency-update pull requests.
- Keep dependency updates subject to the existing SemVer, changelog, CI, and CodeQL requirements before merge.

## 2.8.3 — Release publication review fixes

- Isolate publication and reusable verification by commit SHA so new merges cannot cancel an older version's image builds.
- Serialize only the mutable latest-tag promotion, retaining its current-main guard.
- Reject build metadata and oversized release versions instead of silently changing or colliding Docker tags.

## 2.8.2 — CodeQL and project licensing

- Analyze JavaScript/TypeScript and GitHub Actions workflows with CodeQL, including the repository's required security/code-quality results.
- License first-party TaruBot code under AGPL-3.0-only; include the license in runtime images and OCI metadata.
- Add source-code and license links to `/version` output.

## 2.8.1 — Cross-platform test startup budgets

- Give subprocess and parser-worker tests bounded startup headroom under ARM64 emulation.
- Preserve all module, parser, transport-spacing, and cancellation assertions while avoiding the default five-second test deadline for cold worker startup.

## 2.8.0 — Pull-request CI and published containers

- Validate PRs with version/changelog checks, source checks, the full PostgreSQL-backed test suite, and both multi-platform container builds.
- Generate an invented CI migration fixture while retaining the separate supplied-dump acceptance path.
- Build and publish TaruBot and Nodestone images to GHCR after `main` changes pass verification, using latest, SemVer, and full-commit tags.
- Default Compose to registry images; retain an explicit local source-build override and development database overlay.
- Adopt the feature-branch, PR, passing-CI, merge-to-main workflow.

## 2.7.1 — Versioning policy and delivery readiness

- Require an appropriate SemVer increment for every coherent change set, including documentation, tests, and maintenance.
- Present required Discord intents and bot permissions as name/reason tables in the setup guide.
- Record the requirements-backed implementation gaps, live acceptance checks, and production-delivery work in `docs/OPEN_ITEMS.md`.
- Record live version-command registration and GitHub signature/history verification.

## 2.7.0 — Version and GitHub history command

- Add `/version [commits]` for any human guild member; show five commits by default, up to ten.
- Show the installed SemVer, linked short commit IDs, and commit titles.
- Mark signed commits with **✅** only when GitHub reports a valid verified signature.
- Share/cache bounded GitHub requests, and retain version output during GitHub outages or rate limits.

## Retrospective development milestones

These numbers are assigned now to the completed work stages to establish a meaningful SemVer baseline. Earlier working snapshots used the placeholder `1.0.0`; these entries describe development milestones, not previously published releases or tags.

| Version | Completed milestone |
| --- | --- |
| 2.0.0 | Core rewrite: ownership, membership, nicknames, guest workflow, ledger, PostgreSQL import/recovery, and containers |
| 2.1.0 | Dynamically discovered commands, events, components, and typed service injection |
| 2.2.0 | Independent Nodestone/selector HEAD tracking and checked update workflow |
| 2.3.0 | Role setup, officer/leader rank projection, explicit officer overrides, and startup test plans |
| 2.4.0 | Public development-guild interaction replies |
| 2.5.0 | Automatic role grouping and hierarchy reconciliation |
| 2.5.1 | Correct consecutive role blocks and reuse of existing Member/Guest role IDs |
| 2.6.0 | Nodestone submodule-backed builds, source fingerprints, and clean-clone verification |
| 2.7.0 | Installed-version and verified GitHub commit-history command |
| 2.7.1 | Mandatory version increments and delivery-readiness tracking |
| 2.8.0 | Pull-request validation and GHCR container delivery |
| 2.8.1 | Bounded subprocess/worker test budgets for emulated image builds |
| 2.8.2 | CodeQL merge-gate integration and AGPL-3.0 licensing |
| 2.8.3 | Non-cancelling release publication and exact registry version tags |
| 2.8.4 | Weekly Bun dependency-update pull requests |
| 2.9.0 | Typed Drizzle persistence with exact-value, transaction, and queue regression coverage |
| 2.10.0 | Opt-in lobby/staff channel security and derived registered-visitor Guest access |
| 2.10.1 | Preserve private channels expressed through explicit role/member visibility denies |
| 2.10.2 | Protected community-update resources and separate officer chat |
| 2.11.0 | App Platform spec with automatic PostgreSQL provisioning and provider-CA support |
| 2.11.1 | Reconciliation-scoped inventories and bounded targeted Discord reads |

## Increment policy

- **Major:** incompatible changes to supported commands, configuration, or persisted-data contracts.
- **Minor:** backward-compatible functionality and supported operational capabilities.
- **Patch:** backward-compatible corrections or maintenance, including documentation, tests, and tooling changes without a new feature contract.
- Every coherent change set receives an appropriate version increment; related edits share that increment.

Future changes update `package.json`, the Bun-generated lockfile when affected, and this changelog together. Released versions identify the running build; the latest GitHub commits can include work newer than that build.
