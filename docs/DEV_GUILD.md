# DevBot live test session

## Identity and deployment

- Application/bot: **DevBot**, `943291473477128243`.
- Test guild: **TaruBot Development**, `1040379370159743139`.
- The other application in this guild is **TaruBot**, `965294750741692416`.
- DevBot's isolated PostgreSQL database is `tarubot_dev`.
- `docker-compose.devbot.yml` supplies the development database and requires explicit test-guild scope.

Use the development overlay consistently for this running instance:

```sh
docker compose -f docker-compose.yml -f docker-compose.devbot.yml up -d --wait tarubot nodestone
docker compose -f docker-compose.yml -f docker-compose.devbot.yml logs -f tarubot
```

The Compose service is named `tarubot`; its actual Discord identity comes from the configured application/token and is checked on startup.

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

Higher positions take priority. The current verified layout is:

| Managed role | ID | Position | Separate member-list display |
| --- | --- | --- | --- |
| DevBot FC Leader | `1551979217087103137` | 4 | Enabled |
| DevBot Officer | `1551979211391115405` | 3 | Enabled |
| DevBot Member | `1042089882677420172` | 2 | Enabled |
| DevBot Guest | `1042089887798677545` | 1 | Enabled |

The managed block is uninterrupted, and unrelated roles retain their relative order. The latest session announcement is [available in #chat](https://discord.com/channels/1040379370159743139/1040379370931507252/1552008870069538898).

Repeat the scoped probes with:

```sh
bun run build
bun dist/scripts/discord-inspect.js
bun dist/scripts/discord-smoke.js --member-role 1042089882677420172 --guest-role 1042089887798677545
```

Adding `--channel 1040379861153357995` to the smoke probe explicitly enables the temporary bot-owned message test in `#dev`.

## Human interaction checks

Setup, original-role reuse, resource validation, complete reconciliation, and real profile-token verification have passed. Member and FC Leader delivery, consecutive role positions, preserved permissions, and hoist flags are confirmed by Discord readback. A fresh seven-job refresh passed after the owner's nickname opt-out, leaving no outstanding guild work. The current plan asks testers to confirm the corrected role list and visible member grouping. See `test-plans/current.json` and the latest plan in `#chat`.

The running development instance now has `ENABLE_EFFECTS=true`. Use dedicated DevBot test roles and destinations when configuring stateful workflows, then follow the live checklist in [VERIFICATION.md](VERIFICATION.md).

The owner requested public output for observers in this development server. The DevBot Compose overlay enables `PUBLIC_TEST_RESPONSES` by default; new slash-command, component, and error replies in the configured test guild are public. Authorization still applies to every operation. Visibility is selected when Discord acknowledges an interaction, so the setting applies to new replies after deployment.

DevBot still has **Administrator**. Functional probes succeeded under that permission; validating the intended minimum-permission deployment requires disabling Administrator and granting Manage Roles, Manage Nicknames, and the documented channel permissions explicitly.

Discord forbids bots from changing the owner's nickname regardless of role order. Choose one of the non-owner human participants for successful nickname-write tests; the owner's expected blocked outcome can be tested separately.
