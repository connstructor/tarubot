/** Editable, responsibility-separated development plans rendered within Discord embed limits. */
import type { MessageCreateOptions } from "discord.js";
import { z } from "zod";

/** Keep each party's checklist complete in one field rather than silently truncating actions. */
const actions = z
  .array(z.string().trim().min(1).max(500))
  .min(1)
  .max(12)
  .refine(
    (items) => items.map((item, index) => `${index + 1}. ${item}`).join("\n").length <= 1024,
    "Each responsibility section must fit 1,024 characters.",
  );
export const testSessionSchema = z.object({
  title: z.string().trim().min(1).max(100),
  objective: z.string().trim().min(1).max(500),
  user: actions,
  assistant: actions,
  bot: actions,
});
export type TestSessionPlan = z.infer<typeof testSessionSchema>;

/** Public session information never includes environment values, tokens, or profile proofs. */
export function testSessionMessage(
  plan: TestSessionPlan,
  botName: string,
  startedAt: Date,
  effects: boolean,
): MessageCreateOptions {
  const checklist = (items: string[]) =>
    items.map((item, index) => `${index + 1}. ${item}`).join("\n");
  return {
    content: `${botName} started — here is the test plan for this session.`,
    allowedMentions: { parse: [] },
    embeds: [
      {
        title: plan.title,
        description: `${plan.objective}\n\n**Effects:** ${effects ? "enabled" : "paused"} · **Started:** <t:${Math.floor(startedAt.getTime() / 1000)}:F>`,
        fields: [
          { name: "You — Discord test actions", value: checklist(plan.user) },
          { name: "Me — implementation and verification", value: checklist(plan.assistant) },
          { name: `${botName} — automatic actions`, value: checklist(plan.bot) },
        ],
        timestamp: startedAt.toISOString(),
      },
    ],
  };
}
