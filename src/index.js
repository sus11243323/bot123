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
healthServer.listen(PORT, "0.0.0.0", () => console.log(`🌐 Health server running on port ${PORT}`));

const {
  Client, GatewayIntentBits, Partials, PermissionsBitField, PermissionFlagsBits, Events,
  REST, Routes, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType, MessageFlags
} = require("discord.js");
const { commands, makePanel } = require("./commands");
const { get, update } = require("./store");
const { verifyPassword, hashPassword } = require("./security");

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  if (!token || !clientId) throw new Error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.");
  if (!/^\d{17,20}$/.test(clientId)) throw new Error("DISCORD_CLIENT_ID is invalid.");
  if (guildId && !/^\d{17,20}$/.test(guildId)) throw new Error("DISCORD_GUILD_ID is invalid.");
  const rest = new REST({ version: "10" }).setToken(token);
  const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
  await rest.put(route, { body: commands });
  console.log(`✅ Registered ${commands.length} slash commands ${guildId ? `to guild ${guildId}` : "globally"}.`);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

const joinWindows = new Map();
const raidMembers = new Map();
const restoreLocks = new Set();
const restoredChannelCache = new Map();
const autoSnapshotTimers = new Map();
const antiNukeAuditLocks = new Set();
const antiNukeIncidentState = new Map();
const antiNukeSweepTimers = new Map();

function isAdmin(member) { return member?.permissions?.has(PermissionsBitField.Flags.Administrator); }
function okEmbed(title, description) { return new EmbedBuilder().setColor(0x57f287).setTitle(title).setDescription(description).setTimestamp(); }
function errorEmbed(description) { return new EmbedBuilder().setColor(0xed4245).setTitle("Error").setDescription(description).setTimestamp(); }
function logEmbed(title, description, color = 0x5865f2) { return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp(); }
function cleanChannelName(name) { return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 80) || "ticket"; }
function canManageTarget(interaction, target) {
  if (!target || target.id === interaction.user.id || target.id === interaction.guild.ownerId) return false;
  return interaction.member.roles.highest.comparePositionTo(target.roles.highest) > 0;
}
function formatMessage(template, member) {
  return (template || "Welcome {user} to **{server}**!")
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{username}", member.user.username)
    .replaceAll("{server}", member.guild.name);
}
async function respond(i, payload) {
  try {
    if (i.deferred) return await i.editReply(payload);
    if (i.replied) return await i.followUp(payload);
    return await i.reply(payload);
  } catch (e) {
    if (e?.code !== 10062 && e?.code !== 40060) console.error("Interaction response error:", e);
  }
}
async function sendLog(guild, embed) {
  const cfg = get(guild.id);
  if (!cfg.modlogChannelId) return;
  const ch = guild.channels.cache.get(cfg.modlogChannelId);
  if (ch?.isTextBased()) await ch.send({ embeds: [embed] }).catch(() => {});
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

function snapshotGuildMeta(guild) {
  return {
    serverName: guild.name,
    iconHash: guild.icon || null,
    iconURL: guild.iconURL({ extension: guild.icon?.startsWith("a_") ? "gif" : "png", size: 1024 }) || null
  };
}

async function snapshotGuildChannels(guild) {
  const snapshots = {};
  for (const ch of guild.channels.cache.values()) {
    // Ticket channels are temporary by design. Never put them into the
    // protected snapshot, otherwise closing a ticket could resurrect it.
    if (typeof ch.topic === "string" && ch.topic.startsWith("ticket-owner:")) {
      continue;
    }

    if (ch.isTextBased() || ch.isVoiceBased() || ch.type === ChannelType.GuildCategory) {
      snapshots[ch.id] = snapshotChannel(ch);
    }
  }

  const old = get(guild.id).antiNuke;
  update(guild.id, {
    antiNuke: {
      ...old,
      snapshots,
      ...snapshotGuildMeta(guild)
    }
  });
  return Object.keys(snapshots).length;
}

async function restoreServerIcon(guild, iconURL) {
  if (!iconURL) return false;
  try {
    const response = await fetch(iconURL);
    if (!response.ok) return false;
    const buffer = Buffer.from(await response.arrayBuffer());
    await guild.setIcon(buffer, "Anti-nuke: restore protected server icon");
    return true;
  } catch {
    return false;
  }
}

async function restoreChildrenToCategory(guild, categoryId, recreatedCategory) {
  const snapshots = get(guild.id).antiNuke.snapshots || {};
  const children = Object.values(snapshots)
    .filter(s => s.parentId === categoryId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  for (const childSnap of children) {
    const child = guild.channels.cache.get(childSnap.id);
    if (!child) continue;
    await child.setParent(recreatedCategory.id, { lockPermissions: false }).catch(() => {});
    if (Number.isFinite(childSnap.position)) {
      await child.setPosition(childSnap.position).catch(() => {});
    }
  }
}

async function findRecentAuditEntry(guild, type, targetId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const logs = await guild.fetchAuditLogs({ type, limit: 15 }).catch(() => null);
    const entry = logs?.entries.find(e => {
      if (targetId && e.target?.id !== targetId) return false;
      return Date.now() - e.createdTimestamp < 15000;
    });
    if (entry) return entry;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return null;
}

async function findChannelDeleteExecutor(guild, channelId) {
  return (await findRecentAuditEntry(guild, AuditLogEvent.ChannelDelete, channelId))?.executor || null;
}

async function findChannelCreateExecutor(guild, channelId) {
  return (await findRecentAuditEntry(guild, AuditLogEvent.ChannelCreate, channelId))?.executor || null;
}

async function findChannelUpdateExecutor(guild, channelId) {
  return (await findRecentAuditEntry(guild, AuditLogEvent.ChannelUpdate, channelId))?.executor || null;
}

async function restoreDeletedChannel(guild, snap) {
  if (!snap) return null;

  const key = `${guild.id}:${snap.id}`;
  if (restoreLocks.has(key)) return null;

  const cachedId = restoredChannelCache.get(key);
  if (cachedId) {
    const cached = guild.channels.cache.get(cachedId);
    if (cached) return cached;
    restoredChannelCache.delete(key);
  }

  // Never restore temporary ticket channels.
  if (typeof snap.topic === "string" && snap.topic.startsWith("ticket-owner:")) {
    return null;
  }

  // Reuse a matching category instead of creating duplicates.
  if (snap.type === ChannelType.GuildCategory) {
    const existing = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === snap.name
    );
    if (existing) {
      restoredChannelCache.set(key, existing.id);
      await restoreChildrenToCategory(guild, snap.id, existing);
      return existing;
    }
  }

  // Reuse a matching channel instead of creating duplicates.
  const existingChannel = guild.channels.cache.find(
    c => c.type === snap.type &&
      c.name === snap.name &&
      (c.parentId || null) === (snap.parentId || null)
  );
  if (existingChannel) {
    restoredChannelCache.set(key, existingChannel.id);
    return existingChannel;
  }

  restoreLocks.add(key);
  try {
    let parent = snap.parentId ? guild.channels.cache.get(snap.parentId) : null;
    if (snap.parentId && !parent) {
      const parentSnap = get(guild.id).antiNuke.snapshots?.[snap.parentId];
      if (parentSnap) parent = await restoreDeletedChannel(guild, parentSnap);
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
      permissionOverwrites: snap.permissionOverwrites?.map(x => ({
        id: x.id,
        allow: BigInt(x.allow),
        deny: BigInt(x.deny),
        type: x.type
      }))
    };

    const recreated = await guild.channels.create(options);
    restoredChannelCache.set(key, recreated.id);

    if (Number.isFinite(snap.position)) {
      await recreated.setPosition(snap.position).catch(() => {});
    }

    if (snap.type === ChannelType.GuildCategory) {
      await restoreChildrenToCategory(guild, snap.id, recreated);
    }

    return recreated;
  } catch (err) {
    console.error(`Anti-nuke restore failed for ${snap.name}:`, err);
    return null;
  } finally {
    restoreLocks.delete(key);
  }
}

async function ensureAntiNukeLogsChannel(guild) {
  const cfg = get(guild.id).antiNuke || {};

  // Reuse the configured Logs channel if it still exists.
  if (cfg.logsChannelId) {
    const existing = guild.channels.cache.get(cfg.logsChannelId);
    if (existing?.isTextBased()) return existing;
  }

  // Reuse a channel named exactly "Logs" before creating another one.
  const existingByName = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.name.toLowerCase() === "logs"
  );
  if (existingByName) {
    update(guild.id, {
      antiNuke: { ...cfg, logsChannelId: existingByName.id }
    });
    return existingByName;
  }

  try {
    const channel = await guild.channels.create({
      name: "Logs",
      type: ChannelType.GuildText,
      reason: "Anti-nuke incident log"
    });

    update(guild.id, {
      antiNuke: { ...cfg, logsChannelId: channel.id }
    });

    return channel;
  } catch (err) {
    console.error("Anti-nuke could not create Logs channel:", err.message);
    return null;
  }
}

async function antiNukeLog(guild, text) {
  const cfg = get(guild.id).antiNuke || {};
  if (!cfg?.enabled) return;

  const channels = [];
  const logs = await ensureAntiNukeLogsChannel(guild);
  if (logs?.isTextBased()) channels.push(logs);

  if (cfg.logChannelId && cfg.logChannelId !== logs?.id) {
    const configured = guild.channels.cache.get(cfg.logChannelId);
    if (configured?.isTextBased()) channels.push(configured);
  }

  const embed = new EmbedBuilder()
    .setTitle("🚨 Anti-Nuke Logs")
    .setDescription(text)
    .setColor(0xed4245)
    .setTimestamp();

  for (const channel of channels) {
    await channel.send({ embeds: [embed] }).catch(() => {});
  }
}

async function antiNukeIncidentStarted(guild, executor) {
  const key = `${guild.id}:${executor?.id || "unknown"}`;
  if (!antiNukeIncidentState.has(key)) {
    antiNukeIncidentState.set(key, {
      startedAt: Date.now(),
      created: 0,
      deleted: 0,
      restored: 0,
      removed: 0
    });
    await antiNukeLog(
      guild,
      `🛡️ **Protection activated**\n**Executor:** ${executor?.tag || executor?.id || "Unknown"}\nUnauthorized destructive activity is being contained.`
    );
  }
  return antiNukeIncidentState.get(key);
}

async function antiNukeIncidentSummary(guild, executor) {
  const key = `${guild.id}:${executor?.id || "unknown"}`;
  const state = antiNukeIncidentState.get(key);
  if (!state) return;

  await antiNukeLog(
    guild,
    `✅ **Recovery pass completed**\n**Executor:** ${executor?.tag || executor?.id || "Unknown"}\n` +
    `**Unauthorized created:** ${state.created}\n` +
    `**Unauthorized deleted:** ${state.deleted}\n` +
    `**Channels removed:** ${state.removed}\n` +
    `**Channels restored:** ${state.restored}\n` +
    `**Logs:** <#${get(guild.id).antiNuke.logsChannelId}>`
  );
}

function isAntiNukeExemptExecutor(guild, executor) {
  if (!executor) return false;

  // The server owner is trusted.
  if (executor.id === guild.ownerId) return true;

  // Only THIS bot is trusted. Other bots are never trusted merely because
  // they have Administrator.
  if (client.user && executor.id === client.user.id) return true;

  // A bot with Administrator is STILL untrusted.
  if (executor.bot) return false;

  return false;
}

function isBuilderBotTemporarilyTrusted(guild, executor) {
  if (!guild || !executor?.bot) return false;

  const builderBots = get(guild.id).antiNuke?.builderBots || {};
  const expiresAt = Number(builderBots[executor.id] || 0);

  if (!expiresAt) return false;

  if (Date.now() >= expiresAt) {
    const antiNuke = get(guild.id).antiNuke;
    const next = { ...(antiNuke.builderBots || {}) };
    delete next[executor.id];
    update(guild.id, {
      antiNuke: { ...antiNuke, builderBots: next }
    });
    return false;
  }

  return true;
}

async function isAntiNukeExemptMember(guild, executor) {
  if (!executor) return false;
  if (isAntiNukeExemptExecutor(guild, executor)) return true;

  // Explicit temporary server-builder mode is the ONLY extra bot exemption.
  if (isBuilderBotTemporarilyTrusted(guild, executor)) return true;

  // Other bots are always untrusted, even with Administrator or an Owner role.
  if (executor.bot) return false;

  const member = await guild.members.fetch(executor.id).catch(() => null);
  if (!member) return false;

  // Human Administrator is trusted.
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  // Human with a role named Owner is trusted.
  if (member.roles.cache.some(role => role.name.trim().toLowerCase() === "owner")) return true;

  return false;
}

const antiNukeStrikes = new Map();

async function punishUnauthorizedBot(guild, executor, reason) {
  if (!executor?.bot) return;
  if (!client.user || executor.id === client.user.id) return;
  if (executor.id === guild.ownerId) return;

  const member = await guild.members.fetch(executor.id).catch(() => null);
  if (!member) return;

  // Try to remove a hostile bot after the first confirmed destructive action.
  // Discord role hierarchy can still prevent the kick.
  if (member.kickable) {
    await member.kick(`Anti-nuke: unauthorized bot activity - ${reason}`).catch(err => {
      console.error(`Anti-nuke could not kick ${executor.tag || executor.id}:`, err.message);
    });
    return;
  }

  await antiNukeLog(
    guild,
    `⚠️ Detected unauthorized bot **${executor.tag || executor.id}**, but I could not kick it because of role hierarchy.\n**Reason:** ${reason}`
  );
}

async function deleteUnauthorizedChannel(channel, executor) {
  if (!channel?.deletable) return false;
  try {
    await channel.delete("Anti-nuke: unauthorized channel creation by untrusted bot/member");
    return true;
  } catch (err) {
    console.error(`Anti-nuke could not delete #${channel.name}:`, err.message);
    return false;
  }
}

async function processUnauthorizedChannelCreate(channel, executor) {
  const guild = channel.guild;
  if (!guild || !executor) return;

  const cfg = get(guild.id).antiNuke;
  if (!cfg?.enabled) return;

  if (await isAntiNukeExemptMember(guild, executor)) return;

  const key = `${guild.id}:${channel.id}`;
  if (antiNukeAuditLocks.has(key)) return;
  antiNukeAuditLocks.add(key);

  try {
    const state = await antiNukeIncidentStarted(guild, executor);
    state.created += 1;

    const deleted = await deleteUnauthorizedChannel(channel, executor);
    if (deleted) state.removed += 1;

    await antiNukeLog(
      guild,
      `🚨 **Unauthorized channel creation**\n` +
      `**Channel:** #${channel.name}\n` +
      `**Executor:** ${executor.tag || executor.id}\n` +
      `**Type:** ${channel.type === ChannelType.GuildCategory ? "Category" : "Channel"}\n` +
      `**Action:** ${deleted ? "Removed" : "FAILED to remove"}`
    );

    // Any other bot is hostile even when it has Administrator.
    if (executor.bot) {
      await punishUnauthorizedBot(guild, executor, "unauthorized channel/category creation");
    }

    // Give Discord a moment to finish the audit-log batch, then write a summary.
    setTimeout(() => antiNukeIncidentSummary(guild, executor).catch(() => {}), 3000);
  } finally {
    antiNukeAuditLocks.delete(key);
  }
}

async function handleAntiNukeChannelCreate(channel) {
  const guild = channel.guild;
  if (!guild) return;

  const cfg = get(guild.id).antiNuke;
  if (!cfg?.enabled) return;

  // Audit logs can lag behind ChannelCreate. Retry after the event instead of
  // giving up permanently; this is what prevents mass-create nukes from
  // getting partially through.
  const delays = [250, 750, 1500, 3000, 5000];
  for (const delay of delays) {
    await new Promise(resolve => setTimeout(resolve, delay));
    if (!guild.channels.cache.has(channel.id)) return;

    const executor = await findChannelCreateExecutor(guild, channel.id);
    if (!executor) continue;

    await processUnauthorizedChannelCreate(channel, executor);
    return;
  }

  await antiNukeLog(
    guild,
    `⚠️ **Audit-log lookup timed out** for newly created **#${channel.name}**. No automatic deletion was attempted because the executor could not be verified.`
  );
}

async function sweepRecentUnauthorizedCreates(guild) {
  const cfg = get(guild.id).antiNuke;
  if (!cfg?.enabled) return;

  const logs = await guild.fetchAuditLogs({
    type: AuditLogEvent.ChannelCreate,
    limit: 100
  }).catch(() => null);

  if (!logs) return;

  for (const entry of logs.entries.values()) {
    if (Date.now() - entry.createdTimestamp > 15000) continue;
    const executor = entry.executor;
    const targetId = entry.target?.id;
    if (!executor || !targetId) continue;
    if (await isAntiNukeExemptMember(guild, executor)) continue;

    const channel = guild.channels.cache.get(targetId);
    if (!channel) continue;

    await processUnauthorizedChannelCreate(channel, executor);
  }
}

async function handleAntiNukeChannelDelete(channel) {
  const guild = channel.guild;
  if (!guild) return;

  const cfg = get(guild.id).antiNuke;
  if (!cfg?.enabled) return;

  // Temporary ticket channels must never be resurrected.
  if (typeof channel.topic === "string" && channel.topic.startsWith("ticket-owner:")) {
    return;
  }

  const snap = cfg.snapshots?.[channel.id];
  if (!snap) return;

  const executor = await findChannelDeleteExecutor(guild, channel.id);

  // Never blindly restore when Discord has not identified the executor.
  if (!executor) return;

  // Owner, human Administrator, human Owner-role and our bot are trusted.
  // Another bot with Administrator is NOT trusted.
  if (await isAntiNukeExemptMember(guild, executor)) {
    return;
  }

  const recreated = await restoreDeletedChannel(guild, snap).catch(() => null);

  await antiNukeLog(
    guild,
    recreated
      ? `🚨 Unauthorized deletion detected. Restored **#${snap.name}**.\n**Executor:** ${executor.tag || executor.id}`
      : `⚠️ Unauthorized deletion detected, but restoration of **#${snap.name}** failed.\n**Executor:** ${executor.tag || executor.id}`
  );

  if (executor.bot) {
    await punishUnauthorizedBot(guild, executor, "unauthorized channel/category deletion");
  }
}

async function handleAntiNukeChannelUpdate(oldChannel, newChannel) {
  const guild = newChannel.guild;
  if (!guild) return;

  const cfg = get(guild.id).antiNuke;
  if (!cfg?.enabled) return;

  // Temporary tickets are intentionally allowed to change/delete normally.
  if (typeof newChannel.topic === "string" && newChannel.topic.startsWith("ticket-owner:")) {
    return;
  }

  const snap = cfg.snapshots?.[newChannel.id];
  if (!snap) return;

  const changed =
    oldChannel.name !== newChannel.name ||
    (oldChannel.parentId || null) !== (newChannel.parentId || null) ||
    (oldChannel.rawPosition ?? 0) !== (newChannel.rawPosition ?? 0);

  if (!changed) return;

  const executor = await findChannelUpdateExecutor(guild, newChannel.id);
  if (!executor) return;
  if (await isAntiNukeExemptMember(guild, executor)) return;

  const target = guild.channels.cache.get(newChannel.id);
  if (!target) return;

  // Restore the original category and name. Position restoration is best effort.
  if (target.name !== snap.name) {
    await target.setName(snap.name, "Anti-nuke: restore protected channel name").catch(() => {});
  }

  const parent = snap.parentId
    ? guild.channels.cache.get(snap.parentId)
    : null;

  if ((target.parentId || null) !== (snap.parentId || null)) {
    await target.setParent(parent?.id || null, { lockPermissions: false }).catch(() => {});
  }

  if (Number.isFinite(snap.position)) {
    await target.setPosition(snap.position).catch(() => {});
  }

  await antiNukeLog(
    guild,
    `🚨 Unauthorized channel change reverted on **#${snap.name}**.\n**Executor:** ${executor.tag || executor.id}`
  );

  if (executor.bot) {
    await punishUnauthorizedBot(guild, executor, "unauthorized channel modification");
  }
}

function parseSnapshotInterval(value) {
  const match = String(value || "").trim().toLowerCase().match(/^(\d+)(s|m)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) return null;
  const ms = match[2] === "s" ? amount * 1000 : amount * 60 * 1000;
  if (ms < 5000 || ms > 7 * 24 * 60 * 60 * 1000) return null;
  return ms;
}
function formatSnapshotInterval(ms) {
  if (!ms) return "OFF";
  return ms % 60000 === 0 ? `${ms / 60000}m` : `${ms / 1000}s`;
}
function startAutoSnapshot(guild) {
  const ms = Number(get(guild.id).antiNuke.autoSnapshotIntervalMs);
  if (!Number.isFinite(ms) || ms <= 0) return;
  stopAutoSnapshot(guild.id);
  const timer = setInterval(async () => {
    if (!get(guild.id).antiNuke.enabled) return;
    const count = await snapshotGuildChannels(guild).catch(() => 0);
    if (count) console.log(`💾 Auto-snapshot saved ${count} channels for ${guild.name}.`);
  }, ms);
  autoSnapshotTimers.set(guild.id, timer);
}
function stopAutoSnapshot(guildId) {
  const timer = autoSnapshotTimers.get(guildId);
  if (timer) clearInterval(timer);
  autoSnapshotTimers.delete(guildId);
}

async function handleAntiNukeGuildUpdate(oldGuild, newGuild) {
  if (!oldGuild || !newGuild) return;

  const cfg = get(newGuild.id).antiNuke;
  if (!cfg?.enabled) return;

  const nameChanged = oldGuild.name !== newGuild.name;
  const iconChanged = oldGuild.icon !== newGuild.icon;
  if (!nameChanged && !iconChanged) return;

  const entry = await findRecentAuditEntry(newGuild, AuditLogEvent.GuildUpdate, newGuild.id);
  const executor = entry?.executor || null;
  if (!executor) return;

  // Human owner/admin/Owner-role and our bot are allowed.
  // Other bots are NOT allowed even if they have Administrator.
  if (await isAntiNukeExemptMember(newGuild, executor)) return;

  const actions = [];

  if (nameChanged && cfg.serverName && cfg.serverName !== newGuild.name) {
    const currentName = newGuild.name;
    await newGuild.setName(cfg.serverName, "Anti-nuke: restore protected server name").catch(() => {});
    if (newGuild.name === cfg.serverName || currentName !== cfg.serverName) {
      actions.push(`server name restored to **${cfg.serverName}**`);
    }
  }

  if (iconChanged && cfg.iconURL) {
    const restored = await restoreServerIcon(newGuild, cfg.iconURL);
    if (restored) actions.push("server icon restored");
  }

  if (actions.length) {
    await antiNukeLog(
      newGuild,
      `🚨 Unauthorized server-setting change by **${executor.tag || executor.id}**.\n♻️ ${actions.join(" and ")}.`
    );
  }

  if (executor.bot) {
    await punishUnauthorizedBot(newGuild, executor, "unauthorized server settings change");
  }
}

async function handleJoin(member) {
  const cfg = get(member.guild.id).antiRaid;
  if (cfg.enabled) {
    const now = Date.now();
    const arr = (joinWindows.get(member.guild.id) || []).filter(t => now - t <= cfg.windowSeconds * 1000);
    arr.push(now); joinWindows.set(member.guild.id, arr);
    if (arr.length >= cfg.threshold) {
      const ids = raidMembers.get(member.guild.id) || new Set(); ids.add(member.id); raidMembers.set(member.guild.id, ids);
      const logCh = cfg.logChannelId ? member.guild.channels.cache.get(cfg.logChannelId) : null;
      if (logCh?.isTextBased()) await logCh.send({ embeds: [new EmbedBuilder().setTitle("🛡️ Anti-Raid").setDescription(`Raid threshold reached: **${arr.length}** joins in **${cfg.windowSeconds}s**.`)] }).catch(() => {});
      if (cfg.banOnRaid) {
        for (const id of ids) {
          const target = member.guild.members.cache.get(id); if (!target) continue;
          const ageHours = (Date.now() - target.user.createdTimestamp) / 3600000;
          if (cfg.accountAgeHours > 0 && ageHours > cfg.accountAgeHours) continue;
          if (target.bannable) await target.ban({ reason: "Anti-raid: flagged account during raid incident" }).catch(() => {});
        }
      }
    }
  }
  const general = get(member.guild.id);
  if (general.autoRoleId) {
    const role = member.guild.roles.cache.get(general.autoRoleId);
    if (role && role.position < member.guild.members.me.roles.highest.position) await member.roles.add(role).catch(() => {});
  }
  if (general.welcomeChannelId) {
    const ch = member.guild.channels.cache.get(general.welcomeChannelId);
    if (ch?.isTextBased()) await ch.send({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle("Welcome!").setDescription(formatMessage(general.welcomeMessage, member)).setThumbnail(member.user.displayAvatarURL()).setTimestamp()] }).catch(() => {});
  }
}

async function runSetup(i) {
  if (!isAdmin(i.member)) return respond(i, { content: "Administrator permission is required.", flags: MessageFlags.Ephemeral });
  const guild = i.guild;
  const findText = name => guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === name);
  const findCategory = name => guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name);
  let category = findCategory("Tickets");
  if (!category) category = await guild.channels.create({ name: "Tickets", type: ChannelType.GuildCategory });
  const names = ["welcome", "goodbye", "mod-log", "suggestions"];
  const channels = {};
  for (const name of names) channels[name] = findText(name) || await guild.channels.create({ name, type: ChannelType.GuildText });
  let role = guild.roles.cache.find(r => r.name === "Support Team");
  if (!role) role = await guild.roles.create({ name: "Support Team", reason: "HVH Central setup" });
  update(guild.id, {
    welcomeChannelId: channels.welcome.id, goodbyeChannelId: channels.goodbye.id,
    modlogChannelId: channels["mod-log"].id, ticketCategoryId: category.id,
    supportRoleId: role.id, suggestionsChannelId: channels.suggestions.id,
    welcomeMessage: "Welcome {user} to **{server}**!", goodbyeMessage: "Goodbye {username}, thanks for being part of **{server}**."
  });
  return i.editReply({ content: "✅ Setup complete! Created/located **Tickets**, **#welcome**, **#goodbye**, **#mod-log**, **#suggestions**, and **@Support Team**.\n\nNext: use **/ticket** in the channel where you want the ticket panel." });
}
async function handleConfig(i) {
  const sub = i.options.getSubcommand();
  if (sub === "show") {
    const c = get(i.guildId);
    return respond(i, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Server configuration").setDescription(
      `**Welcome:** ${c.welcomeChannelId ? `<#${c.welcomeChannelId}>` : "Off"}\n**Goodbye:** ${c.goodbyeChannelId ? `<#${c.goodbyeChannelId}>` : "Off"}\n**Mod log:** ${c.modlogChannelId ? `<#${c.modlogChannelId}>` : "Off"}\n**Auto role:** ${c.autoRoleId ? `<@&${c.autoRoleId}>` : "Off"}\n**Tickets:** ${c.ticketCategoryId ? `<#${c.ticketCategoryId}>` : "Off"}\n**Support role:** ${c.supportRoleId ? `<@&${c.supportRoleId}>` : "Off"}\n**Suggestions:** ${c.suggestionsChannelId ? `<#${c.suggestionsChannelId}>` : "Off"}`)], flags: MessageFlags.Ephemeral });
  }
  const patch = {};
  if (sub === "welcome") { patch.welcomeChannelId = i.options.getChannel("channel").id; patch.welcomeMessage = i.options.getString("message") || "Welcome {user} to **{server}**!"; }
  if (sub === "goodbye") { patch.goodbyeChannelId = i.options.getChannel("channel").id; patch.goodbyeMessage = i.options.getString("message") || "Goodbye {username}, thanks for being part of **{server}**."; }
  if (sub === "modlog") patch.modlogChannelId = i.options.getChannel("channel").id;
  if (sub === "autorole") patch.autoRoleId = i.options.getRole("role").id;
  if (sub === "tickets") { patch.ticketCategoryId = i.options.getChannel("category").id; patch.supportRoleId = i.options.getRole("support_role")?.id || null; }
  if (sub === "suggestions") patch.suggestionsChannelId = i.options.getChannel("channel").id;
  update(i.guildId, patch);
  return respond(i, { embeds: [okEmbed("Configuration updated", `The **${sub}** setting has been saved.`)], flags: MessageFlags.Ephemeral });
}
async function postTicketPanel(i) {
  const cfg = get(i.guildId);
  if (!cfg.ticketCategoryId) return respond(i, { embeds: [errorEmbed("Configure tickets first with `/config tickets` or run `/setup`.")], flags: MessageFlags.Ephemeral });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("ticket:create").setLabel("Create Ticket").setEmoji("🎫").setStyle(ButtonStyle.Primary));
  await i.channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Support Tickets").setDescription("Need help? Click **Create Ticket** below. A private channel will be created for you.")], components: [row] });
  return respond(i, { content: "Ticket panel posted.", flags: MessageFlags.Ephemeral });
}
async function createTicket(i) {
  const cfg = get(i.guildId);
  const existing = i.guild.channels.cache.find(c => c.topic === `ticket-owner:${i.user.id}`);
  if (existing) return respond(i, { content: `You already have an open ticket: ${existing}`, flags: MessageFlags.Ephemeral });
  const category = i.guild.channels.cache.get(cfg.ticketCategoryId);
  if (!category) return respond(i, { embeds: [errorEmbed("The configured ticket category no longer exists.")], flags: MessageFlags.Ephemeral });
  const me = i.guild.members.me;
  const overwrites = [
    { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] }
  ];
  if (cfg.supportRoleId) overwrites.push({ id: cfg.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  const channel = await i.guild.channels.create({ name: `ticket-${cleanChannelName(i.user.username)}`, type: ChannelType.GuildText, parent: category.id, topic: `ticket-owner:${i.user.id}`, permissionOverwrites: overwrites });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket:claim").setLabel("Claim").setEmoji("🙋").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket:close").setLabel("Close").setEmoji("🔒").setStyle(ButtonStyle.Danger)
  );
  await channel.send({ content: `${i.user}${cfg.supportRoleId ? ` <@&${cfg.supportRoleId}>` : ""}`, embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Ticket Opened").setDescription("Explain your issue clearly. A staff member will help you here.")], components: [row] });
  await respond(i, { content: `Your ticket is ready: ${channel}`, flags: MessageFlags.Ephemeral });
  await sendLog(i.guild, logEmbed("Ticket created", `${i.user} created ${channel}`));
}
async function closeTicket(i) {
  if (!i.channel.topic?.startsWith("ticket-owner:")) return respond(i, { content: "This is not a ticket channel.", flags: MessageFlags.Ephemeral });
  if (!i.member.permissions.has(PermissionFlagsBits.ManageChannels) && i.channel.topic !== `ticket-owner:${i.user.id}`) return respond(i, { content: "Only the ticket owner or staff can close this ticket.", flags: MessageFlags.Ephemeral });
  await respond(i, { embeds: [okEmbed("Ticket closing", "This channel will be deleted in 5 seconds.")] });
  await sendLog(i.guild, logEmbed("Ticket closed", `${i.user} closed ${i.channel.name}`));
  setTimeout(() => i.channel.delete().catch(() => {}), 5000);
}
async function submitSuggestion(i) {
  const cfg = get(i.guildId);
  const channel = cfg.suggestionsChannelId ? i.guild.channels.cache.get(cfg.suggestionsChannelId) : null;
  if (!channel?.isTextBased()) return respond(i, { embeds: [errorEmbed("Suggestions are not configured. Ask an administrator to use `/config suggestions`.")], flags: MessageFlags.Ephemeral });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("suggest:approve").setLabel("Approve").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId("suggest:deny").setLabel("Deny").setStyle(ButtonStyle.Danger));
  await channel.send({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle("New Suggestion").setDescription(i.options.getString("text")).addFields({ name: "Submitted by", value: `${i.user}` }).setTimestamp()], components: [row] });
  return respond(i, { embeds: [okEmbed("Suggestion submitted", "Your suggestion was sent to the configured suggestions channel.")], flags: MessageFlags.Ephemeral });
}
async function moderation(i) {
  const action = i.commandName;
  const reason = i.options.getString("reason") || "No reason provided";
  if (action === "purge") {
    const deleted = await i.channel.bulkDelete(i.options.getInteger("amount"), true);
    return respond(i, { embeds: [okEmbed("Messages deleted", `Deleted **${deleted.size}** messages.`)], flags: MessageFlags.Ephemeral });
  }
  if (action === "unban") {
    const id = i.options.getString("user_id");
    await i.guild.members.unban(id, reason);
    await sendLog(i.guild, logEmbed("Member unbanned", `**User ID:** ${id}\n**Moderator:** ${i.user}\n**Reason:** ${reason}`, 0x57f287));
    return respond(i, { embeds: [okEmbed("User unbanned", `**${id}** has been unbanned.`)] });
  }
  const member = await i.guild.members.fetch(i.options.getUser("user").id).catch(() => null);
  if (!member) return respond(i, { embeds: [errorEmbed("That member could not be found.")], flags: MessageFlags.Ephemeral });
  if (!canManageTarget(i, member)) return respond(i, { embeds: [errorEmbed("You cannot moderate that member due to role hierarchy or ownership rules.")], flags: MessageFlags.Ephemeral });
  if (action === "warn") await sendLog(i.guild, logEmbed("Member warned", `**Member:** ${member}\n**Moderator:** ${i.user}\n**Reason:** ${reason}`, 0xfee75c));
  if (action === "timeout") await member.timeout(i.options.getInteger("minutes") * 60000, reason);
  if (action === "kick") await member.kick(reason);
  if (action === "ban") await member.ban({ reason, deleteMessageSeconds: 0 });
  if (action !== "warn") await sendLog(i.guild, logEmbed(`Member ${action}ed`, `**Member:** ${member.user.tag}\n**Moderator:** ${i.user}\n**Reason:** ${reason}`, action === "ban" ? 0xed4245 : 0x5865f2));
  return respond(i, { embeds: [okEmbed(action === "warn" ? "Warning issued" : `Member ${action}ed`, `${member.user.tag} was ${action === "warn" ? "warned" : `${action}ed`}.\n**Reason:** ${reason}`)] });
}

client.once(Events.ClientReady, async c => {
  console.log(`Logged in as ${c.user.tag}`);
  c.user.setPresence({ activities: [{ name: "Securing HVH Central", type: 3 }], status: "online" });
  for (const guild of c.guilds.cache.values()) {
    const cfg = get(guild.id);
    if (cfg.antiNuke.enabled) await snapshotGuildChannels(guild).catch(() => {});
    if (cfg.antiNuke.autoSnapshotIntervalMs) startAutoSnapshot(guild);
  }
});
client.on(Events.GuildMemberAdd, handleJoin);
client.on(Events.GuildMemberRemove, async member => {
  const cfg = get(member.guild.id); const ch = cfg.goodbyeChannelId ? member.guild.channels.cache.get(cfg.goodbyeChannelId) : null;
  if (ch?.isTextBased()) await ch.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("Goodbye").setDescription(formatMessage(cfg.goodbyeMessage, member)).setTimestamp()] }).catch(() => {});
});
client.on(Events.GuildBanAdd, async ban => sendLog(ban.guild, logEmbed("Member banned", `**User:** ${ban.user.tag} (${ban.user.id})`, 0xed4245)));
client.on(Events.GuildBanRemove, async ban => sendLog(ban.guild, logEmbed("Member unbanned", `**User:** ${ban.user.tag} (${ban.user.id})`, 0x57f287)));
client.on(Events.ChannelDelete, handleAntiNukeChannelDelete);
client.on(Events.ChannelCreate, handleAntiNukeChannelCreate);
client.on(Events.ChannelUpdate, handleAntiNukeChannelUpdate);
client.on(Events.GuildUpdate, handleAntiNukeGuildUpdate);

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === "ticket:create") return createTicket(interaction);
      if (interaction.customId === "ticket:close") return closeTicket(interaction);
      if (interaction.customId === "ticket:claim") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) return respond(interaction, { content: "You need Manage Channels to claim tickets.", flags: MessageFlags.Ephemeral });
        return respond(interaction, { embeds: [okEmbed("Ticket claimed", `This ticket has been claimed by ${interaction.user}.`)] });
      }
      if (interaction.customId.startsWith("suggest:")) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) return respond(interaction, { content: "You need Manage Messages to review suggestions.", flags: MessageFlags.Ephemeral });
        const approved = interaction.customId.endsWith("approve");
        const embed = interaction.message.embeds[0] ? EmbedBuilder.from(interaction.message.embeds[0]).setColor(approved ? 0x57f287 : 0xed4245).addFields({ name: "Decision", value: `${approved ? "Approved" : "Denied"} by ${interaction.user}` }) : null;
        const disabled = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("suggest:done").setLabel(approved ? "Approved" : "Denied").setStyle(approved ? ButtonStyle.Success : ButtonStyle.Danger).setDisabled(true));
        return interaction.update({ embeds: embed ? [embed] : interaction.message.embeds, components: [disabled] });
      }
      if (interaction.customId.startsWith("panel_")) {
        if (!isAdmin(interaction.member)) return respond(interaction, { content: "Administrator permission required.", flags: MessageFlags.Ephemeral });
        const modal = new ModalBuilder().setCustomId(`panel_auth:${interaction.customId}`).setTitle("HVH Central — Panel Access");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("password").setLabel("Panel password").setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
      }
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("panel_auth:")) {
      if (!isAdmin(interaction.member)) return respond(interaction, { content: "Administrator permission required.", flags: MessageFlags.Ephemeral });
      const cfg = get(interaction.guildId).adminPanel;
      const password = interaction.fields.getTextInputValue("password");
      if (!cfg.passwordHash || !verifyPassword(password, cfg.passwordHash)) return respond(interaction, { content: "❌ Incorrect panel password.", flags: MessageFlags.Ephemeral });
      const action = interaction.customId.split(":")[1];
      if (action === "panel_antiraid") { const a = get(interaction.guildId).antiRaid; return respond(interaction, { content: `🛡️ Anti-raid: ${a.enabled ? "ON" : "OFF"} | threshold ${a.threshold}/${a.windowSeconds}s | ban ${a.banOnRaid ? "ON" : "OFF"}`, flags: MessageFlags.Ephemeral }); }
      if (action === "panel_nuke") { const n = get(interaction.guildId).antiNuke; return respond(interaction, { content: `💥 Anti-nuke: ${n.enabled ? "ON" : "OFF"} | snapshots: ${Object.keys(n.snapshots || {}).length} | log: ${n.logChannelId ? `<#${n.logChannelId}>` : "not set"}`, flags: MessageFlags.Ephemeral }); }
      if (action === "panel_help") return respond(interaction, { content: "Use `/help` to see all commands. `/nuketest` is a safe anti-nuke dry-run and never deletes channels.", flags: MessageFlags.Ephemeral });
      return respond(interaction, { content: `🔐 Password accepted for **${action.replace("panel_", "")}**. Use the corresponding slash command for target/options.`, flags: MessageFlags.Ephemeral });
    }
    if (!interaction.isChatInputCommand()) return;
    const name = interaction.commandName;
    const deferred = new Set(["setup", "config", "ticket", "suggest", "warn", "timeout", "kick", "ban", "unban", "purge", "adminpanel", "antinuke", "nuketest", "autosavesnapshot"]);
    if (deferred.has(name)) await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (name === "help") return respond(interaction, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("HVH Central Commands").setDescription("Full server management, moderation, tickets, suggestions and security tools.").addFields(
      { name: "🛠️ Setup", value: "`/setup` • `/config` • `/ticket`", inline: false },
      { name: "🛡️ Moderation", value: "`/warn` • `/timeout` • `/kick` • `/ban` • `/unban` • `/purge`", inline: false },
      { name: "👋 Server", value: "`/serverinfo` • `/userinfo` • `/ping`", inline: false },
      { name: "💡 Community", value: "`/suggest`", inline: false },
      { name: "🚨 Security", value: "`/adminpanel` • `/antinuke` • `/antinukebuilder` • `/nuketest` • `/autosavesnapshot` • `/antiraid setup|status|test`", inline: false }
    )], flags: MessageFlags.Ephemeral });
    if (name === "ping") return respond(interaction, { content: `🏓 ${Math.round(client.ws.ping)}ms`, flags: MessageFlags.Ephemeral });
    if (name === "serverinfo") { const g = interaction.guild; return respond(interaction, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(g.name).setThumbnail(g.iconURL()).addFields({ name: "Owner", value: `<@${g.ownerId}>`, inline: true }, { name: "Members", value: `${g.memberCount}`, inline: true }, { name: "Channels", value: `${g.channels.cache.size}`, inline: true }, { name: "Roles", value: `${g.roles.cache.size}`, inline: true }, { name: "Created", value: `<t:${Math.floor(g.createdTimestamp / 1000)}:D>`, inline: true })] }); }
    if (name === "userinfo") { const u = interaction.options.getUser("user") || interaction.user; const m = await interaction.guild.members.fetch(u.id).catch(() => null); return respond(interaction, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(u.tag).setThumbnail(u.displayAvatarURL()).addFields({ name: "User ID", value: u.id, inline: true }, { name: "Joined", value: m ? `<t:${Math.floor(m.joinedTimestamp / 1000)}:R>` : "Not in server", inline: true }, { name: "Account", value: `<t:${Math.floor(u.createdTimestamp / 1000)}:R>`, inline: true })] }); }
    if (name === "setup") return runSetup(interaction);
    if (name === "config") return handleConfig(interaction);
    if (name === "ticket") return postTicketPanel(interaction);
    if (name === "suggest") return submitSuggestion(interaction);
    if (["warn", "timeout", "kick", "ban", "unban", "purge"].includes(name)) return moderation(interaction);

    if (name === "adminpanel") {
      if (!isAdmin(interaction.member)) return respond(interaction, { content: "Administrator permission required.", flags: MessageFlags.Ephemeral });
      const channel = interaction.options.getChannel("channel"); const password = interaction.options.getString("password");
      update(interaction.guildId, { adminPanel: { channelId: channel.id, passwordHash: hashPassword(password) } });
      await makePanel(channel); return respond(interaction, "✅ Admin panel created. The password is stored as a secure hash.");
    }
    if (name === "antinukebuilder") {
      if (!isAdmin(interaction.member)) return respond(interaction, { content: "Administrator permission required.", flags: MessageFlags.Ephemeral });

      const bot = interaction.options.getUser("bot");
      const enabled = interaction.options.getBoolean("enabled");
      const rawDuration = interaction.options.getString("duration");

      if (!bot?.bot) {
        return respond(interaction, {
          content: "❌ The selected user must be a bot.",
          flags: MessageFlags.Ephemeral
        });
      }

      const antiNuke = get(interaction.guildId).antiNuke;
      const builderBots = { ...(antiNuke.builderBots || {}) };

      if (!enabled) {
        delete builderBots[bot.id];
        update(interaction.guildId, { antiNuke: { ...antiNuke, builderBots } });

        await antiNukeLog(
          interaction.guild,
          `🔒 Builder mode disabled for <@${bot.id}>. Normal anti-nuke protection is active for this bot again.`
        );

        return respond(interaction, `🔒 Builder mode disabled for ${bot}.`);
      }

      const durationMs = parseSnapshotInterval(rawDuration);
      if (!durationMs) {
        return respond(interaction, {
          content: "❌ Invalid duration. Use `10s`, `10m`, etc. Minimum 5 seconds.",
          flags: MessageFlags.Ephemeral
        });
      }

      const expiresAt = Date.now() + durationMs;
      builderBots[bot.id] = expiresAt;

      update(interaction.guildId, { antiNuke: { ...antiNuke, builderBots } });

      await antiNukeLog(
        interaction.guild,
        `🏗️ Builder mode enabled for ${bot} for **${formatSnapshotInterval(durationMs)}**. This bot may create/delete channels without being treated as a nuker.`
      );

      return respond(
        interaction,
        `🏗️ Builder mode enabled for ${bot} for **${formatSnapshotInterval(durationMs)}**.`
      );
    }

    if (name === "antinuke") {
      if (!isAdmin(interaction.member)) return respond(interaction, { content: "Administrator permission required.", flags: MessageFlags.Ephemeral });
      const channel = interaction.options.getChannel("channel"); const old = get(interaction.guildId).antiNuke;
      update(interaction.guildId, { antiNuke: { ...old, enabled: true, logChannelId: channel.id } });
      const count = await snapshotGuildChannels(interaction.guild);
      await antiNukeLog(interaction.guild, `✅ Anti-nuke enabled. **${count}** channels snapshotted for restoration.`);
      return respond(interaction, `🛡️ Anti-nuke enabled. Alerts: ${channel}. Existing channels were snapshotted.`);
    }

    if (name === "nuketest") {
      if (!isAdmin(interaction.member)) return respond(interaction, { content: "Administrator permission required.", flags: MessageFlags.Ephemeral });
      const cfg = get(interaction.guildId).antiNuke; const count = Object.keys(cfg.snapshots || {}).length;
      const me = interaction.guild.members.me;
      const canManageChannels = !!me?.permissions.has(PermissionFlagsBits.ManageChannels);
      return respond(interaction, { embeds: [new EmbedBuilder().setColor(cfg.enabled && count > 0 && canManageChannels ? 0x57f287 : 0xfee75c).setTitle("🧪 Anti-Nuke Test").setDescription("Safe dry-run only. No channel will be deleted, kicked, or modified.").addFields(
        { name: "Anti-nuke enabled", value: cfg.enabled ? "YES" : "NO", inline: true },
        { name: "Saved channel snapshots", value: String(count), inline: true },
        { name: "Manage Channels permission", value: canManageChannels ? "YES" : "NO", inline: true },
        { name: "Simulated result", value: cfg.enabled && count > 0 && canManageChannels ? "A protected channel deletion would be eligible for detection/restoration." : "Protection is not fully ready; enable anti-nuke and ensure snapshots + permissions exist.", inline: false }
      )], flags: MessageFlags.Ephemeral });
    }
    if (name === "autosavesnapshot") {
      if (!isAdmin(interaction.member)) return respond(interaction, { content: "Administrator permission required.", flags: MessageFlags.Ephemeral });
      const raw = interaction.options.getString("time");
      const intervalMs = parseSnapshotInterval(raw);
      if (!intervalMs) return respond(interaction, { content: "❌ Invalid time. Use `10s` or `10m` (minimum 5s).", flags: MessageFlags.Ephemeral });
      const count = await snapshotGuildChannels(interaction.guild);
      const old = get(interaction.guildId).antiNuke;
      update(interaction.guildId, { antiNuke: { ...old, autoSnapshotIntervalMs: intervalMs } });
      startAutoSnapshot(interaction.guild);
      return respond(interaction, { embeds: [new EmbedBuilder().setColor(0x57f287).setTitle("💾 Auto-Snapshot Enabled").setDescription(`Channel snapshots will be saved every **${formatSnapshotInterval(intervalMs)}**.`).addFields(
        { name: "Interval", value: formatSnapshotInterval(intervalMs), inline: true },
        { name: "Saved now", value: `${count} channels`, inline: true },
        { name: "Anti-nuke", value: get(interaction.guildId).antiNuke.enabled ? "Enabled" : "Not enabled", inline: true }
      )], flags: MessageFlags.Ephemeral });
    }
    if (name === "antiraid") {
      const sub = interaction.options.getSubcommand(); const cfg = get(interaction.guildId).antiRaid;
      if (sub === "setup") {
        update(interaction.guildId, { antiRaid: { enabled: interaction.options.getBoolean("enabled"), threshold: interaction.options.getInteger("threshold"), windowSeconds: interaction.options.getInteger("window"), accountAgeHours: interaction.options.getInteger("account_age"), banOnRaid: interaction.options.getBoolean("ban_on_raid"), logChannelId: interaction.options.getChannel("log_channel")?.id || null } });
        return respond(interaction, "✅ Anti-raid settings saved.");
      }
      if (sub === "status") return respond(interaction, { embeds: [new EmbedBuilder().setTitle("🛡️ Anti-Raid Status").addFields({ name: "Enabled", value: String(cfg.enabled), inline: true }, { name: "Threshold", value: `${cfg.threshold} joins`, inline: true }, { name: "Window", value: `${cfg.windowSeconds}s`, inline: true }, { name: "Account age filter", value: `${cfg.accountAgeHours}h`, inline: true }, { name: "Ban on raid", value: String(cfg.banOnRaid), inline: true }, { name: "Log channel", value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : "Not set", inline: true })], flags: MessageFlags.Ephemeral });
      const joins = interaction.options.getInteger("joins") ?? cfg.threshold; const wouldTrigger = cfg.enabled && joins >= cfg.threshold;
      return respond(interaction, { embeds: [new EmbedBuilder().setTitle("🧪 Anti-Raid Dry Run").setDescription(`Simulated **${joins}** joins. No real members are touched.`).addFields({ name: "Would trigger?", value: wouldTrigger ? "YES" : "NO", inline: true }, { name: "Configured threshold", value: String(cfg.threshold), inline: true }, { name: "Configured action", value: cfg.banOnRaid ? "Ban flagged joiners" : "Log only", inline: true })], flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    if (err?.code === 10062 || err?.rawError?.code === 10062) return;
    console.error(err);
    await respond(interaction, { content: "Something went wrong.", flags: MessageFlags.Ephemeral });
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    const cfg = get(guild.id).antiNuke;
    if (cfg?.enabled && cfg.autoSnapshotIntervalMs) {
      startAutoSnapshot(guild);
    }

    // Sweep shortly after startup so recent channel-create events that happened
    // while the bot was reconnecting are not missed.
    if (cfg?.enabled) {
      await sweepRecentUnauthorizedCreates(guild).catch(() => {});
    }
  }

  // Periodic audit-log sweep catches mass channel creation even when Discord
  // delivers the ChannelCreate gateway events faster than the audit log.
  for (const guild of client.guilds.cache.values()) {
    if (antiNukeSweepTimers.has(guild.id)) continue;
    const timer = setInterval(() => {
      if (get(guild.id).antiNuke?.enabled) {
        sweepRecentUnauthorizedCreates(guild).catch(() => {});
      }
    }, 3000);
    antiNukeSweepTimers.set(guild.id, timer);
  }
});

process.on("unhandledRejection", e => console.error("Unhandled promise rejection:", e));
process.on("uncaughtException", e => console.error("Uncaught exception:", e));

(async () => {
  try { await registerCommands(); await client.login(process.env.DISCORD_TOKEN); }
  catch (err) { console.error("❌ Startup failed:", err); process.exit(1); }
})();
