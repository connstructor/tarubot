/** Short, bounded answers and the observed join belong to one durable guest application. */
import { z } from "zod";

export const GUEST_ANSWER_MIN = 10;
export const GUEST_ANSWER_MAX = 300;
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
