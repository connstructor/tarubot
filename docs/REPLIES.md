# Reply house style

From 2.14.0, every command, button, form and pre-form reply is **one embed** built by a pure presenter in `src/discord/presenters/`, instead of a JSON dump. Ledger channel posts, guest review messages and decision DMs use the same builders. This document is the house style those presenters implement: the owner-approved reply mockups of 2026-09-23, with the amendments recorded at the end. `tests/unit/reply-consistency.test.ts` pins the rules below, and the reply catalog in `tests/fixtures/replies/` renders one case per reply state.

The approved mockups are authoritative. Where this document and an approved card disagree, the card wins unless the [deviations table](#deviations-from-approved) records otherwise.

## Where replies are built

| Module | Responsibility |
| --- | --- |
| `presenters/style.ts` | Tones and colors, status markers, health-check tokens, separators, Discord and house limits |
| `presenters/format.ts` | Escaping, grapheme-safe cutting, gil and counts, Discord timestamps, mentions, links, Lodestone names, lists |
| `presenters/reply.ts` | `reply()`, `post()` and `dataReply()`, the only builders of a `Presented` message |
| `presenters/audience.ts` | `audienceOf()` and the `Viewer` the router derives once per interaction |
| `presenters/jobs.ts` | The job line, the effects field, the paused-save parts and the roster-evidence field |
| `presenters/labels.ts` | Link and grant provenance, application states |
| `presenters/controls.ts` | Every approved button, built through the custom-ID codec in `src/discord/custom-ids.ts` |
| `presenters/failure.ts` | The one failure presenter |
| `presenters/<group>.ts` | `characters`, `ledger`, `configuration`, `guests`, `synchronization`, `utility`, `version` |

Commands parse options, call one service method and return that method's presenter reply. They never format text, catch failures, set `flags` or set `allowedMentions`. `Command.execute` and `Component.execute` are typed to return only a `Presented` (and `beforeModal` a `Presented` or `null`), and the router refuses anything else at runtime as an unexpected failure, so no JSON dump or raw option object can reach Discord. Presenters import application results as types only and never touch persistence (`reply-guard.test.ts`).

## Anatomy

- **Title**: sentence case, outcome first, 60 characters or fewer, no trailing period and no IDs. Successes lead with the verb ("Deposit recorded"); refusals lead with the reason ("Officers only"). Sections are joined with ` · ` ("Ledger history · Example Free Company"), never ": ". The only user text allowed in a title is an escaped character or FC name.
- **Description**: what happened, then what happens next, in at most two sentences (1,000 characters). Refusals add the concept's no-change sentence ([below](#the-no-change-sentence)).
- **Fields**: noun labels, short facts inline (at most three per row), at most 10 fields, each value within 1,024 characters. The last field names the next step with the exact command. Long lists end with "…and N more".
- **Footer**: plain text only (Discord renders no markdown, mentions or timestamps there). Failures always end with `Code <code> · Ref <interaction ID>`.
- **Timestamp**: each reply kind records whether its embed carries one, copied from the approved card's `timestamp` value (the `*_REPLY_KINDS` and `*_POST_KINDS` tables in each group presenter). Replies stamp an injected "now"; posts and DMs stamp the stored event's own time (the ledger entry, the application's submission, the decision), so a retried or redrawn post is identical. Failure cards carry none.
- **Buttons**: only the approved ones, in the approved order ([below](#buttons-and-full-details-json)).

Nothing essential appears only in the footer, the timestamp or the color.

### Limits and exemptions

`HOUSE_LIMITS` in `style.ts` holds the house limits (title 60, description 1,000, 10 fields, 300 characters of user text in a field, 100 for a character name, 150 for an officer diagnostic, 10 job lines). Presenters budget within them; tests check them with `expectHouseStyle`. `reply.ts` separately enforces Discord's hard limits deterministically (256/4,096/25 fields/1,024/2,048/6,000 in total), so an oversized value is cut instead of failing with a 400 after the service has committed. Maximal fixtures assert that no reply is ever cut.

Two documented exemptions:

- **`/config show`** keeps the approved one-field-per-setting layout: 12 fields for a configured guild (13 once the guild has a grandfathering marker: "Pending · runs once at activation" before activation, "Completed <t:…:R>" after it, per the reply spec; approved configuration#4 draws a guild with no marker). It is tested against its own maximum of 15 fields (critique fix C3). Unset roles or channels collapse into one field.
- **Channel posts** may exceed the 1,000-character description, because a ledger post shows the entry's full escaped note (C10). Discord's 4,096-character limit still applies.

## Tones

Color only reinforces the title and markers, which carry the meaning in words. The swatches are discord.js `Colors`, with the approved wording:

| Tone | Color | Approved meaning |
| --- | --- | --- |
| success | Green `#57F287` | Saved and confirmed, or nothing left to do |
| pending | Yellow `#FEE75C` | Saved with Discord work queued, or try again later |
| info | Blurple `#5865F2` | Read-only results and harmless refusals |
| warning | Orange `#E67E22` | The user or an officer can fix it |
| error | Red `#ED4245` | Refused for permissions, or failed unexpectedly |
| neutral | Greyple `#99AAB5` | Utilities and reference lists |

### Tone table (C4)

These rules settle the cases where the approved cards and the swatches could be read two ways. `reply-consistency.test.ts` checks each row.

| State | Tone |
| --- | --- |
| A committed change with nothing left to fix, removals included (unlink, revoke, every clear, layout off, deny, `/unclaim`, `/unassign`) | success |
| A change saved with a caveat the user or an officer must fix: `/nickname enabled:true` by the server owner (the sync it turns on can't take effect), no FC linked (leader role, ledger channel, officer rank), no officer rank (officer role, `adopt_holders:false`), no Officer role (officer rank), no Guest role (review channel, guest grant) | warning |
| A change saved while Discord changes are paused | pending, titled "Saved, Discord changes paused" (errors-and-style#26), unless something is also blocked or failed |
| Any other view showing `‖ PAUSED` | pending, unless something is also blocked or failed |
| Officer `/sync status` overview | pending while runs are active or anything is queued, even with a failed job (guests#44); warning only when the view is focused on blocked or failed work (#45) |
| A no-op result ("already set", "= NO CHANGE") | info, except the approved neutral cards "No correction needed" and "Nickname sync already off" |
| A time-bound refusal (cooldowns, rate limits, busy, shutdown, the Check again throttle) or a token not yet visible | pending; the time-bound ones add a Try again field (a relative time when known, otherwise "shortly") |
| A harmless refusal: a feature not set up yet (members), closed applications, no application needed | info |
| A refusal the user or an officer can fix: input, not found, ambiguous, out of date, ledger state, FC membership, officer setup, blocked, upstream | warning |
| A permission refusal, an ownership conflict or an unexpected error | error |

## Status markers

Status markers describe saved, queued and delivered work. They are plain Unicode glyphs in inline code, always followed by a word, so Discord never turns them into emoji and color is never the only signal.

| Marker | Meaning | Stored job state |
| --- | --- | --- |
| `✓ DONE` | Discord confirmed it | `succeeded` |
| `• SAVED` | Committed to the database | (the transaction, not a job) |
| `… QUEUED` | Waiting for the worker | `queued` with no `last_error` |
| `… IN PROGRESS` | A worker is running it | `running` |
| `↻ WAITING` | A retry is scheduled | `queued` with a waiting code (`ordered`, `busy`, `cooldown`, `superseded`, `lease_lost`: "next"), or any other code ("retrying") |
| `! BLOCKED` | An officer must fix a permission or setting | `blocked` |
| `‖ PAUSED` | Discord changes are off until activation, or for the deployment | `disabled` |
| `✗ FAILED` | Stopped and will not retry | `failed` (`dm_blocked` adds "the decision still stands") |
| `= NO CHANGE` | It was already that way | (a no-op result) |
| `– SKIPPED` | There was nothing to do | `succeeded` with a `skipped` result |

Completion words (applied, posted, sent, secured) belong only to `✓ DONE`, and only a view that reads stored jobs back (`/sync status`, `/guest status`, `/ledger balance` and `history`) can show it.

`/config validate` uses a separate health-check vocabulary, never mixed with the markers: `[OK]`, `[WARN]`, `[FAIL]`, `[OFF]` and `[WAIT]` (configuration#7–#9). Awaiting activation is `[WAIT]` where configuration#9 shows it, and `[WARN]` marks the warnings configuration#8 shows, including `ENABLE_EFFECTS=false` and a review channel without a Guest role. The one other place these tokens appear is `/setup`'s approved Channel access line (configuration#37).

### Job lines

The approved job line (errors-and-style#28) is shared by `/guest status`, `/sync status` and `/ledger balance`:

- **Members** see the marker, a label and plain words: `` `↻ WAITING` Ledger post (retrying in 7 minutes) ``. They never see job IDs, attempts or diagnostics. The labels are in `JOB_KIND` (`jobs.ts`): Role update, Server-wide role check, FC roster check, Departure confirmation, Character profile refresh, Channel access, Role layout, Ledger post, Guest review message, Decision DM, Officer notice.
- **Officers** see the marker, the raw job kind and the 8-character job ID, then the attempt and the next time, with the stored diagnostic quoted underneath and cut to 150 characters: `` `↻ WAITING` reconcile.user `1a2b3c4d` · attempt 3 · next in 7 minutes ``.
- At most 10 lines are shown, then "…and N more". Long officer lists split across fields named "Needs attention (1/2)", each sized to the 1,024-character budget (C7).

## Content rules

### Gil, numbers and times

- Gil is exact, digit-grouped and carries its unit: **10,005,000 gil**, never 10M. `gilText` and `signedGilText` format the `bigint` directly, never through `Number()`.
- Changes are signed with `+` or U+2212 `−`: **+10,005,000 gil**, **−2,500,000 gil**. An opening balance is unsigned. Counts are grouped too ("1,204 members").
- Times are Discord timestamps only: `<t:…:R>` for deadlines and freshness, `<t:…:f>` for record times, `<t:…:D>` for dates. A deadline shows both relative and absolute times. ISO strings never appear.

### Names, IDs and mentions

- User text is escaped for where it renders and cut on grapheme boundaries: 100 characters for character names, 300 for notes and reasons in fields. Titles and footers use their own plain-text escaping.
- A character reads "Example Character @ Diabolos". Ledger titles use the plain FC name (`fcTitleName`, C10); the tagged name (`fcName`) appears only where an approved card shows it, such as the receipt footers of ledger#0 and #2.
- `<@id>`, `<#id>` and `<@&id>` render names and never ping inside embeds. Every message is sent with `allowedMentions: { parse: [] }`, which the router forces last. Officers also see a member's raw ID in code, because a departed user renders as unknown.
- Titles never contain IDs. Members never see job, run or entry UUIDs unless they need one as input. Full IDs stay complete and copyable wherever a follow-up option needs them (`run_id`, `application`, `entry`, `before`), in inline code unless the approved card shows them plain (the `/refresh` run, guests#36), and `shortId` is only a label. Member `/sync status` run lines show only the short label, so their footer names where the full `run_id` comes from (the `/refresh` reply) instead of treating the label as input. Member receipts show the entry number `#seq`; officer receipts, history and posts carry the full entry UUID (LEDGER-08).

### Saved versus delivered (UX-02)

An immediate reply reports only what its transaction committed. Discord work it queued is described by the effects field (`effectsField` in `jobs.ts`), which branches on the result's `effectsMode`:

| `effectsMode` | Effects field | Receipt |
| --- | --- | --- |
| `live` | `` `… QUEUED` Role update `` | The group's success card; "shortly" is allowed |
| `awaiting_activation` | `` `‖ PAUSED` until activation `` (officers add "Why: Server activation pending") | The pending paused-save card |
| `deployment_disabled` | `` `‖ PAUSED` Discord changes are off for this deployment `` (officers add "Why: Disabled globally (ENABLE_EFFECTS)") | The pending paused-save card, saying they apply once changes are turned back on: a restart with `ENABLE_EFFECTS=true` requeues the held work of every activated guild |

The **paused-save card** (errors-and-style#26) keeps the receipt's own sentence about what was saved and its own facts, and adds the `• SAVED` and `‖ PAUSED` fields and the footer "Check progress any time with /sync status". A paused view never says `… QUEUED` for Discord work or "shortly"; the Lodestone roster read, which still runs while Discord changes are paused, is the only work it may show as queued. Roles are never promised: a new link's Member role is the roster-evidence field on the success card (`↻ WAITING for the next roster check` when the roster is stale), never a separate notice or title.

Held work resumes in three ways, and each keeps one row per dedupe key (`requeueParked` in `queue.ts`): activation, any `/config` change, and a restart with `ENABLE_EFFECTS=true`, which requeues `disabled` work of activated guilds. Requeued work drops its stored paused diagnostic, so it reads `… QUEUED` (and "Queued" in `/ledger`) until it runs, never "retrying". A superseded duplicate's sync runs follow the row that carries its work, so a run never reads Completed before that work has run. A `‖ PAUSED` row that is still there while effects are live has nothing coming to resume it, so it never promises an activation: members read "held from an earlier pause, so ask an officer", a ledger post "held from an earlier pause" with the `/config` step that re-queues it, the officer `/guest status` record "Held from an earlier pause" with the same step, and the officer `/sync status` overview lists it under Needs attention with the `/config` step that re-queues it, never the "Nothing to fix" step.

A receipt reports only what was saved, never Discord work that can't happen: the server owner's first `/verify` link reads "Discord doesn't let bots change the server owner's nickname." in its Nickname field, as `/main` does. Both stay success: the owner line is information, and only `/nickname enabled:true` by the owner is the warning caveat card.

### Audiences

`audienceOf()` is the only source of the audience: **member**, **officer** (officer access), or **manager** (server manager with Manage Roles). The router derives the viewer once, from the same freshly resolved actor the services authorize against, before authorization, so a refused member still gets member wording. Presenters choose wording and detail from it but never grant anything; the service remains the only authorization and filtering boundary.

- Replies sent before the actor is known (DMs, bots, a restricted guild, an unknown command or button) use member-safe wording.
- `/characters` and `/guest status` use the officer layout only when an officer names a member; an officer's own record uses the personal view.
- Link provenance differs by audience, as both approved cards show: members read "Verified with a Lodestone token", "Assigned by an officer" and "Imported from the previous bot" (characters#18); officers read "Lodestone token", "Officer assignment" and "Imported link" (#20).
- Members never see officer reasons, reviewers, job details or another member's owner. The one exception is an applicant's own denial reason (C6), capped at 300 characters in the decision DM and in their `/guest status`. Grant and revocation reasons stay officer-only.
- Officer and leader role changes, the officer rank, the role layout and `/officer` render to managers, since only managers can make them.
- Replies are ephemeral. The only exception is the observed test guild when `PUBLIC_TEST_RESPONSES` is set, which the router applies; a handler never sets flags.

## Buttons and Full details (JSON)

Every button custom ID is built and parsed by one codec, `src/discord/custom-ids.ts`. IDs read `<prefix>:<action>[:<selector>…]`, are at most 100 characters, and carry only selectors (an FC, an entry number, a character, a run, an application or a target member), never the clicker. Every click resolves a fresh actor and is authorized again, because a button on a public test-guild reply can be pressed by anyone. Parsing is strict; a malformed or retired ID is the stale-control card. Grammars only grow, and a retired action keeps parsing for at least one minor release. The component prefixes are `config`, `details`, `guest-apply`, `guest`, `ledger`, `sync` and `verify`.

| Button | Where | Acknowledgement |
| --- | --- | --- |
| Open Lodestone profile, Edit Character Profile (links) | `/claim` | — |
| I've added it — verify now (`verify:claim`) | `/claim` | new reply, so the token message is never edited |
| Check again (`verify:again`) | the pending-token card | updates its own card; refused within 15 seconds of that card's last render |
| View history (`ledger:open`) | `/ledger balance` | new reply, so the balance stays visible |
| Newer, Older, Latest (`ledger:newer`, `ledger:older`, `ledger:latest`) | `/ledger history` | updates the page in place; Newer and Latest are enabled whenever a newer entry exists (C1), and Latest is hidden on the newest page (ledger#21, #23) |
| Run health check, Re-check (`config:validate`) | `/config show`, `/config validate` | updates the view in place with the checklist |
| Check sync status (`sync:status`) | `/setup` | new reply |
| Full details (JSON) (`details:*`) | officer read views below | new reply with a file |
| Approve, Deny (`guest:approve`, `guest:deny`) | the guest review message | unchanged since 2.12.0 |

A component updates its own message only when that message is ephemeral or was created for the presser; anyone else's click gets a new reply. A failure during an update is a private follow-up and leaves the view alone, except the pending-token card, which re-renders the same screen.

**Full details (JSON)** is the only way a result reaches Discord as JSON. It is offered only on officer read views the approved style guide lists that summarize or cut records: `/ledger balance` and the officer `/ledger history`, the officer `/sync status` overview and run detail, and `/guest status member:` and `/characters member:` for an officer. `/config show` and `validate` keep their drawn Run health check and Re-check rows without it, because their embeds are complete. The button re-runs the read with the presser's fresh authorization and replies with `tarubot-<view>.json` attached and a "Full details · <view>" embed; `dataReply()` refuses a member viewer even if the router did not. It is never offered on change results, and the file never contains tokens or application answers.

## Failures

Every refusal and error is rendered by `failureReply()` from the failure catalog in `src/domain/failures.ts`, keyed by code and typed detail, never by message text. Group presenters never catch failures, so each concept has one title and tone however it is reached; the interaction scope only picks wording such as the root command, the Example line or the no-change sentence. The approved Failure message is written at its throw site, so logs, job `last_error` and replies share one wording.

Anatomy: the category's tone; the concept's title; the approved message (or member-safe catalog text); the no-change sentence where the concept's approved copy has one; one next-step field; officers' Diagnostic and Affected fields; and the footer `Code <code> · Ref <interaction ID>`. Ref is the interaction ID, which is also the `operation` field of the log entry ([OPERATIONS.md](OPERATIONS.md#reply-references-and-error-codes)). An unexpected error never shows its own text; after a command's work ran it says the request may have been saved, and ledger mutations warn against recording gil twice.

### The no-change sentence

C2 takes the sentence from each concept's approved copy:

- "Nothing was changed." appears on refusals of change commands whose approved copy carries it, and on the read-only `/config validate` and Re-check cards on every verdict.
- The insufficient-funds refusal says "Nothing was recorded." (ledger#7); other ledger refusals say "Nothing was changed." as their approved copy does (errors-and-style#1).
- `/setup` says "Anything already created is reused when you run /setup again."
- The sentence follows the concept, not whether the command reads or changes. A refusal on `/ledger balance`, `/ledger history`, `/sync status`, `/config show` or `/characters` carries it like any other (errors-and-style#1, #2 and #4). These omit it: context and test-instance refusals, "Only your own records", the officer setup card, the closed-applications card, the officer "Linked to another member" card, proofs and the biography card, "No application needed", unexpected errors, and a raw Discord error that may have hit partway through (outside `/setup`). No description repeats it when it already says nothing was saved or changed.
- A retry-timed refusal (the "Please wait a moment" family and the Lodestone, member-list and join-details cards) puts its "Try again …" after the sentence, as errors-and-style#10 and #24 draw it. Other concepts keep their next step where their approved copy puts it.
- No success reply says it.

### Failure catalog

Codes are grouped into categories; each category logs at one level. A concept's title can depend on the detail (which scope refused, which setting is missing) and on the audience; where the tone differs by audience, the Tone column reads members / officers.

| Concept | Codes | Category | Members see | Officers see | Tone | Log level |
| --- | --- | --- | --- | --- | --- | --- |
| input | `input`, `invalid_data` | input | Check your input | Check your input | warning | info |
| forbidden.officer | `forbidden` {officer} | forbidden | Officers only | Officers only | error | info |
| forbidden.owner | `forbidden` {owner} | forbidden | Only your own records | Only your own records | error | info |
| forbidden.manager | `forbidden` {manager, manage_roles, manage_channels} | forbidden | Server managers only | Server managers only | error | info |
| forbidden.hierarchy | `forbidden` {hierarchy} | forbidden | That role is above yours | That role is above yours | error | info |
| forbidden.membership | `forbidden` {membership} | forbidden | FC membership needed | FC membership needed | warning | info |
| forbidden.context | `forbidden` {human, current_member} | forbidden | Not available here | Not available here | error | info |
| forbidden.test_guild | `forbidden` {test_guild} | forbidden | Test instance | Test instance | error | info |
| setup.guild | `setup` {guild} | setup | TaruBot isn't set up here yet | Finish setup first | info / warning | info |
| setup.fc | `setup` {fc} | setup | No Free Company linked | Finish setup first | info / warning | info |
| setup.ledger | `setup` {ledger} | setup | Ledger isn't set up | Finish setup first | info / warning | info |
| setup.officer_role | `setup` {officer_role} | setup | TaruBot isn't set up here yet | Finish setup first | info / warning | info |
| setup.guest_applications | `setup` {guest_applications, guest_role} | setup | Guest applications are closed | Guest applications are closed, with the commands that open them | info | info |
| not_found.* | `not_found` {resource} | not_found | Character not found, Free Company not found, Link not found, Member not found, Application not found, Entry not found, No ledger for that FC, No active claim for this character, That FC isn't linked, Not found | (same) | warning | info |
| ambiguous.* | `ambiguous` | ambiguous | Several characters match; Choose which role to use; Choose which channel to use | (same) | warning | info |
| ownership_conflict | `ownership_conflict` | conflict | Linked to another member | Linked to another member, with the owner on `/assign` (O3) | error | info |
| fc_linked | `fc_linked` | conflict | Another FC is linked | Another FC is linked | warning | info |
| initialized | `initialized` | conflict | Opening balance already set | Opening balance already set | warning | info |
| uninitialized | `uninitialized` | conflict | Opening balance not set | Opening balance not set (a different next step) | warning | info |
| insufficient_funds | `insufficient_funds` | conflict | Not enough recorded gil | Not enough recorded gil | warning | info |
| stale.settings | `conflict`, `superseded`, `stale` | stale | Settings changed — try again | Settings changed — try again | warning | info |
| stale.control | `stale` {control} | stale | This control is out of date | This control is out of date | warning | info |
| stale.form | `stale` {form, join} | stale | Please reopen /apply | Please reopen /apply | warning | info |
| stale.review | `stale` {review} | stale | This review message is out of date | This review message is out of date | warning | info |
| expired | `expired` | stale | Token expired during verification | Token expired during verification | warning | info |
| pending_proof | `pending_proof` | wait | Token not on the Lodestone yet | Token not on the Lodestone yet | pending | info |
| wait.claims_own | `cooldown` {claims_own} | wait | Too many unfinished claims | Too many unfinished claims | pending | info |
| wait.apply | `cooldown` {apply} | wait | You can apply again later | You can apply again later | pending | info |
| wait.retry | `cooldown`, `rate_limited`, `busy`, `transient`, `stopping` | wait | Please wait a moment | Please wait a moment | pending | info |
| eligible | `eligible` | eligible | No application needed | No application needed | info | info |
| upstream.lodestone | `unavailable` | upstream | The Lodestone isn't responding | The Lodestone isn't responding, with the diagnostic | warning | warn |
| upstream.lodestone_incomplete | `incomplete` | upstream | Lodestone results incomplete | Lodestone results incomplete | warning | warn |
| upstream.lodestone_page | `invalid_response` | upstream | Unexpected Lodestone page | Unexpected Lodestone page | warning | warn |
| upstream.biography | `invalid_response` {biography} | upstream | Couldn't read the biography | Couldn't read the biography | warning | warn |
| upstream.member_list | `incomplete` {member_list} | upstream | Couldn't read the member list | Couldn't read the member list | warning | warn |
| upstream.join_context | `incomplete` {join_context} | upstream | Couldn't read your join details | Couldn't read your join details; "Couldn't read that member's join details" when it names someone else (an `/assign` or `/officer` target, an applicant) | warning | warn |
| upstream.discord | `unavailable` {api}; raw Discord 429 and 5xx | upstream | Discord isn't responding | Discord isn't responding | warning | warn |
| blocked | `blocked`; raw Discord 50001, 50013, 10003, 10011 | blocked | Server setup issue | Discord permissions need attention, with Affected and Then, plus How to fix when the refusal is about TaruBot's role position or channel permissions (errors-and-style#8) | warning | warn |
| paused | `disabled` | paused | Discord changes paused | Discord changes paused | pending | warn |
| unexpected | `unexpected` and the internal codes (`idempotency_conflict`, `invalid_job`, `lease_lost`, `ordered`, `dm_blocked`, `configuration`, `schema`, `test_plan`, `writer_lease`) | unexpected | Something went wrong | Something went wrong | error | error |

Raw Discord Unknown Member and Unknown User errors (10007, 10013) in an interaction are `forbidden` {current_member}, "Not available here". A malformed Lodestone ID in sidecar output is `invalid_response` ("Unexpected Lodestone page"), never input, and a member list with any member lacking a join time is the member-list card, as is a full member request Discord rate limits (gateway `RATE_LIMITED`) or stops answering (`GuildMembersTimeout`). Every other error that is not a `Failure`, including a `ZodError`, is `unexpected`, with its class in the log's `source` field. Internal codes keep their own code in the footer while showing the unexpected card.

Every time-bound refusal (cooldowns, rate limits, busy, transient and stopping) has a Try again field: a relative time (`<t:…:R>` with the absolute time) when the failure carries a retry deadline, "in a few seconds" when that deadline is under five seconds away, otherwise "shortly" (the `busy`, `stopping` and `transient` throws carry none). The input card's Example field shows the command with the option the user got wrong. A free-text member option asks to "Paste a Discord user ID or @mention"; "Pick one from the suggestions" is only for autocomplete options. `note()` checks name their option: "Add a note of 1–1,000 characters.", "Add a reason …", "Add a rank …".

## Posts and DMs

Channel posts and DMs are built with `post()` from stored data by the gateway, so jobs pass views instead of message text:

- A **ledger post** reads `<Operation> · <amount>` and is colored by operation as a feed signal: deposit success, withdrawal and opening balance info, correction warning (receipts stay success). It shows the full escaped note, the new balance (a correction also shows the previous balance and the entry it corrects), who recorded it and the entry number, with `Entry <uuid>` in the footer and the entry's own time as the timestamp. Posts have no text content and nothing per attempt, so a retry under the unchanged `ledger:<entry>` nonce sends the same message.
- The **guest review message** is one embed, "Guest application", then "Guest application · approved", "· denied", "· cancelled" or "· no longer needed" once decided, with Approve and Deny disabled. Its first edit clears the pre-2.14.0 text.
- The **decision DM** speaks to the applicant: approved, or not approved with the officers' reason and when they may apply again.

Two messages are documented exclusions from the presenters:

- **`officer.notify`** stays escaped plain text in 2.14.0. This is a deferral, not a limitation: its job payload can gain optional fields under the current payload version, but 2.15.0 redesigns officer notices with operational alerting (OPS-11), so 2.14.0 does not restyle them first.
- The **DevBot test-session announcement** (`src/application/test-session.ts`) already sends an embed, with its own layout: a content line above one embed whose three checklist fields its schema sizes to fit. It is not a user-facing reply, so it keeps that layout.

## Deviations from approved

Every place a shipped reply differs from a drawn approved card, and the authority for it. Sample data (Refs, row counts, commit lists) is not a deviation. Each row is flagged in the 2.14.0 pull request.

| Approved card | What ships | Why | Authority |
| --- | --- | --- | --- |
| configuration#18 | Drawn as a success card whose Discord changes read "Queued · applies after activation". Live, it ships as drawn with `` `… QUEUED` Server-wide role check ``; paused, it is the pending "Saved, Discord changes paused" card. | The drawn card shows a paused save as success, which errors-and-style#26 contradicts. | Owner decision O2 |
| characters#31 | The officer card on `/assign` adds a "Linked to" field with the owner's mention and raw ID. Members' cards are unchanged. | The owner asked officers to see the current owner. | Owner decision O3 (2026-09-23) |
| guests#7, #43, #44 | Their job lines use the errors-and-style#28 component: markers, and for officers the raw job kind and short ID (`` `✓ DONE` reconcile.user `4d3c2b1a` ``), instead of the plain "Role update · Done" words drawn on those cards. Role removals use U+2212. | The drawn cards contradict #28; one job line serves every status view. | Owner decision O2 (officer lines show raw kinds as in #28) |
| guests#43 | Paused-only member work ships as pending instead of the drawn warning. "Paused-only" means every outstanding job is `‖ PAUSED`, every run is completed or paused, and nothing is blocked or failed. Runs read "Paused: N of M done", and the footer is the in-progress "Details for one run: /sync status run_id: with the full ID from your /refresh reply" instead of "Ask an officer if this doesn't clear." Blocked or failed member work still ships as drawn (warning, "Ask an officer" footer). | The drawn state groups paused with blocked and failed. The C4 tone table makes a paused view pending unless something is also blocked or failed. | Amendment C4 |
| characters#20, guests#7 | Add **Full details (JSON)**, which these drawn cards do not show. `/config show` and `validate` do not offer it, although the style guide's list names them, because their drawn button rows (#4, #7–#9) don't. | The drawn cards and the style guide's JSON list disagree. | Owner decision O2 (JSON only where the style guide lists it); please confirm the `/config` omission |
| errors-and-style#1 | The note check reads "Add a note of 1–1,000 characters.", not "Add a **note** of 1–1,000 characters that explains the transaction." | One labelled `note()` wording serves notes, reasons and ranks. | Amendment C10 (the approved Rewrites text) |
| errors-and-style#27 | The footer is `Code unexpected · Ref <id>`, and "Share the reference with an officer." moves into a member "What you can do" field; the Reference and Before retrying fields stay. | The house-style board and the Errors board say every error ends with its code and reference; the drawn #27 footer does not. | Needs owner sign-off |
| errors-and-style#26 | Drawn as a generic "(any change)" notice. Each change receipt saved while Discord changes are paused ships as this card, with its own sentence about what it saved in place of "Your change is saved." The drawn sentence follows it, except on two receipts whose held work is not a role, nickname or channel change. A ledger receipt's second line says when its post goes out. The /apply receipt says when officers see the application. The receipt's own fact fields come after the drawn Saved and Discord changes fields, and /setup keeps its approved Check sync status button (configuration#37), which the drawn #26 has no components for. Officers and managers get "Why: Server activation pending", or "Why: Disabled globally (ENABLE_EFFECTS)", as a second line of the Discord changes value rather than a separate field. While the deployment has effects off, the sentence and the field say "Discord changes are off for this deployment" instead of "until activation". | One generic card can't say what each receipt saved, and the drawn card has no officer or deployment-off variant. | Owner decision O2 (paused saves use the pending #26 card); the reply-specs note on notice-effects-paused (officer Why); amendment C5 (all three effects modes) |

## Resolutions record

A short record of how the 2.14.0 plan resolved design conflicts, with the amendments applied.

- **Layout.** Pure group presenters live in `src/discord/presenters/<group>.ts`; the primitives are split into style, format, reply, audience, jobs, labels, controls and failure; the codec is `src/discord/custom-ids.ts`. The pre-2.14.0 `src/discord/replies.ts` JSON dump is deleted.
- **Return type.** A nominal `Presented` only the `reply.ts` builders can create. A transitional `Presented | InteractionEditReplyOptions` union let each group migrate in its own commit and is gone in 2.14.0.
- **Failures.** One central, code-keyed `failureReply` with a typed `FailureDetail` union. Every input failure is "Check your input"; the option detail only selects the Example.
- **Code renames.** `funds` → `insufficient_funds` (below zero only; an overflow is `input`); `pending` → `pending_proof`; idempotency-key collisions → `idempotency_conflict`; `conflict` → `ambiguous` or `fc_linked` where those apply; `input` or `forbidden` → `not_found` or `stale` where those apply. FC membership stays `forbidden` {membership}; the biography failure stays `invalid_response` {biography}. Non-Failure errors log as `unexpected` with their class in `source`.
- **Log levels.** Expected refusals log at info so a Ref stays findable at the default level; upstream, blocked and paused at warn; unexpected at error.
- **Effects state.** An additive `effectsMode` (`live`, `awaiting_activation`, `deployment_disabled`) on every change result, `/apply` included (C5), beside the existing `effects`.
- **Paused saves.** The pending errors-and-style#26 card, not a success card with a PAUSED field (O2, replacing the plan's success-tone resolution). The approved Pending swatch wording is kept.
- **Ownership conflict.** Error tone, "Linked to another member", as approved in characters#31; officers on `/assign` also see the owner (O3).
- **Unexpected errors.** Footer `Code unexpected · Ref <id>`; the Reference field stays; members get "Share the reference with an officer." and officers "Find this reference in the bot logs (operation field)."
- **Health tokens.** The bracket family stays separate from the markers. `[WAIT]` and `[WARN]` appear exactly where configuration#9 and #8 use them (O2). The Guest applications `[OFF]` line reads "closed, so /apply refuses".
- **Job lines.** The errors-and-style#28 component is canonical: raw kinds, short IDs, attempts and next times for officers, labels for members (O2, replacing the plan's labels-for-officers resolution); diagnostics are cut to 150 characters.
- **Provenance labels.** Per audience, as characters#18 and #20 show.
- **Officer layouts.** Only when an officer names a member.
- **Component acknowledgement.** A synchronous `acknowledge` option; updates only for ephemeral or presser-owned sources; custom IDs never carry viewer IDs.
- **Custom-ID grammar.** One codec; prefixes `config`, `details`, `guest-apply`, `guest`, `ledger`, `sync`, `verify`; one officer-only `details` component replaces per-feature JSON actions.
- **Full details (JSON).** See [above](#buttons-and-full-details-json) and the deviations table.
- **View history** opens a new reply; the pager edits in place.
- **Buttons.** Every approved button ships in 2.14.0. `/refresh` has none, as approved (guests#36).
- **Pre-modal check.** `beforeModal` returns `Presented | null`, fails open within 1.5 seconds, is never reported, and the acknowledgement is spread last so its flags can't be overridden.
- **Channel posts.** The Discord port carries view data and the gateway renders it; jobs never import presenters. Ledger posts are embed-only with content `''`.
- **officer.notify** stays plain text until 2.15.0 (OPS-11) — a deferral; the payload could gain optional fields.
- **Guest application gate.** Open only when both the review channel and the Guest role are set, through one domain predicate shared by the pre-form check, `apply()`, activation and the preview tool (C9).
- **Stale titles.** "This control is out of date" for any obsolete command or button; "Please reopen /apply" for a bad form or missing join context before the form; "Couldn't read your join details" when the gateway lacks the viewer's join time ("Couldn't read that member's join details" for someone else's); "This review message is out of date".
- **Ambiguity titles.** "Several characters match"; "Choose which role to use" or "Choose which channel to use".
- **Setup family.** Members see info titles naming the missing piece; officers and managers see "Finish setup first" with the exact commands. The closed-applications case keeps its title and adds an officer next step.
- **Claim and verify titles.** "Too many unfinished claims" and "Please wait a moment" (pending), "No active claim for this character", "Token expired during verification". The copy says claim and token, never challenge.
- **No-change sentence.** See [above](#the-no-change-sentence) (C2).
- **Display helpers** are named `gilText` and `signedGilText`, distinct from the domain `gil()` parser.
- **Tests.** One catalog (`tests/fixtures/replies/`), `expectHouseStyle`, the reply guard and the consistency test, plus the failure, reporting and router tests.
- **Ledger paging.** `older` is exact from an 11-row read, `newer` from an ascending lookup; page = ceil(above/10)+1 and pages = ceil(above/10) + ceil((total−above)/10), so a hand-typed cursor numbers correctly (C1).
- **Member `/refresh`** keeps the full run ID, as approved in guests#36, in the `/sync status run_id:` line and the "Run" footer.
- **Application autocomplete** labels read "display name or ID · submitted YYYY-MM-DD · short ID", with the full UUID as the value, filtered in-process over the newest 25 pending applications (C12).
- **LEDGER-08.** Member receipts show `#seq`; officer receipts, history and posts carry the full UUID.
- **Check again** is throttled at 15 seconds from the source message's own timestamp, which needs no state. The throttle applies only when the click re-renders that card (it is private or the presser's own), the same predicate the router uses (`rendersSourceInPlace`); a click on someone else's public test-guild card replies with the presser's own check, as `/verify` does.
- **Token state.** The pending-token card is characters#10 as drawn, with Check again; its deadline stays on `/claim`'s card (the plan's extra Token expires field was dropped under O2).

The 27 inconsistencies the reply specs recorded are pinned one by one in `reply-consistency.test.ts` ("resolved inconsistencies"). The states the specs listed as missing are implemented by the presenters above and exercised through the catalog, the router and command tests.
