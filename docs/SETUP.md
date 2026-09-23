# Lobby onboarding, role bootstrap, and FC ranks

## Bootstrap

```text
/setup fc_id:9232097761132958152 prefix:DevBot officer_rank:Officer lobby:#lobby officers:#officer-chat
```

`/setup` requires effective **Manage Server**, **Manage Roles**, and **Manage Channels**. It creates or reuses four distinct ordinary roles: Member, Guest, Officer, and FC Leader, plus the lobby and officer text rooms. Running it explicitly enables the channel-access policy below. Roles are created with zero server permission bits and receive channel-specific access. Every adopted role must be manageable by the bot and, except for the guild owner, below the invoking manager's highest role. Onboarding roles cannot carry Administrator, Manage Server, Manage Roles, or Manage Channels.

The optional prefix defaults to `DevBot` in a configured test guild and to an empty prefix otherwise. In this shared development guild, the resulting names are **DevBot Member**, **DevBot Guest**, **DevBot Officer**, and **DevBot FC Leader**.

Configured IDs are preferred on reruns, so renaming an already configured role does not create duplicates. Otherwise setup looks for a unique match to either the requested prefixed name or the canonical **Member**, **Guest**, **Officer**, or **FC Leader** name, using case/Unicode/whitespace normalization. A prefix therefore does not hide existing unprefixed roles. A reused canonical role is renamed to the requested prefixed name while retaining its ID, permissions, and assignments. An explicitly configured custom name is preserved. Only a missing role is created; ambiguous matches require an explicit `/config roles` selection.

Setup commits the selected role/channel IDs, first-observed channel snapshots, and queued membership/layout/access work together. Discord resource creation precedes that transaction; a retry reuses created resources. Existing lobby reparenting and permission enforcement begin only after snapshots are persisted. To correct a previous duplicate binding, select the original role with `/config roles` before rerunning `/setup`. A different FC still requires explicit unlinking first. After onboarding is enabled, role bindings require manager authority and all four must remain configured; select replacements rather than clearing them.

FC ID and officer rank are optional. Omitting them preserves existing values; a fresh setup can provision roles before linking an FC. Existing human holders of an adopted Officer role receive audited manual grants. Imported guild activation remains a separate cutover step.

Unset officer-notification and guest-review destinations default to the selected officer room. Existing explicit destinations are retained. Configure the ledger and any desired overrides afterward:

```text
/config ledger channel:#dev
/config officer_notifications channel:#dev
/config guest_applications channel:#dev
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

Each write rechecks the current community binding and parent. Guild-update events queue reconciliation when that binding changes. A saved lobby/officer binding that becomes reserved requires `/setup` with a separate room; missing community metadata blocks scope-dependent changes rather than guessing. `/sync status` results include the excluded IDs.

Enabling this policy makes TaruBot authoritative for **View Channel** across role/member overwrites in managed channels. Competing visibility allows/denies are normalized, including custom-role and individual-member exceptions. Other permission bits are retained except the explicit chat/command permissions needed for the lobby/staff rooms and the bot's delivery permissions. Configure integrations with the appropriate access roles. Everyone loses its guild-level View Channel default only when doing so cannot change an excluded area's visibility: each excluded channel/category must have its own explicit everyone View allow/deny. If an excluded area inherits the default, it is preserved and managed-channel overwrites enforce onboarding instead. In that case a new default channel may be visible until its creation event is reconciled. Administrators can also create explicit public overwrites; channel events repair them rather than intercepting Discord's creation request.

The bot needs guild-level Manage Channels/Manage Roles and its own View Channel permission, plus View Channel/Manage Channels/Manage Roles in each existing managed channel. It checks these before enforcement; the reserved community resources are omitted from these checks. Lobby visibility is established before any everyone default change; managed categories are handled before leaf channels. Each remote mutation rechecks job ownership, configuration revision, activation, and protected scope. The managed channel set and required rooms are verified afterward. Partial failure leaves durable work and original snapshots available for a restart/retry; successful no-op passes avoid repeat writes.

Channel create/update/delete events coalesce `channels.access` work without enumerating all members. Startup, guild rejoin, role changes, configuration changes, and refresh also schedule repair; refresh status includes its access child job. Use `/sync status` to see completion or a blocked capability. Run `/setup` to repair missing bindings, and `/refresh` after correcting external permissions.

`channel_access_policies.original_state` retains the first channel overwrites, type, name, and parent; `guilds.access_everyone_before` retains the original everyone permission bitfield. Setup and successful enforcement are audited. Take a database backup before first activation. For operator recovery, stop the writer and inspect those original snapshots and the setup audit's created-resource flags. They provide the evidence for a deliberate manual restore. Before restarting after a policy rollback, disable `access_policy_enabled`, increment `revision`, and audit that operator decision through the Drizzle maintenance boundary. Normal reconciliation deliberately restores the configured policy, so editing managed visibility alone is treated as drift.

## Registered visitor access

In onboarding-enabled guilds, an **active trusted ownership link** establishes registration. Accepted fresh FC evidence still determines Member status. A registered owner whose linked characters are not eligible for the linked FC receives Guest automatically; if no FC is linked, registration is sufficient locally. Imported trusted ownership and authorized assignment are trusted links as well as profile-token verification. A profile's FC hint never establishes membership.

Automatic Guest is derived, not inserted as an irrevocable manual grant. Explicit Guest revocation suppresses it across restarts/rejoins, and removing the final active link removes this basis for access. Independent manual/approved/imported grants and former-member eligibility retain their existing rules. FC Member eligibility takes precedence even when Guest is revoked. Unknown/stale roster evidence cannot create a new automatic grant; an already-held Guest role can be preserved while accepted evidence is stale. `/guest status` reports `verifiedGuestEligible` separately, and `/apply` explains when existing eligibility should be repaired by reconciliation instead.

## Member-list grouping and role hierarchy

The four configured roles automatically enable **Display role members separately from online members** (`hoist`). They form **one consecutive block**, with highest-to-lowest priority **FC Leader → Officer → Member → Guest**, below the bot's highest role. New roles are created with separate display enabled; existing configured roles are updated by durable `roles.layout` work.

Layout checks run after setup, role binding changes, guild refresh, role events, and application startup. Only necessary writes are sent. The planner packs the block starting at the lowest configured role's effective position, preserving unrelated roles' relative order. It submits the complete final hierarchy because sparse position updates can leave roles interleaved. Discord.js resolves tied raw positions before planning; readback verifies the full result and adjacency, rather than checking priority alone. Partial configurations form a smaller consecutive block with the same relative priority.

Layout shares setup's guild lock, rechecks the current configuration and effect activation before writes, and verifies Discord's result afterward. `/sync status` reports pending or blocked work; refresh runs include layout in their child-job totals. Repair missing roles or hierarchy permissions and rerun `/setup` or `/refresh` to retry.

Discord displays groups according to membership, presence, and channel visibility. Empty roles do not produce empty headings, and a member with multiple displayed roles belongs to the highest applicable group. Role grouping does not assign membership or change the rank eligibility rules below.

## Officer authority

```text
/config officer_rank rank:Officer
/config officer_rank clear:true
/officer grant member:DISCORD_ID reason:EXPLANATION
/officer revoke member:DISCORD_ID reason:EXPLANATION
```

An Officer role grants **bot-only officer command access**. Server managers retain their existing access. Role provisioning, changes to the Officer/FC Leader role binding, changes to the officer rank mapping, and explicit officer grants/revocations require a server manager with Manage Roles. All four role bindings require that authority once channel onboarding is enabled; initial setup additionally checks Manage Channels. Changing the linked FC while officer rank automation is enabled also requires manager authority.

When an in-game rank is configured, a trusted linked character with that normalized rank in accepted roster evidence qualifies its owner for the Officer role. Rank names are matched using consistent Unicode, case, and whitespace normalization; this uses the **FC rank**, not the character's Grand Company rank.

Manual grants work independently of FC rank. A manual revocation suppresses automatic officer eligibility until an explicit grant restores it. Revocation is checked in application authorization immediately, even if Discord role removal is pending.

Bot-only officers can assign ordinary trusted membership links, but such assignments do not confer automatic officer authority. A verified claim, trusted import, or assignment by a server manager with Manage Roles is required for that privilege. This prevents indirect delegation through `/assign`.

Officer command visibility is enforced at runtime because Discord's static default permission bitfield cannot represent a configurable role. Both the router and application operation enforce authorization. `/setup` and `/officer` retain static server-manager permission requirements.

## FC Leader and freshness

FC leadership uses the validated unique Lodestone master-rank icon, independently of the FC's customizable leader title. Woven Souls currently names that rank `Fussy Bunbun`. The leader role is an access/status role; it does not implicitly grant officer command authority.

Rank names and leadership facts are stored with accepted roster members. Existing confirmed membership awaiting departure confirmation keeps its last positive rank evidence. Missing/unrecognized rank or leader evidence preserves an existing projection but cannot grant a new automatic role. An unknown master marker is treated as unknown leadership, and its compatibility contract must be updated if upstream changes the marker.

Member and Guest eligibility use the established ownership, membership, application, grant, and revocation policies plus the opt-in registration rule above. Creating a role does not create character ownership. FC Leader grants staff channel visibility but still does not implicitly grant officer command authority.

## Migration

The role/rank feature introduced `002_setup_and_ranks.sql`; **2.10.0 adds `003_guild_access.sql`** for channel bindings, the opt-in flag, and recovery snapshots. Stop the application writer, back up its database, and run the normal explicit migration command with the new image before starting it. Refresh the slash-command registration for the new `/setup` options and permissions.

Existing guilds migrate with `access_policy_enabled=false`. Their visibility and registered-visitor behavior are enabled only by a manager running `/setup`. Imported guild activation still requires its persisted effects flag and the process-wide `ENABLE_EFFECTS` flag. Original migrations remain immutable; Drizzle mappings and the startup checksum advance together.
