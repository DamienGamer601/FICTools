// ════════════════════════════════════════════════════════════════════════════
//  db.js — Stockage simple basé sur un fichier JSON
// ════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'db.json');

function ensureDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, pendingStates: {} }, null, 2));
  }
}

function read() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function write(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function upsertUser(discordId, fields) {
  const db = read();
  const existing = db.users[discordId];
  db.users[discordId] = {
    discordId,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...existing,
    ...fields,
    updatedAt: new Date().toISOString()
  };
  write(db);
  return db.users[discordId];
}

function getUser(discordId) {
  return read().users[discordId] || null;
}

function listUsers(statusFilter = null) {
  const users = Object.values(read().users);
  return statusFilter ? users.filter(u => u.status === statusFilter) : users;
}

function setUserStatus(discordId, status) {
  const db = read();
  if (!db.users[discordId]) return null;
  db.users[discordId].status    = status;
  db.users[discordId].updatedAt = new Date().toISOString();
  write(db);
  return db.users[discordId];
}

function setPendingState(state, discordId) {
  const db = read();
  db.pendingStates[state] = { discordId, createdAt: new Date().toISOString() };
  write(db);
}

function getPendingState(state) {
  return read().pendingStates[state] || null;
}

function clearOldStates(maxAgeMs = 30 * 60 * 1000) {
  const db  = read();
  const now = Date.now();
  for (const [state, entry] of Object.entries(db.pendingStates)) {
    if (now - new Date(entry.createdAt).getTime() > maxAgeMs)
      delete db.pendingStates[state];
  }
  write(db);
}

module.exports = {
  upsertUser, getUser, listUsers, setUserStatus,
  setPendingState, getPendingState, clearOldStates,

  // ── Profils partagés ────────────────────────────────────────────────────────
  listProfiles() {
    return Object.values(read().profiles || {})
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  addProfile(profile) {
    const db = read();
    if (!db.profiles) db.profiles = {};
    const id = require('crypto').randomUUID();
    db.profiles[id] = { id, ...profile, createdAt: new Date().toISOString() };
    write(db);
    return db.profiles[id];
  },

  deleteProfile(id) {
    const db = read();
    if (!db.profiles || !db.profiles[id]) return false;
    delete db.profiles[id];
    write(db);
    return true;
  }
};
