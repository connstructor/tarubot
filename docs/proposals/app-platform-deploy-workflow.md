# Proposal: automated, owner-approved App Platform deploys

> **Historical (2026-09-25).** App Platform was retired in 2.21.0, and the Nodestone sidecar image it names is gone. Releases B and C are to be re-planned for the Linode Compose host over SSH; this proposal remains as the record of the approved principles.

**Status:** approved by the owner on 2026-09-24 (draft 3). Its recommendations are the answers to its decisions. Release A shipped as 2.16.0, with `commands.js declared`/`check` and the `app-spec.ts` image rules moved to Release B, which uses them. Releases B and C come after the cutover. No DigitalOcean resource, token, bucket, database login, GitHub environment, variable or secret has been created for them yet.

This draft carries three things:
- **Your decisions of 2026-09-24:**
  - automate as much as possible, including database migrations;
  - register Discord commands in the workflow;
  - accept a few minutes of downtime for a release with a migration;
  - use restore points plus scheduled off-site backups instead of a manual dump before each window.
- **Two review rounds**, 48 and 61 findings, each upheld by two independent verifiers, plus a final check of coverage and contradictions. All of them are addressed here.
- **A replacement for the deploy-on-push draft** in `.do/app-main.yaml`. That draft was found unsafe: every merge would have migrated production under the running bot, including during the cutover.

## In short

**For each release, you:**

1. Merge the release PR, as today.
2. Get a GitHub notification (email and mobile app) *only* if the release changes something that runs in production. Documentation-, test- or CI-only releases ask nothing of you.
3. Open the run, read the plan on its Summary page, and click **Approve and deploy** (or **Reject**).

**The workflow, by itself:**

- Deploys the images CI tested, pinned by digest.
- Handles a migration in two stages:
  1. the old bot stops, so nothing writes to the database;
  2. the new release's migrate job takes the database writer lease, records a restore point, and applies all pending migrations as one transaction.
- Re-registers Discord commands when Discord's registered set differs from the release's.
- Puts the previous release back when a failure happened before the new release could have written anything.
- Otherwise stops, and tells you exactly what state it left.

**What still needs you:**

- The approval click.
- The one-time cutover (W1–W16).
- Recovery after the new release has written to the database and then failed. The workflow never rolls back work you didn't approve.
- A few rare setup changes the workflow refuses to make: new secrets, components or databases, and instance sizes.
- Tokens, the backup bucket and its key.

The [decisions](#decisions-for-you) are at the end. Each has a recommendation, so a yes or no per item is enough.

## How it fits together

```text
merge to main ──► "Publish containers" publishes X.Y.Z (tested bot, Nodestone and backup images)
                          │  (success, push to main)
                          ▼
        Plan job   (read-only token; automatic, or started by hand for rollback/resume/commands)
          ├─ nothing that runs in production changed ─► ends quietly: "no deploy needed"
          ├─ deploys disabled ────────────────────────► plan job skipped; no secrets loaded
          ├─ something it must not do ─────────────────► fails with the reason (GitHub emails you)
          └─ deployable ──► the plan, in the run summary
                          │
              you approve in GitHub  (environment "production")
                          │
        Deploy job  (deploy token)
          ├─ one stage:  update images (+ synced settings); the new bot takes over the writer lease
          └─ two stages: A  maintenance: the old bot stops
                         B  new release: migrate job takes the writer lease, logs the restore point,
                            migrates in one transaction; then the new bot starts
          └─ verify ─► automatic recovery only when provably safe
                          │
        Commands job  (Discord token, fresh runner, nothing installed)
          └─ compare Discord's commands with the release's; register if different; check again
                          │
        Notify job  ──► Pushover: deployed / skipped / refused / rejected / recovered / needs you

DevBot and other Compose hosts: unchanged; they still pull GHCR tags by hand.
Recommended order: publish → update DevBot and try it → approve the production plan.
```

## One-time setup, in order

Each step is a provider or settings action and needs your go-ahead.

| When | Step |
| --- | --- |
| Before the PR that adds `deploy.yml` merges | **GitHub environments.** Unprotected ones would be created automatically on the first run. <br>• **`production-plan`**: branch `main` only, no reviewers, no custom deployment protection rules (the plan job skips deployment records, which such rules would block). <br>• **`production`**: branch `main` only; **you as required reviewer**; **"Allow administrators to bypass configured protection rules" off**; "Prevent self-review" off, since you are the only reviewer. <br>• **`production-commands`**: branch `main` only, no reviewers. Only the commands job uses it, and that job runs only after an approved deploy job. <br>• **`notify`**: branch `main` only. <br>**Repository variables** (not secrets): `DO_APP_ID`, and `DEPLOY_ENABLED` left unset. |
| With the backup release (C), before any automated migration | **Backups.** <br>• A bucket with a provider other than DigitalOcean, with object lock or versioning and a retention period, and a key that can write but not delete. <br>• A dedicated read-only database login, created as `doadmin` with `pg_read_all_data`. <br>• An `age` encryption key pair, with the private half kept offline by you. <br>The bucket key and the read-only database URL go into App Platform on the backup job only, as encrypted secrets. See [Backups](#backups). |
| At W16, before the token leaves the production env file | **`production-commands`:** store `DISCORD_TOKEN` (the token from W3's reset) there now. Discord shows a token only when it is reset, and W16 removes it from the production env file unless local tools still need it. |
| After the cutover, once Releases B and C are live (a new post-cutover step after W16) | **Tokens**, created only now so their 90 days aren't wasted. <br>• **Read token** (`app:read` plus the `regions:read`, `sizes:read` and `actions:read` it requires) → `DIGITALOCEAN_ACCESS_TOKEN` in `production-plan`. <br>• **Deploy token** (`app:update` plus the `app:read`, `regions:read`, `sizes:read` and `actions:read` it requires) → `DIGITALOCEAN_ACCESS_TOKEN` in `production`. <br>• Optional: **`PUSHOVER_USER`** and **`PUSHOVER_TOKEN`** → `notify`. |
| After that, once the backup job has made one dump that passed the restore test | **Enable:** set `DEPLOY_ENABLED=true`. |

About the tokens:
- **Neither token** can create or delete apps, open the console, or use DigitalOcean's `database:*` API scopes.
- **The deploy token is still a production database credential.** It can change what the app's components run, including jobs that hold the database binding, and it can toggle the app's trusted-source rule. Both tokens can read runtime logs, which contain member data.
- **If the first update is refused for a missing scope,** add `database:update` (never `database:create`). DigitalOcean lists it as an optional associated scope of `app:update`.
- **No short-lived alternative exists.** DigitalOcean has no short-lived GitHub sign-in (OIDC) for its API.

**Where the Discord token lives after W16:** App Platform (the worker) and GitHub `production-commands`. Your production env file keeps it only if you still run local tools that need it. After a token reset, update every place that holds it.

## Triggers, inputs and concurrency

- **Automatic:** `workflow_run` on "Publish containers" (`completed`, branch `main`). The plan job runs only when that publish succeeded for a `push` and `DEPLOY_ENABLED` is `true`. Otherwise the run ends without loading any secret. A unit test pins `publish.yml`'s `name:`, so a rename can't silently break the trigger.
- **By hand** (`workflow_dispatch`), with these inputs:
  - `version`: a published SemVer.
  - `rollback`: default false. Allows a target that is not a descendant of the live commit.
  - `resume`: `finish` or `restore`. Continues or undoes an interrupted two-stage deploy (see [Interrupted runs](#interrupted-runs)).
  - `repin`: default false. Switches a tag-pinned live spec to digests without a new release. The first release the workflow deploys does this anyway.
  - `commands_only`: default false. No app update; brings Discord's commands in line with the live release. It still needs your approval.
- **Which commit's code runs:** the workflow and its scripts come from the run's commit (`github.sha`, main as of the trigger). Both jobs check out exactly that commit, and the deploy job refuses if the plan's script commit differs. The target release's files (`.do/app.yaml`, `migrations/`, `src/config/env.ts`) are only read, as data.
- **Re-runs are refused.** Every job, and the concurrency group, requires the first attempt (`run_attempt == 1`) on `main`. "Re-run failed jobs" would otherwise reuse a stale plan's outputs. Start a fresh run instead.
- **Concurrency:** runs that can deploy share one group, `app-platform-production`, and a running deploy is never cancelled. Runs that will end without planning (a failed publish, deploys disabled, a re-run, a branch other than `main`) get their own throwaway group, so they can never displace a real one. GitHub keeps one run waiting behind the running one, and a newer deployable run replaces an older waiting one. A run waiting for **your approval** holds the group for up to 30 days, so reject a plan you won't approve.
- **Permissions:** `contents: read` and `actions: read` only.

## Plan job

Runs in `production-plan` with the read token, without recording a GitHub deployment.

**What it prints:** versions, commits, digests, file and key names, and the target template's values for synced settings, which are already public in the repository. Never live spec values, secrets or logs.

**How it ends:**
- **Success with a notice:** "no deploy needed" or "already live". While deploys are disabled, the plan job doesn't run at all.
- **Failure, so GitHub emails you:** a real refusal.

| Step | What it does | Why |
| --- | --- | --- |
| 1. Preconditions | Refuses unless the `production` environment (read through GitHub's public API) requires your review, allows only `main`, and doesn't let admins bypass. | The approval gate is real only if the environment is set up that way. |
| 2. Find the release | Takes the target commit: the publish run's commit, or the first-parent commit on `main` whose `package.json` has `version`. The bot and Nodestone images, and the backup image when the target's template declares the backup job, must exist as `X.Y.Z` and `sha-<commit>`, with those tags on the same digest. Each must carry that commit as its revision label, and come from a successful "Publish containers" run of it. | A release maps to exactly one reviewed commit whose images passed CI. |
| 3. Resolve digests | The **Intel/AMD (linux/amd64) build** digest of each image, not the multi-platform bundle that also holds the ARM build and provenance records. Registry and repository come from the target's template. | Tags can move; digests can't. App Platform needs amd64. |
| 4. Read what's live | `GET /v2/apps/{id}` into a private file. The live spec is `.app.active_deployment.spec`: the deployment actually running, not the last one submitted. Its image revision labels must be commits on `main` whose `package.json` matches their version label. Worker and migrate job must be one image; Nodestone and the backup job must come from the same release. **With `resume`:** the live release, the live commit and the base spec are those of the pre-maintenance deployment named in the marker, read from the deployment history (`GET /v2/apps/{id}/deployments/{id}`, its `spec`); the active maintenance spec is only checked for the marker. | After a failed update, the last submitted spec names a release that never ran. |
| 5. Check the app's state | Refuses if any of these hold: <br>• a deployment is in progress or pending; <br>• the app is pinned by an App Platform rollback, which blocks deployments until you commit or revert it in the console; <br>• the submitted spec differs from the active one outside image references (a failed manual change), except under `resume`, when it is this workflow's stage B or recovery spec for the marker's run; <br>• there is no worker, meaning before W13, or maintenance without a matching `resume`; <br>• the app's name or database isn't `tarubot`. <br>When the only difference is images from an earlier failed run of this workflow, it continues from the active release and says so. | Stops on anything it can't safely reason about. |
| 6. Compare live and target | Diffs the two commits for: <br>• **runtime changes**: everything except known non-runtime paths (`docs/`, `tests/`, `*.md`, `.github/` except `workflows/publish.yml`, which builds the images, `test-plans/`, `production.env.example`, and `package.json`'s version line and `.do/app.yaml`'s release-tag line); <br>• **migrations**: any added file, and any change to an applied one; <br>• **the spec template** against the active spec (see [Spec changes](#spec-changes-in-a-release)); <br>• **configuration schemas**: `src/config/env.ts`, the sidecar's settings and `production.env.example`; new or changed keys the template doesn't set are flagged "check before approving"; <br>• **declared commands**: a hash of the payload each release's image declares (`commands.js declared`, a new offline mode run with networking off). This is advisory; the commands job always compares with what Discord actually has. | Decides whether a deploy is needed, whether it takes one stage or two, what spec changes it carries, and what you should check. |
| 7. Decide | **Ends quietly:** no runtime change; the target is already live; or, on an automatic run, the target is an ancestor of the live commit ("superseded by the live release"). <br>**`commands_only`:** refuses unless `version` is the live release; skips the other comparisons, plans no app update, and still asks for approval so the commands job can run. <br>**`repin`:** refuses unless `version` is the live release and the live spec still uses tags; plans a one-stage image-reference update. <br>**Refuses:** <br>• a changed, deleted or renamed *applied* migration; <br>• a target that isn't a descendant of the live commit, unless `rollback: true` was given by hand; <br>• a rollback across a migration; <br>• any target below the first release containing both [Release A](#bot-and-tooling-changes) and [Release C](#backups), because older releases lack the safeguards, or the backup image the live backup job needs; <br>• a spec change outside the sync rules; <br>• for two stages, no successful backup-job run in the last 26 hours, or one still running. <br>**Otherwise:** one stage or two. | Automates what it can prove safe; explains the rest. |
| 8. Write the plan | The summary, and the approval text (see the list below). | This is what you read before approving, and what your approval covers. |

The summary shows:
- live version and commit → target version and commit, and the three digests;
- one or two stages, with the expected downtime, the new migration files, and the age of the latest off-site backup;
- spec changes, as key paths with the template's values, and configuration keys to check;
- whether the declared commands changed;
- runtime changes, such as Bun or the base image. They never block, but you may want to watch the first minutes;
- the release notes in between, and a reminder: "Tried on DevBot?";
- **the conditional actions your approval covers**, for example: "If the new release fails before taking the writer lease, apply maintenance to stop it, then re-apply live release 2.16.3 (digests …)." and "If Discord's commands differ from 2.16.4's, register them."

The plan's outputs for the jobs after it: whether to deploy (`deploy`), the target commit, the digests, the bot image repository (`image`), the stage count, the active deployment ID, a hash of the canonical JSON of the active spec, and the plan's script commit.

## Approval

- **Notification:** GitHub notifies you by email and in the mobile app when the deploy job waits.
- **Reviewing:** open the run and read the Plan job's summary. Then choose **Review deployments**, tick `production`, and **Approve and deploy** or **Reject**. Your comment and the summary are public, like the logs.
- **Expiry:** an unanswered request fails after 30 days.
- **Requirements amendment:** *"The owner's own approval of a `production` deployment, given in the GitHub web or mobile UI, authorizes the app updates its plan lists (both stages), the automatic recovery re-apply it lists, and the command registration it lists."* It sits beside the matching changes to MIG-13, DEPLOY-DO-01, OPS-14 and CLAUDE.md, listed in [Repository changes](#repository-changes-and-packaging).
- **Agents:** Claude sessions never approve, reject or bypass a pending deployment, and never start the workflow unless you ask in that session.

## Deploy job

Runs in `production` with the deploy token, after your approval.

- **Private files:** everything holding spec contents is private (0600) in the runner's temporary directory. Nothing is printed or uploaded, and a final step always deletes the files.
- **Locked dependencies:** installed from the lockfile, with install scripts disabled, before any step receives the token. The token-bearing step runs with Bun's auto-install off.
- **`commands_only` runs:** the job only re-checks that the live release equals `version`, makes no app update, and marks itself verified, so the commands job runs after your approval.

### Common steps

| Step | What it does | Why |
| --- | --- | --- |
| 1. Re-check | Everything from Plan steps 1, 4, 5 and 7 again, and `DEPLOY_ENABLED` must still be `true`. The active deployment ID, the active-spec hash and the plan's script commit must be unchanged, and the run must be on its first attempt. | A console edit, another deploy, a failed update or a rollback after approval stops the run. |
| 2. Take the live spec | The raw `.app.active_deployment.spec` from `GET /v2/apps/{id}`, not `doctl`'s export. It is also saved as the **previous full spec**, for recovery. **With `resume`:** the previous full spec is the pre-maintenance deployment's spec (Plan step 4), never the maintenance spec, which has no worker, no jobs and none of their secrets; steps 3–5 build and check stage B from it. | `doctl` re-encodes exports and silently drops fields it doesn't know. The raw API keeps every field, and encrypted secrets (`EV[...]`, App Platform's encrypted form of a secret) stay encrypted. |
| 3. Build the target spec | Applies the planned spec changes from the target's template. For each image it sets `registry_type`, `registry` and `repository` from the template, and `digest` from the plan, removing `tag`. | App Platform rejects an image with both a tag and a digest. |
| 4. Prove nothing else changed | Compares the target spec with the live one. The only differences allowed are the image references and the planned changes. | A bug in step 3 can't slip in another change. |
| 5. Run the repository's checks | First `app-spec.ts full`, which checks: <br>• one worker, the database binding, no placeholders, no pool; <br>• worker and migrate images identical; <br>• exactly one of tag or digest per image. <br>Then `doctl apps spec validate --schema-only` in the digest-pinned doctl image, with networking off. It is strict: an unknown field fails it, and the fix is to bump the doctl pin. | The invariants CI applies to the template, applied to the real spec. |

### One stage (no migration)

| Step | What it does | Why |
| --- | --- | --- |
| 6. Apply | Submits the target spec through the API (each deployment gets a 15-minute poll budget; the job's 90-minute limit fits two stages, one recovery and verification), and takes the new deployment's ID from `pending_deployment` (an empty ID means refuse). It polls that deployment's **phase** until ACTIVE, and fails at once on ERROR, CANCELED or SUPERSEDED. A timeout is reported as "outcome unknown, deployment `<id>`". | `doctl --wait` counts progress steps and never checks the phase. The migrate job finds nothing pending, so it needs no lease. If the plan missed a migration, the guard refuses it and App Platform keeps the old deployment. |

### Two stages (migration)

| Step | What it does | Why |
| --- | --- | --- |
| 6A. Stage A: maintenance | Derives the `maintenance` phase (no worker, no jobs) from the live spec. It adds one non-secret marker to Nodestone: `TARUBOT_DEPLOY_RUN=<run id>:<target commit>:<previous deployment id>`. It applies this and polls until ACTIVE. | App Platform stops the old bot, which releases the writer lease within its 27-second shutdown. The marker lets a later run prove the maintenance state came from this workflow. |
| 6B. Stage B: new release | Applies the target full spec and polls its phase. Before the new bot starts, the migrate job: <br>1. takes the writer lease inside the migration transaction, waiting up to 90 seconds for a slow-stopping bot, then refusing; <br>2. logs the database clock at that moment, the **restore point**, since no bot wrote after it; <br>3. applies every pending migration in that one transaction; <br>4. logs the database clock again just before committing. <br>The new bot then starts, checks the schema again after taking the lease, and logs in. | No bot can write during the migration. All pending migrations commit or roll back together. |
| 6C. Record | Reads the migrate job's logs for this deployment, privately. It records the restorable window and an outcome of committed, not committed, or unknown. | Supporting evidence for the summary. The recovery decision rests on something stronger (below). |

### Verify

| Step | What it does | Why |
| --- | --- | --- |
| 7. Ready and holding the lease | Searches the new deployment's worker logs (`run`, plus `run_restarted` for crashed instances) for "Database writer lease acquired" and "TaruBot ready". Each log call is capped by `--tail` and a 60-second timeout. It records three facts: whether the new release ever took the lease, whether it became ready, and whether the evidence is **complete**: at most one restart, and no log call truncated or timed out. Only yes/no answers and timestamps reach the summary. | "Active" only means the liveness probe answered, which it also does while a bot waits for the lease. Whether the new release took the lease decides what recovery is safe. |

A deploy succeeds when the new release is ready, holds the lease, and hasn't restarted.

## Commands job

Runs on a **fresh runner**, with no checkout and no installed dependencies, in `production-commands`. It runs only after the deploy job verified the new release, or after an approved `commands_only` run. The runner doesn't share a filesystem or environment with the deploy job, so the Discord token never meets the deploy job's dependencies.

1. Runs `commands.js check`, a new mode, inside the deployed bot image (`docker run` by digest, `/usr/bin/docker` by absolute path). Like `list`, it reads the global scope and every guild scope, and compares the release's full declared payload with what Discord has registered. It exits: <br>• 0 when they're equal; <br>• 2 when only the global scope differs; <br>• 3 for guild-scope leftovers or an unreadable scope; <br>• 1 on an error.
2. On exit 2 only, runs `register.js --global`, then `commands.js check` again, which must now exit 0. Exit 3 fails the job with "guild leftovers: clear by hand with `commands.js clear-guild`", and exit 1 fails it as an error. Neither triggers a registration.

This covers new releases, rollbacks, and drift after a failed registration. It needs no guess about whether "commands changed". A mismatch window in either direction is harmless, because every release from Release A onwards answers unknown commands, subcommands or options with the stale-command card instead of acting.

To retry after a failed registration, start the workflow by hand with the live `version` and `commands_only: true`. It changes nothing on App Platform, still asks for your approval, and then runs this job.

## Notify job

Runs last whenever the plan job ran (`if: always() && needs.plan.result != 'skipped'`), in `notify`. It sends one Pushover message with the outcome and the run link:
- deployed;
- skipped ("no deploy needed", "already live", "superseded");
- refused, with the reason;
- rejected, or expired after 30 days;
- recovered;
- **needs you**, with the state and the restore window.

GitHub's own failure emails still arrive for failed runs.

## Failure handling and automatic recovery

**The rule:** the workflow puts the previous release back automatically only when the new release provably wrote nothing, or when the old release's own startup check decides it. It never re-applies while any deployment is still in progress.

| When it fails | State | What the workflow does |
| --- | --- | --- |
| Plan or pre-apply checks | Nothing changed | Ends with the reason. |
| One stage: the deployment errors (image pull, health check, the guard refusing an unexpected migration) | App Platform keeps the previous deployment running | Reports it. Nothing to undo. |
| One stage: active, but the new release **never took the lease**, and the evidence is complete | The old bot stopped; the new one hasn't written yet | First applies the maintenance phase with the marker, which stops the new bot, so it can't take the lease later. Once that is ACTIVE, reads the new deployment's logs again. Only if they still show no lease, with complete evidence, does it re-apply the previous full spec, verify the old release, and report "recovered". Otherwise it alerts as in the next row, leaving maintenance for `resume`. |
| One stage: the new release **took the lease** but isn't ready, or restarted, or the evidence is incomplete | The new release may have written, and the old release may fail job kinds it doesn't know | **No automatic rollback.** Alerts you: "The new release may have run with the writer lease. Roll back with `rollback: true`, or ship a fix." |
| Poll timeout, in any stage | Unknown; a deployment may still be running | No recovery. Alerts you with the deployment ID. |
| Stage A fails | The previous deployment still runs | Reports it. Nothing to undo. |
| Stage B fails, and the migrate job didn't commit or the outcome is unknown | The bot is down in maintenance | Once stage B's deployment is terminal, re-applies the previous full spec. The **old release decides**: its pre-deploy job checks the schema. <br>• **Unchanged schema:** the old release comes back, and the workflow verifies it. <br>• **Committed migration:** the old job refuses with "Schema version/checksum mismatch", nothing old runs, and the workflow switches to the next row. |
| Stage B: the migration **committed**, and the new release fails, or the old release refused to start | The schema is new; the old release can't run on it | Alerts you with the restore window and whether the new release took the lease. <br>**New release never took the lease:** restoring to the restore point loses nothing, but it's manual, because it forks the cluster ([APP_PLATFORM.md](../APP_PLATFORM.md)). <br>**New release took the lease:** recovery is forward-only, through a fix release. While the app is still in maintenance, start it by hand with `resume: finish` and the fix's `version`; its migrate job skips the committed files and applies only new ones. If stage B's deployment became active, a normal run deploys the fix. |
| A recovery re-apply fails | The bot may be down | Stops and alerts you. From here on it's manual. |
| The run dies between stage A and stage B (runner lost, job timeout) | The bot is down in maintenance, with the marker | See [Interrupted runs](#interrupted-runs). |
| The run dies after submitting a deployment (any stage, or a recovery re-apply) | Unknown: App Platform may finish it with nobody watching | The next plan reports what's live. If the new release is live and ready, start `commands_only` with its version. If the app is in maintenance, use `resume`; the old release's schema check decides. |
| The commands job fails | The new release runs with Discord's old commands, which it answers with the stale-command card | Alerts you. Retry with `commands_only: true`. |

Every "alerts you" is a failed run with a Pushover message marked **needs you**.

## Interrupted runs

If a two-stage run dies after stage A, the app stays in maintenance: no bot, and the old schema unless stage B had been submitted. Automatic plans refuse while the app is in maintenance.

Start the workflow by hand with one of these:
- **`resume: finish`** and `version` set to the marker's target, or a newer fix release. This skips stage A and applies stage B.
- **`resume: restore`**, with `version` set to the pre-maintenance release. This re-applies the pre-maintenance full spec, found in App Platform's deployment history through the marker's previous deployment ID. As above, the old release's schema check decides whether that is possible.

Either input is accepted only when the active deployment is a maintenance spec that carries this workflow's marker. A maintenance state you applied by hand is refused. For `finish`, the backup gate counts back from when stage A was applied, since no job runs in maintenance and nothing has been written since.

## Rollback

Start the workflow by hand with the older `version` and `rollback: true`.

- **Across a migration:** refused. Schemas only move forward.
- **Below the first release with both Release A and Release C:** refused, because older releases lack the safeguards the workflow relies on, or the backup image the live backup job needs.
- **Command changes:** the commands job re-registers the older release's commands once it runs. In between, both releases answer unknown shapes with the stale-command card.
- **Work only the newer release understands:** the older release fails an unknown job kind or payload version as `invalid_job`, which is terminal. After a rollback, check `/sync status` for failed work, and requeue it with `retry.js` once a fix release is live.
- **App Platform's own rollback:** avoid it. It pins the app, and the workflow refuses until the pin is committed or reverted.
- **Keeping old images:** never delete GHCR image versions that the live or previous deployment uses. Recovery re-applies them by digest.

## Spec changes in a release

Releases that change `.do/app.yaml` (a new environment variable, a health check, a job timeout, an alert) are handled by comparing the target template with the live spec.

**How the comparison works:**
- Components are matched by name, and each component's `envs` list is compared as a whole, by key, so removals show.
- The comparison ignores secret values, `databases[].cluster_name` (which can differ after a recovery), and the image `tag`/`digest`, which the workflow controls. `registry_type`, `registry` and `repository` come from the template and are listed when they change.
- Components and alerts are matched by name. **Added:** in the target's template, not in the live spec. **Removed:** in the live release's own template (`.do/app.yaml` at the live commit) and in the live spec, but not in the target's template. **Live-only:** in neither template, which are ignored and listed. A component added or removed is refused; an alert added or removed is synced.

**Synced automatically, and listed in the plan with the template's values:**
- non-secret environment variables added, changed or removed on existing components;
- `run_command`;
- health checks and termination settings;
- job timeouts and schedules;
- alerts.

**Refused, with the key paths named:**
- a component added or removed;
- any change to the database block;
- a new secret, which needs a value only you have;
- instance sizes, which cost money;
- anything `app-spec.ts full` rejects.

You apply these by hand: export the live spec from the raw API (`GET /v2/apps/{id}`, `.app.active_deployment.spec`) rather than `doctl apps spec get`, which drops fields it doesn't know, then edit it, check it with `app-spec.js full`, then `doctl apps update`. Then commit the same change to `.do/app.yaml` so the template and the live spec agree again. New alerts, such as `DEPLOYMENT_LIVE` and a worker `RESTART_COUNT`, go into `.do/app.yaml` in a release and are then synced.

## Backups

- **Restore point for every migration.** Stage B's migrate job logs the database clock when it took the writer lease, and again before committing. Restoring the managed database to that point gives the exact pre-migration state. DigitalOcean keeps point-in-time recovery for 7 days. Restoring **loses nothing only if the new release never took the lease**, which the summary states.
- **Daily off-site backup.** A scheduled App Platform job, declared in `.do/app.yaml` with `kind: SCHEDULED` and `schedule.cron`, for example 04:30 UTC. It runs the release's pinned backup image and:
  1. dumps the database as a dedicated **read-only** login, in one consistent snapshot;
  2. records per-table row counts and the schema version from the same snapshot;
  3. encrypts both with `age` to a public key whose private half only you hold;
  4. uploads them under unique names to a bucket outside DigitalOcean, which has object lock or versioning with a retention period: under `daily/`, and on the first of each month also under `monthly/`;
  5. logs the object names, sizes and checksums.
- **What protects the backups:**
  - The job's secrets are its read-only database URL (`BACKUP_DATABASE_URL`) and a bucket key that can write but not delete.
  - Nothing in DigitalOcean or GitHub can read a dump back.
  - Old versions survive an overwrite, so a leaked key can't destroy history.
  - The deploy token could still change the job to exfiltrate data before encryption, which is one reason it counts as a production credential.
- **In the template.** `.do/app.yaml` carries the job with `REPLACE_WITH_` placeholders for its two secrets, which the plan ignores as secret values. The live spec holds the encrypted values. The first time the job is added is a manual spec change, because it brings new secrets. After that, its image and settings update with each release, like Nodestone's.
- **Gate on migrations.** A two-stage release is refused unless the backup job succeeded within the last 26 hours and isn't running. The newest dump can still be up to a day old when a migration runs; the restore point covers the time since.
- **Restore test,** quarterly. On your machine:
  1. decrypt the latest dump;
  2. restore it into a **throwaway local PostgreSQL 18 container**, never DevBot's database;
  3. run a new `backup-verify.js`, which checks the schema version and every table's row count against the job's record. Run it from a clean clone of the dump's release, never this checkout (whose `.env` selects DevBot), as `env -i HOME="$HOME" PATH="$PATH" bun --env-file=<restore-test env> dist/scripts/backup-verify.js`. That env file sets only `DATABASE_URL`, pointing at the container on loopback: the tool guard's unmanaged profile, with no application ID or Discord token;
  4. delete the container.
- **Key loss:** losing the private key makes every dump unreadable. Keep an offline copy.

These replace the rule "take an independent dump before every maintenance window". The one-time cutover still takes its manual dump, as MIGRATION.md says.

## Bot and tooling changes

**Release A** ships before the cutover, so production starts with these changes. They're useful with or without the workflow.

1. **Migration guard** (`Database.migrate`). After taking the migration lock, it lists the pending migrations. If any exist, it:
   - takes the writer lease with a transaction-scoped lock (`pg_try_advisory_xact_lock(714882494)`), retrying for up to `MIGRATE_WRITER_WAIT_SECONDS` (90 by default), then refusing and naming the holder's process;
   - logs `clock_timestamp()` after taking the lease and before committing.

   A transaction-scoped lock and the bot's session lock on the same key block each other, and the lock ends at commit or rollback. With nothing pending, it never touches the lease.
2. **Schema re-check after taking the lease** (`ApplicationLifecycle.prepare`). A bot that waited for the lease checks the schema again once it holds it. On a mismatch it releases the lease and exits. Otherwise an old bot that restarted during a migration could take the lease after the commit and write with old code.
3. **Unknown commands.** A command, subcommand or option name or type the running release doesn't declare gets the stale-command card, never a handler's default action. Today, for example, `/officer` treats any subcommand other than `grant` and `reset` as a revoke.
4. **`commands.js declared` and `commands.js check`.** Offline, `declared` hashes the payload the release declares. `check` compares the full declared payload, options included, with what Discord has registered.
5. **`app-spec.ts full` image rules:**
   - worker and migrate images identical;
   - exactly one of tag or digest per image;
   - digest-aware checks.
6. **Compose and DevBot docs.** With the guard, `migrate.js` refuses while the bot container holds the lease. So "stop `tarubot` before migrating", already the DevBot procedure, becomes required on every Compose host.

## Security and hygiene

- **Secrets by environment:**
  - The read token sits in `production-plan`.
  - The deploy token sits in `production`, behind your approval.
  - The Discord token sits in `production-commands`, used only by a job that runs after an approved deploy, on a fresh runner with nothing installed.
  - The Pushover secrets sit in `notify`.
  - All four environments are limited to `main`. The `workflow_run` trigger only follows publish runs of pushes to `main`, and never checks out pull-request code.
- **Public logs:** no shell tracing; command output goes to private files; no artifacts. Spec contents, app JSON and runtime logs are never printed.
- **Pinning:**
  - `actions/checkout` and `oven-sh/setup-bun` are pinned to the same full commit SHAs CI uses, and Bun to the `package.json` version.
  - `doctl` runs from the digest-pinned image CI already uses. It is used for offline validation, phase polling, logs, and job-run listing, with a 60-second timeout on every log call. Spec reads and writes go through the raw API.
  - Not `digitalocean/app_action`: it creates the app from a spec file when none exists, and can hang waiting for a public URL our internal-only Nodestone never gets.
  - Not `digitalocean/action-doctl`: it downloads an unverified binary and silently falls back to another version.
- **Input handling:** inputs reach shell steps only through `env:`. CodeQL already analyzes the workflows.
- **Least privilege:** `contents: read` and `actions: read` only. No job has a database credential, because database work runs inside App Platform.
- **Release tags:** drop `publish.yml`'s `v*` tag trigger. Releases are merges to `main`, the repository has no tags, and a pushed `v*` tag could republish a version from a commit outside `main`.

## Operating it

- **Pause:** clear `DEPLOY_ENABLED`. Publishes then end quietly, loading no secrets, and a run already waiting for approval refuses if approved. Clear it at the start of any manual maintenance window.
- **Resume after a pause:** set it again, then start a run by hand with the newest version.
- **Stop:** Actions → Deploy to App Platform → Disable workflow.
- **Retire:** revoke both DigitalOcean tokens, delete the environments, and remove `DISCORD_TOKEN` from GitHub.
- **Token expiry:**
  - An expired read token fails the plan. An expired deploy token fails the deploy job's first API call, after your approval but before any change. Both are created together, so rotate both: create new ones with the same scopes, replace the secrets, and revoke the old ones. A calendar reminder before the 90 days is worth setting.
  - After a Discord token reset, update `production-commands`, the App Platform worker, and any env file that holds the token.
- **Cost:**
  - GitHub runners are free for public repositories, and image deploys need no App Platform build.
  - Each deploy briefly runs two bot containers.
  - The backup job runs one small container a day, plus bucket storage, which should be cents a month.

## First runs after W16

1. At W13 the live spec uses tags, and releases before the workflow are deployed by hand, with tags. The first release the workflow deploys switches the spec to digests; to do that without a release, run by hand with the live version and `repin: true`.
2. Before setting `DEPLOY_ENABLED`, let the backup job produce one dump, and run the restore test on it.
3. For the first real run, read the plan closely, then check the evidence the run records:
   - the deployment phases;
   - how long the old and new bots overlap, from their lease log lines;
   - for the first two-stage release, how long the bot is actually down.

## To confirm

**On a normal run:**
- the tokens' scopes are enough (with or without `database:update`);
- App Platform accepts an amd64 build digest;
- the ready lines arrive within the wait;
- how long the old and new bots overlap;
- how long a two-stage release is down;
- that the migrate job's logs can be read for a deployment. If job-run listing doesn't include pre-deploy runs, read the `migrate` component's deploy logs for the deployment instead;
- how precise the restore-point timestamp is;
- that `doadmin` can grant `pg_read_all_data` on the managed cluster. If not, grant `SELECT` on all tables, plus default privileges for future ones.

**Only with a deliberate failure.** The automatic recovery depends on these. They could be tested on a throwaway App Platform app before `DEPLOY_ENABLED` (an owner-authorized cost of a few cents), or you can accept that the first real failure is also their first test:
- a failed pre-deploy job leaves the previous deployment running;
- removing the worker in stage A stops the old bot before stage B's migrate job starts;
- a re-applied previous spec whose pre-deploy job hits the schema mismatch fails without starting its worker.

## Repository changes and packaging

- **Release A, before the cutover** (shipped alone as 2.16.0; OPS-10/OPS-11 moved to 2.17.0 so v2 could launch the same day):
  - the migration guard;
  - the schema re-check after the lease;
  - the unknown-command handling;
  - tests;
  - (moved to Release B, which uses them: `commands.js declared` and `check`, and the `app-spec.ts` image rules);
  - docs: OPERATIONS.md (writer lease, guard), README.md (Compose: stop before migrating), APP_PLATFORM.md (digest-aware manual steps: "set `digest`", not "edit the image tags"; export specs from the raw API), MIGRATION.md (W16 stores `DISCORD_TOKEN` in `production-commands`), and CLAUDE.md (project map: `commands` gains `declared` and `check`);
  - the usual CHANGELOG, VERIFICATION, OPEN_ITEMS, DEV_GUILD and version syncs.
- **Release C, backups, before automated migrations:**
  - a `backup` image built by `publish.yml`, with PostgreSQL 18 client tools, `age` and the uploader;
  - the backup and `backup-verify.js` scripts, with tests;
  - the backup job in `.do/app.yaml`, with placeholders;
  - `app-spec.ts` and its tests: jobs found by name (`migrate` pre-deploy, `backup` scheduled); the backup job binds `BACKUP_DATABASE_URL` (secret) with `DATABASE_CA_CERT`, never `DATABASE_URL` or `DISCORD_TOKEN`; the verified-TLS and no-pool rules cover `BACKUP_DATABASE_URL`;
  - the tool guard gains `BACKUP_DATABASE_URL`, whose production rule requires the read-only login (not `tarubot`, not `doadmin`), port 25060 and the CA;
  - docs: OPERATIONS.md (backups, restore test), APP_PLATFORM.md (independent exports), and CLAUDE.md (project map: the backup tool, `backup-verify`, the `backup` image);
  - the usual CHANGELOG, VERIFICATION, OPEN_ITEMS, DEV_GUILD and version syncs.
- **Release B, the workflow:**
  - `.github/workflows/deploy.yml`;
  - `commands.js declared` and `check`, and the `app-spec.ts` image rules (moved from Release A);
  - `scripts/app-deploy.ts`, whose pure, unit-tested subcommands the workflow calls, with fixture specs holding `EV[...]` values;
  - the `publish.yml` name test, and dropping its `v*` trigger;
  - docs:
    - APP_PLATFORM.md: the workflow, environments and tokens; the maintenance sequence for automated migrations;
    - CI_CD.md;
    - MIGRATION.md: a post-cutover step after W16 creates the DigitalOcean tokens and sets `DEPLOY_ENABLED` once B and C are live and one dump has passed the restore test;
    - REQUIREMENTS.md: the approval amendment; MIG-13 and DEPLOY-DO-01, where the guard replaces the operator's lease check for automated migrations; OPS-14, for in-image registration by the workflow; the "Production hosting" paragraph (the approval exception for app updates and command registration) and the "Production tooling" paragraph (in-image runs with the production profile passed as environment variables); the backup rule;
    - CLAUDE.md and AGENTS.md: the project map (`scripts/app-deploy.ts`, `deploy.yml`); the agent rules above; and, in "Production and cutover", the two exceptions: your UI approval authorizes the app updates, recovery re-apply and command registration its plan lists, and the workflow runs `commands.js check` and `register.js --global` inside the deployed image;
  - the usual CHANGELOG, VERIFICATION, OPEN_ITEMS, DEV_GUILD and version syncs.

B and C can ship in either order. The workflow refuses two-stage releases until C's job has run successfully, so C only has to be live before the first migration after cutover.

## Decisions for you

A yes or no per item is enough, unless noted.

1. **Trigger.** Should every successful publish plan automatically, asking you only when something that runs in production changed, with manual runs for rollback, resume and commands? *Recommended: yes.*
2. **Tokens.** Two DigitalOcean tokens (read-only for the plan, deploy behind approval), rather than one? With one, the plan can't read the live app before you approve. *Recommended: two.*
3. **Spec sync.** Should the workflow apply the listed safe spec changes itself, refusing the rest? *Recommended: yes.*
4. **Backup bucket provider:** Backblaze B2, AWS S3, or Cloudflare R2? R2 can't issue a key that writes without also reading. *Recommended: B2, which is cheap for small, rarely read backups and has object lock.*
5. **Backup retention and key.** Lifecycle rules keeping `daily/` for 30 days and `monthly/` for 365 days, with object-lock retention no longer than each, and an `age` key with an offline copy? *Recommended: yes.*
6. **Notifications.** Pushover on every outcome, in addition to GitHub's failure emails? *Recommended: yes.*
7. **Failure test.** Test the recovery paths once on a throwaway app before enabling, or accept learning them in production? *Recommended: the throwaway test.*
8. **Packaging.** Release A in 2.16.0 before the cutover, with B and C after it? *Recommended: yes.*
9. **Agents.** May a Claude session start the workflow when you ask it to? You would still approve every deploy. *Recommended: yes, only when asked in that session.*
10. **Your draft.** Delete `.do/app-main.yaml`? *Recommended: yes.*

## Appendix: workflow skeleton (illustrative)

```yaml
# Plans each published release and, with the owner's approval, deploys it to App Platform.
name: Deploy to App Platform

on:
  workflow_run:
    workflows: ["Publish containers"] # pinned by a unit test against publish.yml's name
    types: [completed]
    branches: [main]
  workflow_dispatch:
    inputs:
      version: { description: "Published SemVer", required: true, type: string }
      rollback: { description: "Allow a non-descendant (older) release", type: boolean, default: false }
      resume: { description: "Interrupted two-stage deploy", type: choice, options: ["", finish, restore], default: "" }
      repin: { description: "Switch the live spec from tags to digests", type: boolean, default: false }
      commands_only: { description: "No app update; bring Discord's commands in line", type: boolean, default: false }

permissions:
  contents: read
  actions: read # check the release's "Publish containers" run

# Only runs that can deploy share the production group; the rest can never displace them.
concurrency:
  group: ${{ (vars.DEPLOY_ENABLED == 'true' && github.ref == 'refs/heads/main' && github.run_attempt == 1 && (github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'))) && 'app-platform-production' || format('app-platform-ignored-{0}', github.run_id) }}
  cancel-in-progress: false # never interrupt a running deploy

jobs:
  plan:
    name: Plan
    if: vars.DEPLOY_ENABLED == 'true' && github.ref == 'refs/heads/main' && github.run_attempt == 1 && (github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'))
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    environment: { name: production-plan, deployment: false } # read-only token
    outputs:
      deploy: ${{ steps.plan.outputs.deploy }}
      stages: ${{ steps.plan.outputs.stages }}
      target_commit: ${{ steps.plan.outputs.target_commit }}
      bot: ${{ steps.plan.outputs.bot }}             # amd64 build digests
      nodestone: ${{ steps.plan.outputs.nodestone }}
      backup: ${{ steps.plan.outputs.backup }}
      image: ${{ steps.plan.outputs.image }}         # ghcr.io/<registry>/<repository> from the template
      active_deployment: ${{ steps.plan.outputs.active_deployment }}
      active_spec_hash: ${{ steps.plan.outputs.active_spec_hash }}
      script_commit: ${{ github.sha }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { ref: "${{ github.sha }}", fetch-depth: 0, submodules: recursive, persist-credentials: false }
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with: { bun-version-file: package.json }
      - run: bun install --frozen-lockfile --ignore-scripts # no secrets in this step; needs vendor/nodestone
      - id: plan
        env:
          DO_APP_ID: ${{ vars.DO_APP_ID }}
          DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
          GH_TOKEN: ${{ github.token }}
          TARGET_SHA: ${{ github.event.workflow_run.head_sha }}
          INPUTS: ${{ toJSON(inputs) }}
        run: bun --no-install scripts/app-deploy.ts plan

  deploy:
    name: Deploy and verify
    needs: plan
    if: needs.plan.outputs.deploy == 'true' && github.run_attempt == 1
    runs-on: ubuntu-24.04
    timeout-minutes: 90 # two stages, one recovery and verification
    environment: production # the owner approves here
    outputs:
      verified: ${{ steps.deploy.outputs.verified }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { ref: "${{ github.sha }}", fetch-depth: 0, submodules: recursive, persist-credentials: false }
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with: { bun-version-file: package.json }
      - run: bun install --frozen-lockfile --ignore-scripts # no secrets in this step; needs vendor/nodestone
      - id: deploy
        env:
          DEPLOY_ENABLED: ${{ vars.DEPLOY_ENABLED }}
          DO_APP_ID: ${{ vars.DO_APP_ID }}
          DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
          GH_TOKEN: ${{ github.token }}
          PLAN: ${{ toJSON(needs.plan.outputs) }}
          INPUTS: ${{ toJSON(inputs) }}
        run: bun --no-install scripts/app-deploy.ts deploy # re-check, build, prove, apply (1 or 2 stages), verify, recover
      - if: always()
        run: rm -rf "$RUNNER_TEMP/app-platform"

  commands:
    name: Commands
    needs: [plan, deploy]
    if: needs.deploy.outputs.verified == 'true' && github.run_attempt == 1
    runs-on: ubuntu-24.04 # fresh runner: no checkout, nothing installed
    timeout-minutes: 10
    environment: production-commands # DISCORD_TOKEN only
    steps:
      - env:
          DISCORD_TOKEN: ${{ secrets.DISCORD_TOKEN }}
          IMAGE: ${{ needs.plan.outputs.image }}@${{ needs.plan.outputs.bot }}
        run: |
          tool() { /usr/bin/docker run --rm -e DISCORD_TOKEN -e DISCORD_APPLICATION_ID=965294750741692416 \
            -e TARUBOT_ENVIRONMENT=production -e TEST_GUILD_ID= "$IMAGE" bun "dist/scripts/$1" "${@:2}" > /dev/null; }
          # check: 0 equal, 2 only the global scope differs, 3 guild leftovers/unreadable, 1 error.
          status=0; tool commands.js check || status=$?
          if [ "$status" -eq 2 ]; then
            tool register.js --global
            tool commands.js check
          elif [ "$status" -ne 0 ]; then
            exit "$status"
          fi

  notify:
    name: Notify
    needs: [plan, deploy, commands]
    if: always() && needs.plan.result != 'skipped'
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    environment: notify # PUSHOVER_USER, PUSHOVER_TOKEN
    steps:
      - env:
          PUSHOVER_USER: ${{ secrets.PUSHOVER_USER }}
          PUSHOVER_TOKEN: ${{ secrets.PUSHOVER_TOKEN }}
          RESULTS: ${{ toJSON(needs) }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: echo "Send one Pushover message summarizing RESULTS with RUN_URL (implemented in the real workflow)."
```
