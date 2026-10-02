const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");
const { hashPassword } = require("./security");
const { get, update } = require("./store");
const { MessageFlags } = require("discord.js");

const commands = [
  new SlashCommandBuilder().setName("help").setDescription("Show bot commands."),
  new SlashCommandBuilder().setName("ping").setDescription("Show bot latency."),
  new SlashCommandBuilder().setName("adminpanel").setDescription("Create the protected administration panel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel").setDescription("Channel for the panel").addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName("password").setDescription("Panel password").setRequired(true).setMinLength(8)),
  new SlashCommandBuilder().setName("antinuke").setDescription("Configure anti-nuke protection.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel").setDescription("Channel for anti-nuke alerts").addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName("antiraid").setDescription("Configure anti-raid protection.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName("setup").setDescription("Configure anti-raid.")
      .addBooleanOption(o => o.setName("enabled").setDescription("Enable detection").setRequired(true))
      .addIntegerOption(o => o.setName("threshold").setDescription("Joins required").setMinValue(2).setMaxValue(100).setRequired(true))
      .addIntegerOption(o => o.setName("window").setDescription("Detection window in seconds").setMinValue(2).setMaxValue(120).setRequired(true))
      .addIntegerOption(o => o.setName("account-age").setDescription("Flag accounts younger than this many hours").setMinValue(0).setMaxValue(8760).setRequired(true))
      .addBooleanOption(o => o.setName("ban-on-raid").setDescription("Ban flagged joiners during an incident").setRequired(true))
      .addChannelOption(o => o.setName("log-channel").setDescription("Anti-raid log channel").addChannelTypes(ChannelType.GuildText).setRequired(false)))
    .addSubcommand(s => s.setName("status").setDescription("Show anti-raid status."))
    .addSubcommand(s => s.setName("test").setDescription("Dry-run a simulated raid; never bans real members.")
      .addIntegerOption(o => o.setName("joins").setDescription("Simulated joins").setMinValue(1).setMaxValue(100).setRequired(true))),
  new SlashCommandBuilder().setName("ban").setDescription("Ban a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder().setName("kick").setDescription("Kick a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder().setName("timeout").setDescription("Timeout a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("Duration").setMinValue(1).setMaxValue(40320).setRequired(true)),
  new SlashCommandBuilder().setName("purge").setDescription("Delete recent messages.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o => o.setName("amount").setDescription("Messages to delete").setMinValue(1).setMaxValue(100).setRequired(true))
].map(c => c.toJSON());

async function makePanel(channel) {
  const embed = new EmbedBuilder()
    .setTitle("🛡️ HVH Central — Security Panel")
    .setDescription("Protected server administration panel. Click an action and enter the panel password when prompted.")
    .addFields(
      { name: "Moderation", value: "Ban, kick, timeout and purge are available through commands and the panel." },
      { name: "Security", value: "Anti-raid configuration and dry-run testing are available." },
      { name: "Access", value: "Discord permissions **and** the panel password are required." }
    )
    .setFooter({ text: "HVH Central Security" });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel_ban").setLabel("Ban").setEmoji("🔨").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("panel_kick").setLabel("Kick").setEmoji("👢").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("panel_timeout").setLabel("Timeout").setEmoji("🔇").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel_purge").setLabel("Purge").setEmoji("🧹").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel_antiraid").setLabel("Anti-Raid Status").setEmoji("🛡️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel_help").setLabel("Commands").setEmoji("📋").setStyle(ButtonStyle.Secondary)
  );
  return channel.send({ embeds: [embed], components: [row1, row2] });
}

module.exports = { commands, makePanel };
