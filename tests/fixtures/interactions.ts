/** Exercise real Discord.js acknowledgements and modal parsing with a local REST recorder. */
import { spyOn } from "bun:test";
import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  InteractionType,
  ModalSubmitInteraction,
} from "discord.js";

export function interactionFixture() {
  const client = new Client<true>({ intents: [] });
  const requests: { method: string; route: string; body: unknown }[] = [];
  const member = {
    guildId: "100",
    userId: "400",
    joinedAt: "2026-01-01T00:00:00.000Z",
    bot: false,
  };
  let serial = 10000;
  const user = () => ({
    id: member.userId,
    username: "visitor",
    discriminator: "0",
    avatar: null,
    bot: member.bot,
  });
  const message = (id = "123456789") => ({
    id,
    channel_id: "200",
    author: { id: "900", username: "bot", discriminator: "0", avatar: null, bot: true },
    content: "Review",
    timestamp: "2026-01-01T00:00:00.000Z",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    components: [],
    pinned: false,
    type: 0,
  });
  const payload = () => ({
    id: String(++serial),
    application_id: "900",
    token: "fixture-interaction-token",
    version: 1,
    guild_id: member.guildId || undefined,
    channel: { id: "200", type: 0 },
    user: user(),
    member: member.guildId
      ? { user: user(), roles: [], joined_at: member.joinedAt, permissions: "0", flags: 0 }
      : undefined,
    app_permissions: "0",
    locale: "en-US",
    guild_locale: "en-US",
    entitlements: [],
    authorizing_integration_owners: {},
    attachment_size_limit: 10000000,
  });
  const post = spyOn(client.rest, "post").mockImplementation(async (route, options) => {
    requests.push({ method: "post", route, body: structuredClone(options?.body) });
    return {};
  });
  const patch = spyOn(client.rest, "patch").mockImplementation(async (route, options) => {
    requests.push({ method: "patch", route, body: structuredClone(options?.body) });
    return message();
  });
  const get = spyOn(client.rest, "get").mockImplementation(async (route) => {
    if (route === `/guilds/${member.guildId}`)
      return {
        id: member.guildId,
        name: "Fixture",
        owner_id: "300",
        roles: [],
        unavailable: false,
      };
    throw new Error(`Unexpected interaction fixture read ${route}`);
  });
  return {
    client,
    requests,
    member,
    slash(name = "apply") {
      // SDK constructors are internal in the typings; runtime construction plus instanceof
      // keeps the fixture typed without substituting a hand-written interaction implementation.
      const value: unknown = Reflect.construct(ChatInputCommandInteraction, [
        client,
        {
          ...payload(),
          type: InteractionType.ApplicationCommand,
          data: { id: "700", name, type: 1, options: [] },
        },
      ]);
      if (!(value instanceof ChatInputCommandInteraction)) throw new Error("Invalid slash fixture");
      return value;
    },
    submit(
      customId: string,
      answers = {
        introduction: "I enjoy playing games with friends.",
        interest: "A friend invited me to meet your community.",
      },
    ) {
      const value: unknown = Reflect.construct(ModalSubmitInteraction, [
        client,
        {
          ...payload(),
          type: InteractionType.ModalSubmit,
          data: {
            custom_id: customId,
            components: Object.entries({
              introduction: answers.introduction,
              interest: answers.interest,
            }).map(([custom_id, value], index) => ({
              type: ComponentType.Label,
              id: index * 2 + 1,
              component: { type: ComponentType.TextInput, id: index * 2 + 2, custom_id, value },
            })),
          },
        },
      ]);
      if (!(value instanceof ModalSubmitInteraction)) throw new Error("Invalid modal fixture");
      return value;
    },
    button(customId: string, messageId = "123456789") {
      const value: unknown = Reflect.construct(ButtonInteraction, [
        client,
        {
          ...payload(),
          type: InteractionType.MessageComponent,
          data: { custom_id: customId, component_type: ComponentType.Button },
          message: message(messageId),
        },
      ]);
      if (!(value instanceof ButtonInteraction)) throw new Error("Invalid button fixture");
      return value;
    },
    async close() {
      post.mockRestore();
      patch.mockRestore();
      get.mockRestore();
      await client.destroy();
    },
  };
}
