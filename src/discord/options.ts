/** Reusable registration conventions; feature-specific options belong in their modules. */
import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandStringOption } from "discord.js";

/** Existing commands are guild-only; new modules can supply their own Discord builder. */
export const command = (name: string, description: string) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild);

/** Keep accepted input bounds consistent across definitions and autocomplete declarations. */
export const string =
  (name: string, description: string, required = false, autocomplete = false) =>
  (option: SlashCommandStringOption) =>
    option
      .setName(name)
      .setDescription(description)
      .setRequired(required)
      .setMaxLength(name === "note" || name === "reason" ? 1000 : 200)
      .setAutocomplete(autocomplete);
