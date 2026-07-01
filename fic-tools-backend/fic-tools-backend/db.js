// ════════════════════════════════════════════════════════════════════════════
//  db.js — Stockage persistant MongoDB Atlas
//  Remplace le fichier JSON local (qui se réinitialise à chaque redéploiement
//  sur Render plan gratuit).
//  Même API publique que l'ancienne version — aucun autre fichier à modifier.
// ════════════════════════════════════════════════════════════════════════════

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI manquant dans les variables d\'environnement.');
  process.exit(1);
}

let client;
let db;

async function connect() {
  if (db) return db;
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('fic-tools');

  // Index unique sur discordId pour éviter les doublons
  await db.collection('users').createIndex({ discordId: 1 }, { unique: true });
  // Index TTL sur pendingStates : expiration automatique après 30 minutes
  await db.collection('pendingStates').createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 1800 }
  );

  console.log('✅ MongoDB connecté.');
  return db;
}

// ── Users ──────────────────────────────────────────────────────────────────
async function upsertUser(discordId, fields) {
  const col = (await connect()).collection('users');
  const now = new Date().toISOString();
  const update = {
    $set:         { ...fields, updatedAt: now },
    $setOnInsert: { discordId, status: 'pending', createdAt: now }
  };
  const res = await col.findOneAndUpdate(
    { discordId },
    update,
    { upsert: true, returnDocument: 'after' }
  );
  return res;
}

async function getUser(discordId) {
  const col = (await connect()).collection('users');
  return col.findOne({ discordId }, { projection: { _id: 0 } });
}

async function listUsers(statusFilter = null) {
  const col = (await connect()).collection('users');
  const query = statusFilter ? { status: statusFilter } : {};
  return col.find(query, { projection: { _id: 0 } }).toArray();
}

async function setUserStatus(discordId, status) {
  const col = (await connect()).collection('users');
  const res = await col.findOneAndUpdate(
    { discordId },
    { $set: { status, updatedAt: new Date().toISOString() } },
    { returnDocument: 'after', projection: { _id: 0 } }
  );
  return res;
}

// ── Pending login states ─────────────────────────────────────────────────────
async function setPendingState(state, discordId) {
  const col = (await connect()).collection('pendingStates');
  await col.updateOne(
    { state },
    { $set: { state, discordId, createdAt: new Date() } },
    { upsert: true }
  );
}

async function getPendingState(state) {
  const col = (await connect()).collection('pendingStates');
  return col.findOne({ state }, { projection: { _id: 0 } });
}

async function clearOldStates() {
  // Géré automatiquement par l'index TTL MongoDB (expireAfterSeconds: 1800)
}

module.exports = {
  upsertUser, getUser, listUsers, setUserStatus,
  setPendingState, getPendingState, clearOldStates
};
