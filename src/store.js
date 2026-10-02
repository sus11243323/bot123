const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "data", "guilds.json");
let db = {};
try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch { db = {}; }

function defaults() {
  return {
    adminPanel: { channelId: null, passwordHash: null },
    antiNuke: { logChannelId: null, enabled: false, snapshots: {}, autoSnapshotIntervalMs: null },
    antiRaid: {
      enabled: false,
      threshold: 5,
      windowSeconds: 10,
      accountAgeHours: 24,
      banOnRaid: true,
      logChannelId: null
    },
    welcomeChannelId: null,
    welcomeMessage: "Welcome {user} to **{server}**!",
    goodbyeChannelId: null,
    goodbyeMessage: "Goodbye {username}, thanks for being part of **{server}**.",
    modlogChannelId: null,
    autoRoleId: null,
    ticketCategoryId: null,
    supportRoleId: null,
    suggestionsChannelId: null
  };
}

function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
}

function get(guildId) {
  if (!db[guildId]) {
    db[guildId] = defaults();
    save();
  } else {
    const d = defaults();
    db[guildId] = {
      ...d,
      ...db[guildId],
      adminPanel: { ...d.adminPanel, ...(db[guildId].adminPanel || {}) },
      antiNuke: { ...d.antiNuke, ...(db[guildId].antiNuke || {}) },
      antiRaid: { ...d.antiRaid, ...(db[guildId].antiRaid || {}) }
    };
  }
  return db[guildId];
}

function update(guildId, patch) {
  const current = get(guildId);
  db[guildId] = {
    ...current,
    ...patch,
    adminPanel: { ...current.adminPanel, ...(patch.adminPanel || {}) },
    antiNuke: { ...current.antiNuke, ...(patch.antiNuke || {}) },
    antiRaid: { ...current.antiRaid, ...(patch.antiRaid || {}) }
  };
  save();
  return db[guildId];
}

module.exports = { get, update };
