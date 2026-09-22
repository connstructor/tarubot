/** Transport-only interaction dispatch: lookup, acknowledgement, actor checks, and replies. */
import { PermissionFlagsBits } from "discord.js";
import type { AutocompleteInteraction, Interaction } from "discord.js";
import { z } from "zod";
import { authorize, type Actor } from "../domain/policy.js";
import { Failure, message } from "../domain/values.js";
import type { Command } from "./command.js";
import type { Component } from "./component.js";
import type { BotContext } from "./context.js";
import { ServiceKey } from "./services.js";
import { replyAcknowledgement } from "./reply-visibility.js";

/** Feature behavior lives in discovered modules, so new routes never require a switch edit. */
export class InteractionRouter {
  constructor(
    private readonly context: BotContext,
    private readonly commands: ReadonlyMap<string, Command>,
    private readonly components: ReadonlyMap<string, Component>,
  ) {
    for (const module of [...commands.values(), ...components.values()])
      context.services.require(module.requires);
  }

  /** Defer before network/database work and consistently distinguish failures from success. */
  async handle(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      await this.autocomplete(interaction);
      return;
    }
    if (
      !interaction.isChatInputCommand() &&
      !interaction.isMessageComponent() &&
      !interaction.isModalSubmit()
    )
      return;
    const module = interaction.isChatInputCommand()
      ? this.commands.get(interaction.commandName)
      : this.components.get(interaction.customId.split(":")[0] ?? "");
    const ephemeral =
      !interaction.isChatInputCommand() ||
      this.commands.get(interaction.commandName)?.ephemeral !== false;
    await interaction.deferReply(
      replyAcknowledgement(interaction.guildId, ephemeral, this.context.publicResponseGuildId),
    );
    try {
      if (!interaction.guildId || interaction.user.bot)
        throw new Failure("forbidden", "Commands are available to human guild members only.");
      if (!this.context.allowsGuild(interaction.guildId))
        throw new Failure("forbidden", "This instance is restricted to its configured test guild.");
      if (!module)
        throw new Failure(
          "input",
          "Unknown or obsolete interaction. Ask an officer to redeploy commands.",
        );
      const actor = await this.context.resolveActor(interaction.guildId, interaction.user.id);
      authorize(actor, interaction.guildId, module.access);
      // Separate lookups retain precise interaction types without casting a handler union.
      if (interaction.isChatInputCommand()) {
        const command = this.commands.get(interaction.commandName);
        if (!command) throw new Error("Command disappeared from immutable registry");
        await interaction.editReply({
          allowedMentions: { parse: [] },
          ...(await command.execute({ ...this.context, actor, interaction })),
        });
      } else {
        const component = this.components.get(interaction.customId.split(":")[0] ?? "");
        if (!component) throw new Error("Component disappeared from immutable registry");
        await interaction.editReply({
          allowedMentions: { parse: [] },
          ...(await component.execute({ ...this.context, actor, interaction })),
        });
      }
    } catch (error) {
      this.context.report(error, interaction.id);
      const explanation =
        error instanceof z.ZodError
          ? "Invalid input or unexpected external data. Check the selected values and try again."
          : message(error);
      await interaction.editReply({
        content: `${explanation.slice(0, 1700)}\nOperation: ${interaction.id}`,
        allowedMentions: { parse: [] },
      });
    }
  }

  /** Use permission-bearing interaction data because Discord autocomplete cannot be deferred. */
  private async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
      if (
        !interaction.guildId ||
        interaction.user.bot ||
        !this.context.allowsGuild(interaction.guildId)
      ) {
        await interaction.respond([]);
        return;
      }
      const module = this.commands.get(interaction.commandName);
      if (!module?.autocomplete) {
        await interaction.respond([]);
        return;
      }
      const base: Actor = {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        officer: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
        manageRoles: interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) ?? false,
        serverManager: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
        roleIds: interaction.inCachedGuild()
          ? [...interaction.member.roles.cache.keys()]
          : interaction.inRawGuild()
            ? interaction.member.roles
            : [],
      };
      const actor = this.context.enrichActor ? await this.context.enrichActor(base) : base;
      authorize(actor, actor.guildId, module.access);
      await interaction.respond(
        (await module.autocomplete({ ...this.context, actor, interaction })).slice(0, 25),
      );
    } catch (error) {
      this.context.report(error, interaction.id);
      await interaction.respond([]).catch(() => {});
    }
  }
}

/** The gateway event module depends on a router capability, not a concrete main module. */
export const interactionRouterKey = new ServiceKey(
  "interaction router",
  (value): value is InteractionRouter => value instanceof InteractionRouter,
);
