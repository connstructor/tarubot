/** Custom-ID namespaces let buttons, menus, and modals be extended without router edits. */
import type {
  InteractionEditReplyOptions,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import type { Actor } from "../domain/policy.js";
import type { BotContext } from "./context.js";
import type { ServiceKey } from "./services.js";

/** Modules narrow the specific component type they support before reading its fields. */
export interface ComponentContext extends BotContext {
  readonly actor: Actor;
  readonly interaction: MessageComponentInteraction | ModalSubmitInteraction;
}

/** A namespace owns all custom IDs beginning with prefix followed by a colon. */
export interface ComponentOptions {
  readonly prefix: string;
  readonly access?: "user" | "officer";
  readonly requires?: readonly ServiceKey<unknown>[];
  readonly execute: (
    context: ComponentContext,
  ) => Promise<InteractionEditReplyOptions> | InteractionEditReplyOptions;
}

/** Validated component definition; payload-specific authorization stays in its handler. */
export class Component {
  readonly prefix: string;
  readonly access: "user" | "officer";
  readonly requires: readonly ServiceKey<unknown>[];
  readonly execute: ComponentOptions["execute"];

  constructor(options: ComponentOptions) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(options.prefix) || typeof options.execute !== "function") {
      throw new Error("A component requires a valid custom-ID prefix and an execute handler.");
    }
    this.prefix = options.prefix;
    this.access = options.access ?? "user";
    this.requires = options.requires ?? [];
    this.execute = options.execute;
  }
}

/** Construct the default export consumed by component discovery. */
export const defineComponent = (options: ComponentOptions): Component => new Component(options);
