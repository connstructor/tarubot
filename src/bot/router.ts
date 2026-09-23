/** Transport-only interaction dispatch: lookup, acknowledgement, actor checks, and replies. */
import { PermissionFlagsBits } from "discord.js";
import type { AutocompleteInteraction, ChatInputCommandInteraction, Interaction } from "discord.js";
import { z } from "zod";
import { classifyFailure } from "../domain/failures.js";
import { authorize, type Actor } from "../domain/policy.js";
import { Failure, message } from "../domain/values.js";
import type { Command } from "./command.js";
import type { Component } from "./component.js";
import type { BotContext } from "./context.js";
import { ServiceKey } from "./services.js";
import { replyAcknowledgement } from "./reply-visibility.js";

/**
 * Time allowed for a modal command's pre-modal check. Discord gives the first acknowledgement three
 * seconds from interaction creation, and gateway delivery plus the response request both use part
 * of that. After this budget the form opens anyway, which is what happened before the check existed.
 */
export const MODAL_GATE_BUDGET_MS = 1500;

/** Feature behavior lives in discovered modules, so new routes never require a switch edit. */
export class InteractionRouter {
  constructor(
    private readonly context: BotContext,
    private readonly commands: ReadonlyMap<string, Command>,
    private readonly components: ReadonlyMap<string, Component>,
    /** Tests shorten this; production uses the default. */
    private readonly modalGateBudgetMs = MODAL_GATE_BUDGET_MS,
  ) {
    for (const module of [...commands.values(), ...components.values()])
      context.services.require(module.requires);
  }

  /** Defer before remote work, or open a synchronous form as the initial acknowledgement. */
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
    const acknowledgement = replyAcknowledgement(
      interaction.guildId,
      ephemeral,
      this.context.publicResponseGuildId,
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
      if (interaction.isChatInputCommand()) {
        const command = this.commands.get(interaction.commandName);
        if (command?.modal) {
          // A pre-modal check can refuse a closed feature before the user writes answers that
          // cannot be submitted. The refusal is the interaction's only acknowledgement, and the
          // default visibility applies (ephemeral unless the observed test guild overrides it).
          const refusal = await this.modalRefusal(command, interaction, interaction.guildId);
          if (refusal !== null) {
            await interaction.reply({
              ...acknowledgement,
              content: refusal.slice(0, 1700),
              allowedMentions: { parse: [] },
            });
            return;
          }
          // No authority or state change is granted by opening a form. Its separate submission
          // follows the normal fresh-actor path below; Discord forbids showing a modal after defer.
          await interaction.showModal(command.modal(interaction));
          return;
        }
      }
      await interaction.deferReply(acknowledgement);
      const actor = await this.context.resolveActor(interaction.guildId, interaction.user.id);
      authorize(actor, interaction.guildId, module.access);
      // Separate lookups retain precise interaction types without casting a handler union.
      if (interaction.isChatInputCommand()) {
        const command = this.commands.get(interaction.commandName);
        if (!command?.execute) throw new Error("Command disappeared from immutable registry");
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
      // Routine refusals log at info, dependency and settings trouble at warn, and only failures
      // without an approved explanation at error, so the interaction ID stays findable.
      this.context.report(error, interaction.id, { level: classifyFailure(error).level });
      const explanation =
        error instanceof z.ZodError
          ? "Invalid input or unexpected external data. Check the selected values and try again."
          : message(error);
      const response = {
        content: `${explanation.slice(0, 1700)}\nOperation: ${interaction.id}`,
        allowedMentions: { parse: [] as const },
      };
      if (interaction.deferred || interaction.replied) await interaction.editReply(response);
      else await interaction.reply({ ...acknowledgement, ...response });
    }
  }

  /**
   * Run a modal command's optional pre-modal check within the acknowledgement budget. It returns
   * refusal text, or null to open the form. It fails open: an error or a slow read is reported
   * and the form opens as before, because opening a form grants nothing and the submission path
   * repeats the check authoritatively.
   */
  private async modalRefusal(
    command: Command,
    interaction: ChatInputCommandInteraction,
    guildId: string,
  ): Promise<string | null> {
    if (!command.beforeModal) return null;
    // A private sentinel cannot collide with any refusal text the check might return.
    const overrun = Symbol("pre-modal budget overrun");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const budget = new Promise<typeof overrun>((resolve) => {
        timer = setTimeout(() => resolve(overrun), this.modalGateBudgetMs);
      });
      // Promise.race also subscribes to the check, so a late rejection is never unhandled.
      const outcome = await Promise.race([
        Promise.resolve(command.beforeModal({ ...this.context, guildId, interaction })),
        budget,
      ]);
      if (outcome !== overrun) return outcome;
      const overran = new Failure(
        "unavailable",
        "The pre-form check overran its budget; the form opened.",
      );
      this.context.report(overran, interaction.id, { level: classifyFailure(overran).level });
      return null;
    } catch (error) {
      this.context.report(error, interaction.id, { level: classifyFailure(error).level });
      return null;
    } finally {
      clearTimeout(timer);
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
      this.context.report(error, interaction.id, { level: classifyFailure(error).level });
      await interaction.respond([]).catch(() => {});
    }
  }
}

/** The gateway event module depends on a router capability, not a concrete main module. */
export const interactionRouterKey = new ServiceKey(
  "interaction router",
  (value): value is InteractionRouter => value instanceof InteractionRouter,
);
