// ════════════════════════════════════════════════════════════════════════════
//  server.js — Backend FIC Tools
//  OAuth2 Discord + whitelist d'accès manuelle (approuvée via bot Discord)
// ════════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');

const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI,
  DISCORD_WEBHOOK_URL, ADMIN_API_KEY,
  JWT_SECRET, PORT = 3000
} = process.env;

const app = express();
app.use(express.json());

// ─── Middleware: protège les routes /api/admin/* ──────────────────────────────
function requireAdminKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.key;
  if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Clé admin invalide ou manquante.' });
  }
  next();
}

// ─── OAuth: étape 1 — redirection vers Discord ────────────────────────────────
app.get('/auth/discord', (req, res) => {
  const state = uuidv4();
  db.setPendingState(state, null); // pas encore lié à un discordId

  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify',
    state
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

// ─── OAuth: étape 1bis — l'app Electron démarre le flow avec SON propre state ──
// (utilisé pour relier la session du navigateur à l'app desktop)
app.get('/auth/discord/start', (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).send('Paramètre "state" manquant.');

  db.setPendingState(state, null);

  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify',
    state
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

// ─── OAuth: étape 2 — callback Discord ────────────────────────────────────────
app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Requête invalide.');

  try {
    // Échange du code contre un access_token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  DISCORD_REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Échange OAuth échoué.');

    // Récupération du profil Discord
    const userRes  = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const discordUser = await userRes.json();

    const existing = db.getUser(discordUser.id);
    const isNew = !existing;

    const user = db.upsertUser(discordUser.id, {
      username: `${discordUser.username}${discordUser.discriminator && discordUser.discriminator !== '0' ? '#' + discordUser.discriminator : ''}`,
      avatar: discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : null,
      status: existing ? existing.status : 'pending'
    });

    db.setPendingState(state, discordUser.id);

    if (isNew || user.status === 'pending') {
      notifyNewRequest(user).catch(() => {});
    }

    res.send(renderStatusPage(user));
  } catch (err) {
    console.error(err);
    res.status(500).send('Une erreur est survenue pendant la connexion Discord.');
  }
});

// ─── Polling depuis l'app Electron ─────────────────────────────────────────────
app.get('/api/auth-status', (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).json({ error: 'state manquant' });

  const pending = db.getPendingState(state);
  if (!pending || !pending.discordId) return res.json({ status: 'waiting' });

  const user = db.getUser(pending.discordId);
  if (!user) return res.json({ status: 'waiting' });

  if (user.status === 'approved') {
    const token = jwt.sign(
      { discordId: user.discordId, username: user.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    return res.json({ status: 'approved', token, user: { username: user.username, avatar: user.avatar } });
  }

  return res.json({ status: user.status, user: { username: user.username, avatar: user.avatar } });
});

// ─── Vérification du token à chaque lancement de l'app ────────────────────────
app.get('/api/verify', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ valid: false });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.getUser(payload.discordId);
    if (!user || user.status !== 'approved') return res.json({ valid: false });
    return res.json({ valid: true, user: { username: user.username, avatar: user.avatar } });
  } catch {
    return res.json({ valid: false });
  }
});

// ─── Notification Discord (webhook — utilisé pour prévenir d'une nouvelle demande) ─
async function notifyNewRequest(user) {
  if (!DISCORD_WEBHOOK_URL) return;
  await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: "🔔 Nouvelle demande d'accès — FIC Tools",
        description: `**${user.username}** demande l'accès à FIC Tools.\n\nID Discord : \`${user.discordId}\``,
        color: 5832715,
        thumbnail: user.avatar ? { url: user.avatar } : undefined,
        footer: { text: `/approuver puis colle l'ID : ${user.discordId}` }
      }]
    })
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  API ADMIN — appelée par les commandes BotGhost (/approuver, /refuser, etc.)
//  Protégée par la clé ADMIN_API_KEY (header "Authorization: Bearer <clé>")
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/approve', requireAdminKey, (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });

  const user = db.getUser(discordId);
  if (!user) return res.status(404).json({ error: "Ce membre ne s'est pas encore connecté à FIC Tools." });

  db.setUserStatus(discordId, 'approved');
  res.json({ success: true, message: `${user.username} a été approuvé.` });
});

app.post('/api/admin/reject', requireAdminKey, (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });

  const user = db.getUser(discordId);
  if (!user) return res.status(404).json({ error: "Ce membre ne s'est pas encore connecté à FIC Tools." });

  db.setUserStatus(discordId, 'rejected');
  res.json({ success: true, message: `${user.username} a été refusé.` });
});

app.post('/api/admin/revoke', requireAdminKey, (req, res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId manquant.' });

  const user = db.getUser(discordId);
  if (!user) return res.status(404).json({ error: "Ce membre ne s'est pas encore connecté à FIC Tools." });

  db.setUserStatus(discordId, 'pending');
  res.json({ success: true, message: `Accès de ${user.username} révoqué (remis en attente).` });
});

app.get('/api/admin/pending', requireAdminKey, (req, res) => {
  const pending = db.listUsers('pending');
  res.json({
    count: pending.length,
    list: pending.map(u => `${u.username} — ${u.discordId}`).join('\n') || 'Aucune demande en attente.',
    users: pending
  });
});

app.get('/api/admin/lookup', requireAdminKey, (req, res) => {
  const { discordId } = req.query;
  const user = discordId ? db.getUser(discordId) : null;
  if (!user) return res.json({ found: false });
  res.json({ found: true, username: user.username, status: user.status });
});
function renderStatusPage(user) {
  const messages = {
    pending:  { title: '⏳ Demande envoyée', text: 'Un administrateur FIC doit valider ton accès. Tu peux fermer cette page et retourner dans FIC Tools — la vérification se fait automatiquement.', color: '#d29922' },
    approved: { title: '✅ Accès autorisé',   text: 'Ton compte est approuvé. Retourne dans FIC Tools, l\'application va se débloquer automatiquement.', color: '#3fb950' },
    rejected: { title: '⛔ Accès refusé',     text: 'Ta demande d\'accès a été refusée par un administrateur FIC.', color: '#f85149' }
  };
  const m = messages[user.status] || messages.pending;

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>FIC Tools — Connexion</title>
  <style>
    body{margin:0;font-family:'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;}
    .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:36px 42px;text-align:center;max-width:420px;}
    h1{color:${m.color};font-size:22px;margin-bottom:14px;}
    p{color:#8b949e;font-size:14px;line-height:1.6;}
    .user{margin-top:18px;font-size:13px;color:#6e7681;}
  </style></head><body>
  <div class="card"><h1>${m.title}</h1><p>${m.text}</p><div class="user">Connecté en tant que <strong>${escapeHtml(user.username)}</strong></div></div>
  </body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

app.get('/', (req, res) => res.send('FIC Tools backend — OK'));

// ─── Nettoyage périodique des states expirés ──────────────────────────────────
setInterval(() => db.clearOldStates(), 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`FIC Tools backend en écoute sur le port ${PORT}`);
});
