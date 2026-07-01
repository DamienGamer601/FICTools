// ════════════════════════════════════════════════════════════════════════════
//  server.js — Backend FIC Tools
//  OAuth2 Discord + whitelist d'accès manuelle (approuvée via BotGhost)
// ════════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db       = require('./db');

const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI,
  DISCORD_WEBHOOK_URL, ADMIN_API_KEY, ADMIN_DISCORD_IDS = '',
  JWT_SECRET, PORT = 3000
} = process.env;

const adminIds = ADMIN_DISCORD_IDS.split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.use(express.json());

// ─── Middleware BotGhost ──────────────────────────────────────────────────────
function requireAdminKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const key  = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.key;
  if (!ADMIN_API_KEY || key !== ADMIN_API_KEY)
    return res.status(401).json({ error: 'Clé admin invalide.' });
  next();
}

// ─── Middleware app FIC Tools (JWT admin) ─────────────────────────────────────
function requireAdminJWT(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!adminIds.includes(payload.discordId))
      return res.status(403).json({ error: "Tu n'es pas administrateur FIC Tools." });
    req.adminDiscordId = payload.discordId;
    next();
  } catch {
    return res.status(401).json({ error: 'Session invalide.' });
  }
}

// ─── OAuth étape 1 : lancement depuis l'app Electron ─────────────────────────
app.get('/auth/discord/start', async (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).send('Paramètre "state" manquant.');
  await db.setPendingState(state, null);
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID, redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code', scope: 'identify', state
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ─── OAuth étape 2 : callback Discord ────────────────────────────────────────
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
    if (!tokenData.access_token) throw new Error('Échange OAuth échoué.');

    const userRes     = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const discordUser = await userRes.json();

    const existing = await db.getUser(discordUser.id);
    const isNew    = !existing;

    const user = await db.upsertUser(discordUser.id, {
      username: `${discordUser.username}${discordUser.discriminator && discordUser.discriminator !== '0' ? '#' + discordUser.discriminator : ''}`,
      avatar:   discordUser.avatar ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png` : null,
      status:   existing ? existing.status : 'pending'
    });

    await db.setPendingState(state, discordUser.id);

    if (isNew || user.status === 'pending') notifyNewRequest(user).catch(() => {});

    res.send(renderStatusPage(user));
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur pendant la connexion Discord.');
  }
});

// ─── Polling depuis l'app (vérification statut toutes les 4s) ─────────────────
app.get('/api/auth-status', async (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).json({ error: 'state manquant' });

  const pending = await db.getPendingState(state);
  if (!pending || !pending.discordId) return res.json({ status: 'waiting' });

  const user = await db.getUser(pending.discordId);
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

// ─── Vérification du token au lancement de l'app ──────────────────────────────
app.get('/api/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ valid: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user    = await db.getUser(payload.discordId);
    if (!user || user.status !== 'approved') return res.json({ valid: false });
    return res.json({
      valid: true,
      user: { username: user.username, avatar: user.avatar, isAdmin: adminIds.includes(user.discordId) }
    });
  } catch {
    return res.json({ valid: false });
  }
});

// ─── Webhook Discord (notification nouvelle demande) ──────────────────────────
// ─── Webhook : envoie la notification ET stocke l'ID du message ──────────────
async function notifyNewRequest(user) {
  if (!DISCORD_WEBHOOK_URL) return;

  // ?wait=true → Discord renvoie le message créé avec son ID
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
    // Stocke l'ID du message dans le profil utilisateur
    await db.upsertUser(user.discordId, { webhookMessageId: data.id });
  }
}

// ─── Supprime le message webhook après une action (approuver/refuser/révoquer) ─
async function deleteWebhookMessage(discordId) {
  if (!DISCORD_WEBHOOK_URL) return;
  const user = await db.getUser(discordId);
  if (!user?.webhookMessageId) return;

  const msgId = user.webhookMessageId;
  // Efface l'ID stocké en premier pour éviter les doublons en cas d'erreur réseau
  await db.upsertUser(discordId, { webhookMessageId: null });

  await fetch(`${DISCORD_WEBHOOK_URL}/messages/${msgId}`, {
    method: 'DELETE'
  }).catch(() => {}); // silencieux si le message a déjà été supprimé manuellement
}

// ════════════════════════════════════════════════════════════════════════════
//  API BotGhost (/approuver, /refuser, /revoquer, /demandes)
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/approve', requireAdminKey, async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });
  const user = await db.getUser(discordId);
  if (!user) return res.status(404).json({ error: "Ce membre ne s'est pas encore connecté à FIC Tools." });
  await db.setUserStatus(discordId, 'approved');
  await deleteWebhookMessage(discordId);
  res.json({ success: true, message: `${user.username} a été approuvé.` });
});

app.post('/api/admin/reject', requireAdminKey, async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });
  const user = await db.getUser(discordId);
  if (!user) return res.status(404).json({ error: "Ce membre ne s'est pas encore connecté à FIC Tools." });
  await db.setUserStatus(discordId, 'rejected');
  await deleteWebhookMessage(discordId);
  res.json({ success: true, message: `${user.username} a été refusé.` });
});

app.post('/api/admin/revoke', requireAdminKey, async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });
  const user = await db.getUser(discordId);
  if (!user) return res.status(404).json({ error: "Ce membre ne s'est pas encore connecté à FIC Tools." });
  await db.setUserStatus(discordId, 'pending');
  await deleteWebhookMessage(discordId);
  res.json({ success: true, message: `Accès de ${user.username} révoqué.` });
});

app.get('/api/admin/pending', requireAdminKey, async (req, res) => {
  const pending = await db.listUsers('pending');
  res.json({
    count: pending.length,
    list:  pending.map(u => `${u.username} — ${u.discordId}`).join('\n') || 'Aucune demande en attente.',
    users: pending
  });
});

app.get('/api/admin/lookup', requireAdminKey, async (req, res) => {
  const user = req.query.discordId ? await db.getUser(req.query.discordId) : null;
  if (!user) return res.json({ found: false });
  res.json({ found: true, username: user.username, status: user.status });
});

// ════════════════════════════════════════════════════════════════════════════
//  API onglet Administration (FIC Tools app)
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/app-admin/users', requireAdminJWT, async (req, res) => {
  const users = (await db.listUsers()).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({
    users: users.map(u => ({
      discordId: u.discordId, username: u.username, avatar: u.avatar,
      status: u.status, isAdmin: adminIds.includes(u.discordId), updatedAt: u.updatedAt
    }))
  });
});

app.get('/api/app-admin/stats', requireAdminJWT, async (req, res) => {
  const all = await db.listUsers();
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
  const user = await db.getUser(discordId);
  if (!user) return res.status(404).json({ error: 'Membre introuvable.' });
  await db.setUserStatus(discordId, 'approved');
  await deleteWebhookMessage(discordId);
  res.json({ success: true });
});

app.post('/api/app-admin/revoke', requireAdminJWT, async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });
  if (discordId === req.adminDiscordId) return res.status(400).json({ error: 'Tu ne peux pas révoquer ton propre accès.' });
  const user = await db.getUser(discordId);
  if (!user) return res.status(404).json({ error: 'Membre introuvable.' });
  await db.setUserStatus(discordId, 'pending');
  await deleteWebhookMessage(discordId);
  res.json({ success: true });
});

app.post('/api/app-admin/reject', requireAdminJWT, async (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });
  if (discordId === req.adminDiscordId) return res.status(400).json({ error: 'Action impossible sur ton propre compte.' });
  const user = await db.getUser(discordId);
  if (!user) return res.status(404).json({ error: 'Membre introuvable.' });
  await db.setUserStatus(discordId, 'rejected');
  await deleteWebhookMessage(discordId);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  PROFILS PARTAGÉS
//  GET    /api/profiles               → liste (membres approuvés)
//  POST   /api/app-admin/profiles     → ajouter un profil (admin)
//  DELETE /api/app-admin/profiles/:id → supprimer un profil (admin)
// ════════════════════════════════════════════════════════════════════════════

function requireValidJWT(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.getUser(payload.discordId);
    if (!user || user.status !== 'approved') return res.status(403).json({ error: 'Accès non autorisé.' });
    req.discordId = payload.discordId;
    next();
  } catch {
    return res.status(401).json({ error: 'Session invalide.' });
  }
}

app.get('/api/profiles', requireValidJWT, (req, res) => {
  res.json({ profiles: db.listProfiles() });
});

app.post('/api/app-admin/profiles', requireAdminJWT, (req, res) => {
  const { name, description, version, downloadUrl, game } = req.body;
  if (!name || !downloadUrl) return res.status(400).json({ error: 'name et downloadUrl sont requis.' });
  const profile = db.addProfile({
    name,
    description: description || '',
    version:     version || '1.0',
    downloadUrl,
    game:        game || 'ETS2',
    addedBy:     req.adminDiscordId
  });
  res.json({ success: true, profile });
});

app.delete('/api/app-admin/profiles/:id', requireAdminJWT, (req, res) => {
  const ok = db.deleteProfile(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Profil introuvable.' });
  res.json({ success: true });
});

// ─── HTML affiché après la connexion Discord ──────────────────────────────────
function renderStatusPage(user) {
  const messages = {
    pending:  { title: '⏳ Demande envoyée', text: 'Un administrateur FIC doit valider ton accès. Retourne dans FIC Tools — la vérification se fait automatiquement.', color: '#d29922' },
    approved: { title: '✅ Accès autorisé',   text: 'Ton compte est approuvé. Retourne dans FIC Tools.', color: '#3fb950' },
    rejected: { title: '⛔ Accès refusé',     text: 'Ta demande a été refusée.', color: '#f85149' }
  };
  const m = messages[user.status] || messages.pending;
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>FIC Tools</title>
  <style>body{margin:0;font-family:'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:36px 42px;text-align:center;max-width:420px;}
  h1{color:${m.color};font-size:22px;margin-bottom:14px;}p{color:#8b949e;font-size:14px;line-height:1.6;}
  .user{margin-top:18px;font-size:13px;color:#6e7681;}</style></head><body>
  <div class="card"><h1>${m.title}</h1><p>${m.text}</p>
  <div class="user">Connecté en tant que <strong>${String(user.username).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</strong></div>
  </div></body></html>`;
}

app.get('/', (_, res) => res.send('FIC Tools backend — OK'));

app.listen(PORT, () => console.log(`FIC Tools backend en écoute sur le port ${PORT}`));
