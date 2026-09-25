/**
 * Utility presenters: /ping and /channel (guests-sync-utility#50–#53), neutral reference replies
 * with no service behind them, and /issue's confirmation (2.18.0). Pure.
 */
import { ChannelType } from "discord.js";
import { code, mentionChannel, plain } from "./format.js";
import type { IssueSubmitted } from "../../application/issue-reports.js";
import { reply, type Presented, type ReplySpec } from "./reply.js";

/**
 * Every utility reply kind, with whether its embed carries a timestamp (none do, per the reply
 * specs; C11). The reply catalog must cover every kind.
 */
const TIMESTAMP = {
  "ping.measured": false,
  "ping.unmeasured": false,
  "channel.details": false,
  "channel.unavailable": false,
  "issue.received": false,
  "issue.saved": false,
} as const satisfies Record<string, boolean>;

/** A utility reply state; tests catalogue one case per kind. */
export type UtilityReplyKind = keyof typeof TIMESTAMP;

/** Every utility reply kind, for catalog completeness checks. */
export const UTILITY_REPLY_KINDS = Object.keys(TIMESTAMP) as readonly UtilityReplyKind[];

/** Build a utility reply of `kind`; none carries a timestamp. */
function card(kind: UtilityReplyKind, spec: Omit<ReplySpec, "timestamp">): Presented {
  return reply({ ...spec, timestamp: TIMESTAMP[kind] ? new Date() : null });
}

/** en-US digit grouping for the latency ('1,204 ms'). */
const grouping = new Intl.NumberFormat("en-US");

/**
 * /ping: the gateway's last heartbeat round trip, or a note that it isn't measured yet (Discord
 * reports -1 until the first heartbeat, which the command passes as null). Neutral either way.
 */
export function pingReply(latencyMs: number | null): Presented {
  if (latencyMs === null)
    return card("ping.unmeasured", {
      tone: "neutral",
      title: "Pong",
      description:
        "Gateway latency isn't measured yet. TaruBot connected moments ago. Try again in a minute.",
    });
  return card("ping.measured", {
    tone: "neutral",
    title: "Pong",
    description: `Discord gateway latency: **${grouping.format(Math.round(latencyMs))} ms**`,
    footer: "Measured from the last gateway heartbeat",
  });
}

/** Channel types in plain words; anything newer shows Discord's own name for it. */
const CHANNEL_TYPE: Readonly<Partial<Record<ChannelType, string>>> = {
  [ChannelType.GuildText]: "Text channel",
  [ChannelType.GuildAnnouncement]: "Announcement channel",
  [ChannelType.GuildVoice]: "Voice channel (text chat)",
  [ChannelType.GuildStageVoice]: "Stage channel",
  [ChannelType.PublicThread]: "Public thread",
  [ChannelType.PrivateThread]: "Private thread",
  [ChannelType.AnnouncementThread]: "Announcement thread",
  [ChannelType.GuildForum]: "Forum",
  [ChannelType.GuildMedia]: "Media channel",
};

/** What /channel knows about the channel it ran in; name and type need it to be cached. */
export interface ChannelFacts {
  readonly id: string;
  readonly name: string | null;
  readonly type: ChannelType | null;
}

/**
 * /channel: the channel as a mention (which shows its name to the viewer without pinging), its
 * name escaped and capped at 100 characters, its type in plain words, and its ID in code. When
 * TaruBot can't see the channel's details, only the ID is shown, with a note saying why.
 */
export function channelReply(channel: ChannelFacts): Presented {
  const id = { name: "ID", value: code(channel.id) };
  if (channel.name === null || channel.type === null)
    return card("channel.unavailable", {
      tone: "neutral",
      title: "Channel details",
      description: mentionChannel(channel.id),
      fields: [
        id,
        {
          name: "Details",
          value: "Name and type aren't available here. TaruBot can't see this channel's details.",
        },
      ],
    });
  return card("channel.details", {
    tone: "neutral",
    title: "Channel details",
    description: mentionChannel(channel.id),
    fields: [
      { name: "Name", value: plain(channel.name, 100), inline: true },
      {
        name: "Type",
        value: CHANNEL_TYPE[channel.type] ?? ChannelType[channel.type] ?? "Other channel",
        inline: true,
      },
      id,
    ],
  });
}

/** What a report carries, said plainly, because it leaves Discord for the maintainers. */
const REPORT_CONTENTS =
  "Your description, your linked characters and settings in this server, your recent TaruBot activity, and TaruBot's health and recent logs.";

/**
 * /issue (2.18.0): the report was saved and is on its way to TaruBot's maintainers (success), or
 * saved until issue reporting is connected on this deployment (pending). Either way it says what
 * the report carries, and the Ref ties the reply to the report.
 */
export function issueReply(submitted: IssueSubmitted): Presented {
  const included = { name: "Sent with it", value: REPORT_CONTENTS };
  if (submitted.delivery === "saved")
    return card("issue.saved", {
      tone: "pending",
      title: "Report saved",
      description:
        "Thanks. Issue reporting isn't connected on this TaruBot yet, so your report is saved and goes to the maintainers once it is.",
      fields: [included],
      footer: `Ref ${submitted.ref}`,
    });
  return card("issue.received", {
    tone: "success",
    title: "Report received",
    description:
      "Thanks. Your report is on its way to TaruBot's maintainers, with a snapshot of TaruBot's state right now.",
    fields: [included],
    footer: `Ref ${submitted.ref}`,
  });
}
