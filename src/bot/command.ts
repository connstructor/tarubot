/** A slash command owns its registration schema, execution, and private autocomplete. */
import type {
  ApplicationCommandOptionChoiceData,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
  SlashCommandBuilder,
} from "discord.js";
import type { Actor } from "../domain/policy.js";
import type { BotContext } from "./context.js";
import type { ServiceKey } from "./services.js";

/** Both command and autocomplete handlers receive an already authenticated guild actor. */
export interface CommandContext extends BotContext {
  readonly actor: Actor;
  readonly interaction: ChatInputCommandInteraction;
}

/** Autocomplete cannot defer, so its actor comes from Discord's permission-bearing payload. */
export interface AutocompleteContext extends BotContext {
  readonly actor: Actor;
  readonly interaction: AutocompleteInteraction;
}

/** Metadata and handlers exported together prevent registration/runtime inventories drifting. */
export interface CommandOptions {
  readonly data: Pick<SlashCommandBuilder, "toJSON">;
  readonly access?: "user" | "officer";
  readonly ephemeral?: boolean;
  readonly requires?: readonly ServiceKey<unknown>[];
  readonly execute: (
    context: CommandContext,
  ) => Promise<InteractionEditReplyOptions> | InteractionEditReplyOptions;
  readonly autocomplete?: (
    context: AutocompleteContext,
  ) =>
    | Promise<ApplicationCommandOptionChoiceData<string>[]>
    | ApplicationCommandOptionChoiceData<string>[];
}

/** Nominal module type lets discovery validate unknown imports using instanceof. */
export class Command {
  private readonly definition: ReturnType<SlashCommandBuilder["toJSON"]>;
  readonly name: string;
  readonly access: "user" | "officer";
  readonly ephemeral: boolean;
  readonly requires: readonly ServiceKey<unknown>[];
  readonly execute: CommandOptions["execute"];
  readonly autocomplete: CommandOptions["autocomplete"];

  constructor(options: CommandOptions) {
    if (typeof options.data?.toJSON !== "function" || typeof options.execute !== "function") {
      throw new Error("A command requires a Discord builder and an execute handler.");
    }
    if (options.autocomplete !== undefined && typeof options.autocomplete !== "function") {
      throw new Error("Command autocomplete must be a function.");
    }
    // Discord.js validates names, option structure, and limits while serializing the builder.
    this.definition = options.data.toJSON();
    this.name = this.definition.name;
    this.access = options.access ?? "user";
    this.ephemeral = options.ephemeral ?? true;
    this.requires = options.requires ?? [];
    this.execute = options.execute;
    this.autocomplete = options.autocomplete;
  }

  /** Return a copy so deployment code cannot mutate the running command definition. */
  toJSON(): ReturnType<SlashCommandBuilder["toJSON"]> {
    return structuredClone(this.definition);
  }
}

/** Define a discoverable default export with handler parameters inferred from the contract. */
export const defineCommand = (options: CommandOptions): Command => new Command(options);
