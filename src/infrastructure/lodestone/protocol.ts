/**
 * The contract between the bot and its parser workers (2.21.0: in process; the sidecar's HTTP API
 * is gone). Parser payloads remain unknown until the adapter's operation-specific validation.
 */
import { z } from "zod";
import { idSchema } from "../../domain/values.js";

/** A bounded allowlist of operations/identifiers prevents arbitrary upstream URL execution. */
export const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("profile"),
    id: idSchema,
    biography: z.boolean().default(false),
  }),
  z.object({ operation: z.literal("fc"), id: idSchema }),
  z.object({
    operation: z.literal("members"),
    id: idSchema,
    page: z.number().int().min(1).max(100),
  }),
  z.object({
    operation: z.literal("search"),
    name: z.string().min(1).max(100),
    world: z.string().min(1).max(80),
    page: z.number().int().min(1).max(100),
  }),
]);
export type ParseRequest = z.infer<typeof requestSchema>;
/**
 * Useful transport categories survive the worker boundary without leaking HTML. `rate_limited` is
 * the Lodestone throttling (the gate then refuses new starts for the cooldown in retryAfter);
 * `private` is a character page the Lodestone answers with its "Access Restricted" page.
 */
export const failureSchema = z.object({
  ok: z.literal(false),
  code: z.enum([
    "not_found",
    "unavailable",
    "rate_limited",
    "private",
    "invalid_response",
    "incomplete",
  ]),
  retryAfter: z.number().nonnegative().default(0),
});
/** A parse outcome: successful data deliberately makes no claim about its shape. */
export const responseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  failureSchema,
]);
export type ParseResponse = z.infer<typeof responseSchema>;
