/** Shared sidecar wire contract. Parser payloads remain unknown until operation-specific validation. */
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
/** Useful transport categories survive worker boundaries without leaking HTML or credentials. */
export const failureSchema = z.object({
  ok: z.literal(false),
  code: z.enum(["not_found", "unavailable", "rate_limited", "invalid_response", "incomplete"]),
  retryAfter: z.number().nonnegative().default(0),
});
/** Successful envelopes deliberately make no claim about the raw parser's data shape. */
export const responseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  failureSchema,
]);
