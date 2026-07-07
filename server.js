// ════════════════════════════════════════════════════════════════════════════
//  server.js — Backend FIC Tools
//  OAuth2 Discord + whitelist manuelle + profils + convois
// ════════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI,
  DISCORD_WEBHOOK_URL, ADMIN_API_KEY, ADMIN_DISCORD_IDS = '',
  JWT_SECRET, PORT = 3000
} = process.env;

const adminIds = ADMIN_DISCORD_IDS.split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.use(express.json());

// ════════════════════════════════════════════════════════════════════════════
//  MIDDLEWARES
// ════════════════════════════════════════════════════════════════════════════

// Pour les appels BotGhost (clé secrète)
function requireAdminKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const key  = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.key;
  if (!ADMIN_API_KEY || key !== ADMIN_API_KEY)
    return res.status(401).json({ error: 'Clé admin invalide.' });
  next();
}

// Pour les membres authentifiés (token JWT valide + approuvé)
function requireValidJWT(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user    = db.getUser(payload.discordId);
    if (!user || user.status !== 'approved') return res.status(403).json({ error: 'Accès refusé.' });
    req.discordId = payload.discordId;
    req.user = user;
    next();
  } catch { return res.status(401).json({ error: 'Session invalide.' }); }
}

// Pour les admins (token JWT + discordId dans ADMIN_DISCORD_IDS)
function requireAdminJWT(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!adminIds.includes(payload.discordId))
      return res.status(403).json({ error: "Tu n'es pas administrateur FIC Tools." });
    const user = db.getUser(payload.discordId);
    if (!user || user.status !== 'approved') return res.status(403).json({ error: 'Accès refusé.' });
    req.adminDiscordId = payload.discordId;
    req.user = user;
    next();
  } catch { return res.status(401).json({ error: 'Session invalide.' }); }
}

// ════════════════════════════════════════════════════════════════════════════
//  OAUTH2 DISCORD
// ════════════════════════════════════════════════════════════════════════════

app.get('/auth/discord/start', (req, res) => {
  const state = req.query.state || uuidv4();
  db.setPendingState(state, null);
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID, redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code', scope: 'identify', state
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Requête invalide.');
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: DISCORD_REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('OAuth échoué.');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const discordUser = await userRes.json();

    const existing = db.getUser(discordUser.id);
    const isNew    = !existing;

    const user = db.upsertUser(discordUser.id, {
      username: discordUser.username,
      avatar: discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : null,
      status: existing ? existing.status : 'pending'
    });

    db.setPendingState(state, discordUser.id);
    if (isNew || user.status === 'pending') notifyNewRequest(user).catch(() => {});

    res.send(renderStatusPage(user));
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur de connexion Discord.');
  }
});

app.get('/api/auth-status', (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).json({ error: 'state manquant' });
  const pending = db.getPendingState(state);
  if (!pending?.discordId) return res.json({ status: 'waiting' });
  const user = db.getUser(pending.discordId);
  if (!user) return res.json({ status: 'waiting' });
  if (user.status === 'approved') {
    const token = jwt.sign(
      { discordId: user.discordId, username: user.username },
      JWT_SECRET, { expiresIn: '30d' }
    );
    return res.json({
      status: 'approved', token,
      user: { username: user.username, avatar: user.avatar, isAdmin: adminIds.includes(user.discordId) }
    });
  }
  return res.json({ status: user.status, user: { username: user.username, avatar: user.avatar } });
});

app.get('/api/verify', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ valid: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.getUser(payload.discordId);
    if (!user || user.status !== 'approved') return res.json({ valid: false });
    return res.json({
      valid: true,
      user: { username: user.username, avatar: user.avatar, isAdmin: adminIds.includes(user.discordId) }
    });
  } catch { return res.json({ valid: false }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  API BOTGHOST (/approuver, /refuser, /revoquer, /demandes)
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/approve', requireAdminKey, async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });
  const user = db.getUser(discordId);
  if (!user) return res.status(404).json({ error: "Ce membre ne s'est pas encore connecté à FIC Tools." });
  db.setUserStatus(discordId, 'approved');
  await deleteWebhookMessage(discordId);
  res.json({ success: true, message: `${user.username} a été approuvé.` });
});

app.post('/api/admin/reject', requireAdminKey, async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });
  const user = db.getUser(discordId);
  if (!user) return res.status(404).json({ error: "Ce membre ne s'est pas encore connecté à FIC Tools." });
  db.setUserStatus(discordId, 'rejected');
  await deleteWebhookMessage(discordId);
  res.json({ success: true, message: `${user.username} a été refusé.` });
});

app.post('/api/admin/revoke', requireAdminKey, async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });
  const user = db.getUser(discordId);
  if (!user) return res.status(404).json({ error: "Ce membre ne s'est pas encore connecté à FIC Tools." });
  db.setUserStatus(discordId, 'pending');
  await deleteWebhookMessage(discordId);
  res.json({ success: true, message: `Accès de ${user.username} révoqué.` });
});

app.get('/api/admin/pending', requireAdminKey, (req, res) => {
  const pending = db.listUsers('pending');
  res.json({
    count: pending.length,
    list:  pending.map(u => `${u.username} — ${u.discordId}`).join('\n') || 'Aucune demande.',
    users: pending
  });
});

app.get('/api/admin/lookup', requireAdminKey, (req, res) => {
  const user = req.query.discordId ? db.getUser(req.query.discordId) : null;
  if (!user) return res.json({ found: false });
  res.json({ found: true, username: user.username, status: user.status });
});

// ════════════════════════════════════════════════════════════════════════════
//  API APP-ADMIN (depuis l'onglet Administration de FIC Tools)
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/app-admin/users', requireAdminJWT, (req, res) => {
  const users = db.listUsers().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ users: users.map(u => ({
    discordId: u.discordId, username: u.username, avatar: u.avatar,
    status: u.status, isAdmin: adminIds.includes(u.discordId), updatedAt: u.updatedAt
  }))});
});

app.get('/api/app-admin/stats', requireAdminJWT, (req, res) => {
  const all = db.listUsers();
  res.json({
    total:    all.length,
    approved: all.filter(u => u.status === 'approved').length,
    pending:  all.filter(u => u.status === 'pending').length,
    rejected: all.filter(u => u.status === 'rejected').length
  });
});

app.post('/api/app-admin/approve', requireAdminJWT, async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });
  const user = db.getUser(discordId);
  if (!user) return res.status(404).json({ error: 'Membre introuvable.' });
  db.setUserStatus(discordId, 'approved');
  await deleteWebhookMessage(discordId);
  res.json({ success: true });
});

app.post('/api/app-admin/reject', requireAdminJWT, async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });
  if (discordId === req.adminDiscordId) return res.status(400).json({ error: 'Action impossible sur ton propre compte.' });
  const user = db.getUser(discordId);
  if (!user) return res.status(404).json({ error: 'Membre introuvable.' });
  db.setUserStatus(discordId, 'rejected');
  await deleteWebhookMessage(discordId);
  res.json({ success: true });
});

app.post('/api/app-admin/revoke', requireAdminJWT, async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });
  if (discordId === req.adminDiscordId) return res.status(400).json({ error: 'Tu ne peux pas révoquer ton propre accès.' });
  const user = db.getUser(discordId);
  if (!user) return res.status(404).json({ error: 'Membre introuvable.' });
  db.setUserStatus(discordId, 'pending');
  await deleteWebhookMessage(discordId);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  PROFILS PARTAGÉS
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/profiles', requireValidJWT, (req, res) => {
  res.json({ profiles: db.listProfiles() });
});

app.post('/api/app-admin/profiles', requireAdminJWT, (req, res) => {
  const { name, description, version, downloadUrl, game } = req.body;
  if (!name || !downloadUrl) return res.status(400).json({ error: 'name et downloadUrl sont requis.' });
  const profile = db.addProfile({ name, description: description || '', version: version || '1.0', downloadUrl, game: game || 'ETS2', addedBy: req.adminDiscordId });
  res.json({ success: true, profile });
});

app.delete('/api/app-admin/profiles/:id', requireAdminJWT, (req, res) => {
  const ok = db.deleteProfile(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Profil introuvable.' });
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  CONVOIS
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/convoys', requireValidJWT, (req, res) => {
  res.json({ convoys: db.listConvoys() });
});

app.post('/api/app-admin/convoys', requireAdminJWT, (req, res) => {
  const { title, date, time, server, departure, arrival, description, maxSlots, game } = req.body;
  if (!title || !date) return res.status(400).json({ error: 'title et date sont requis.' });
  const convoy = db.addConvoy({
    title, date,
    time:        time        || '20:00',
    server:      server      || 'EU2',
    departure:   departure   || '',
    arrival:     arrival     || '',
    description: description || '',
    maxSlots:    maxSlots    || null,
    game:        game        || 'ETS2',
    createdBy:   req.adminDiscordId
  });
  res.json({ success: true, convoy });
});

app.delete('/api/app-admin/convoys/:id', requireAdminJWT, (req, res) => {
  const ok = db.deleteConvoy(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Convoi introuvable.' });
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  WEBHOOK NOTIFICATIONS
// ════════════════════════════════════════════════════════════════════════════

async function notifyNewRequest(user) {
  if (!DISCORD_WEBHOOK_URL) return;
  const res = await fetch(`${DISCORD_WEBHOOK_URL}?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: "🔔 Nouvelle demande d'accès — FIC Tools",
        description: `**${user.username}** demande l'accès.\n\nID Discord : \`${user.discordId}\``,
        color: 5832715,
        thumbnail: user.avatar ? { url: user.avatar } : undefined,
        footer: { text: `/approuver puis colle l'ID : ${user.discordId}` }
      }]
    })
  });
  if (res.ok) {
    const data = await res.json();
    db.upsertUser(user.discordId, { webhookMessageId: data.id });
  }
}

async function deleteWebhookMessage(discordId) {
  if (!DISCORD_WEBHOOK_URL) return;
  const user = db.getUser(discordId);
  if (!user?.webhookMessageId) return;
  const msgId = user.webhookMessageId;
  db.upsertUser(discordId, { webhookMessageId: null });
  await fetch(`${DISCORD_WEBHOOK_URL}/messages/${msgId}`, { method: 'DELETE' }).catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════════
//  HTML — Page statut après connexion Discord
// ════════════════════════════════════════════════════════════════════════════

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderStatusPage(user) {
  const messages = {
    pending:  { title: '⏳ Demande envoyée',  text: 'Un administrateur FIC doit valider ton accès. Retourne dans FIC Tools.', color: '#d29922' },
    approved: { title: '✅ Accès autorisé',    text: "Ton compte est approuvé. Retourne dans FIC Tools, l'application va se débloquer.", color: '#3fb950' },
    rejected: { title: '⛔ Accès refusé',      text: "Ta demande a été refusée. Contacte un administrateur FIC.", color: '#f85149' }
  };
  const m = messages[user.status] || messages.pending;
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>FIC Tools</title>
  <style>body{margin:0;font-family:'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:36px 42px;text-align:center;max-width:420px;}
  h1{color:${m.color};font-size:22px;margin-bottom:14px;}p{color:#8b949e;font-size:14px;line-height:1.6;}</style>
  </head><body><div class="card"><h1>${m.title}</h1><p>${m.text}</p><p style="margin-top:12px;font-size:12px;color:#6e7681;">Connecté en tant que <strong>${escHtml(user.username)}</strong></p></div></body></html>`;
}

app.get('/', (req, res) => res.send('FIC Tools backend — OK'));

setInterval(() => db.clearOldStates(), 10 * 60 * 1000);

app.listen(PORT, () => console.log(`FIC Tools backend en écoute sur le port ${PORT}`));
