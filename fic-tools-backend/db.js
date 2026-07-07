// ════════════════════════════════════════════════════════════════════════════
//  db.js — Stockage JSON simple
// ════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'db.json');

function ensureDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, pendingStates: {}, profiles: {}, convoys: {} }, null, 2));
  }
}

function read() {
  ensureDb();
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!raw.profiles) raw.profiles = {};
  if (!raw.convoys)  raw.convoys  = {};
  return raw;
}

function write(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── Utilisateurs ──────────────────────────────────────────────────────────────
function upsertUser(discordId, fields) {
  const db = read();
  const existing = db.users[discordId];
  db.users[discordId] = {
    discordId, status: 'pending', createdAt: new Date().toISOString(),
    ...existing, ...fields, updatedAt: new Date().toISOString()
  };
  write(db);
  return db.users[discordId];
}
function getUser(discordId) { return read().users[discordId] || null; }
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

// ── Pending OAuth states ───────────────────────────────────────────────────────
function setPendingState(state, discordId) {
  const db = read();
  db.pendingStates[state] = { discordId, createdAt: new Date().toISOString() };
  write(db);
}
function getPendingState(state) { return read().pendingStates[state] || null; }
function clearOldStates(maxAgeMs = 30 * 60 * 1000) {
  const db = read(); const now = Date.now();
  for (const [s, e] of Object.entries(db.pendingStates))
    if (now - new Date(e.createdAt).getTime() > maxAgeMs) delete db.pendingStates[s];
  write(db);
}

// ── Profils partagés ──────────────────────────────────────────────────────────
function listProfiles() {
  return Object.values(read().profiles).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
function addProfile(profile) {
  const db = read();
  const id = require('crypto').randomUUID();
  db.profiles[id] = { id, ...profile, createdAt: new Date().toISOString() };
  write(db);
  return db.profiles[id];
}
function deleteProfile(id) {
  const db = read();
  if (!db.profiles[id]) return false;
  delete db.profiles[id]; write(db); return true;
}

// ── Convois ───────────────────────────────────────────────────────────────────
function listConvoys() {
  return Object.values(read().convoys)
    .sort((a, b) => new Date(a.date + 'T' + (a.time || '00:00')) - new Date(b.date + 'T' + (b.time || '00:00')));
}
function addConvoy(convoy) {
  const db = read();
  const id = require('crypto').randomUUID();
  db.convoys[id] = { id, ...convoy, createdAt: new Date().toISOString() };
  write(db);
  return db.convoys[id];
}
function deleteConvoy(id) {
  const db = read();
  if (!db.convoys[id]) return false;
  delete db.convoys[id]; write(db); return true;
}

module.exports = {
  upsertUser, getUser, listUsers, setUserStatus,
  setPendingState, getPendingState, clearOldStates,
  listProfiles, addProfile, deleteProfile,
  listConvoys, addConvoy, deleteConvoy
};
