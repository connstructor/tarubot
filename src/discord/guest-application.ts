/** Discord form presentation is separate from durable eligibility and approval decisions. */
import {
  EmbedBuilder,
  escapeMarkdown,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { ChatInputCommandInteraction, ModalSubmitInteraction } from "discord.js";
import type { ApplicationRecord } from "../application/records.js";
import type { Actor } from "../domain/policy.js";
import {
  GUEST_ANSWER_MAX,
  GUEST_ANSWER_MIN,
  type GuestApplicationInput,
} from "../domain/guest-application.js";
import { Failure, idSchema } from "../domain/values.js";

/** Use Discord's interaction join context without a network round trip before showModal. */
export function guestApplicationModal(interaction: ChatInputCommandInteraction): ModalBuilder {
  const joined = interaction.inCachedGuild()
    ? interaction.member.joinedTimestamp
    : interaction.inRawGuild()
      ? Date.parse(interaction.member.joined_at ?? "")
      : null;
  // Without the join time the form cannot be bound to this join; reopening /apply retries it.
  if (!interaction.guildId || !joined || !Number.isSafeInteger(joined))
    throw new Failure(
      "stale",
      "Discord didn't send your join details. Run /apply again from inside the server.",
      0,
      { kind: "stale", what: "join" },
    );
  const field = (name: string, label: string, description: string) =>
    new LabelBuilder()
      .setLabel(label)
      .setDescription(description)
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(name)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(GUEST_ANSWER_MIN)
          .setMaxLength(GUEST_ANSWER_MAX),
      );
  return new ModalBuilder()
    .setCustomId(`guest-apply:${interaction.guildId}:${interaction.user.id}:${joined}`)
    .setTitle("Guest application")
    .addLabelComponents(
      field(
        "introduction",
        "Introduce yourself",
        "A short introduction for the officers (10–300 characters).",
      ),
      field(
        "interest",
        "Why join this server?",
        "Tell us what interests you and how you found us or who invited you.",
      ),
    );
}

/** Bound IDs are not credentials: compare the submitting actor, then refresh presence in Service.apply. */
export function guestApplicationSubmission(
  interaction: ModalSubmitInteraction,
  actor: Actor,
): GuestApplicationInput {
  const match = /^guest-apply:([1-9][0-9]{0,19}):([1-9][0-9]{0,19}):([1-9][0-9]{0,12})$/.exec(
    interaction.customId,
  );
  if (
    !match ||
    !idSchema.safeParse(match[1]).success ||
    !idSchema.safeParse(match[2]).success ||
    match[1] !== actor.guildId ||
    match[2] !== actor.userId ||
    interaction.guildId !== actor.guildId ||
    interaction.user.id !== actor.userId
  )
    throw new Failure(
      "stale",
      "This form belongs to someone else or to another server. Run /apply yourself.",
      0,
      { kind: "stale", what: "form" },
    );
  return {
    joinedAt: new Date(Number(match[3])),
    introduction: interaction.fields.getTextInputValue("introduction"),
    interest: interaction.fields.getTextInputValue("interest"),
  };
}

/** Named embed fields isolate applicant text from decision metadata and fit without truncating answers. */
export function guestApplicationEmbeds(application: ApplicationRecord): EmbedBuilder[] {
  return [
    new EmbedBuilder()
      .setTitle("Applicant answers")
      .setDescription(
        application.introduction === null
          ? "Submitted before application forms were introduced."
          : "Officer review is required; submitting this form does not grant access.",
      )
      .addFields(
        ...(application.introduction !== null && application.interest !== null
          ? [
              { name: "Introduce yourself", value: escapeMarkdown(application.introduction) },
              { name: "Why join this server?", value: escapeMarkdown(application.interest) },
            ]
          : []),
      ),
  ];
}
