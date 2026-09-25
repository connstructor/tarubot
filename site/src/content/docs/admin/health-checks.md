---
title: Health checks
description: Check the server's setup with /config show and /config validate, follow background work, and fix what they report.
sidebar:
  order: 10
---

## Settings and checks

[`/config show`](/tarubot/reference/commands/#config-show) lists every setting: the linked FC, the four roles, the officer rank, the channels, guest applications, onboarding and the role layout.

[`/config validate`](/tarubot/reference/commands/#config-validate) checks the setup without changing anything, and lists each check with a token:

- `[OK]` passed; `[WARN]` works but needs attention; `[FAIL]` stops a feature; `[OFF]` switched off; `[WAIT]` waiting for something, such as a first roster.
- It covers whether each role and channel exists, TaruBot's permissions and role position, the linked FC and how fresh its roster is, onboarding, changes in Discord, the role layout, and whether Discord changes are paused. With onboarding on, it also warns when members and guests may not be able to read the [changelog channel](/tarubot/admin/notices-and-updates/#visibility-with-lobby-onboarding).
- The title gives the verdict: problems, warnings, or all checks passed.

**Run health check** on `/config show`, and **Re-check** on `/config validate`, run the checks again in place. Fix what a `[FAIL]` line names, then re-check. [Replies and error codes](/tarubot/reference/replies/#health-check-tokens) explains each token.

Run `/config validate` after setting a server up, after changing roles or channels in Discord, and whenever members report missing roles.

## Background work

Officers get the server-wide view of [`/sync status`](/tarubot/reference/commands/#sync-status): recent runs, outstanding work, what runs next, and what needs attention. Each job line shows the raw job kind (such as `reconcile.user`), the first 8 characters of its ID, the attempt, when it runs next, and its stored diagnostic. **Full details (JSON)** attaches the complete view. `/sync status run_id:<id>` shows one run.

A failed job stops being listed once the same work succeeds after it; the job itself is kept as history.

What to do with each [status marker](/tarubot/reference/replies/#status-markers):

- `! BLOCKED`: a permission, the role order, or a deleted role or channel. Fix what the diagnostic names, then run `/config validate`. TaruBot retries blocked work by itself about every 10 minutes, and saving a `/config` role or channel, the FC link or `/config guest_applications` retries it at once.
- `‖ PAUSED`: Discord changes are off for the deployment. Only its operator can turn them back on.
- `✗ FAILED`: the job stopped after repeated errors. Tell the deployment's operator, who can retry it; the error was also reported to them if issue reports are on.
- `↻ WAITING`: it's waiting its turn, a Lodestone rate limit or a retry. Nothing to do.

Members see only their own requests and work, in plain words.

## Repeats and unsetting

A request that matches what's already saved changes nothing and replies with `= NO CHANGE`: naming the saved officer rank, a `/config guest_applications` request that matches the settings, `/main` naming the current main, `/nickname` repeating its setting, and `/officer reset` or `/guest reset` with nothing to remove. Nothing is saved, audited or queued.

Choosing the role or channel that's already saved with `/config roles`, `/config ledger`, `/config officer_notifications` or `/config changelog` is the exception: it's saved and audited again and rechecks the server, which is a handy way to requeue held work.

To stop using a setting, use its unset option: `unset_channel:true` for `ledger`, `officer_notifications`, `changelog` and `guest_applications`, `unset_role:true` for the `roles` commands, and `unset_rank:true` for `officer_rank`. Unsetting never deletes the Discord channel or role.

## Naming members

Every `member` option suggests server members as you type, matching display name, username, global name or nickname. You can also paste a user ID or an @mention, so you can name someone who has left the server. Where a member may name only themselves (`/characters` and `/guest status` for non-officers), they're offered only themselves.

## Members who leave

When a member leaves the Discord server, their links, grants and revocations stay on record and apply again if they return. A waiting guest application is cancelled. Officers can still act on someone who left by pasting their user ID: `/unassign`, `/officer revoke`, `/officer reset`, `/guest revoke` and `/guest status` all work for them.
