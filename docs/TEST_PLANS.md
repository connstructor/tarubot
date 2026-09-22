# Startup test-session plans

The discovered `test-session.event.ts` listener posts one session announcement after successful application initialization. It runs only when `TEST_GUILD_ID` is set and defaults to the unique guild text channel named `chat` in that guild.

The message separates actions into three sections:

- **You**: human actions in Discord, including exact commands and prerequisites.
- **Me**: implementation, observation, diagnosis, and follow-up verification by the coding assistant.
- **DevBot**: automatic acquisition, reconciliation, and delivery work.

Edit `test-plans/current.json` before starting a new test session. Each party's complete checklist must fit one 1,024-character embed field; invalid plans produce a scoped startup diagnostic instead of a truncated checklist. The plan includes the startup timestamp and current effect-enable state, and uses an explicit no-mentions policy.

`docker-compose.build.yml` mounts this directory read-only for local source-based sessions, so an edited plan is read on the next startup without rebuilding application code. Published images carry a default copy and do not require a host checkout or plan directory. Combine the build override with `docker-compose.devbot.yml` when using the isolated development database. Set `TEST_PLAN_CHANNEL_ID` to choose a specific channel if `#chat` is ambiguous, and `TEST_PLAN_FILE` to select another plan file.

A once-only ready listener and per-startup message nonce prevent repeated announcements within one process. A new process posts a new session plan. Operational one-shot clients do not install live event modules, so inspection/registration tools do not announce extra sessions.
