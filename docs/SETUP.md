# Lobby onboarding, role bootstrap, and FC ranks

## Bootstrap

```text
/setup fc_id:9232097761132958152 prefix:DevBot officer_rank:Officer lobby:#lobby officers:#officer-chat
```

`/setup` requires effective **Manage Server**, **Manage Roles**, and **Manage Channels**. It creates or reuses four distinct ordinary roles: Member, Guest, Officer, and FC Leader, plus the lobby and officer text rooms. Running it explicitly enables the channel-access policy below. Roles are created with zero server permission bits and receive channel-specific access. Every adopted role must be manageable by the bot and, except for the guild owner, below the invoking manager's highest role. Onboarding roles cannot carry Administrator, Manage Server, Manage Roles, or Manage Channels.

The optional prefix defaults to `DevBot` in a configured test guild and to an empty prefix otherwise. In this shared development guild, the resulting names are **DevBot Member**, **DevBot Guest**, **DevBot Officer**, and **DevBot FC Leader**.

Configured IDs are preferred on reruns, so renaming an already configured role does not create duplicates. Otherwise setup looks for a unique match to either the requested prefixed name or the canonical **Member**, **Guest**, **Officer**, or **FC Leader** name, using case/Unicode/whitespace normalization. A prefix therefore does not hide existing unprefixed roles. A reused canonical role is renamed to the requested prefixed name while retaining its ID, permissions, and assignments. An explicitly configured custom name is preserved. Only a missing role is created; ambiguous matches require an explicit `/config roles` selection.

Setup commits the selected role/channel IDs, first-observed channel snapshots, and queued membership, layout (while the role-layout switch is on), and access work together. Discord resource creation precedes that transaction; a retry reuses created resources. Existing lobby reparenting and permission enforcement begin only after snapshots are persisted. To correct a previous duplicate binding, select the original role with `/config roles` before rerunning `/setup`. A different FC still requires explicit unlinking first. After onboarding is enabled, role bindings require manager authority and all four must remain configured; select replacements rather than unsetting them.

FC ID and officer rank are optional. Omitting them preserves existing values; a fresh setup can provision roles before linking an FC. Existing human holders of an adopted Officer role receive audited manual grants. Imported guild activation remains a separate cutover step, and `/setup` is not run in the imported production guild at launch: it would enable onboarding, open `/apply`, and adopt every Officer-role holder (see [Officer authority](#officer-authority) for the non-adopting binding).

Unset officer-notification and guest-review destinations default to the selected officer room. `/setup` also switches guest applications on, including in a guild where they were switched off, so `/apply` opens. Existing explicit destinations are retained. Configure the ledger and any desired overrides afterward:

```text
/config ledger channel:#dev
/config officer_notifications channel:#dev
/config guest_applications channel:#officer-chat
/config validate
```

## Channel visibility

| Current access | Lobby | Ordinary channels | Officer room / existing private areas |
| --- | --- | --- | --- |
| Newcomer without access roles | Yes | No | No |
| Member or Guest | No | Yes | No |
| Officer or FC Leader, including with Member/Guest | Yes | Yes | Yes |
| This bot | Yes | Yes | Yes |

Discord's guild owner and Administrator permissions inherently bypass channel restrictions. Manage Server alone does not bypass visibility; ordinary managers need the appropriate access role to see staff rooms.

The lobby is a top-level text channel. Newcomers can read history, chat, and use application commands there; the lobby's everyone overwrite denies thread creation. Text, announcement, voice, stage, forum, media, and category channels all receive the visibility policy. Threads retain Discord's parent-channel visibility requirement. Existing private areas are classified as staff-only from their first snapshot, including children of staff categories; subsequent repair preserves that classification across role changes. For newly observed closed channels after onboarding, any explicit View Channel allow or deny is privacy evidence, regardless of role/member target. A channel closed only by the guild default, with no visibility overwrites, remains ordinary.

On reruns, saved channel IDs take precedence. Otherwise setup reuses a unique `#lobby`, prefers a recognizable private officer/staff room (starting with `#officer-chat`), then a sole private text room, then a recognizable officer/staff name. Missing rooms are created as `#lobby` and `#officer-chat` with their intended overwrites already installed. Ambiguity requires explicit `lobby`/`officers` selections; the two rooms must be distinct guild text channels outside the reserved scope below.

### Community resources outside onboarding

Discord's configured **community-updates channel** (`public_updates_channel_id`) and its parent category are excluded by ID. They are not candidates for lobby/officer rooms, do not need to be viewable by the bot, are not added to onboarding recovery snapshots, and receive no onboarding permission or parent changes. Protecting the category also prevents its permission propagation from changing the reserved child. The visibility matrix applies to managed areas; these excluded resources retain their existing community policy.

Each reconciliation captures the channel inventory once. Before writes, it rechecks the protected binding/parent against the connected Guilds Gateway cache; a changed binding/parent, missing metadata, or disconnected/unavailable guild invalidates that pass. Hidden community channels cannot be read individually under limited permissions, so they are never force-fetched per target. Guild-update events queue reconciliation when the binding changes. A saved lobby/officer binding that becomes reserved requires `/setup` with a separate room. `/sync status` results include the excluded IDs.

Unchanged targets need no individual REST read. Changed targets are fetched immediately before mutation and again for readback. A full final snapshot verifies the managed set and protected scope. An ordinary pass uses two full channel-list requests independent of guild size; lowering the shared everyone default adds one authoritative catalogue check. This avoids repeated full-list rate limiting while preserving current-target reads and scope fences.

Enabling this policy makes TaruBot authoritative for **View Channel** across role/member overwrites in managed channels. Competing visibility allows/denies are normalized, including custom-role and individual-member exceptions. Other permission bits are retained except the explicit chat/command permissions needed for the lobby/staff rooms and the bot's delivery permissions. Configure integrations with the appropriate access roles. Everyone loses its guild-level View Channel default only when doing so cannot change an excluded area's visibility: each excluded channel/category must have its own explicit everyone View allow/deny. If an excluded area inherits the default, it is preserved and managed-channel overwrites enforce onboarding instead. In that case a new default channel may be visible until its creation event is reconciled. Administrators can also create explicit public overwrites; channel events repair them rather than intercepting Discord's creation request.

The bot needs guild-level Manage Channels/Manage Roles and its own View Channel permission, plus View Channel/Manage Channels/Manage Roles in each existing managed channel. It checks these before enforcement; the reserved community resources are omitted from these checks. Lobby visibility is established before any everyone default change; managed categories are handled before leaf channels. Each remote mutation rechecks job ownership, configuration revision, activation, and protected scope. The managed channel set and required rooms are verified afterward. Partial failure leaves durable work and original snapshots available for a restart/retry; successful no-op passes avoid repeat writes.

Channel create/update/delete events coalesce `channels.access` work without enumerating all members. Startup, guild rejoin, role changes, configuration changes, and refresh also schedule repair; refresh status includes its access child job. Use `/sync status` to see completion or a blocked capability. Run `/setup` to repair missing bindings, and `/refresh` after correcting external permissions.

`channel_access_policies.original_state` retains the first channel overwrites, type, name, and parent; `guilds.access_everyone_before` retains the original everyone permission bitfield. Setup and successful enforcement are audited. Take a database backup before first activation. For operator recovery, stop the writer and inspect those original snapshots and the setup audit's created-resource flags. They provide the evidence for a deliberate manual restore. Before restarting after a policy rollback, disable `access_policy_enabled`, increment `revision`, and audit that operator decision through the Drizzle maintenance boundary. Normal reconciliation deliberately restores the configured policy, so editing managed visibility alone is treated as drift.

## Registered visitor access (all guilds)

In every configured guild, whether or not onboarding is enabled, an **active trusted ownership link** establishes registration. Imported trusted ownership and authorized assignment are trusted links as well as profile-token verification; a pending `/claim` and a profile's FC hint never count. Access is the union over the user's links (ROLE-07):

- any character with confirmed membership in the linked FC gives **Member**;
- any such character holding the configured in-game officer rank adds **Officer**, unless that link came from a bot-only officer's assignment;
- a registered owner with no FC character gets **Guest**. With no FC linked, registration alone suffices.

Onboarding only adds channel visibility on top of these roles; a guild without `/setup` receives no channel-visibility work.

Automatic Guest is derived, not inserted as an irrevocable manual grant. Explicit Guest revocation suppresses it across restarts/rejoins, and removing the final active link removes this basis for access. Independent manual/approved/imported/grandfathered grants and former-member eligibility retain their existing rules. FC Member eligibility takes precedence even when Guest is revoked; restoring a revoked user with `/guest grant` creates a durable manual grant. `/guest reset member:MEMBER reason:EXPLANATION` (2.15.0) removes every override instead: it lifts the revocation and ends every active grant of any provenance, so FC membership and registered characters decide Guest again. Ended grants are kept as history (`guest_grants.ended_at`) and no longer confer Guest or appear in `/guest status`. First-activation grandfathering still counts an ended grant as an existing grant (basis `existing_grant`) and writes no grant for that member, so a reset before activation is not undone there; the plan's provenance lists active grants only. Like `/guest grant` and `/guest revoke`, it needs an officer. A reset is audited as `guest.reset` and reconciles the member; with nothing to remove it replies with the info `= NO CHANGE` card and audits nothing. Unknown/stale roster evidence cannot create a new automatic role; an already-held Guest role can be preserved while accepted evidence is stale. `/guest status` reports `verifiedGuestEligible` separately, and `/apply` explains when existing eligibility should be repaired by reconciliation instead.

## Unverified visitor applications

Guest applications are **open only while the applications switch is on and both a review channel and the Guest role are configured**. The switch (`guilds.guest_applications_enabled`, 2.15.0) is separate from the review channel, so closing applications no longer loses the channel. In 2.14.x, applications were open whenever a channel and the Guest role were set, and closing them meant unsetting the channel; releases before 2.14.0 checked only the channel, so a visitor could fill the form and then be refused.

Imported guilds start switched off: the importer keeps the legacy review channel with the switch off, and activation leaves applications off unless it is run with `--guest-applications open`, which needs that channel and validates it first. While closed, `/apply` answers "Guest applications are not open in this server. Ask an officer about Guest access." before its form opens, and a form opened earlier is refused the same way at submission. Visitors can still get Guest by verifying a character or through an officer's `/guest grant`. The owner has deferred the form's live acceptance until after launch.

Officers control applications with `/config guest_applications`, whose options combine in one call and are saved in one configuration revision:

```text
/config guest_applications enabled:true
/config guest_applications enabled:false
/config guest_applications channel:#officer-chat
/config guest_applications enabled:true channel:#officer-chat
/config guest_applications unset_channel:true
```

- `enabled:true` opens applications deliberately. It needs a review channel and the Guest role; switched on without one of them, the switch is saved and the reply names what is still missing, while `/apply` stays closed. After an import, reopening is `/config guest_applications enabled:true`, because the legacy channel is kept.
- Switching on first validates the channel that will take applications: the one named in the same call, otherwise the kept one, such as an import's legacy channel. If that channel was deleted or TaruBot cannot post there, the call is refused (`blocked`) and nothing is saved; name a working channel with `enabled:true channel:#…`. If another change lands between that check and the save, so applications would take a channel this call did not validate, the call saves nothing and asks to be run again (`conflict`).
- `enabled:false` closes applications and keeps the review channel. It never validates the kept channel, so a deleted review channel cannot block closing. Applications already waiting stay reviewable in their original channel, by button or with `/guest approve` and `/guest deny`.
- `channel:#…` sets the review channel, and a named channel is always validated first, even while applications stay off. For open applications the reply reads "Review channel changed", and applications already posted stay reviewable where they were posted. `unset_channel:true` stops using a review channel without validating any channel (it replaced 2.14.x's `clear:true`), which also leaves `/apply` closed. `channel` together with `unset_channel`, or no option at all, is an input error.
- Each changed setting is audited separately (`config` on `guest_applications_enabled` or `guest_application_channel_id`) and queues the usual repair pass. A request that matches what is saved changes nothing and replies with the info `= NO CHANGE` card.
- `/setup` switches applications on and adopts the officer room as the review channel when none is set.

`/config show` reads "Off · reviews in #channel" while the switch is off with a channel kept. `/config validate` lists the review channel's check only while applications are on; switched off, it lists applications as closed and leaves the kept channel out of the checklist and its health line.

Visitors without an active trusted character link use `/apply` in the lobby. It opens a modal with two required answers, each 10–300 characters: **Introduce yourself** and **Why join this server?** The second prompt asks how they found the community or who invited them. Officers review these answers for spam before deciding; submitting or reopening the form grants no access.

Choose a staff-only review channel with `/config guest_applications channel:#officer-chat`. Setup preserves an existing configured channel, so changing the officer-room binding alone does not move reviews. Each submitted application retains its review channel and original answers. Command confirmations, status replies, and decision acknowledgements omit the answers, including when public development replies are enabled.

The review contains the applicant ID, submission time, outcome, answer fields, and persistent **Approve / Deny** buttons. Officers can also use `/guest approve` or `/guest deny` with the application ID; the deny command accepts a reason. An approved decision queues Guest-role delivery and an outcome DM. A denied application grants nothing and enforces the configured `GUEST_COOLDOWN_SECONDS` before reapplication (one day by default); a failed DM does not undo the decision. `/guest status` separates application outcome from delivery status.

Forms bind to the invoking user, guild, and join time. Leaving/rejoining requires opening a new form. Repeated submissions during the same pending application return that application without replacing the answers. Restarts preserve answers and buttons; missing review messages are recreated from the stored record when review work is retried. Older applications without answers remain reviewable and are labeled as legacy submissions.

Trusted verified/imported/assigned links continue through character/FC eligibility rather than this manual application path, including while roster evidence is uncertain. Verification before an officer decision supersedes the application without creating an independent manual grant. Existing grants, explicit officer grant/revoke operations, automatic registered-visitor Guest access, and FC Member precedence retain their policy.

## Member-list grouping and role hierarchy

While the guild's **role-layout switch** is on, the four configured roles automatically enable **Display role members separately from online members** (`hoist`). They form **one consecutive block**, with highest-to-lowest priority **FC Leader → Officer → Member → Guest**, below the bot's highest role. New roles are created with separate display enabled; existing configured roles are updated by durable `roles.layout` work.

### Role layout switch

`guilds.role_layout_enabled` decides whether TaruBot manages role presentation at all (CFG-07):

- **Defaults.** Guilds created by the legacy import start **off**, so the production server keeps its existing role display and order. Every other guild starts **on**: guilds first created by `/setup` or `/config`, and guilds managed live before migration 005 (DevBot's). `/setup` never changes the switch.
- **Off.** TaruBot changes no role's hoist flag or position. Startup, rejoin, role events, role configuration, setup, activation, and refresh queue no layout work; a queued or requeued `roles.layout` job completes as `skipped: layout disabled`. Roles that `/setup` creates keep Discord's default display. Role assignment is unaffected.
- **Changing it.** `/config role_layout enabled:true|false` requires a server manager with Manage Server and Manage Roles. Enabling first repeats the hierarchy checks for every managed role, then queues one layout pass; disabling queues nothing and never reverts display or order already applied, and a pass already running stops before its next write. Each change is audited (`config.role_layout` with the previous value) and advances the configuration revision; repeating the current value changes nothing. `/config show` and `/config validate` report the switch, and the cutover preview's `roleLayout.ifEnabled` shows what enabling it would move.

Layout checks run after setup, role binding changes, guild refresh, role events, and application startup, only while the switch is on. Only necessary writes are sent. The planner packs the block starting at the lowest configured role's effective position, preserving unrelated roles' relative order. It submits the complete final hierarchy because sparse position updates can leave roles interleaved. Discord.js resolves tied raw positions before planning; readback verifies the full result and adjacency, rather than checking priority alone. Partial configurations form a smaller consecutive block with the same relative priority.

Layout shares setup's guild lock, rechecks the current configuration, the role-layout switch, and effect activation before writes, and verifies Discord's result afterward. `/sync status` reports pending or blocked work; refresh runs include layout in their child-job totals. Repair missing roles or hierarchy permissions and rerun `/setup` or `/refresh` to retry.

Discord displays groups according to membership, presence, and channel visibility. Empty roles do not produce empty headings, and a member with multiple displayed roles belongs to the highest applicable group. Role grouping does not assign membership or change the rank eligibility rules below.

## Officer authority

```text
/config officer_rank rank:Officer
/config officer_rank unset_rank:true
/config roles officer role:@Officer adopt_holders:false
/officer grant member:MEMBER reason:EXPLANATION
/officer revoke member:MEMBER reason:EXPLANATION
/officer reset member:MEMBER reason:EXPLANATION
```

`member:` suggests server members as you type (display name, username, global name or nickname), as every member option does since 2.15.0. A pasted user ID or mention is still accepted, so someone who has left can be named by ID. `/config roles <role> unset_role:true` and `/config officer_rank unset_rank:true` replaced 2.14.x's `clear:true`, and the receipts read "unset".

A changed officer rank advances the configuration revision, is audited as `config.officer_rank` and queues a repair pass. Naming the saved rank again (or `unset_rank:true` with no rank set) changes nothing (2.15.0): it replies "Officer rank already set" (or "Officer rank already unset") with the info `= NO CHANGE` card, and advances no revision, writes no audit and queues no repair pass.

An Officer role grants **bot-only officer command access**. Server managers retain their existing access. Role provisioning, changes to the Officer/FC Leader role binding, changes to the officer rank mapping, and explicit officer grants, revocations and resets require a server manager with Manage Roles. All four role bindings require that authority once channel onboarding is enabled; initial setup additionally checks Manage Channels. Changing the linked FC while officer rank automation is enabled also requires manager authority. While an Officer role is bound, an officer grant, revocation or reset also requires that the manager's highest role be above it (the server owner is exempt) and that TaruBot can manage it.

When an in-game rank is configured, a trusted linked character with confirmed FC membership and that normalized rank in accepted roster evidence qualifies its owner for the Officer role; with several linked characters, any one suffices. Rank names are matched using consistent Unicode, case, and whitespace normalization; this uses the **FC rank**, not the character's Grand Company rank.

Manual grants work independently of FC rank. A manual revocation suppresses automatic officer eligibility until an explicit grant restores it. Revocation is checked in application authorization immediately, even if Discord role removal is pending.

`/officer reset` (2.15.0) deletes the member's grant or revocation, so the in-game rank decides again; with no rank set, only `/officer grant` confers officer access, and the reply says so. Like grant and revoke, it checks the bound Officer role's hierarchy first, before it looks for an override. Like a revoke, it works for someone who has left. It is audited as `officer.reset` and reconciles the member; before any Officer role is bound, the removal is recorded and changes no role. With no override to remove, it replies with the info `= NO CHANGE` card and audits nothing.

Bot-only officers can assign ordinary trusted membership links, but such assignments do not confer automatic officer authority. A verified claim, trusted import, or assignment by a server manager with Manage Roles is required for that privilege. This prevents indirect delegation through `/assign`.

Binding an Officer role with `/config roles officer role:@Officer` normally grants its current human holders audited manual officer grants. Add `adopt_holders:false` to bind it without adopting anyone, so officer authority comes only from the mapped in-game rank and explicit `/officer grant`; the option exists only on `/config roles officer`, and the choice is recorded in the `config` audit. `/officer grant` and `/officer revoke` also work before any Officer role is bound: the override is recorded (the reply's Discord role field reads "Applies once an Officer role is set") and confers nothing until a role is bound. The production launch uses this order: map the rank first (`/config officer_rank rank:Officer`), grant the owner-approved exceptions, then bind the legacy role with `adopt_holders:false`. Binding queues an immediate repair pass, and grants recorded first keep exceptions from losing the role when it is bound. Holders with neither the rank nor a grant lose the Officer role once reconciliation runs.

Officer command visibility is enforced at runtime because Discord's static default permission bitfield cannot represent a configurable role. Both the router and application operation enforce authorization. `/setup` and `/officer` retain static server-manager permission requirements.

## FC Leader and freshness

FC leadership uses the validated unique Lodestone master-rank icon, independently of the FC's customizable leader title. Woven Souls currently names that rank `Fussy Bunbun`. The leader role is an access/status role; it does not implicitly grant officer command authority.

Rank names and leadership facts are stored with accepted roster members. Existing confirmed membership awaiting departure confirmation keeps its last positive rank evidence. Missing/unrecognized rank or leader evidence preserves an existing projection but cannot grant a new automatic role. An unknown master marker is treated as unknown leadership, and its compatibility contract must be updated if upstream changes the marker.

Member and Guest eligibility use the established ownership, membership, application, grant, and revocation policies plus the registration rule above. Creating a role does not create character ownership. FC Leader grants staff channel visibility but still does not implicitly grant officer command authority.

## Migration

The role/rank feature introduced `002_setup_and_ranks.sql`; **2.10.0 adds `003_guild_access.sql`** for channel bindings, the opt-in flag, and recovery snapshots. Stop the application writer, back up its database, and run the normal explicit migration command with the new image before starting it. Refresh the slash-command registration for the new `/setup` options and permissions.

**2.12.0 adds `004_guest_application_form.sql`** for guest introduction/interest answers. Follow the same stopped-writer backup/migration procedure using matching images, then register the updated `/apply` definition. Existing applications, grants, decisions, channels, and visibility snapshots are preserved; only new submissions require form answers.

Existing guilds migrate with `access_policy_enabled=false`. Their channel visibility is enabled only by a manager running `/setup`. Imported guild activation still requires its persisted effects flag and the process-wide `ENABLE_EFFECTS` flag. Original migrations remain immutable; Drizzle mappings and the startup checksum advance together.

**2.13.0 adds `005_launch_access_policy.sql`**:

- The `guest_grants` provenance check also accepts `grandfathered`.
- `guilds.guest_grandfather` (`pending`/`completed`) and `guest_grandfathered_at` form the once-only first-activation marker. Existing guilds that were never imported keep NULL and are never grandfathered; an imported guild that was never activated becomes `pending`.
- `guilds.role_layout_enabled` defaults on. Guilds with a `migration.import` audit are backfilled off.

The migration does not change any guild's revision. Registered-visitor Guest needs no schema change: it no longer depends on `access_policy_enabled`, so registered non-members in onboarding-off guilds receive Guest after the upgrade. Follow the same stopped-writer backup/migration procedure and register the updated commands (`/config role_layout` and the `adopt_holders` option).

**2.15.0 adds `006_guest_application_switch.sql`**:

- `guilds.guest_applications_enabled` defaults off. Guilds that already had a review channel are backfilled on, so a live guild such as DevBot stays open, except imported guilds still awaiting first activation (`guest_grandfather='pending'`), which stay off. Guilds without a channel stay off.
- `guest_grants.ended_at`, `ended_by` and `ended_reason` record a grant that `/guest reset` ended. Existing grants stay active.

The migration does not change any guild's revision. Follow the same stopped-writer backup/migration procedure, then re-register guild commands: `/officer reset` and `/guest reset` are new (19 roots, 43 paths), the `/config` unset options are renamed (`unset_channel`, `unset_role`, `unset_rank`), `/config guest_applications` gains `enabled`, every member option now autocompletes, and option descriptions changed, including `/ledger adjust entry:`, which takes an entry number (`5` or `#5`) or the entry ID.
