const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "data", "guilds.json");
let db = {};
try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch { db = {}; }

function save() {
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
}
function get(guildId) {
  if (!db[guildId]) {
    db[guildId] = {
      adminPanel: { channelId: null, passwordHash: null },
      antiNuke: { logChannelId: null, enabled: false, snapshots: {} },
      antiRaid: {
        enabled: false,
        threshold: 5,
        windowSeconds: 10,
        accountAgeHours: 24,
        banOnRaid: true,
        logChannelId: null
      }
    };
    save();
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
