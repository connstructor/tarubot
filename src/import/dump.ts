/** Decode the supported MySQL/MariaDB dump subset as data; input SQL is never executed. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { Failure, gil, idSchema } from "../domain/values.js";

type Cell = string | null;
/** Split only outside quoted values/comments, so escaped quotes and embedded semicolons survive. */
function statements(input: string): string[] {
  if (Buffer.byteLength(input) > 64 * 1024 * 1024)
    throw new Failure("input", "Dump exceeds the 64 MiB import limit.");
  const result: string[] = [];
  let text = "";
  let quote: string | null = null;
  for (let index = 0; index < input.length; index++) {
    const char = input[index] ?? "";
    const next = input[index + 1];
    if (quote) {
      text += char;
      if (char === "\\" && next !== undefined) {
        text += next;
        index++;
      } else if (char === quote) {
        if (next === quote) {
          text += next;
          index++;
        } else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      text += char;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = input.indexOf("*/", index + 2);
      if (end < 0) throw new Failure("input", "Unterminated SQL comment.");
      index = end + 1;
      text += " ";
      continue;
    }
    if (char === "#" || (char === "-" && next === "-" && /\s/.test(input[index + 2] ?? " "))) {
      const end = input.indexOf("\n", index);
      index = end < 0 ? input.length : end;
      text += "\n";
      continue;
    }
    if (char === ";") {
      if (text.trim()) result.push(text.trim());
      text = "";
    } else text += char;
  }
  if (quote) throw new Failure("input", "Unterminated SQL quoted value.");
  if (text.trim()) result.push(text.trim());
  return result;
}
/** Decode quoted cells, SQL NULL, and exact decimal integer text from INSERT VALUES. */
function tuples(input: string): Cell[][] {
  let index = 0;
  const result: Cell[][] = [];
  const whitespace = () => {
    while (/\s/.test(input[index] ?? "X")) index++;
  };
  const expected = (char: string) => {
    whitespace();
    if (input[index++] !== char)
      throw new Failure("input", `Malformed SQL VALUES near offset ${index}.`);
  };
  const escapes: Record<string, string> = {
    "0": "\0",
    b: "\b",
    n: "\n",
    r: "\r",
    t: "\t",
    Z: "\x1a",
  };
  while (index < input.length) {
    whitespace();
    if (index === input.length) break;
    expected("(");
    const row: Cell[] = [];
    for (;;) {
      whitespace();
      let value: Cell = "";
      if (input[index] === "'" || input[index] === '"') {
        const quote = input[index++];
        let closed = false;
        while (index < input.length) {
          const char = input[index++] ?? "";
          if (char === "\\") {
            const next = input[index++];
            if (next === undefined) throw new Failure("input", "Incomplete escape.");
            value += escapes[next] ?? next;
          } else if (char === quote) {
            if (input[index] === quote) {
              value += quote;
              index++;
            } else {
              closed = true;
              break;
            }
          } else value += char;
        }
        if (!closed) throw new Failure("input", "Unterminated SQL value.");
      } else {
        const match = /^(NULL|-?[0-9]+)/i.exec(input.slice(index));
        if (!match)
          throw new Failure(
            "input",
            "Unsupported SQL value; expected quoted text, NULL, or integer.",
          );
        index += match[0].length;
        value = match[0].toUpperCase() === "NULL" ? null : match[0];
      }
      row.push(value);
      whitespace();
      if (input[index] === ")") {
        index++;
        break;
      }
      expected(",");
    }
    result.push(row);
    whitespace();
    if (index < input.length) expected(",");
  }
  return result;
}
// Only optional role/channel resources treat empty strings as unconfigured; relationships do not.
const optionalId = z.preprocess((value) => (value === "" ? null : value), idSchema.nullable());
const text = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "PostgreSQL text cannot contain NUL");
/** Validate source values before any live-state transaction begins. */
const fcSchema = z.object({
  fc_id: idSchema,
  name: text,
  tag: z.string(),
  world: text,
  gil_balance: z
    .string()
    .nullable()
    .transform((value) => (value === null ? null : gil(value).toString())),
  last_updated: z.string().nullable(),
});
const characterSchema = z.object({
  char_id: idSchema,
  owner: idSchema.nullable(),
  fc: idSchema.nullable(),
  forename: text,
  surname: text,
  world: text,
});
const guildSchema = z
  .object({
    guild_id: idSchema,
    fc: idSchema.nullable(),
    member_role_id: optionalId,
    guest_role_id: optionalId,
    ledger_channel_id: optionalId,
    officer_notifications_channel_id: optionalId,
    guest_application_channel_id: optionalId,
  })
  .refine(
    (value) => !value.member_role_id || value.member_role_id !== value.guest_role_id,
    "Member and guest roles must be distinct",
  );
export type LegacyGuild = z.infer<typeof guildSchema>;
/** Validated source rows plus the fingerprint used for idempotence and provenance. */
export interface LegacyData {
  fingerprint: string;
  companies: z.infer<typeof fcSchema>[];
  characters: z.infer<typeof characterSchema>[];
  users: string[];
  guilds: LegacyGuild[];
}
/** Two passes decouple schema/data ordering; relational validation catches broken source keys. */
export function readDump(input: string): LegacyData {
  const commands = statements(input);
  const schemas = new Map<string, string[]>();
  const tables = new Map<string, Record<string, Cell>[]>();
  for (const command of commands) {
    const create = /^CREATE TABLE\s+`(\w+)`\s*\(([\s\S]*)\)/i.exec(command);
    if (create?.[1] && create[2])
      schemas.set(
        create[1],
        [...create[2].matchAll(/^\s*`(\w+)`\s+/gm)].map((match) => match[1] ?? ""),
      );
  }
  for (const command of commands) {
    if (!/^INSERT\s/i.test(command)) continue;
    const insert = /^INSERT INTO\s+`(\w+)`\s*(?:\(([^)]*)\))?\s+VALUES\s*([\s\S]*)$/i.exec(command);
    if (!insert?.[1] || insert[3] === undefined)
      throw new Failure("input", "Unsupported INSERT syntax.");
    const name = insert[1];
    if (!["freecompany", "gamecharacter", "member", "guild"].includes(name))
      throw new Failure("input", `Unexpected input table ${name}.`);
    const columns = insert[2]
      ? [...insert[2].matchAll(/`(\w+)`/g)].map((match) => match[1] ?? "")
      : schemas.get(name);
    if (!columns?.length) throw new Failure("input", `Missing column schema for ${name}.`);
    const rows = tables.get(name) ?? [];
    for (const tuple of tuples(insert[3])) {
      if (tuple.length !== columns.length)
        throw new Failure("input", `Column count mismatch in ${name}.`);
      rows.push(Object.fromEntries(columns.map((column, index) => [column, tuple[index] ?? null])));
    }
    tables.set(name, rows);
  }
  const data: LegacyData = {
    fingerprint: createHash("sha256").update(input).digest("hex"),
    companies: z.array(fcSchema).parse(tables.get("freecompany")),
    characters: z.array(characterSchema).parse(tables.get("gamecharacter")),
    users: z
      .array(z.object({ discord_id: idSchema }))
      .parse(tables.get("member"))
      .map((row) => row.discord_id),
    guilds: z.array(guildSchema).min(1).parse(tables.get("guild")),
  };
  const companyIds = new Set(data.companies.map((row) => row.fc_id));
  const userIds = new Set(data.users);
  const characterIds = new Set(data.characters.map((row) => row.char_id));
  const guildIds = new Set(data.guilds.map((row) => row.guild_id));
  if (
    companyIds.size !== data.companies.length ||
    userIds.size !== data.users.length ||
    characterIds.size !== data.characters.length ||
    guildIds.size !== data.guilds.length
  )
    throw new Failure("input", "Duplicate source primary keys.");
  for (const row of data.characters)
    if ((row.owner && !userIds.has(row.owner)) || (row.fc && !companyIds.has(row.fc)))
      throw new Failure("input", `Broken source relationship for character ${row.char_id}.`);
  for (const row of data.guilds)
    if (row.fc && !companyIds.has(row.fc))
      throw new Failure("input", `Broken FC relationship for guild ${row.guild_id}.`);
  for (const row of data.companies)
    if (row.last_updated) {
      const date = new Date(`${row.last_updated.replace(" ", "T")}Z`);
      if (
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 19) !== row.last_updated.replace(" ", "T")
      )
        throw new Failure("input", `Invalid source timestamp for FC ${row.fc_id}.`);
    }
  return data;
}
