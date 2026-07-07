# FIC Tools — Backend d'authentification Discord (+ BotGhost)

Ce serveur gère : la connexion Discord (OAuth2) côté app, et une whitelist d'accès que tu approuves/refuses via des commandes **BotGhost**.

## Étape 1 — Créer l'application Discord (pour l'OAuth2 uniquement)

1. Va sur https://discord.com/developers/applications → **New Application** → nomme-la `FIC Tools`.
2. Onglet **OAuth2 → General** :
   - Note le **Client ID** et clique **Reset Secret** pour obtenir le **Client Secret**.
   - Dans **Redirects**, ajoute (tu pourras corriger l'URL après l'étape 2) :
     `https://TON-APP.onrender.com/auth/discord/callback`

   ⚠️ Cette application Discord sert uniquement à la connexion ("Se connecter avec Discord"), **ce n'est pas ton bot BotGhost** — ce sont deux choses séparées, pas besoin de les relier.

## Étape 2 — Déployer le backend sur Render (gratuit)

1. Crée un dépôt GitHub avec le contenu de ce dossier `fic-tools-backend/`.
2. Va sur https://render.com → **New +** → **Web Service** → connecte ton dépôt GitHub.
3. Configuration :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free
4. Onglet **Environment** → ajoute les variables :

| Variable | Valeur |
|---|---|
| `DISCORD_CLIENT_ID` | Client ID de l'étape 1 |
| `DISCORD_CLIENT_SECRET` | Client Secret de l'étape 1 |
| `DISCORD_REDIRECT_URI` | `https://TON-APP.onrender.com/auth/discord/callback` |
| `DISCORD_WEBHOOK_URL` | (optionnel) webhook d'un salon, pour être notifié des nouvelles demandes |
| `ADMIN_API_KEY` | Une longue chaîne aléatoire que **toi seul connais** — génère-en une sur https://generate-secret.vercel.app/32 |
| `JWT_SECRET` | Une autre longue chaîne aléatoire (différente de la précédente) |

5. Clique **Deploy**. Note l'URL Render finale (ex: `https://fic-tools-backend.onrender.com`).
6. Retourne sur **Discord Developer Portal → OAuth2 → Redirects**, corrige l'URL avec le vrai nom Render.
7. Mets à jour `DISCORD_REDIRECT_URI` sur Render avec cette URL exacte, puis redéploie ("Manual Deploy").

## Étape 3 — Créer le webhook de notification (optionnel mais recommandé)

1. Dans Discord, va dans le salon où tu veux recevoir les notifications → **Modifier le salon → Intégrations → Webhooks → Nouveau Webhook**.
2. Copie l'URL du webhook → colle-la dans la variable `DISCORD_WEBHOOK_URL` sur Render.

## Étape 4 — Configurer les commandes dans BotGhost

Va dans ton bot sur https://botghost.com → **Commands → Create Command**. Crée ces 4 commandes (Slash Command) :

### `/approuver`
- **Option** : `discord_id` (type *String* ou *User* — si tu prends *User*, BotGhost te donne `{user.id}`)
- **Actions** :
  1. **API Request**
     - Method : `POST`
     - URL : `https://TON-APP.onrender.com/api/admin/approve`
     - Headers : `Authorization` = `Bearer TA_ADMIN_API_KEY` (la même que sur Render)
     - Headers : `Content-Type` = `application/json`
     - Body (JSON) : `{ "discordId": "{option.discord_id}" }` (ou `{user.id}` si tu utilises une option *User*)
     - Stocke la réponse dans une variable, ex. `api_response`
  2. **Send Message** (réponse de la commande)
     - `✅ Accès approuvé : {api_response.message}`

### `/refuser`
- Même structure, mais URL → `/api/admin/reject`

### `/revoquer`
- Même structure, mais URL → `/api/admin/revoke`

### `/demandes`
- Pas d'option nécessaire.
- **Actions** :
  1. **API Request**
     - Method : `GET`
     - URL : `https://TON-APP.onrender.com/api/admin/pending`
     - Headers : `Authorization` = `Bearer TA_ADMIN_API_KEY`
     - Stocke la réponse dans `api_response`
  2. **Send Message**
     - `📋 Demandes en attente (**{api_response.count}**) :\n{api_response.list}`

💡 **Astuce pratique** : utilise une option de type **User** (`@membre`) plutôt que de copier-coller des IDs à la main — c'est plus simple et moins sujet aux erreurs. Dans BotGhost, une option *User* expose automatiquement `{option.membre.id}` à utiliser dans le body de la requête API.

## Étape 5 — Connecter FIC Tools (l'app desktop)

Dans `fic-tools/main.js`, remplace :
```js
const BACKEND_URL = 'https://fic-tools-backend.onrender.com';
```
par l'URL réelle de ton service Render, puis relance `npm start`.

## Tester le flux complet

1. Lance FIC Tools → écran "Se connecter avec Discord" → le navigateur s'ouvre, tu autorises l'app.
2. Sur Discord, tape `/demandes` → tu dois voir la demande.
3. Tape `/approuver @toi-même`.
4. Dans FIC Tools, l'app se débloque automatiquement (vérifié toutes les 4 secondes).

## Sécurité

- `ADMIN_API_KEY` doit rester secrète — ne la partage qu'entre Render et BotGhost. Si elle fuite, n'importe qui pourrait approuver des comptes : régénère-la sur Render si besoin (et mets à jour BotGhost en conséquence).
- ⚠️ Le plan gratuit Render réinitialise le fichier `data/db.json` à chaque redéploiement (stockage non persistant). La whitelist sera donc perdue si tu push une mise à jour du backend — à garder en tête pour une grosse VTC, sinon ça reste très bien pour démarrer.
