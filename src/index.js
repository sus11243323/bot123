require("dotenv").config();
const http = require("http");

const PORT = Number(process.env.PORT) || 3000;

const healthServer = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("HVH Central bot is running.");
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

healthServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Health server running on port ${PORT}`);
});

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  Events,
  REST,
  Routes,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags
} = require("discord.js");

const { commands, makePanel } = require("./commands");
const { get, update } = require("./store");
const { verifyPassword } = require("./security");

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId) {
    throw new Error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env");
  }

  if (!/^\d{17,20}$/.test(clientId)) {
    throw new Error("DISCORD_CLIENT_ID is invalid.");
  }

  if (guildId && !/^\d{17,20}$/.test(guildId)) {
    throw new Error("DISCORD_GUILD_ID is invalid.");
  }

  const rest = new REST({ version: "10" }).setToken(token);

  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body: commands });

  console.log(
    `✅ Registered ${commands.length} slash commands ${
      guildId ? `to guild ${guildId}` : "globally"
    }.`
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const joinWindows = new Map();
const raidMembers = new Map();
const restoreLocks = new Set();

function isAdmin(member) {
  return member?.permissions?.has(
    PermissionsBitField.Flags.Administrator
  );
}

async function antiNukeLog(guild, text) {
  const cfg = get(guild.id).antiNuke;

  if (!cfg?.enabled || !cfg.logChannelId) return;

  const ch = guild.channels.cache.get(cfg.logChannelId);

  if (ch?.isTextBased()) {
    await ch
      .send({
        embeds: [
          new EmbedBuilder()
            .setTitle("🚨 Anti-Nuke")
            .setDescription(text)
        ]
      })
      .catch(() => {});
  }
}

function snapshotChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId,
    position: channel.rawPosition,
    topic: channel.topic ?? null,
    nsfw: !!channel.nsfw,
    rateLimitPerUser: channel.rateLimitPerUser ?? 0,
    bitrate: channel.bitrate ?? null,
    userLimit: channel.userLimit ?? null,

    permissionOverwrites: channel.permissionOverwrites.cache.map(o => ({
      id: o.id,
      allow: o.allow.bitfield.toString(),
      deny: o.deny.bitfield.toString(),
      type: o.type
    }))
  };
}

async function snapshotGuildChannels(guild) {
  const cfg = get(guild.id);
  const snapshots = {};

  for (const ch of guild.channels.cache.values()) {
    if (
      ch.isTextBased() ||
      ch.isVoiceBased() ||
      ch.type === 4
    ) {
      snapshots[ch.id] = snapshotChannel(ch);
    }
  }

  update(guild.id, {
    antiNuke: {
      ...cfg.antiNuke,
      snapshots
    }
  });
}

async function findChannelDeleteExecutor(guild, channelId) {
  const logs = await guild
    .fetchAuditLogs({
      type: 12,
      limit: 10
    })
    .catch(() => null);

  const entry = logs?.entries.find(
    e =>
      e.target?.id === channelId &&
      Date.now() - e.createdTimestamp < 15000
  );

  return entry?.executor || null;
}

async function restoreDeletedChannel(guild, snap) {
  if (!snap || restoreLocks.has(`${guild.id}:${snap.id}`)) {
    return null;
  }

  restoreLocks.add(`${guild.id}:${snap.id}`);

  try {
    let parent = snap.parentId
      ? guild.channels.cache.get(snap.parentId)
      : null;

    if (snap.parentId && !parent) {
      const parentSnap =
        get(guild.id).antiNuke.snapshots?.[snap.parentId];

      if (parentSnap) {
        parent = await restoreDeletedChannel(
          guild,
          parentSnap
        );
      }
    }

    const options = {
      name: snap.name,
      type: snap.type,
      parent: parent?.id,
      topic: snap.topic || undefined,
      nsfw: snap.nsfw,
      rateLimitPerUser: snap.rateLimitPerUser,
      bitrate: snap.bitrate || undefined,
      userLimit: snap.userLimit || undefined,

      permissionOverwrites:
        snap.permissionOverwrites?.map(x => ({
          id: x.id,
          allow: BigInt(x.allow),
          deny: BigInt(x.deny),
          type: x.type
        }))
    };

    const recreated = await guild.channels.create(options);

    if (Number.isFinite(snap.position)) {
      await recreated
        .setPosition(snap.position)
        .catch(() => {});
    }

    return recreated;
  } finally {
    restoreLocks.delete(`${guild.id}:${snap.id}`);
  }
}

async function handleAntiNukeChannelDelete(channel) {
  const cfg = get(channel.guild.id).antiNuke;

  if (!cfg?.enabled) return;

  const snap = cfg.snapshots?.[channel.id];

  const executor = await findChannelDeleteExecutor(
    channel.guild,
    channel.id
  );

  const isBot = !!executor?.bot;

  if (
    executor &&
    executor.id !== channel.guild.ownerId &&
    isBot
  ) {
    const member = await channel.guild.members
      .fetch(executor.id)
      .catch(() => null);

    if (member?.kickable) {
      await member
        .kick(
          "Anti-nuke: bot deleted a protected channel"
        )
        .catch(() => {});
    }

    await antiNukeLog(
      channel.guild,
      `Blocked bot **${executor.tag}** after it deleted **#${channel.name}**.`
    );
  }

  if (snap) {
    const recreated = await restoreDeletedChannel(
      channel.guild,
      snap
    ).catch(() => null);

    if (recreated) {
      await antiNukeLog(
        channel.guild,
        `♻️ Restored deleted channel **#${snap.name}**.`
      );
    } else {
      await antiNukeLog(
        channel.guild,
        `⚠️ Could not restore **#${snap.name}** automatically.`
      );
    }
  }
}

async function logRaid(guild, text) {
  const cfg = get(guild.id).antiRaid;

  if (!cfg.logChannelId) return;

  const ch = guild.channels.cache.get(cfg.logChannelId);

  if (ch?.isTextBased()) {
    await ch
      .send({
        embeds: [
          new EmbedBuilder()
            .setTitle("🛡️ Anti-Raid")
            .setDescription(text)
        ]
      })
      .catch(() => {});
  }
}

async function handleJoin(member) {
  const cfg = get(member.guild.id).antiRaid;

  if (!cfg.enabled) return;

  const now = Date.now();

  const arr = (
    joinWindows.get(member.guild.id) || []
  ).filter(
    t => now - t <= cfg.windowSeconds * 1000
  );

  arr.push(now);

  joinWindows.set(member.guild.id, arr);

  if (arr.length < cfg.threshold) return;

  const ids =
    raidMembers.get(member.guild.id) || new Set();

  ids.add(member.id);

  raidMembers.set(member.guild.id, ids);

  await logRaid(
    member.guild,
    `Raid threshold reached: **${arr.length}** joins in **${cfg.windowSeconds}s**.`
  );

  if (!cfg.banOnRaid) return;

  for (const id of ids) {
    const target =
      member.guild.members.cache.get(id);

    if (!target) continue;

    const ageHours =
      (Date.now() - target.user.createdTimestamp) /
      3600000;

    if (
      ageHours <= cfg.accountAgeHours &&
      target.bannable
    ) {
      await target
        .ban({
          reason:
            "Anti-raid: flagged account during raid incident"
        })
        .catch(() => {});
    }
  }
}

client.once(Events.ClientReady, async c => {
  console.log(`Logged in as ${c.user.tag}`);

  c.user.setPresence({
    activities: [
      {
        name: "Securing HVH Central",
        type: 3
      }
    ],
    status: "online"
  });

  for (const guild of c.guilds.cache.values()) {
    const cfg = get(guild.id).antiNuke;

    if (cfg?.enabled) {
      await snapshotGuildChannels(guild).catch(
        () => {}
      );
    }
  }
});

client.on(
  Events.GuildMemberAdd,
  handleJoin
);

client.on(
  Events.ChannelDelete,
  handleAntiNukeChannelDelete
);

client.on(
  Events.ChannelCreate,
  async channel => {
    const cfg =
      get(channel.guild.id).antiNuke;

    if (
      cfg?.enabled &&
      !cfg.snapshots?.[channel.id]
    ) {
      await snapshotGuildChannels(
        channel.guild
      ).catch(() => {});
    }
  }
);

client.on(
  Events.ChannelUpdate,
  async channel => {
    const cfg =
      get(channel.guild.id).antiNuke;

    if (cfg?.enabled) {
      await snapshotGuildChannels(
        channel.guild
      ).catch(() => {});
    }
  }
);

client.on(
  Events.InteractionCreate,
  async interaction => {
    try {
      if (interaction.isChatInputCommand()) {
        const name =
          interaction.commandName;

        if (name === "ping") {
          return interaction.reply({
            content: `🏓 ${Math.round(
              client.ws.ping
            )}ms`
          });
        }

        if (name === "help") {
          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setTitle(
                  "HVH Central Commands"
                )
                .setDescription(
                  "`/adminpanel` — create the protected panel\n" +
                  "`/antiraid setup` — configure anti-raid\n" +
                  "`/antiraid status` — view protection\n" +
                  "`/antiraid test` — safe dry-run\n" +
                  "`/ban`, `/kick`, `/timeout`, `/purge` — moderation"
                )
            ]
          });
        }

        if (name === "adminpanel") {
          if (
            !isAdmin(interaction.member)
          ) {
            return interaction.reply({
              content:
                "Administrator permission required.",
              flags: MessageFlags.Ephemeral
            });
          }

          await interaction.deferReply({
            flags: MessageFlags.Ephemeral
          });

          const channel =
            interaction.options.getChannel(
              "channel"
            );

          const password =
            interaction.options.getString(
              "password"
            );

          update(interaction.guildId, {
            adminPanel: {
              channelId: channel.id,
              passwordHash:
                require("./security").hashPassword(
                  password
                )
            }
          });

          await makePanel(channel);

          return interaction.editReply(
            "✅ Admin panel created. The password is stored as a secure hash."
          );
        }

        if (name === "antinuke") {
          if (
            !isAdmin(interaction.member)
          ) {
            return interaction.reply({
              content:
                "Administrator permission required.",
              flags: MessageFlags.Ephemeral
            });
          }

          await interaction.deferReply({
            flags: MessageFlags.Ephemeral
          });

          const channel =
            interaction.options.getChannel(
              "channel"
            );

          const old =
            get(interaction.guildId)
              .antiNuke;

          update(interaction.guildId, {
            antiNuke: {
              ...old,
              enabled: true,
              logChannelId: channel.id
            }
          });

          await snapshotGuildChannels(
            interaction.guild
          );

          await antiNukeLog(
            interaction.guild,
            `✅ Anti-nuke enabled. Alerts will be sent here. Protected channels have been snapshotted.`
          );

          return interaction.editReply(
            `🛡️ Anti-nuke enabled. Alerts: ${channel}. Existing channels were snapshotted for restoration.`
          );
        }

        if (name === "antiraid") {
          const sub =
            interaction.options.getSubcommand();

          const cfg =
            get(interaction.guildId)
              .antiRaid;

          if (sub === "setup") {
            await interaction.deferReply({
              flags: MessageFlags.Ephemeral
            });

            update(interaction.guildId, {
              antiRaid: {
                enabled:
                  interaction.options.getBoolean(
                    "enabled"
                  ),

                threshold:
                  interaction.options.getInteger(
                    "threshold"
                  ),

                windowSeconds:
                  interaction.options.getInteger(
                    "window"
                  ),

                accountAgeHours:
                  interaction.options.getInteger(
                    "account-age"
                  ),

                banOnRaid:
                  interaction.options.getBoolean(
                    "ban-on-raid"
                  ),

                logChannelId:
                  interaction.options.getChannel(
                    "log-channel"
                  )?.id || null
              }
            });

            return interaction.editReply(
              "✅ Anti-raid settings saved."
            );
          }

          if (sub === "status") {
            return interaction.reply({
              flags: MessageFlags.Ephemeral,

              embeds: [
                new EmbedBuilder()
                  .setTitle(
                    "🛡️ Anti-Raid Status"
                  )
                  .addFields(
                    {
                      name: "Enabled",
                      value: String(
                        cfg.enabled
                      ),
                      inline: true
                    },
                    {
                      name: "Threshold",
                      value: `${cfg.threshold} joins`,
                      inline: true
                    },
                    {
                      name: "Window",
                      value: `${cfg.windowSeconds}s`,
                      inline: true
                    },
                    {
                      name: "Account age filter",
                      value: `${cfg.accountAgeHours}h`,
                      inline: true
                    },
                    {
                      name: "Ban on raid",
                      value: String(
                        cfg.banOnRaid
                      ),
                      inline: true
                    },
                    {
                      name: "Log channel",
                      value:
                        cfg.logChannelId
                          ? `<#${cfg.logChannelId}>`
                          : "Not set",
                      inline: true
                    }
                  )
              ]
            });
          }

          if (sub === "test") {
            const joins =
              interaction.options.getInteger(
                "joins"
              );

            const wouldTrigger =
              cfg.enabled &&
              joins >= cfg.threshold;

            return interaction.reply({
              flags: MessageFlags.Ephemeral,

              embeds: [
                new EmbedBuilder()
                  .setTitle(
                    "🧪 Anti-Raid Dry Run"
                  )
                  .setDescription(
                    `Simulated **${joins}** joins. No real members are touched.`
                  )
                  .addFields(
                    {
                      name: "Would trigger?",
                      value:
                        wouldTrigger
                          ? "YES"
                          : "NO",
                      inline: true
                    },
                    {
                      name:
                        "Configured threshold",
                      value: String(
                        cfg.threshold
                      ),
                      inline: true
                    },
                    {
                      name:
                        "Configured action",
                      value:
                        cfg.banOnRaid
                          ? "Ban flagged joiners"
                          : "Log only",
                      inline: true
                    }
                  )
              ]
            });
          }
        }

        if (
          [
            "ban",
            "kick",
            "timeout",
            "purge"
          ].includes(name)
        ) {
          await interaction.deferReply({
            flags: MessageFlags.Ephemeral
          });

          if (!interaction.memberPermissions) {
            return interaction.editReply(
              "Missing required permission."
            );
          }

          if (name === "purge") {
            const amount =
              interaction.options.getInteger(
                "amount"
              );

            const deleted =
              await interaction.channel.bulkDelete(
                amount,
                true
              );

            return interaction.editReply(
              `🧹 Deleted ${deleted.size} messages.`
            );
          }

          const user =
            interaction.options.getUser(
              "user"
            );

          const member =
            await interaction.guild.members
              .fetch(user.id)
              .catch(() => null);

          if (!member) {
            return interaction.editReply(
              "Member not found."
            );
          }

          if (
            !member.moderatable &&
            name !== "ban"
          ) {
            return interaction.editReply(
              "I cannot moderate that member due to role hierarchy."
            );
          }

          if (name === "ban") {
            await member.ban({
              reason:
                interaction.options.getString(
                  "reason"
                ) || "Moderation"
            });
          }

          if (name === "kick") {
            await member.kick(
              interaction.options.getString(
                "reason"
              ) || "Moderation"
            );
          }

          if (name === "timeout") {
            await member.timeout(
              interaction.options.getInteger(
                "minutes"
              ) * 60000,
              "Moderation"
            );
          }

          return interaction.editReply(
            `✅ ${name} completed for ${user.tag}.`
          );
        }
      }

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          "panel_"
        )
      ) {
        if (
          !isAdmin(interaction.member)
        ) {
          return interaction.reply({
            content:
              "Administrator permission required.",
            flags: MessageFlags.Ephemeral
          });
        }

        const modal =
          new ModalBuilder()
            .setCustomId(
              `panel_auth:${interaction.customId}`
            )
            .setTitle(
              "HVH Central — Panel Access"
            );

        const input =
          new TextInputBuilder()
            .setCustomId("password")
            .setLabel(
              "Panel password"
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            input
          )
        );

        return interaction.showModal(
          modal
        );
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          "panel_auth:"
        )
      ) {
        if (
          !isAdmin(interaction.member)
        ) {
          return interaction.reply({
            content:
              "Administrator permission required.",
            flags: MessageFlags.Ephemeral
          });
        }

        const cfg =
          get(interaction.guildId)
            .adminPanel;

        const password =
          interaction.fields.getTextInputValue(
            "password"
          );

        if (
          !verifyPassword(
            password,
            cfg.passwordHash
          )
        ) {
          return interaction.reply({
            content:
              "❌ Incorrect panel password.",
            flags: MessageFlags.Ephemeral
          });
        }

        const action =
          interaction.customId.split(":")[1];

        if (
          action === "panel_antiraid"
        ) {
          const a =
            get(interaction.guildId)
              .antiRaid;

          return interaction.reply({
            flags: MessageFlags.Ephemeral,

            content:
              `🛡️ Anti-raid: ${
                a.enabled
                  ? "ON"
                  : "OFF"
              } | threshold ${
                a.threshold
              }/${a.windowSeconds}s | ban ${
                a.banOnRaid
                  ? "ON"
                  : "OFF"
              }`
          });
        }

        if (
          action === "panel_help"
        ) {
          return interaction.reply({
            flags: MessageFlags.Ephemeral,

            content:
              "Use `/ban`, `/kick`, `/timeout`, `/purge`, and `/antiraid`. This panel password only unlocks the panel after Discord Administrator permission is verified."
          });
        }

        return interaction.reply({
          flags: MessageFlags.Ephemeral,

          content:
            `🔐 Password accepted for **${action.replace(
              "panel_",
              ""
            )}**. Use the corresponding slash command for the target/options.`
        });
      }
    } catch (err) {
      // Discord 10062 = interaction expired/unknown.
      // It is harmless and should not spam the Railway logs.
      if (
        err?.code === 10062 ||
        err?.rawError?.code === 10062
      ) {
        return;
      }

      console.error(err);

      if (
        !interaction.replied &&
        !interaction.deferred
      ) {
        await interaction
          .reply({
            content:
              "Something went wrong.",
            flags: MessageFlags.Ephemeral
          })
          .catch(() => {});
      } else {
        await interaction
          .editReply({
            content:
              "Something went wrong."
          })
          .catch(() => {});
      }
    }
  }
);

(async () => {
  try {
    await registerCommands();
    await client.login(
      process.env.DISCORD_TOKEN
    );
  } catch (err) {
    console.error(
      "❌ Startup failed:",
      err
    );

    process.exit(1);
  }
})();
