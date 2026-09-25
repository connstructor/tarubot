---
title: Characters and nicknames
description: See your links, choose your main character, manage your nickname, and what happens when you leave the FC.
sidebar:
  order: 3
---

## See your characters

[`/characters`](/tarubot/reference/commands/#characters) lists your linked characters in this server: each one's name and world, how it was linked (verified with a Lodestone token, assigned by an officer, or imported from the previous bot), when, and which one is your main. It also shows your nickname setting, and your most recently ended links under **Previously linked**.

## Choose your main character

Your main character is the one TaruBot uses for your nickname. Your first linked character becomes your main automatically. To change it, run [`/main`](/tarubot/reference/commands/#main) and pick one of your linked characters:

```text
/main character:99000001
```

`/main` uses what TaruBot has stored, so it works while the Lodestone is down. Naming your current main again changes nothing and says so.

## Nickname sync

With nickname sync on, TaruBot sets your server nickname to your main character's name, cut to Discord's 32-character limit, and keeps it in step when the character is renamed. It turns on automatically with your first linked character.

- **Turn it off** with [`/nickname`](/tarubot/reference/commands/#nickname) `enabled:false`. TaruBot then puts back the nickname you had before it changed yours, unless you have changed your nickname yourself since.
- **Turn it on** with `/nickname enabled:true`. You need a main character first.
- **A manual change pauses it.** If you or a moderator change your nickname by hand, TaruBot takes that as your choice: it stops managing your nickname instead of overwriting it. Run `/nickname enabled:true` to hand it back to TaruBot.

Repeating the current setting changes nothing and says so.

:::note
Discord doesn't let any bot change the server owner's nickname. If you own the server, TaruBot leaves your nickname alone and its replies say so.
:::

## Coming from the previous bot

If your links were imported from the server's previous bot, TaruBot kept your old settings and didn't choose a main character for you or turn on nickname sync. To opt in, choose a main and turn sync on:

```text
/main character:99000001
/nickname enabled:true
```

## When you leave the FC

TaruBot reads the FC's roster from the Lodestone regularly, every six hours unless the operator changed it. A character missing from one roster isn't treated as gone yet: TaruBot confirms a departure only when two complete rosters, read at least a minute apart, both leave the character out; it reads the second one about a minute after the first. If the character reappears in between, nothing changes.

Once your departure is confirmed and none of your other linked characters is in the FC:

- your Member role is removed;
- you get the Guest role as a former member, unless an officer has revoked your Guest access;
- your links, main character and nickname stay as they are.

If you rejoin the FC, the next roster that lists you gives you the Member role again.

If you leave the Discord server, your links and any Guest grant stay on record and apply again if you come back, unless an officer changes them.
