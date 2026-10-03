const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");

const commands = [
  new SlashCommandBuilder().setName("help").setDescription("Show all bot commands and features."),
  new SlashCommandBuilder().setName("ping").setDescription("Check the bot latency and health."),
  new SlashCommandBuilder().setName("serverinfo").setDescription("Show information about this server."),
  new SlashCommandBuilder().setName("userinfo").setDescription("Show information about a member.")
    .addUserOption(o => o.setName("user").setDescription("Member to inspect").setRequired(false)),
  new SlashCommandBuilder().setName("setup").setDescription("Create the recommended channels, role and ticket setup.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("ticket").setDescription("Post the ticket panel in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName("config").setDescription("Configure server features.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName("welcome").setDescription("Configure welcome messages.")
      .addChannelOption(o => o.setName("channel").setDescription("Welcome channel").addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addStringOption(o => o.setName("message").setDescription("Use {user}, {username}, {server}").setRequired(false)))
    .addSubcommand(s => s.setName("goodbye").setDescription("Configure goodbye messages.")
      .addChannelOption(o => o.setName("channel").setDescription("Goodbye channel").addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addStringOption(o => o.setName("message").setDescription("Use {user}, {username}, {server}").setRequired(false)))
    .addSubcommand(s => s.setName("modlog").setDescription("Set the moderation log channel.")
      .addChannelOption(o => o.setName("channel").setDescription("Log channel").addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName("autorole").setDescription("Set the role given to new members.")
      .addRoleOption(o => o.setName("role").setDescription("Auto role").setRequired(true)))
    .addSubcommand(s => s.setName("tickets").setDescription("Configure ticket category and support role.")
      .addChannelOption(o => o.setName("category").setDescription("Ticket category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
      .addRoleOption(o => o.setName("support_role").setDescription("Support role").setRequired(false)))
    .addSubcommand(s => s.setName("suggestions").setDescription("Set the suggestions channel.")
      .addChannelOption(o => o.setName("channel").setDescription("Suggestions channel").addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName("show").setDescription("Show current configuration.")),
  new SlashCommandBuilder().setName("warn").setDescription("Warn a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("timeout").setDescription("Timeout a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("Duration in minutes").setMinValue(1).setMaxValue(40320).setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("kick").setDescription("Kick a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("ban").setDescription("Ban a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("unban").setDescription("Unban a user by ID.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(o => o.setName("user_id").setDescription("Discord user ID").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("purge").setDescription("Delete recent messages.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o => o.setName("amount").setDescription("1-100 messages").setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName("suggest").setDescription("Submit a suggestion.")
    .addStringOption(o => o.setName("text").setDescription("Your suggestion").setMinLength(3).setMaxLength(1000).setRequired(true)),
  new SlashCommandBuilder().setName("adminpanel").setDescription("Create the protected administration panel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel").setDescription("Channel for the panel").addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName("password").setDescription("Panel password (8-100 characters)").setMinLength(8).setMaxLength(100).setRequired(true)),
  new SlashCommandBuilder().setName("antinuke").setDescription("Configure anti-nuke protection.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel").setDescription("Channel for anti-nuke alerts").addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName("antinukebuilder").setDescription("Temporarily trust a legitimate server-builder bot.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName("bot").setDescription("The builder bot to trust").setRequired(true))
    .addBooleanOption(o => o.setName("enabled").setDescription("Enable or disable builder mode").setRequired(true))
    .addStringOption(o => o.setName("duration").setDescription("Duration, e.g. 10s or 10m; required when enabled").setRequired(false)),
  new SlashCommandBuilder().setName("nuketest").setDescription("Safe dry-run of the anti-nuke system; no channels are deleted.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("autosavesnapshot").setDescription("Automatically save anti-nuke channel snapshots on a timer.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("time").setDescription("Snapshot interval, for example 10s or 10m").setRequired(true)
      .setMinLength(2).setMaxLength(6)),
  new SlashCommandBuilder().setName("antiraid").setDescription("Configure and test anti-raid protection.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName("setup").setDescription("Configure anti-raid protection.")
      .addBooleanOption(o => o.setName("enabled").setDescription("Enable anti-raid").setRequired(true))
      .addIntegerOption(o => o.setName("threshold").setDescription("Joins that trigger anti-raid").setMinValue(2).setMaxValue(100).setRequired(true))
      .addIntegerOption(o => o.setName("window").setDescription("Detection window in seconds").setMinValue(2).setMaxValue(120).setRequired(true))
      .addIntegerOption(o => o.setName("account_age").setDescription("Only flag accounts newer than this many hours; 0 disables age filter").setMinValue(0).setMaxValue(8760).setRequired(true))
      .addBooleanOption(o => o.setName("ban_on_raid").setDescription("Ban flagged joiners during an incident").setRequired(true))
      .addChannelOption(o => o.setName("log_channel").setDescription("Anti-raid log channel").addChannelTypes(ChannelType.GuildText).setRequired(false)))
    .addSubcommand(s => s.setName("status").setDescription("Show anti-raid settings."))
    .addSubcommand(s => s.setName("test").setDescription("Simulate an anti-raid trigger without banning anyone.")
      .addIntegerOption(o => o.setName("joins").setDescription("Number of simulated joins").setMinValue(1).setMaxValue(100).setRequired(false))),

  new SlashCommandBuilder().setName("softban").setDescription("Ban and immediately unban a member to clear recent messages.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("slowmode").setDescription("Set slowmode for the current channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption(o => o.setName("seconds").setDescription("0-21600 seconds").setMinValue(0).setMaxValue(21600).setRequired(true)),
  new SlashCommandBuilder().setName("avatar").setDescription("Show a user's avatar.")
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(false)),
  new SlashCommandBuilder().setName("roleinfo").setDescription("Show information about a role.")
    .addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)),
  new SlashCommandBuilder().setName("poll").setDescription("Create a simple yes/no poll.")
    .addStringOption(o => o.setName("question").setDescription("Poll question").setMinLength(3).setMaxLength(500).setRequired(true)),
  new SlashCommandBuilder().setName("announce").setDescription("Post an announcement in a selected channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption(o => o.setName("channel").setDescription("Announcement channel").addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName("message").setDescription("Announcement text").setMinLength(1).setMaxLength(2000).setRequired(true)),
  new SlashCommandBuilder().setName("ticketclose").setDescription("Close the current ticket channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName("ticketrename").setDescription("Rename the current ticket channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption(o => o.setName("name").setDescription("New channel name").setMinLength(2).setMaxLength(90).setRequired(true)),
  new SlashCommandBuilder().setName("lockdown").setDescription("Lock or unlock all text channels for @everyone.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption(o => o.setName("enabled").setDescription("Enable or disable lockdown").setRequired(true)),
  new SlashCommandBuilder().setName("security").setDescription("Show the current security protection status.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(c => c.toJSON());

async function makePanel(channel) {
  const embed = new EmbedBuilder()
    .setTitle("🛡️ HVH Central — Security Panel")
    .setDescription("Protected server administration panel. Click an action and enter the panel password when prompted.")
    .addFields(
      { name: "Moderation", value: "Ban, kick, timeout and purge are available." },
      { name: "Security", value: "Anti-raid and anti-nuke testing are safe dry-runs." },
      { name: "Other", value: "Tickets, setup, configuration and suggestions are available through slash commands." }
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
    new ButtonBuilder().setCustomId("panel_nuke").setLabel("Anti-Nuke Status").setEmoji("💥").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel_help").setLabel("Commands").setEmoji("📋").setStyle(ButtonStyle.Secondary)
  );
  return channel.send({ embeds: [embed], components: [row1, row2] });
}

module.exports = { commands, makePanel };
