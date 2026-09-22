/** Announce the current editable test plan once per successfully initialized development startup. */
import { randomBytes } from "node:crypto";
import { ChannelType, Events } from "discord.js";
import { applicationKey, gatewayKey, lifecycleKey } from "../application/keys.js";
import {
  testSessionMessage,
  testSessionSchema,
  type TestSessionPlan,
} from "../application/test-session.js";
import { defineEvent } from "../bot/event.js";
import { Failure, id } from "../domain/values.js";

export default defineEvent({
  id: "test-session-announcement",
  event: Events.ClientReady,
  once: true,
  requires: [applicationKey, gatewayKey, lifecycleKey],
  async execute(context) {
    const app = context.services.get(applicationKey);
    const guildId = app.config.TEST_GUILD_ID;
    if (!guildId) return;
    // All ready listeners run concurrently; announce only after application initialization succeeds.
    await context.services.get(lifecycleKey).whenReady();
    if (context.isStopping()) return;
    const path = process.env.TEST_PLAN_FILE || "test-plans/current.json";
    let plan: TestSessionPlan;
    try {
      plan = testSessionSchema.parse(await Bun.file(path).json());
    } catch {
      throw new Failure(
        "test_plan",
        `Cannot load a valid session plan from ${path}. Check the plan file and section lengths.`,
      );
    }
    const guild = await context.client.guilds.fetch(guildId);
    let channelId = process.env.TEST_PLAN_CHANNEL_ID;
    if (channelId) channelId = id(channelId);
    else {
      const matches = (await guild.channels.fetch()).filter(
        (channel) => channel?.type === ChannelType.GuildText && channel.name === "chat",
      );
      if (matches.size !== 1)
        throw new Failure(
          "test_plan",
          "Set TEST_PLAN_CHANNEL_ID to identify the test guild's #chat channel unambiguously.",
        );
      channelId = matches.first()?.id;
    }
    if (!channelId) throw new Failure("test_plan", "The test-plan channel is unavailable.");
    await context.services.get(gatewayKey).validateChannel(guildId, channelId);
    const channel = await context.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guildId)
      throw new Failure(
        "test_plan",
        "The announcement channel must belong to the configured test guild.",
      );
    // A nonce identifies retries within this startup; a new process creates a new session message.
    await channel.send({
      ...testSessionMessage(
        plan,
        context.client.user?.username ?? "DevBot",
        new Date(),
        app.config.ENABLE_EFFECTS,
      ),
      nonce: randomBytes(8).readBigUInt64BE().toString(),
      enforceNonce: true,
    });
  },
});
