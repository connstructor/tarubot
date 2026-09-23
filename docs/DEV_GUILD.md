# DevBot live test session

## Identity and deployment

- Application/bot: **DevBot**, `943291473477128243`.
- Test guild: **TaruBot Development**, `1040379370159743139`.
- The other application in this guild is **TaruBot**, `965294750741692416`.
- DevBot's isolated PostgreSQL database is `tarubot_dev`.
- `docker-compose.devbot.yml` supplies the development database and requires explicit test-guild scope.

Use the development overlay consistently for this running instance:

```sh
docker compose -f docker-compose.yml -f docker-compose.devbot.yml pull
docker compose -f docker-compose.yml -f docker-compose.devbot.yml up -d --wait tarubot nodestone
docker compose -f docker-compose.yml -f docker-compose.devbot.yml logs -f tarubot
```

The Compose service is named `tarubot`; its actual Discord identity comes from the configured application/token and is checked on startup.

These commands use published GHCR images. Before testing unmerged source changes, append `-f docker-compose.build.yml` and use `up -d --build --wait`; that override selects local image tags and mounts the editable startup plan. See [CI_CD.md](CI_CD.md).

## Completed on 2026-09-22

- Authenticated identity matched the configured DevBot application.
- Guild-only registration produced 16 root commands and all 33 expected paths. Readback matched command ownership, guild scope, and default permissions.
- Gateway login and complete privileged member enumeration succeeded: one human and the two separate bots.
- After the owner moved DevBot's role to the top, the existing Member/Guest role definitions and hierarchy passed read-only validation.
- In `#dev`, a message authored by DevBot was sent, fetched, edited, and deleted. The probe checked message ownership before editing/deleting it.
- The bot restarted into ready state with both database and Discord connectivity healthy.
- The sidecar reported both deployed upstream revisions current against their repositories' HEADs.
- Human-invoked `/ping` returned `discordGatewayLatencyMs: 72`, confirming a live gateway latency response through the discovered command handler.
- Human-invoked `/channel` returned channel `1040379370931507252`, name `chat`, and type `GuildText`, matching the test guild's channel metadata.
- The owner confirmed that both utility replies were ephemeral.
- Human-invoked `/config show` returned the expected unconfigured-guild setup instruction (operation `1551950477652918342`). A database check confirmed the read-only command created no guild configuration.
- After the owner set `ENABLE_EFFECTS=true`, the development container was recreated and its readiness probe confirmed `effects: true`, with database and Discord connectivity healthy.
- The setup/rank extension was migrated and deployed. Guild-scoped readback now matches 18 root commands and 39 command paths, including `/setup`, `/officer`, and officer-rank configuration.
- The startup plan was posted by DevBot in `#chat`, with separate **You**, **Me**, and **DevBot** action sections: message `1551970559120642221`.
- A fresh complete live roster exposed the FC rank names and a unique master marker: 105 members, with the leader's custom rank title `Fussy Bunbun` and the officer rank `Officer`.
- The latest guild enumeration includes five humans and the two bots, so non-owner nickname test participants are now available.
- Live `/setup` created all four DevBot roles; a second invocation reused the identical IDs with `created: false` for every role. Both decisions were confirmed in the guild audit records.
- `/config validate` confirmed all four managed roles and all three notification destinations available, with global and guild effects enabled. Officer-rank mapping is `Officer`.
- Refresh run `236bb6fc-3780-443d-8b86-43476835b9df` reused fresh roster evidence, completed guild enumeration plus five human reconciliation jobs, and finished with six successful jobs, no blocked/failed work, and no role deltas.
- The accepted snapshot at `2026-09-22T15:33:15.264Z` contains 105 distinct members, one leader, and six characters with FC rank `Officer`. At the end of setup there were no active DevBot character links, so withholding membership-derived roles was correct.
- The requested public test-guild reply policy was deployed. Readiness reports `publicTestResponses: true`; scoped visibility tests passed. A human repeat command can confirm channel-visible interaction delivery.
- Restart posted the updated character-verification plan in `#chat` as message `1551983447013064705`, with separate You/Me/DevBot responsibilities.
- Shion Tsuji (`38371223`) completed profile-token verification after an initial publication-delay result. Link `4da8b599-533f-4d63-aa5f-26a670bff5e7` is active with `profile_token` provenance; the challenge was consumed and only its hash was persisted. The proof token is deliberately excluded from this log.
- Discord readback confirmed **DevBot Member** and **DevBot FC Leader** on the verified owner, alongside the pre-existing Member role. The accepted FC rank is `Fussy Bunbun`; the configured `Officer` rank did not match.
- The verified user is the guild owner. Nickname delivery is correctly blocked by Discord hierarchy, while roles are applied and ownership remains committed.
- Successful verification responses were visible through the ordinary `#chat` message API with flags `0`, confirming the requested public response behavior.
- The role-layout build passed 66 automated tests and was deployed with the development overlay. Startup posted the role-hierarchy/member-list plan as message `1551994024498303009` in `#chat`, with flags `0` and all three responsibility sections.
- Live Discord readback confirmed all four configured roles have `hoist: true` and the intended priority below DevBot. Unrelated roles retained their relative order and separate-display settings; the verified owner retained both DevBot roles and the existing Member role.
- Layout job `7c5d1498-2db8-4caa-abfb-0a90d241b829` coalesced its role-event echoes and succeeded after two passes. Follow-up job `1ad404bb-6dd9-41c2-a367-340a0faf6657` succeeded with empty hoist/position deltas, confirming convergence.
- The startup role events briefly rate-limited complete member enumeration. Durable retries recovered: job `b43dcbaf-9755-400c-a3d3-20acb6fc34d7` completed all five humans. Final readiness showed zero pending work and zero degraded FCs; the only blocked effect was the expected guild-owner nickname update.

### Consecutive block and original-role reuse correction

The first layout checked priority but allowed interleaving and retained newly created duplicates. The owner requested one consecutive block and reuse of the original Member/Guest roles. The corrected deployment was verified on 2026-09-22:

- Guild configuration revision **9** binds Member to `1042089882677420172` and Guest to `1042089887798677545`. Setup reused all four IDs with `created: false`, renaming the two original roles to the requested DevBot-prefixed names.
- Original Member and Guest permissions remain exactly `1071698529857`; their existing IDs and Discord references were retained. Both verified FC members (`669230721168179200` and `725369723964882976`) hold the original Member role; the owner also retains FC Leader.
- Removed the obsolete roles `1551979199554912286` and `1551979205183406210` only after confirming their setup-creation audit records, retired bindings, zero holders in a complete seven-member enumeration, and zero channel references. Both removals were audited.
- Live readback verified adjacent managed positions **4, 3, 2, 1**, all with separate member-list display enabled. DevBot remains at position 6 and the other bot at position 5, above the whole block.
- Follow-up layout job `4ccba9e7-65de-4772-ab80-e7bfe60467db` succeeded with empty hoist/position deltas. Readiness showed zero pending work and zero degraded FCs. The sole blocked effect remained the expected guild-owner nickname update.
- Startup posted message `1552008870069538898` with the corrected role-reuse/consecutive-hierarchy plan and all three responsibility sections. The submodule-built Nodestone sidecar was healthy and reported both upstream revisions current.
- The owner's subsequent `/config validate` confirmed revision 9, all seven configured role/channel capabilities available, both effect switches enabled, and no roster acquisition error.
- The owner ran `/nickname enabled:false`, clearing the expected nickname block. Persisted nickname management, restoration, pending-write, and successful-write flags are all false.
- Refresh run `df8fa3fa-9688-4994-9435-58e32a3b59d5` reused the valid `17:29:12.810Z` roster and completed all **seven jobs**: guild enumeration, five human reconciliations, and role layout. The human status snapshot caught layout still running; database readback confirmed it succeeded at `2026-09-22T17:57:35.080124Z`, on its first attempt with empty hoist/position deltas. Every run job succeeded, and no queued, running, blocked, failed, or disabled guild-scoped work remained.

Higher positions take priority. The recorded layout at that verification was:

| Managed role | ID | Position | Separate member-list display |
| --- | --- | --- | --- |
| DevBot FC Leader | `1551979217087103137` | 4 | Enabled |
| DevBot Officer | `1551979211391115405` | 3 | Enabled |
| DevBot Member | `1042089882677420172` | 2 | Enabled |
| DevBot Guest | `1042089887798677545` | 1 | Enabled |

The managed block was uninterrupted, and unrelated roles retained their relative order. That session announcement is [available in #chat](https://discord.com/channels/1040379370159743139/1040379370931507252/1552008870069538898).

Repeat the scoped probes with:

```sh
bun run build
bun dist/scripts/discord-inspect.js
bun dist/scripts/discord-smoke.js --member-role 1042089882677420172 --guest-role 1042089887798677545
```

Adding `--channel 1040379861153357995` to the smoke probe explicitly enables the temporary bot-owned message test in `#dev`.

## Version-command delivery

- Guild registration now exposes **19 root commands / 40 paths**, including `/version`. Its default member permissions are unrestricted; the optional `commits` integer is bounded from 1 through 10.
- Human `/version` responses `1552029009527709747` and `1552029149059620865` were read back in `#chat`, showing `TaruBot v2.7.0`, four commit fields, and public message flags `0` for the guild owner.
- The running maintenance build reports **2.7.1** from its compiled manifest. Live GitHub retrieval returned the published `main` history with canonical links and valid verified-signature metadata. The 2.7.0 count-1/count-10 service probes returned one and six available commits respectively; the 2.7.1 default-count probe returned five. Rendering placed ✅ next to verified commit IDs.
- Startup announcement `1552030590482776246` contains the current 2.7.1 version/history test plan with all three responsibility sections. Readiness confirmed database/Discord connectivity, enabled effects/public development replies, zero pending/blocked work, and zero degraded FCs.
- History is fetched from GitHub and shared in an in-memory cache for up to five minutes. The installed version comes from the compiled package manifest. Ordinary non-officer invocation, count-boundary UI checks, and link/badge visual confirmation remain in the current plan.

## Human interaction checks

### 2.10.1 rollout and limited-permission follow-up

- Published bot/sidecar images for merge `0744cfbe926c38ec277ab8481f75e3391a91c31d` were pulled and deployed as **2.10.1**, without source mounts.
- With the writer stopped, `tarubot_dev` was backed up to `.cache/backups/tarubot_dev-before-2.10.1-0744cfb.dump`. A disposable restore matched every existing row, sequence, trigger, and constraint. Migration 003 was rehearsed on that restore before application to DevBot; all prior application rows were preserved.
- Two active ownership links, guild revision 9, and the uninitialized ledger account survived rollout. Database/Discord readiness passed with zero pending/blocked work. All 19 root commands / 40 paths matched their deployed definitions, including the new setup options.
- The 2.10.1 startup plan was read back publicly in `#chat`: [message 1552126390214860923](https://discord.com/channels/1040379370159743139/1040379370931507252/1552126390214860923).
- The subsequent permission check confirmed **Administrator disabled** and exactly the README's eight explicit bot-role permissions. All four role bindings passed hierarchy checks; complete enumeration returned seven humans and DevBot.
- Discord identifies `1040379572358746144` (`moderator-only`) as `public_updates_channel_id`, under the permission-synced `1040381910863593492` (`Admin`) category. The owner requested these community resources remain outside onboarding.
- Created the separate private **officer-chat**, `1552149138148433930`, with staff and bot access. DevBot successfully read it and exercised both permission-edit and channel-edit APIs under its limited role. Reserved community metadata was verified intact.
- A read-only probe of the compiled 2.10.2 fix passed setup preflight for ten managed channels, excluding the community-updates channel and Admin category. This was a one-shot validation; the running application remains on the published 2.10.1 image until the fix is merged/published/deployed.

At that point onboarding was still opted out. The separate room's creation and permission readback do not establish the cause of the earlier community-channel 403 responses.

### 2.11.1 rollout and completed setup — 2026-09-23

- PR #5 merged as `1de878ef6c314cd83ac26bf7513d5db64210bcad`; matching published 2.11.1 bot/sidecar images replaced the previous release, with no source mounts. The stopped-writer backup is `.cache/backups/tarubot_dev-before-2.11.1-1de878e.dump`; schema 003 and existing ownership/ledger state were retained.
- Readiness and the bounded officer-room preflight passed. Startup posted [message 1552179968069472363](https://discord.com/channels/1040379370159743139/1040379370931507252/1552179968069472363).
- The user ran `/setup`, reusing all four role IDs and officer-chat `1552149138148433930`, and creating lobby `1552181036492791818`. Persisted guild revision **10** has onboarding enabled.
- Access job `8df5614c-3c95-44bb-b3d9-e5c90df4b436` succeeded for 11 managed channels with the community-updates channel and Admin excluded. The final no-op pass reported no changed channels/default and no outstanding work. The user reported that the rest looked good; exhaustive human visibility/recovery checks remain separate acceptance work.
- Guest-review destination still points at `#dev` (`1040379861153357995`). The next guest-form session should explicitly set `/config guest_applications channel:#officer-chat` before applications are submitted.

### Next session: 2.12.0 unverified-visitor forms

The user selected manual form review **only for unverified visitors**. Verified non-FC users keep automatic Guest eligibility and FC members keep Member eligibility. PR #6 merged at `db062bdbb9fc502d62a214f8a56692e418b8875b` on 2026-09-23 at 05:46:39 UTC with all checks passed. [Publication run 35823822742](https://github.com/connstructor/tarubot/actions/runs/35823822742) succeeded, so the 2.12.0 images are available. Migration 004 and the new `/apply` flow still require deployment and live testing.

A fresh read-only handoff check confirmed the bot and sidecar still run **2.11.1**, revision `1de878ef6c314cd83ac26bf7513d5db64210bcad`, and PostgreSQL still reports schema **003**. All three containers are healthy; readiness has database/Discord connected, effects/public development replies enabled, no pending/blocked work, and no degraded FCs. Guild revision 10 and its role/channel bindings remain intact, with two active links and an uninitialized ledger (`NULL`, sequence 0). See [SESSION_HANDOFF.md](SESSION_HANDOFF.md) for the exact resume state. The source startup plan tracks the 2.12.1 documentation milestone; use the plan matching whichever checked release is deployed.

Setup, original-role reuse, resource validation, complete reconciliation, and real profile-token verification have passed. Member and FC Leader delivery, consecutive role positions, preserved permissions, and hoist flags are confirmed by Discord readback. A fresh seven-job refresh passed after the owner's nickname opt-out. The current plan focuses on unverified visitor applications while preserving registered access. See `test-plans/current.json`, the latest plan in `#chat`, and [OPEN_ITEMS.md](OPEN_ITEMS.md) for remaining acceptance work.

The running development instance now has `ENABLE_EFFECTS=true`. Use dedicated DevBot test roles and destinations when configuring stateful workflows, then follow the live checklist in [VERIFICATION.md](VERIFICATION.md).

The owner requested public output for observers in this development server. The DevBot Compose overlay enables `PUBLIC_TEST_RESPONSES` by default; new slash-command, component, and error replies in the configured test guild are public. Authorization still applies to every operation. Visibility is selected when Discord acknowledges an interaction, so the setting applies to new replies after deployment.

Earlier functional probes used Administrator. It is now disabled; the documented limited permissions, role hierarchy, command inventory, member enumeration, and new officer-room management have passed. Full onboarding and human visibility verification under that permission set remain in the current session plan.

Discord forbids bots from changing the owner's nickname regardless of role order. Choose one of the non-owner human participants for successful nickname-write tests; the owner's expected blocked outcome can be tested separately.
