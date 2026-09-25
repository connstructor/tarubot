# DevBot live test session

## Identity and deployment

- Application/bot: **DevBot**, `943291473477128243`.
- Test guild: **TaruBot Development**, `1040379370159743139`.
- The production application **TaruBot**, `965294750741692416`, is no longer in this guild (404 in the 2.13.0 rollout).
- DevBot's isolated PostgreSQL database is `tarubot_dev`.
- `docker-compose.devbot.yml` supplies the development database and requires explicit test-guild scope.

Use the development overlay consistently for this running instance:

```sh
docker compose -f docker-compose.yml -f docker-compose.devbot.yml pull
docker compose -f docker-compose.yml -f docker-compose.devbot.yml up -d --wait --remove-orphans tarubot
docker compose -f docker-compose.yml -f docker-compose.devbot.yml logs -f tarubot
```

The Compose service is named `tarubot`; its actual Discord identity comes from the configured application/token and is checked on startup.

These commands use the published GHCR image `ghcr.io/deconfined/tarubot` (until 2.20.0 also `ghcr.io/deconfined/tarubot-nodestone`, the parser sidecar; since 2.21.0 the parser runs in the bot, and `--remove-orphans` clears the old container). The GitHub account was named `connstructor` until 2026-09-24, and image paths under that name no longer resolve. Before testing unmerged source changes, append `-f docker-compose.build.yml` and use `up -d --build --wait`; that override selects local image tags and mounts the editable startup plan. See [CI_CD.md](CI_CD.md).

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

### 2.12.1 rollout and first guest-form check — 2026-09-23

- Published 2.12.1 bot/sidecar images (revision `da7ed72aa0a2e072f1566282b212453a8a8dce12`, the PR #7 merge; application code identical to 2.12.0) replaced 2.11.1 with no source mounts. With the writer stopped, `tarubot_dev` was backed up to `.cache/backups/tarubot_dev-before-2.12.1-da7ed72.dump`. A disposable restore matched every row, sequence, trigger, and constraint, and migration 004 was rehearsed there before being applied to DevBot at 13:05:46 UTC; all 25 application tables were unchanged by it.
- Guild registration was replaced and read back as identical to the image's definitions (19 roots / 40 paths); only `/apply` had changed. Readiness passed with no pending/blocked work, and startup posted the plan as message `1552305018441310379`. Guild revision 10, both active links, and the uninitialized ledger were retained.
- The owner ran `/config guest_applications channel:#officer-chat` (revision 11, audited); `/config validate` reported all nine role/channel capabilities available.
- Unverified visitor `1010097911566180445` submitted application `f6198657-4f4b-4477-b9c8-c98ba09fa9ed` with bounded answers. Nothing was granted before the decision, and a repeated submission returned the same application. Review message `1552306613384118474` was posted in officer-chat. The owner approved it: the grant, audit, updated review, approval DM, and DevBot Guest role were all delivered.
- Follow-up: expected role-layout lock waits and a gateway-echo generation change were logged at error level, and the final no-op reconciliation replaced the applied Guest delta in its job result. See [OPEN_ITEMS.md](OPEN_ITEMS.md).

### 2.12.3 rollout and launch-scope session (in progress) — 2026-09-23

- Published 2.12.3 bot/sidecar images (revision `341c6ed610ed12b8d787f468644d2fb0d2edbf42`, the PR #10 merge) replaced 2.12.1 at 15:51 UTC with no migration. The stopped-writer backup `.cache/backups/tarubot_dev-before-2.12.3-341c6ed.dump` restored exactly (every row, sequence, trigger and constraint). Guild commands matched the image before and after re-registration (19 roots / 40 paths).
- Startup logged no warn or error lines (2.12.1 logged six error-level `busy` waits for the same startup). All 12 startup jobs succeeded; the role-layout job was superseded once by its own echo and recorded the wait at debug. The launch-scope plan was posted as message `1552346750315143329`.
- `/config validate`: all nine role/channel capabilities available, effects on globally and for the guild.
- Ledger: `/ledger initialize` (10,000,000), deposit +10,000 and withdraw −5,000 recorded sequences 1–3 with exact balances (10,005,000 final); `/ledger history` listed them newest first, and all three ledger notifications posted (delivery jobs succeeded).
- `/assign` with a typed name in `member` failed with a raw `SyntaxError` (operation `1552351740568015000`): the ID schema's range refinement ran after its regex failed (Zod 4) and called `BigInt()` on the name. 2.13.0 guards the refinement and adds regression tests; it reached DevBot at 20:10 UTC.
- The owner reviewed the replies (all raw JSON) and approved the embed mockups for 2.14.0; the remaining session steps are `/ledger adjust`, non-officer denials, `/assign`/`/unassign` with a numeric ID, role removals and drift repair, and `/guest revoke`/`/guest grant`.

### 2.13.0 rollout — 2026-09-23

- Published 2.13.0 bot/sidecar images (revision `2e3f27c9310c6918641fb0e27f7661f4927eec5f`, the PR #11 merge) replaced 2.12.3. The image's migration 005 checksum (`42b5c297e725…`) matches `main`.
- The writer stopped at 20:09:26 UTC (exit 0; all 257 jobs succeeded; no open connections). The backup `.cache/backups/tarubot_dev-before-2.13.0-2e3f27c.dump` (sha256 `85e13489…`) restored exactly into `tarubot_dev_restore_test` with the 2.12.3 build (schema 004).
- Rehearsal: the 2.13.0 `migrate.js` refused the restore copy without `--restore-rehearsal` (the DevBot profile requires `tarubot_dev`) and passed with it: schema ready, all 25 tables identical apart from the new columns, the guild's role layout on, the grandfathering marker NULL, revision 11, and the provenance check including `grandfathered`. The rehearsal database was dropped.
- Migration 005 was applied to `tarubot_dev` at 20:09:55 UTC. Data matched the stopped snapshot; guild revision 11 is unchanged, with `role_layout_enabled` true and `guest_grandfather` NULL.
- 2.13.0 started at 20:10 UTC: readiness 200 with the writer lease held (one holder of advisory lock 714882494), zero warn or error log lines, and all 10 startup jobs succeeded; `roles.layout` converged with nothing to hoist or move.
- Guild commands went from 19 roots / 40 paths (only `/config` differed) to 19 / 41 after registration, matching the image; `commands.js list --declared-scope` reports clean.
- Guard refusals under the DevBot `.env`: `register.js --global` (with `TEST_GUILD_ID` set), and `preview.js` and `activate.js` for the production guild `1036062273631952955` (not this profile's guild), all exit 1 before any I/O.
- The startup plan was posted as message `1552411775201316946` ("Session: 2.13.0 launch policy on DevBot").
- Owner actions confirmed: the local `.env` `DATABASE_URL` names `tarubot_dev`, and the production application is no longer in the development guild (404).
- Remaining 2.13.0 checks: the layout switch, the multi-character union and the closed-applications refusal.
- Follow-up: guard refusals print a Bun stack trace; operator tools should print only the Failure message.

### 2.14.0 rollout — 2026-09-24

- Published 2.14.0 bot/sidecar images (revision `0e60f2117001fe7bd8d56c4c172960f5f139d148`, the PR #12 merge) replaced 2.13.0 with no migration. The first attempt of publish run 35948831624 failed in the amd64 image build's contract stage: the sidecar spacing test measured 999 ms against at least 1,000 (fixed in 2.14.1). Re-running the failed jobs published both images and promoted `latest`.
- The writer stopped at 02:57:53 UTC (exit 0; all 278 jobs succeeded; no open connections and no lease holders). The backup `.cache/backups/tarubot_dev-before-2.14.0-0e60f21.dump` (95,219 bytes, sha256 `02ed249e3cae895d…`) restored into `tarubot_dev_restore_test`, where the 2.14.0 build's `check-restore.js` matched every application row, sequence, trigger and constraint at `005_launch_access_policy.sql`. The restore copy was dropped.
- 2.14.0 started at 02:58:17 UTC: readiness 200 (database, writer lease, Discord and effects true; nothing pending or blocked; no degraded FCs) with one holder of advisory lock 714882494, zero warn or error log lines, and all startup jobs succeeded (`reconcile.guild` 1, `reconcile.user` 6, `roles.layout` 1, `channels.access` 1). Nothing was parked, so the new startup requeue had nothing to resume.
- Guild commands went from 19 roots / 41 paths (`/config` and `/ledger` differed) to 19 / 41 matching the image after `register.js --guild 1040379370159743139`; `commands.js list` for the guild reports clean.
- The startup plan was posted at 02:58:21 UTC as message `1552514500140335215`: one embed, "Session: 2.14.0 embed replies instead of JSON", with fields of 982, 1,020 and 619 characters and no mentions.
- The owner's 2.14.0 reply session (`test-plans/current.json`) had not started at this point. Its paused pass needs a restart with `ENABLE_EFFECTS=false`, with the owner's go-ahead. It ran later that day on the new machine; see [the 2.14.0 reply session](#2140-reply-session--2026-09-24).
- Still open from earlier sessions at this point: the 2.13.0 checks from plan message `1552411775201316946` (the layout switch, the union through `/assign` with numeric IDs, the closed `/apply`, and Guest revoke and grant) and the 2.12.3 leftovers (`/ledger adjust` and non-officer denials).

### Machine move — 2026-09-24

- DevBot moved to a new Linux machine; the repository is at `/home/connstruct/src/tarubot`. `tarubot_dev` was restored there from `.cache/backups/tarubot_dev-handoff-0e60f21.dump` (97,427 bytes, sha256 `dddc5d55c7548a11…`), and `check-restore.js` passed at `005_launch_access_policy.sql` for all 26 tables.
- DevBot 2.14.0 (revision `0e60f21`) started at 03:52:47 UTC. Readiness (including `writerLease`) and the guild command read-back were clean, and the startup plan was posted as message `1552528212054249474`.
- Docker on this machine needs the `docker` group. The 2026-09-24 session ran Compose through `sg docker`.

### 2.14.0 reply session — 2026-09-24

The owner ran the 2.14.0 reply session from plan message `1552528212054249474`, 04:00–05:04 UTC. Each reply was compared with the approved mockups, and each failure's `Code · Ref` footer with the log. Every Ref read back matched the logged operation, with the Code matching the logged code. The ledger posts had one embed, no parsed mentions and the full entry ID in the footer. Nine deviations (D1–D9) came out of the session. The owner decided each one, and all of them ship in 2.15.0.

Testers:

- The owner, kaanidog (`725369723964882976`), a server manager and officer.
- PigeonMuffin (`289803961693765632`), an officer by rank through Wyra Riyuh (`38804790`), served as the non-officer. The owner removed his officer access with `/officer revoke` (`1552536049245364347`; its `reconcile.user` job succeeded, and read-back showed Member only), and at 05:06:23 UTC the owner restored it with `/officer grant` ("Pity."), a manual grant. The 2.15.0 session's `/officer reset` removed that grant, so the rank decides again ([the 2.15.0 session](#2150-session--2026-09-24)).
- moonbun_art and poppymori each made a first link. The subject of the `/guest` checks was pazzberry (`1010097911566180445`), the 2.12.1 applicant.

Steps covered:

1. **Utility and configuration (04:00 UTC).** `/version` (`1552530073956126830`), `/ping` (`1552530099297853470`), `/channel` (`1552530116347822151`), `/config show` (`1552530145750028288`) and `/config validate` (`1552530176041164860`) matched their mockups apart from D1. No warn or error lines were logged, and no mentions were parsed.
2. **Characters.**
   - The owner ran `/claim` for I'kayah Tsuji (`47536018`, `1552531545254928414`). The verify button first showed the pending card, then Check again edited it in place to "I'kayah Tsuji is verified" (`1552531608660090881`).
   - A Check again inside the cooldown (`1552531668517130290`) showed "Please wait a moment" with `Code cooldown · Ref 1552531661609246790`.
   - `/characters` (`1552531891155107870`) matched the self-list. `/main` naming the current main (`1552531913804087306`) replied "Main character updated" (D2). `/unclaim` succeeded (`1552531957697740891`).
   - On a second claim, `/verify` before the token was published (`1552535836745138226`) showed "Token not on the Lodestone yet" with `Code pending_proof · Ref 1552535835897897011`. After publication, `/verify` (`1552536301641801828`) verified the character.
   - moonbun_art (`1552536749283221585`, `1552537060869546056`) and poppymori (`1552539965429260378`, `1552540154084986891`, `1552540182232961025`) each made a first link. It set their main and nickname as the approved cards show.
   - The owner's `/nickname enabled:true` (`1552539884886167612`) showed the Server owner warning (D7).
3. **Ledger.**
   - moonbun_art, as a member: a deposit (`1552536866715074590`, post `1552536873786671115`), `/ledger balance` (`1552536940845334589`) and `/ledger history` (`1552536989511847967`), all in the member layout.
   - Officer deposits: `1552532057840816218` and `1552532221519331458`.
   - An oversized withdrawal of 999,999,999 (`1552540004914303057`) replied "Nothing was recorded.". Three withdrawals (`1552540076011946098`, `1552540113995571240`, `1552540153430544424`) had their posts read back.
   - Officer `/ledger balance`: `1552540194714943528`. `/ledger history` with Older (`1552541180561072161`) edited itself in place to page 2 of 2.
   - The 2.12.3 leftover `/ledger adjust`: a bad entry (`1552532645689298964`, `Code input · Ref 1552532645072601128`) showed no Example (D3), and the owner had read the option as the entry number (D4). The UUID then recorded "Correction recorded", which corrects #5 (`1552532747442978937`, audited as `ledger.adjust`).
4. **Guests.**
   - Member `/guest status`: `1552537055517483028`. The officer's `/guest status member:1010097911566180445` (`1552540327456546846`), `/guest revoke` (`1552540373740421131`) and `/guest grant` (`1552540418334400512`) matched guests-board/5 and /6.
   - `/config guest_applications clear:true` (`1552541488909385738`, revision 12) closed applications. PigeonMuffin's `/apply` got the approved closed card (`1552541633894154311`).
   - `channel:#officer-chat` reopened applications (`1552541733059952711`, revision 13) and requeued one held job. Closing by unsetting the channel prompted D8.
5. **Non-officer denials (PigeonMuffin).**
   - `/config show` (`1552537134991278200`) and `/ledger withdraw` (`1552537200833331251`) were refused as specified.
   - `/characters member:` with a typed name (`1552537269104017408`, `1552537555138777139`) was "Check your input" (D5). With a real mention (`1552537890251087962`), it reached "Only your own records".
   - A spaces-only note can't be sent: the Discord client refuses a blank required option, so the server-side note check stays covered by unit tests.
   - `run_id:` values that weren't run IDs (`1552537438046523502`, `1552537747875692584`) were "Check your input" with no Example (D3).
6. **Sync.**
   - Member `/refresh` (`1552537338175946782`) and `/sync status` (`1552537392127148052`) matched, as did `/sync status run_id:` with the full ID (`1552538614267772959`).
   - The officer's `/sync status` (`1552540256362954782`) listed D7's blocked job under Needs attention.
   - Its Full details (`1552540263988199465`) was a 3,600-byte `tarubot-sync.json` with no tokens, secrets or application answers.
7. **Paused pass.**
   - DevBot restarted at 04:52:41 UTC with `ENABLE_EFFECTS=false` as a shell override (`.env` unchanged): readiness 200, `effects:false`, `writerLease:true`, and one lease holder. 11 jobs went `disabled`, each with the paused warn line, and the plan was re-posted with "Effects: paused".
   - `/nickname enabled:false` (`1552543671792963684`), `/guest revoke` and `/guest grant` for pazzberry (`1552543751937859584`, `1552543776222879754`) and `/refresh` (`1552543794988060702`) each showed the pending "Saved, Discord changes paused" card with `‖ PAUSED`. None showed QUEUED or "shortly".
   - The officer's `/sync status` (`1552543830190981180`) showed 23 paused items. `/config validate` (`1552543909026996314`) warned `[WARN] Disabled for this deployment`. Full details (`1552545789740580874`) listed 23 `disabled` jobs.
   - Effects were restored at 05:03:49 UTC: readiness 200, one lease holder and no warn or error lines. "Requeued work held while Discord changes were off" requeued 7 jobs (one per dedupe key, with duplicates closed as `skipped: superseded`). All 45 recent jobs succeeded, including the 10 of run `95855457`.
   - Read-back: pazzberry has Guest, kaanidog has FC Leader and Member, and PigeonMuffin has Member only. The plan was re-posted as `1552546091290067046`.
   - Not covered live: PigeonMuffin's member `/sync status` while paused, because the tester had left. The guests#43 deviation tests cover it.

The review message of decided application `f6198657` (`1552306613384118474`, officer-chat) still has its pre-2.14.0 text. 2.14.0 converts a review message on its next update, and a decided application gets none. The conversion therefore couldn't be confirmed live: that needs a new application, and the forms are on hold. Unit tests cover it.

Deviations and decisions. The owner first planned D1–D4 as a 2.14.2 patch, then moved everything from the session into 2.15.0. OPS-10/OPS-11 moved to 2.16.0, and the cutover floor became 2.16.0.

| # | Found | Owner decision (2026-09-24) | 2.15.0 |
| --- | --- | --- | --- |
| D1 | `/config show`, `/config validate` and the ledger receipt footers read `Woven Souls ««Souls»»`. The stored Lodestone tag keeps its guillemets. | Show the tag once. | `fcTagText` removes one surrounding pair of guillemets before every presenter adds its own. |
| D2 | `/main` naming the current main replied "Main character updated" and queued reconciliation. | "Don't imply a change where no change occurred." | "Already your main character" and "Nickname sync already on" (info), and "Nickname sync already off" (neutral), are `= NO CHANGE` cards that save and queue nothing. `/config officer_rank` naming the saved rank is "Officer rank already set", with no revision bump. |
| D3 | The input failures for `/ledger adjust entry:` and `/sync status run_id:` had no Example. | "If there's a parameter to input, it should provide an example." | Every option of every registered path has an Example; a test walks the registered commands. A failure that isn't about an option's value, such as `/nickname enabled:true` without a main, shows none. |
| D4 | The owner read `/ledger adjust entry:` as the `#5` shown in history, receipts and posts, but the option took only the UUID. | "Allow it to accept the integer, or the UUID." | Accepts `5`, `#5` or the UUID, with a number resolved in the current FC account. Re-register the commands. |
| D5 | `member:` accepted only an ID or a resolved mention, so a typed name never reached "Only your own records". | Autocomplete on the member picker. | Every member option suggests server members, from the cache and then Discord's member search. IDs and mentions are still accepted. Re-register the commands. |
| D6 | PigeonMuffin's officer assignment was removed and he then re-linked Wyra Riyuh, leaving one active link and no main ("Nickname sync: On (no main set)"). His verify reply would have said "Main character: Unchanged". | "Yes, auto-main on relink." | A new link becomes the main when the member has no main and no other active link; it keeps the sync setting, and with sync on it replaces the nickname restore the unlink queued. The reply says "Set as your main because you didn't have one." Imported members keep their state. |
| D7 | The owner's `/nickname enabled:true` queued `reconcile.user` `52ffb81e`. The job blocked because the owner isn't manageable, sat under Needs attention, and blocked again after each `/config` change. | Skip the owner's nickname instead of blocking. | The gateway marks the server owner, and reconciliation leaves the owner's nickname alone and drops any pending restore or write. |
| D8 | Applications opened and closed only through the review channel (`clear:true` closed them). | "The channel setting should be separate from whether applications are enabled." No option is named `clear` ("Clear sounds like you're erasing the channel's history"). | Migration 006 adds a stored switch. `/config guest_applications` takes `enabled:true\|false`, `channel:#…` and `unset_channel:true`. Imports keep the legacy channel with the switch off, and waiting applications stay reviewable. Switching on validates the channel that will take applications, including a stored legacy one. The unset options are `unset_channel`, `unset_role` and `unset_rank`. |
| D9 | Restoring PigeonMuffin with `/officer grant` would leave a manual override; no command removed one. | "Have a third option that removes any override and goes back to membership/rank logic." | `/officer reset` removes the officer override; like grant and revoke, it needs a manager whose highest role is above the Officer role (the server owner is exempt). `/guest reset` lifts the revocation and ends every active grant of any provenance, and ended grants stay as history, which grandfathering still counts. 19 roots / 43 paths. |

Before the 2.15.0 PR, an adversarial review of the change set found gaps in the D2, D3 and D6–D9 fixes; commit `07af9d8` closes them, and the 2.15.0 column above describes the fixed behavior ([VERIFICATION.md](VERIFICATION.md#automated-suites) lists the findings). The 2.15.0 session checks three of them live: the `/config officer_rank` repeat, a deleted stored review channel refusing `enabled:true`, and `/officer reset` by a manager below the Officer role.

Still open after this session: the 2.13.0 layout-switch check, and the multi-character union through `/assign` and `/unassign` with numeric IDs. The closed `/apply` card, Guest revoke and grant, `/ledger adjust` and the non-officer denials passed on 2.14.0. The live checks for 2.15.0, including the closed `/apply` on the new switch, are in `test-plans/current.json`.

### 2.15.0 rollout — 2026-09-24

- PR #14 merged as `974bd27` after every check passed. Its Claude review confirmed the 2.14.1 fix: 11 subagents, none started in the background, all 11 completed, and `claude[bot]` posted ("No issues found"). The review job (run 35999943080) recorded 55 Bash and 3 Write permission denials, a follow-up. Publish run 36002040486 published both 2.15.0 images (revision label `974bd27e52441ae097e2fe0edefca84b32d1187a`) and promoted `latest`.
- The writer stopped at 13:00:47 UTC (exit 0; all 407 jobs succeeded; nothing pending or blocked; no open connections and no lease holders). The backup `.cache/backups/tarubot_dev-before-2.15.0-974bd27.dump` (110,533 bytes, sha256 `b2c81741959659860e75c842ef9d29b2d59fa68be5822739d60724837b135663`) restored into `tarubot_dev_restore_test`, where the 2.15.0 build's `check-restore.js --schema-version 005_launch_access_policy.sql` matched all 26 tables, and every sequence, trigger and constraint.
- `migrate.js --restore-rehearsal` on the copy printed `Schema ready.` at `006_guest_application_switch.sql`: the dev guild's switch was backfilled on (a review channel was set and grandfathering is not pending), its revision stayed 13, and the three `guest_grants.ended_*` columns were added. The copy was dropped. With no lease holder or connection, `migrate.js` then brought `tarubot_dev` to 006 with the same result.
- 2.15.0 started at 13:01:55 and was healthy at 13:02:12 UTC: readiness 200 (database, writer lease, Discord and effects true), the lease acquired on the first attempt, and no warn or error log lines.
- `register.js --guild 1040379370159743139` registered 19 roots / 43 paths. `commands.js list` exited 0 and clean: 19 roots in the dev guild, and none global or in `905225566783963136`, the only other guild the bot has joined. That read-back compares paths and default permissions, so a read-only GET of the guild's commands checked the option names: the `unset_*` options, `/config guest_applications enabled|channel|unset_channel`, and `/officer reset` and `/guest reset` with `member` and `reason` are registered, and no option is named `clear`.
- The startup plan was posted at 13:02:01 UTC as message `1552666419064479837`: "Session: 2.15.0 reply-session fixes and the guest-application switch", with fields of 1,019, 857 and 624 characters and no mentions. The owner's 2.15.0 session had not started at this point.
- Later that day the owner renamed the GitHub account `connstructor` to `deconfined`. The images DevBot runs (pulled as `ghcr.io/connstructor/…:2.15.0`) have the same digests as `ghcr.io/deconfined/tarubot:2.15.0` and `tarubot-nodestone:2.15.0`. The old paths now answer 403, so pulls need the 2.15.1 Compose defaults. Compose's configuration hash includes the image name, so the first `up` from a 2.15.1 or later checkout recreates `tarubot` and `nodestone` from the same digests even with `TARUBOT_IMAGE_TAG=2.15.0`. That is a restart (the gateway reconnects and the startup plan is posted again), so it needs the owner's go-ahead and belongs with the next DevBot update; read-only checks (`ps`, `logs`, readiness) leave the containers running.

### 2.15.0 session — 2026-09-24

The owner ran the plan's first steps from 14:22 to 14:25 UTC, and at 18:00 UTC marked the remaining steps complete. The results (Discord message IDs in brackets):

- **D1, D8.** `/config show` (`1552686731688415242`) and `/config validate` (`1552686785241288866`) show the FC tag once, as "Woven Souls «Souls»". Guest applications are Open in officer-chat, and all 13 checks passed at revision 13.
- **D2.** `/main` (`1552686844242825227`) replied `= NO CHANGE` "Already your main character".
- **D2, D7.** `/nickname enabled:true`, run twice (`1552686886735188028`, `1552686909418119229`):
  - The first turned sync on, with the server-owner note; the second replied `= NO CHANGE`.
  - The owner's `reconcile.user` job succeeded, with the nickname reported `applied` and no write: the owner skip.
- **D2.** `/config officer_rank rank:Officer` (`1552686965705408664`) replied `= NO CHANGE`, with no Heads-up. That is correct, because an FC is linked and an Officer role is bound.
- **D4.** Three `/ledger adjust` corrections of entry #5, with the balance going 4,903,868 → 10,000 → 20,000 → 30,000 gil (test values):
  - receipts: `1552687049499480166`, `1552687107355582597`, `1552687173789024310`;
  - posts in #dev: `1552687059909746699`, `1552687116843094148`, `1552687191090659472`.
  - The receipt footers show the FC tag once.
- **D9.** `/officer reset member:PigeonMuffin` (`1552687267439444039`) replied "Officer override removed", audited as `officer.reset` with `previous: granted`.
  - It removed the manual grant from the 2.14.0 session (`officer.grant`, 05:06:23 UTC, "Pity."). Earlier notes said PigeonMuffin was still revoked; that was wrong, because the grant had restored him.
  - He now has no override and is an officer by rank. Its `reconcile.user` and `channels.access` jobs succeeded.
- **Routine roster read.** The 17:31 UTC roster read accepted 105 members with no departures and posted the plain-text roster notice (`1552734198656143421`). Officer notices stay plain text until 2.17.0 (OPS-11).
- **Logs.** From 13:02 to 18:00 UTC there were no warn or error log lines (595 info lines), and every job succeeded.
- **Accepted without a live record.** The owner accepted these steps; no further command replies were captured after 14:24 UTC:
  - `/nickname enabled:false`;
  - the failure Examples (an unknown `/ledger adjust` entry, `/sync status run_id:nope`);
  - member autocomplete;
  - the non-officer `/characters member:`;
  - the re-link main;
  - the guest-application switch steps;
  - the `/officer reset` repeat and the manager-below-role refusal;
  - `/guest reset`.

  The unit and PostgreSQL suites cover each of them ([VERIFICATION.md](VERIFICATION.md#automated-suites)).

### 2.16.0 rollout — 2026-09-24

This was E1's DevBot validation of the cutover release.

- PR #16 merged as `c812d4d` after every check passed. The Claude review found no issues. Publish run 36057348161 published `ghcr.io/deconfined/tarubot:2.16.0` (`sha256:325322ba…`) and `tarubot-nodestone:2.16.0` (`sha256:1fced412…`), with revision label `c812d4d`.
- **Before the update:** readiness was 200, with nothing pending or blocked. The writer stopped at 20:54:59 UTC (exit 0; all 441 jobs succeeded; no connections and no lease holders; head 006).
- **Backup and restore check:** the backup `.cache/backups/tarubot_dev-before-2.16.0-c812d4d.dump` is 114,827 bytes, sha256 `f8aecd12d4f00b871c9fb04cd51105b4ee3a6f4d2664beed811b3f855a366923`. It was restored into `tarubot_dev_restore_test`, where the 2.16.0 `check-restore.js` matched all 26 tables at 006. The copy was then dropped.
- **Start:** there was no migration. `up -d --wait` at 20:55:13 recreated both containers from the `ghcr.io/deconfined` paths, and they were healthy at 20:55:30. Readiness was 200, with database, writer lease, Discord and effects all true. The lease was acquired on the first attempt (1 ms). No warn or error log lines.
- **Migration guard check:** `migrate.js` ran beside the running bot and printed `Schema ready.` with nothing pending. The bot kept the lease, so there was one holder: with nothing pending, the guard leaves the lease alone.
- **Commands:** `commands.js list` exited 0 and clean (19 roots in the dev guild, none global). No re-registration was needed.
- **Startup plan:** posted at 20:55:16 UTC as message `1552785518171787365`, "Session: 2.16.0 cutover safeguards", with fields of 304, 499 and 269 characters and no mentions.
- **Owner's smoke test (20:57 UTC):** `/version` (v2.16.0, `deconfined/tarubot`, all commits verified), `/config show`, `/characters`, `/ledger balance` and `/sync status` all answered. There were no stale cards, and the log had info lines only.

Production cut over with 2.16.0 that evening ([MIGRATION.md](MIGRATION.md#record-of-the-2026-09-24-cutover)). DevBot stays on 2.16.0 until 2.16.1 is published. 2.16.1 changes no bot behavior.

### 2.16.1 rollout — 2026-09-24

- PR #17 merged as `1655adc`. Before the merge, the Claude review found that HOSTING.md's migration procedure never pulled or pinned the new release; `b556b28` fixed it. Publish run 36072940021 published `tarubot:2.16.1` (`sha256:6b6986b6…`, revision label `1655adc`) and `tarubot-nodestone:2.16.1` (`sha256:6820f4c5…`), and promoted `latest`.
- **Production first** ([HOSTING.md](HOSTING.md)):
  - The host clone was on a detached HEAD at `c812d4d` from the move, so `git pull --ff-only` refused ("not currently on a branch") before anything restarted. It now tracks `main` (`git checkout -B main --track origin/main`).
  - The tracked Compose file differs from the copy set aside at the move only in its header comment.
  - `up -d --wait` at 23:38:59 UTC was healthy at 23:39:16. Readiness was 200, with database, writer lease, Discord and effects true and no public test responses.
  - The only warn lines were profile `unavailable` retries: the private-profile storm that 2.17.0 fixes.
- **Post-cutover tools:**
  - From the operator clone at 2.16.1, `preview.js --late-joiners` read the Linode database under the production profile. The new guard accepted port 27520. It reported `completed` with 0 late joiners.
  - The planned profile retries were unnecessary. 76 of the 79 characters behind the failed rows had been refreshed by later scheduler jobs, and the other three are the deleted and private characters.
  - `retry.js` can't retry profile jobs anyway: they carry no guild.
- **DevBot:**
  - Readiness was 200 with all 465 jobs succeeded. The writer stopped at 23:40:20 UTC: exit 0, no connections, no lease holders, head 006.
  - The backup `.cache/backups/tarubot_dev-before-2.16.1-1655adc.dump` is 117,054 bytes, sha256 `644beefe353e3a49a50a5adc6080996120d8152c58395210e239a43d6c61c615`. It was restored into `tarubot_dev_restore_test`, where `check-restore.js` matched all 26 tables at 006. The copy was dropped.
  - There was no migration. 2.16.1 was healthy at 23:40:52, with readiness 200, one lease holder (acquired in 1 ms) and info log lines only.
  - `commands.js list` exited 0 and clean: 19 commands in the dev guild, none global.
  - The plan was posted at 23:40:39 as message `1552827138057441331`, "Session: 2.16.1 Linode hosting", with fields of 336, 432 and 186 characters and no mentions.

### 2.17.0 rollout — 2026-09-25

- PR #18 merged as `baa9d3c` after every check passed; the Claude review found no issues. Publish run 36077621763 published `tarubot:2.17.0` (`sha256:fe38d715…`) and `tarubot-nodestone:2.17.0` (`sha256:b57bbc28…`), and promoted `latest`.
- **DevBot:**
  - The writer stopped at 00:32:55 UTC: exit 0, 476 jobs all succeeded, no connections or lease holders, head 006.
  - The backup `.cache/backups/tarubot_dev-before-2.17.0-baa9d3c.dump` is 117,775 bytes, sha256 `7fd22e5dc746f54cc2d6f0747b3677b2a2fd1bda48a83e0da5fa9cffde67697e`. It was restored into `tarubot_dev_restore_test`, where `check-restore.js` matched 26 tables at 006.
  - `migrate.js --restore-rehearsal` on the copy applied `007_profile_checks.sql` (lease at 00:33:06.298) and printed `Schema ready.`, with all 105 characters' new columns NULL. The copy was dropped.
  - `migrate.js` on `tarubot_dev` applied 007 (lease at 00:33:15.130).
  - 2.17.0 was healthy at 00:33:31. Readiness was 200, and the sidecar reported `lodestone {cooldownSeconds: 0, strikes: 0}` (and `upstream: update_available`: newer Nodestone commits, a separate update). There was one lease holder, `commands.js list` exited 0 and clean, and the log had info lines only.
  - The plan was posted as message `1552840387318522020`, "Session: 2.17.0 Lodestone hardening". The scheduler stamped no profiles, because all of DevBot's were fresh.
- **Production** ([HOSTING.md](HOSTING.md), the migration procedure):
  - The pull and pin to 2.17.0 ran while 2.16.1 kept running. The bot stopped at 00:34:19 (exit 0).
  - The writer-lease gate printed nothing: head 006, no other connections.
  - The backup `~/tarubot-cutover/work/backups/before-2.17.0.dump` is 271,248 bytes, sha256 `a6ee39060ef8951a04bb1e5e6a33fbf07f407daf18eaae285ad3022221bb88fc`, with 26 tables of data. It is kept off Linode.
  - `migrate.js` in the new image applied 007. Its restore point is 00:34:35.012502 UTC.
  - The bot was healthy at 00:34:50, about 31 s of downtime. Readiness was 200, with one lease holder at head 007 and info log lines only; the storm's warnings were gone.
- **The storm's characters:** 13746792 and 51218446 completed as `{status: "private"}`, their next checks paced a day out. 35999242 had no active link: an officer had already run `/unassign` at 2026-09-24 22:56:10 UTC ("Deleted from the Lodestone."), so the automatic two-404 unlink had nothing to do there. The PostgreSQL tests cover it.

### 2.18.0 rollout — 2026-09-25

- PR #19 merged as `98552d9` after three Claude review rounds, which found five real bugs, all fixed; the last round had no comments. Publish run 36088537989 published `tarubot:2.18.0` (`sha256:0abd8a6a…`) and `tarubot-nodestone:2.18.0` (`sha256:d5f41e4d…`), and promoted `latest`.
- **DevBot:**
  - The owner added `GITHUB_REPORTS_TOKEN` to `.env`: one line, whose checksum matches the token file.
  - The writer stopped at 03:07:08 UTC: exit 0, 487 jobs all succeeded, no connections or lease holders, head 007.
  - The backup `.cache/backups/tarubot_dev-before-2.18.0-98552d9.dump` is 118,704 bytes, sha256 `206992daf3e1d64c09558607facbac9c18b384cb3be3253f32b32de85627a204`. The restore check matched 26 tables at 007.
  - The rehearsal on the copy applied `008_issue_reports.sql` and printed `Schema ready.`, with `issue_reports` empty. The copy was dropped.
  - `migrate.js` applied 008 (lease at 03:07:35.769). 2.18.0 was healthy at 03:07:52, with the token present in the container, one lease holder and info log lines only.
  - `register.js --guild` registered 20 roots / 44 paths, and `commands.js list` exited 0 and clean (20 commands in the dev guild, none global).
  - The plan was posted as message `1552879227550961796`, "Session: 2.18.0 issue reports".
- **Production:**
  - The token was appended to the host's `.env` over SSH stdin: one line, checksum matching, mode 600.
  - The pull and pin to 2.18.0 ran while 2.17.0 kept running. The bot stopped at 03:08:45.
  - The writer-lease gate printed nothing (head 007).
  - The backup `~/tarubot-cutover/work/backups/before-2.18.0.dump` is 308,481 bytes, sha256 `f8ad32f85b0dd6713c805b8f0b8d87968561dd36d32cb20fb8f4a9a86be58f99`, with 26 tables of data.
  - `migrate.js` in the new image applied 008. Its restore point is 03:08:59.951594 UTC.
  - The bot was healthy at 03:09:15, about 30 s of downtime, with the token present, one lease holder, head 008 and info log lines only.
  - From the operator clone, `register.js --global` registered 20 roots / 44 paths, and `commands.js list` exited 0 and clean (global 20, including `issue`).
- **First report:** the owner's `/issue` opened issue #1 in `deconfined/tarubot-reports`, with the right title, labels and fenced description, and no secrets. Its layout problems, above all a code fence starting mid-line, are fixed in 2.18.1.

### 2.18.1 rollout and reports-token rotation — 2026-09-25

- PR #20 merged as `6a3973d`. The review round fixed a null roster age read as "0 s" and routine logs being filtered after truncation; the re-review had no comments. Publish run 36092052960 published `tarubot:2.18.1` (`sha256:e2e0d0ac…`) and `tarubot-nodestone:2.18.1` (`sha256:1848bdcb…`).
- **DevBot:**
  - 501 jobs, all succeeded. The writer stopped at 03:58:39 UTC, head 008.
  - The backup `.cache/backups/tarubot_dev-before-2.18.1-6a3973d.dump` is 124,514 bytes, sha256 `eefcbd69e1a2693b58c93cd399ec45abb446cf53b5377ab0be9bf6d6aebabee4`. The restore was verified at 008.
  - Healthy at 03:58:59, readiness 200.
- **Production:** the no-migration procedure (pull, pin, `up -d --wait`). Healthy at 03:59:27, with the token present and info log lines only.
- **Token rotation:**
  - The first reports token had been pasted in chat, so the owner regenerated it. The new one can open issues only in `tarubot-reports` (the empty-body probe got 422 there, 403 on the main repository), and the old one answers 401.
  - The production `.env` was swapped over SSH stdin (temporary file and rename, mode 600, checksum matching), and the bot container was recreated at 04:07:39.
  - The owner swapped DevBot's `.env`, and the container was recreated at 04:08:29.
  - Test report #3, which failed five times with 401 while the old token was active, was delivered as issue #2 at 04:08:50.
  - Issue #2 rendered as 11 tables, 2 code blocks and the collapsible logs, with no stray fences and no secrets.

### 2.21.0 rollout — 2026-09-25

- PR #23 merged as `220a99f`; CI, CodeQL and the Claude review passed with no comments. Publish run 36130248661 published one image, `tarubot:2.21.0` (`sha256:db294d15…`), and promoted `latest`; there is no `tarubot-nodestone:2.21.0`. It carries 2.19.0 (live selectors) and 2.20.0 (TaruBot's own parser), which were not deployed separately.
- **DevBot:**
  - 556 jobs, all succeeded. The writer stopped at 11:40:47 UTC with no lease holders, head 008.
  - The backup `.cache/backups/tarubot_dev-before-2.21.0-220a99f.dump` is 130,299 bytes, sha256 `6684c7e5636dbdf8f8939c488d07457828481e97ef1faa4bddd3e4969fb03a71`. The restore was verified at 008 and the copy dropped. No migration and no registration.
  - `up -d --wait --remove-orphans tarubot` at 11:40:50, healthy at 11:41:06; `tarubot-nodestone-1` was removed as an orphan.
  - Readiness 200 with the new `lodestone` object: no parses running, no cooldown, selectors `a96d68b` (bundled, upstream current). The logs held only the startup lines and "Lodestone selector upstream status changed" (current); reconciliation, layout and channel jobs succeeded, and the plan posted without error.
- **Production:**
  - The host clone pulled `220a99f` (git could not remove the untracked `vendor/nodestone` leftover, which is inert), `TARUBOT_IMAGE_TAG=2.21.0`, pull, then `up -d --wait --remove-orphans` at 11:42:18, healthy at 11:42:24. `tarubot-nodestone-1` was removed.
  - Readiness 200 with test responses off, the Lodestone object current and the reports token present. 124 member reconciliations succeeded by 11:43:27.
  - No Lodestone job was due in the first minutes (profiles are paced daily, rosters every 6 h), so a read-only parse ran inside the production container: a profile with its FC in 755 ms, the Woven Souls FC (105 members) in 803 ms, and member page 1 (50 entries, page 1 of 3).
- **Operator machine:** the production-tools clone `~/tarubot-cutover/src` moved from 2.18.0 to 2.21.0 and was rebuilt. The cutover's `tarubot-cutover-nodestone` container, running since the cutover, was stopped; 2.21.0 tools parse in their own process.

### 2.22.0 rollout — 2026-09-25

- PR #24 merged as `dfa6c5b`; CI, CodeQL and the Claude review passed with no comments. Publish run 36135042231 published `tarubot:2.22.0` (`sha256:f8fea36a…`) and promoted `latest`.
- **DevBot:** 567 jobs, all succeeded. The writer stopped at 12:32:21 UTC with no lease holders, head 008. The backup `.cache/backups/tarubot_dev-before-2.22.0-dfa6c5b.dump` is 131,026 bytes, sha256 `ca2ff878b3efa3cec9875dd767018f803f21c9e7c8e25c90483a922ea9f1c2f8`; the restore was verified at 008. Healthy at 12:32:40, readiness 200, and the heartbeat off, as intended (no URL in DevBot's `.env`).
- **Production:** the ping URL went from `~/tarubot-cutover/healthchecks-production.url` into the host's `.env` over SSH stdin, in the same rewrite that pinned `TARUBOT_IMAGE_TAG=2.22.0`; the file stayed mode 600 and its checksum matches the saved URL. `up -d --wait --remove-orphans` at 12:32:54, healthy at 12:33:00, readiness 200 with the heartbeat on and the reports token present. No heartbeat warnings over the first scheduler passes, and the owner confirmed the check receives good pings.

### 2.24.1 rollout, with 2.24.0's backup schedule — 2026-09-25

- 2.23.0 (PR #25, `9cf2afd`) changed only docs and an operator script, so nothing was deployed. 2.24.0 (PR #26, `b325b81`) and 2.24.1 (PR #27, `8a580de`) went out together. Publish run 36147321044 published `tarubot:2.24.1` (`sha256:d37f56d3…`) and promoted `latest`.
- **DevBot:** 578 jobs, all succeeded. The writer stopped at 14:29:56 UTC with no lease holders, head 008. The backup `.cache/backups/tarubot_dev-before-2.24.1-8a580de.dump` is 131,730 bytes, sha256 `b8122b3dbb9225d77730e553b590f0e1a96d26b872359b0e0a38f0499285f132`; the restore was verified at 008. Healthy at 14:30:15, readiness 200.
- **Production:**
  - The host clone pulled `8a580de`, `ops/backup.sh` arriving executable from Git. Then `TARUBOT_IMAGE_TAG=2.24.1`, pull, and `up -d --wait --remove-orphans` at 14:30:29, healthy at 14:30:35.
  - Readiness 200 with the heartbeat on. None of the `BACKUP_*` settings is visible inside the bot's container.
  - `~/tarubot/ops/backup.sh` then ran from its real path: `backup ok: tarubot-20260925T143036Z (396896 bytes, settings 2623 bytes)`, with no backup container left behind.
- **Schedule.** The crontab line `30 4 * * * $HOME/tarubot/ops/backup.sh >> $HOME/tarubot-backup.log 2>&1` is installed, cron is active, and the log is mode 600.
  - The first install ran under `set -e`. There, the `grep` that drops an old line found nothing to keep and ended the subshell before the new line was written, installing an empty crontab.
  - Reinstalled without that. HOSTING.md's command runs in an ordinary shell and is unaffected.
- The scratch-copy test runs at 13:15 and 13:31 left their `daily/` copies, which expire after 30 days.

### 2.26.0 rollout plan (`/suggest`; not yet run)

Planned only: 2.26.0 (issue #32) is not merged or deployed. It follows 2.24.3 and 2.25.0 in the agreed release order, and each step below needs the owner's go-ahead.

- **DevBot** (restart, no migration): stop the writer, take the usual `pg_dump` and restore check at the current head, `up -d --wait --remove-orphans tarubot`, `register.js --guild` (21 roots / 45 paths), `commands.js list`, then readiness, logs and the plan in #chat. DevBot needs no new setting: with `GITHUB_REPORTS_TOKEN` in its `.env`, `/suggest` previews into the private `deconfined/tarubot-reports`.
- **DevBot checks:**
  - a member's `/suggest` opens a preview issue in `deconfined/tarubot-reports`; check its title, fixed first line, fenced text, footer and the labels `enhancement` and `from-discord` (created there on first use), and that the reply names `deconfined/tarubot-reports#N`;
  - a second try within the hour gets "You can suggest again later";
  - an idea of fewer than 10 visible characters gets "Check your input" with the Example;
  - an account without the Member or Guest role gets "FC membership needed" with the steps to either role (PigeonMuffin, with his roles removed for the test, or a fresh account).
- **Production:** put `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_PRIVATE_KEY` in the host's `.env` over SSH stdin (temporary file and rename, mode 600, the PEM double-quoted and multi-line like the CA, checksum matched), refresh the settings copy, then the no-migration procedure (pull, pin `TARUBOT_IMAGE_TAG=2.26.0`, `up -d --wait`). Probe the app without creating an issue (expect 422; [OPERATIONS.md](OPERATIONS.md#public-suggestions)), then `register.js --global` from the operator clone and `commands.js list` (21 global).
- **Owner test:** one `/suggest` in Woven Souls. Check that the author is the app's bot account, both labels are applied, `＠` replaces `@`, no IDs appear, and no Claude run starts in Actions. Then close or delete the test issue and record the result here and in VERIFICATION.md.

### Remaining unverified-visitor form checks (on hold until after launch)

The user selected manual form review **only for unverified visitors**. Verified non-FC users keep automatic Guest eligibility and FC members keep Member eligibility. PR #6 merged at `db062bdbb9fc502d62a214f8a56692e418b8875b` on 2026-09-23 at 05:46:39 UTC with all checks passed. [Publication run 35823822742](https://github.com/deconfined/tarubot/actions/runs/35823822742) succeeded, so the 2.12.0 images are available. Migration 004 is deployed; the remaining `/apply` scenarios still require live testing. From 2.15.0, `/apply` also needs the guest-application switch on (`/config guest_applications enabled:true`); migration 006 turns it on for DevBot because a review channel is set.

Before that rollout, a read-only handoff check confirmed the bot and sidecar ran **2.11.1**, revision `1de878ef6c314cd83ac26bf7513d5db64210bcad`, and PostgreSQL reported schema **003**. All three containers were healthy; readiness had database/Discord connected, effects/public development replies enabled, no pending/blocked work, and no degraded FCs. Guild revision 10 and its role/channel bindings remained intact, with two active links and an uninitialized ledger (`NULL`, sequence 0). See [SESSION_HANDOFF.md](SESSION_HANDOFF.md) for the exact resume state. The source startup plan is the 2.15 session (2.15.0 or later), which DevBot posted on 2.15.0 as message `1552666419064479837`; the owner completed it on 2026-09-24 ([the 2.15.0 session](#2150-session--2026-09-24)). Use the plan matching whichever checked release is deployed.

Setup, original-role reuse, resource validation, complete reconciliation, and real profile-token verification have passed. Member and FC Leader delivery, consecutive role positions, preserved permissions, and hoist flags are confirmed by Discord readback. A fresh seven-job refresh passed after the owner's nickname opt-out. The owner put the remaining form checks on hold on 2026-09-23, and they remain on hold. The 2.14.0 reply session passed on 2026-09-24 apart from D1–D9, which 2.15.0 resolves. It could not confirm live that a review message is converted to one embed, because that needs a new application. The current plan, `test-plans/current.json`, is the 2.15 session (2.15.0 or later, posted on 2.15.0), completed on 2026-09-24: D1, D2, D4, D7 and D9 were confirmed live, and the owner accepted the remaining steps. The 2.13.0 layout-switch and `/assign` union checks also remain. See `test-plans/current.json`, the latest plan in `#chat`, and [OPEN_ITEMS.md](OPEN_ITEMS.md) for remaining acceptance work.

The running development instance now has `ENABLE_EFFECTS=true`. Use dedicated DevBot test roles and destinations when configuring stateful workflows, then follow the live checklist in [VERIFICATION.md](VERIFICATION.md).

The owner requested public output for observers in this development server. The DevBot Compose overlay enables `PUBLIC_TEST_RESPONSES` by default; new slash-command, component, and error replies in the configured test guild are public. Authorization still applies to every operation. Visibility is selected when Discord acknowledges an interaction, so the setting applies to new replies after deployment.

Earlier functional probes used Administrator. It is now disabled; the documented limited permissions, role hierarchy, command inventory, member enumeration, and new officer-room management have passed. Full onboarding and human visibility verification under that permission set remain in the current session plan.

Discord forbids bots from changing the owner's nickname regardless of role order. Choose one of the non-owner human participants for successful nickname-write tests. Through 2.14.x the owner's nickname sync leaves a blocked `reconcile.user` job (D7). From 2.15.0 reconciliation skips the owner's nickname and drops any restore queued for it, so neither `/nickname enabled:true` nor `enabled:false` from the owner should leave anything blocked.
