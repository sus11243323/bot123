const { MessageFlags } = require("discord.js");

async function safeReply(interaction, payload) {
  try {
    if (interaction.replied || interaction.deferred) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (err) {
    if (err?.code === 10062 || err?.code === 40060) return null;
    throw err;
  }
}
async function safeEdit(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    return await interaction.reply(payload);
  } catch (err) {
    if (err?.code === 10062 || err?.code === 40060) return null;
    throw err;
  }
}
module.exports = { safeReply, safeEdit, MessageFlags };
