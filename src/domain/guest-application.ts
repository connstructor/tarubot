/** Short, bounded answers and the observed join belong to one durable guest application. */
import { z } from "zod";

export const GUEST_ANSWER_MIN = 10;
export const GUEST_ANSWER_MAX = 300;
/**
 * Visitor-facing refusal when a server has no review channel, which is how imported servers start
 * (owner launch decision 2026-09-23). /apply shows it before the form opens, and Service.apply
 * repeats it at submission, so both paths tell a visitor the same thing.
 */
export const GUEST_APPLICATIONS_CLOSED =
  "Guest applications are not open in this server. Ask an officer about Guest access.";
const answer = z
  .string()
  .trim()
  .min(GUEST_ANSWER_MIN)
  .max(GUEST_ANSWER_MAX)
  .refine((value) => value.isWellFormed() && !value.includes("\0"));

/** Validate again at the application boundary; client-side modal limits are only guidance. */
export const guestApplicationInput = z.strictObject({
  joinedAt: z.date(),
  introduction: answer,
  interest: answer,
});
export type GuestApplicationInput = z.infer<typeof guestApplicationInput>;
