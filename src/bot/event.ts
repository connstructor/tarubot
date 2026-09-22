/** Typed event definitions preserve Discord.js argument tuples through dynamic loading. */
import type { ClientEvents } from "discord.js";
import type { BotContext } from "./context.js";
import type { ServiceKey } from "./services.js";

/** IDs are unique per handler; multiple handlers may subscribe to the same Discord event. */
export interface EventOptions<E extends keyof ClientEvents> {
  readonly id: string;
  readonly event: E;
  readonly once?: boolean;
  readonly duringShutdown?: boolean;
  readonly requires?: readonly ServiceKey<unknown>[];
  readonly execute: (context: BotContext, ...args: ClientEvents[E]) => void | Promise<void>;
}

/** Discovery checks this common base without erasing handlers into untyped argument arrays. */
export abstract class GatewayEvent {
  constructor(
    readonly id: string,
    readonly requires: readonly ServiceKey<unknown>[],
  ) {}
  abstract bind(context: BotContext): () => void;
}

/** The closure retains E, so listener registration never needs an unsafe type assertion. */
class TypedEvent<E extends keyof ClientEvents> extends GatewayEvent {
  constructor(private readonly options: EventOptions<E>) {
    super(options.id, options.requires ?? []);
    if (!options.id.trim() || !options.event || typeof options.execute !== "function") {
      throw new Error("An event requires an ID, a Discord event name, and an execute handler.");
    }
  }

  /** Contain synchronous/asynchronous failures and return exact listener cleanup. */
  override bind(context: BotContext): () => void {
    const listener = (...args: ClientEvents[E]): void => {
      if (context.isStopping() && !this.options.duringShutdown) return;
      const invoke = async (): Promise<void> => {
        try {
          await this.options.execute(context, ...args);
        } catch (error) {
          context.report(error, `event:${this.id}`);
        }
      };
      void invoke();
    };
    if (this.options.once) context.client.once(this.options.event, listener);
    else context.client.on(this.options.event, listener);
    return () => {
      context.client.off(this.options.event, listener);
    };
  }
}

/** Infer handler arguments directly from the selected Discord event. */
export const defineEvent = <E extends keyof ClientEvents>(options: EventOptions<E>): GatewayEvent =>
  new TypedEvent(options);
