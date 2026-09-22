/** Explicit command deployment uses the same filesystem-discovered definitions as runtime. */
import { REST, Routes } from "discord.js";
import { loadCommands } from "../src/bot/discovery.js";
import { id } from "../src/domain/values.js";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required");
const application = id(process.env.DISCORD_APPLICATION_ID);
const args = process.argv.slice(2);
const guildIndex = args.indexOf("--guild");
const guild = guildIndex >= 0 ? id(args[guildIndex + 1]) : null;
if ((guild !== null) === args.includes("--global"))
  throw new Error("Choose exactly one of --guild GUILD_ID or --global.");
const rest = new REST({ version: "10" }).setToken(token);
const commands = await loadCommands();
await rest.put(
  guild
    ? Routes.applicationGuildCommands(application, guild)
    : Routes.applicationCommands(application),
  { body: [...commands.values()].map((command) => command.toJSON()) },
);
console.log(
  `Registered exactly ${commands.size} root commands in ${guild ?? "global production"} scope.`,
);
