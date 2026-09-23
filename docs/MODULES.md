# Extending the bot

Commands, Discord gateway events, and interaction components are independently discovered modules. `src/main.ts` wires capabilities and starts the application. Feature handlers live in their own files.

```text
src/
  bot/                         # Generic contracts, service registry, discovery, and routing
  commands/
    characters/*.command.ts    # One file per root slash command
    configuration/*.command.ts
    guests/*.command.ts
    ledger/*.command.ts
    synchronization/*.command.ts
    utility/*.command.ts
  events/*.event.ts            # One file per independently identifiable listener
  components/*.component.ts   # One file per custom-ID namespace
  discord/                    # SDK port, option builders, selectors, and reply helpers
  application/                # Injectable feature services and durable business operations
```

## Discovery and deployment

- Discovery is recursive, deterministic, and relative to the loader's `import.meta.url`.
- Source execution discovers `*.command.ts`, `*.event.ts`, and `*.component.ts`. Production discovers their compiled `.js` equivalents under `dist/src/`.
- Helpers and declaration files are ignored. Each executable module default-exports the appropriate `defineCommand`, `defineEvent`, or `defineComponent` result.
- Empty feature groups are supported, including a directory absent after its final module was removed and output rebuilt. Other filesystem failures remain errors.
- Invalid exports, duplicate command names, duplicate component prefixes, duplicate event-handler IDs, and missing declared services fail startup with diagnostics.
- Runtime dispatch and `commands:register` use the same `loadCommands()` function. Registration loads definitions without connecting application services to PostgreSQL or logging a gateway client into Discord.
- `bun run build` cleans generated `dist/` first. Removing or renaming a source module therefore removes its stale compiled route as well.
- Deploy definition changes with `bun run commands:register --guild ID` for development or `--global` at production cutover. Rebuild/restart to load changed execution code. Event/component additions are loaded on restart.

## Add a command

Create `src/commands/utility/hello.command.ts`:

```ts
/** A generic Discord utility; it needs no game-specific service. */
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";

export default defineCommand({
  data: command("hello", "Say hello"),
  execute({ actor }) {
    // Return ordinary Discord edit-reply options; the router has already deferred.
    return { content: `Hello, ${actor.userId}!` };
  },
});
```

The module owns its builder, `execute`, optional `autocomplete`, and optional required services. Root commands such as `/config` keep their related subcommands together in that feature's module.

The router provides guild/human checks, test-guild scoping, current actor resolution, prompt acknowledgement, safe failure presentation, and default mention handling. Replies default to ephemeral; new features with an intentionally public response can declare `ephemeral: false`. Existing product commands retain their ephemeral contract.

For observed development sessions, `PUBLIC_TEST_RESPONSES=true` overrides command/component visibility only in `TEST_GUILD_ID`. It does not bypass authorization. The DevBot Compose overlay enables this policy so the development server can follow testing.

For an officer-only root, set both the Discord builder's default `ManageGuild` permission and `access: "officer"`. Mixed-permission subcommands must authorize their individual operations. Application services recheck authorization independently.

`execute` can return content, embeds, attachments, or components. `dataReply()` is available for bounded structured results. Autocomplete returns up to 25 string choices and uses Discord's permission-bearing interaction payload, since autocomplete cannot defer. Keep private completion queries inside an authorized application operation.

### Open a modal

A command can declare a synchronous `modal(interaction)` factory **instead of** `execute`. It returns a `ModalBuilder`, as `/apply` does using labeled text inputs. These openers are user-access only, receive no resolved actor or service context, and must not do network/database work: `showModal` must be Discord's initial acknowledgement. Opening the form does not create a record or grant authority.

Route submission through a separate discovered component namespace. The router defers that submission, resolves the current actor, and authorizes it before the handler runs. Validate actor/guild bindings, input limits, and current persisted context again in the application operation; custom IDs are context, not credentials. A form may remain open across a process restart. Reject obsolete joins and duplicate submissions according to the feature's durable policy. Pre-acknowledgement failures use the same reply-visibility rules as deferred errors.

## Add an event

Create `src/events/welcome.event.ts`:

```ts
/** A best-effort welcome feature independent of FC membership policy. */
import { Events } from "discord.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "custom-welcome", // Unique handler identity, even when event names are shared.
  event: Events.GuildMemberAdd,
  async execute(context, member) {
    // Scope guild-specific work and exclude bots before sending the notification.
    if (!context.allowsGuild(member.guild.id) || member.user.bot) return;
    await member.send({ content: "Welcome to the server!", allowedMentions: { parse: [] } });
  },
});
```

Handler arguments are inferred from `ClientEvents`: selecting a different event changes the tuple TypeScript requires. Multiple modules may subscribe to the same Discord event. Use `once: true` for once-only listeners. The shared binding layer catches synchronous/asynchronous errors, stops new work during shutdown, and returns listener cleanup functions. An infrastructure listener can opt into `duringShutdown: true`.

Stateful decisions and critical deliveries should use an application service and the durable outbox. The example above intentionally treats the welcome DM as best-effort. Configure any additional Discord intents explicitly in `DiscordGateway` and, for privileged intents, in the developer portal.

The built-in `client-ready.event.ts` invokes application initialization. Its lifecycle service owns readiness and scheduling, while `src/main.ts` owns dependency construction and process-signal housekeeping. One-shot operational scripts await their isolated clients' readiness without installing live bot feature listeners.

## Inject a new service

Capability tokens allow a feature to add dependencies without expanding the router's context contract:

```ts
/** A stateless example feature capability. */
import { ServiceKey } from "../../bot/services.js";

export class Clock {
  /** Return an explicit UTC instant for presentation or application policy. */
  now(): Date { return new Date(); }
}

/** The predicate validates dynamically retrieved providers without unsafe assertions. */
export const clockKey = new ServiceKey("clock", (value): value is Clock => value instanceof Clock);
```

Provide the instance once in the composition root with `services.provide(clockKey, new Clock())`. A module declares `requires: [clockKey]`, then obtains its typed capability with `context.services.get(clockKey)`. Required providers are checked before gateway work is accepted. Import the same exported token in the provider and consumer; token identity and names are validated to prevent ambiguous registrations.

TaruBot's existing tokens are in `src/application/keys.ts`. They expose the application service, synchronization, guild-observation operations, lifecycle, PostgreSQL, and Discord gateway. New capabilities can live alongside their own feature code.

## Add a component

Create a `*.component.ts` default export using `defineComponent` with a unique `prefix`. IDs of the form `prefix:payload` route to that module. Buttons, message-component interactions, and modal submissions share this lookup; the handler narrows the interaction type it supports.

The `guest` component demonstrates durable officer review IDs: it validates action, application UUID, guild, actor permissions, and stored message identity before committing a decision. The separate user-level `guest-apply` namespace handles application forms and their join bindings. New components should resolve private payloads through the same owning-guild authorization rules.

## Commenting conventions

- File headers explain the module's responsibility and architectural boundary.
- Public contracts and methods document invariants, authorization, side effects, and return semantics.
- Inline comments explain lock ordering, idempotency, stale evidence, ambiguous acknowledgements, and other decisions whose reasons are not obvious from syntax.
- Gateway modules describe filtering and delegation; business rules belong with their application/domain implementation.
- Scripts document inputs, maintenance intent, cleanup, and database/network boundaries.
- Tests explain controlled failures, synthetic data, and the invariant being exercised.
- Strict JSON configuration is explained in [CONFIGURATION.md](CONFIGURATION.md); executable/configuration formats that support comments carry inline documentation.

When extending a feature, update the relevant comments and meaningful behavior tests together. The inventory test documents the current product contract; intentionally adding a public command requires updating that expected inventory as well.
