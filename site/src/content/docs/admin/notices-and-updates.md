---
title: Officer notices and update posts
description: What TaruBot tells officers about Lodestone trouble and unlinked characters, and the update posts it shares with members.
sidebar:
  order: 9
---

TaruBot posts in two channels besides the ledger: officer notices in a staff channel, and, if you choose one, short update posts for members. Both are sent with mentions turned off, so they never ping anyone.

## Officer notices

Choose a staff-only text channel with [`/config officer_notifications`](/tarubot/reference/commands/#config-officer_notifications). Without one, notices are skipped. TaruBot posts plain text there:

- **Lodestone trouble.** "Lodestone synchronization is degraded. Existing accepted membership evidence is retained; inspect /sync status." TaruBot keeps using the last roster it accepted, so nobody loses a role over an outage.
- **Recovery.** "Lodestone synchronization recovered: the FC roster was accepted again." It follows only an outage that officers were told about.
- **Characters unlinked automatically.** One notice per link TaruBot ended because the character's Lodestone page was gone on two checks at least an hour apart. See [Links TaruBot ends by itself](/tarubot/admin/member-links/#links-tarubot-ends-by-itself).

Routine roster reads post nothing.

### How often Lodestone notices post

The trouble notice waits before it posts, and repeats slowly, so a short blip doesn't reach officers at all:

- **Five minutes' grace.** The first failed roster read since the last good one starts the notice, and it posts only if the roster still hasn't been read five minutes later. A roster read in that time cancels it, and no recovery line follows.
- **At most once a day.** While the FC's roster keeps failing, the notice repeats at most once every 24 hours.
- **One at a time.** While a notice is still waiting to post, including one held by a permission problem or paused Discord changes, no new one is started.
- **Throttling isn't trouble.** When the Lodestone asks TaruBot to slow down, or work waits its turn, no notice is posted.
- **One recovery line per outage.** It posts once the roster is read again, only if a trouble notice was posted during that outage. Each outage longer than the grace period gets its own pair.
- **Unlinking the FC** with `/config fc unlink` cancels a trouble notice that hasn't posted yet, so nothing posts later about an FC the server no longer uses.

While a notice waits to post, the officer view of [`/sync status`](/tarubot/reference/commands/#sync-status) lists it as an `officer.notify` job. A notice cancelled before it posted simply leaves the list; that's expected.

## Update posts

When TaruBot starts on a newer version, it can post what's new for members in a channel you choose: one short message, "TaruBot updated to vX.Y.Z", with a one-sentence note for each release since the last post, newest first. The title links the full changelog, and [`/version`](/tarubot/reference/commands/#version) lists the recent commits.

- **Only what members notice.** A release that changes nothing for members has no note and isn't listed, and an update with nothing for members posts nothing.
- **No repeats.** A restart, a rollback or another update doesn't repeat releases the channel was already told about. Only a crash in the middle of a post or an operator's restore of an older backup can repeat one; see [Monitoring](/tarubot/deploy/monitoring/#update-posts).
- **Nothing piles up.** Updates released while no channel is set are never posted later.

### Choosing the channel

Officers choose it with [`/config changelog`](/tarubot/reference/commands/#config-changelog):

```text
/config changelog channel:#tarubot-updates
```

Pick a normal text channel that members and guests can read, and where TaruBot can post. Announcement channels are refused, like every channel setting.

Setting the channel posts nothing at once: the first post comes with the next update that has something for members. Moving it to another channel keeps its place in the release history, so nothing is posted again. To stop the posts, run `/config changelog unset_channel:true`; the channel and its old posts stay.

### Visibility with lobby onboarding

Where [lobby onboarding](/tarubot/admin/setup/#channel-visibility) manages who sees each channel, TaruBot checks who can read the channel you chose, and warns without changing anything:

- **The lobby, the officer room or a staff-only channel** gives a warning receipt: members and guests can't read it, so they won't see the posts. Choose another channel.
- **A channel onboarding has no record of** gets a **Visibility** note on the receipt: a channel created since TaruBot's last repair pass, or Discord's community-updates channel, which onboarding never manages. Make sure members and guests can read it.

Choosing the same channel again replies `= NO CHANGE` and keeps the note. [`/config validate`](/tarubot/admin/health-checks/) shows either case as a `[WARN] Changelog` line for as long as it applies. TaruBot never changes the channel's permissions for update posts; pick a channel members can already read.

Without onboarding, server admins own every channel's permissions, and TaruBot doesn't check who can read it.

### When a post doesn't arrive

- **`! BLOCKED`** on a `changelog.post` job in `/sync status`: TaruBot can't post in the channel. Fix its permissions there, or choose another channel. Saving a `/config` role or channel, the FC link or `/config guest_applications` retries it at once; otherwise it retries by itself about every 10 minutes.
- **`‖ PAUSED`**: Discord changes are paused for the server or the deployment. The post goes out once they're back on, as one post covering every release since the last.
- **Nothing in `/sync status`**: there was nothing to post. The update had nothing for members, the channel was unset before the post went out, or the channel had already been told about this version.
