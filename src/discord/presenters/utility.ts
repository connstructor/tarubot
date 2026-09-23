/**
 * Utility presenters: /ping and /channel (guests-sync-utility#50–#53). Both are neutral reference
 * replies with no service behind them, so they have no failure states of their own. Pure.
 */
import { ChannelType } from "discord.js";
import { code, mentionChannel, plain } from "./format.js";
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
