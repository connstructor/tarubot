# Role bootstrap and FC ranks

## Bootstrap

```text
/setup fc_id:9232097761132958152 prefix:DevBot officer_rank:Officer
```

`/setup` requires effective **Manage Server** and **Manage Roles**. It creates or reuses four distinct ordinary roles: Member, Guest, Officer, and FC Leader. They are created with zero server permission bits; administrators can configure channel access separately. Every adopted role must be manageable by the bot and, except for the guild owner, below the invoking manager's highest role.

The optional prefix defaults to `DevBot` in a configured test guild and to an empty prefix otherwise. In this shared development guild, the resulting names are **DevBot Member**, **DevBot Guest**, **DevBot Officer**, and **DevBot FC Leader**.

Configured IDs are preferred on reruns, so renaming an already configured role does not create duplicates. Otherwise setup looks for a unique match to either the requested prefixed name or the canonical **Member**, **Guest**, **Officer**, or **FC Leader** name, using case/Unicode/whitespace normalization. A prefix therefore does not hide existing unprefixed roles. A reused canonical role is renamed to the requested prefixed name while retaining its ID, permissions, and assignments. An explicitly configured custom name is preserved. Only a missing role is created; ambiguous matches require an explicit `/config roles` selection.

Setup commits the selected IDs together and queues membership reconciliation and role layout. To correct a previous duplicate binding, select the original role with `/config roles` before rerunning `/setup`. Retired role assignments are then reconciled using the new IDs; existing character links and eligibility remain authoritative. A different FC still requires explicit unlinking first.

FC ID and officer rank are optional. Omitting them preserves existing values; a fresh setup can provision roles before linking an FC. Existing human holders of an adopted Officer role receive audited manual grants. Imported guild activation remains a separate cutover step.

Configure notification destinations afterward:

```text
/config ledger channel:#dev
/config officer_notifications channel:#dev
/config guest_applications channel:#dev
/config validate
```

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

An Officer role grants **bot-only officer command access**. Server managers retain their existing access. Role provisioning, changes to the Officer/FC Leader role binding, changes to the officer rank mapping, and explicit officer grants/revocations require a server manager with Manage Roles. Changing the linked FC while officer rank automation is enabled also requires that authority.

When an in-game rank is configured, a trusted linked character with that normalized rank in accepted roster evidence qualifies its owner for the Officer role. Rank names are matched using consistent Unicode, case, and whitespace normalization; this uses the **FC rank**, not the character's Grand Company rank.

Manual grants work independently of FC rank. A manual revocation suppresses automatic officer eligibility until an explicit grant restores it. Revocation is checked in application authorization immediately, even if Discord role removal is pending.

Bot-only officers can assign ordinary trusted membership links, but such assignments do not confer automatic officer authority. A verified claim, trusted import, or assignment by a server manager with Manage Roles is required for that privilege. This prevents indirect delegation through `/assign`.

Officer command visibility is enforced at runtime because Discord's static default permission bitfield cannot represent a configurable role. Both the router and application operation enforce authorization. `/setup` and `/officer` retain static server-manager permission requirements.

## FC Leader and freshness

FC leadership uses the validated unique Lodestone master-rank icon, independently of the FC's customizable leader title. Woven Souls currently names that rank `Fussy Bunbun`. The leader role is an access/status role; it does not implicitly grant officer command authority.

Rank names and leadership facts are stored with accepted roster members. Existing confirmed membership awaiting departure confirmation keeps its last positive rank evidence. Missing/unrecognized rank or leader evidence preserves an existing projection but cannot grant a new automatic role. An unknown master marker is treated as unknown leadership, and its compatibility contract must be updated if upstream changes the marker.

Member and Guest eligibility continue to use the established ownership, membership, application, grant, and revocation policies. Creating a role does not create character ownership or grant access by itself.

## Migration

This feature adds `002_setup_and_ranks.sql`. Stop the application writer and run the normal explicit migration command before starting the updated image. The migration adds staff role settings, snapshot rank evidence, and durable officer overrides without rewriting the initial migration.
