require("dotenv").config();
const { REST, Routes } = require("discord.js");
const { commands } = require("./commands");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !clientId) throw new Error("Set DISCORD_TOKEN and DISCORD_CLIENT_ID in .env");
if (!/^\d{17,20}$/.test(clientId)) throw new Error("DISCORD_CLIENT_ID is not a valid Discord application ID.");
if (guildId && !/^\d{17,20}$/.test(guildId)) throw new Error("DISCORD_GUILD_ID is not a valid Discord server ID.");

const rest = new REST({ version: "10" }).setToken(token);
(async () => {
  const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} commands ${guildId ? `to guild ${guildId}` : "globally"}.`);
})().catch(console.error);
