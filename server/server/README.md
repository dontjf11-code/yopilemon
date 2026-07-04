# YopiLemon — server & hosting guide

YopiLemon is a static front-end served by a small Node backend. The backend does three things:

1. **Discord login via username + DM code** — you type your Discord username; the bot looks you up in the server and DMs you a one-time code; you enter the code to log in. Receiving the DM proves you control the account.
2. **Server-membership gate** — the bot only finds and DMs users who are members of server `1464869872344502424`. If you're not in the server, no code is sent and login is impossible.
3. **AI proxy** — forwards chat requests to the upstream AI endpoint with the secret API key, so the key and provider are never sent to the browser.

This guide walks you through everything: creating the Discord bot, inviting it, deploying to **Render (free tier)**, and running it locally.

> Created by **yopix**.

---

## Architecture at a glance

```
Browser  ──/auth/request-code──▶  YopiLemon server  ──bot DMs user a 6-digit code──▶  Discord
Browser  ──/auth/verify────────▶  (checks code, creates session)
Browser  ──/api/chat───────────▶  YopiLemon server  ──▶  upstream AI endpoint
                                │
                                └─ serves static site (index/chat/login.html, *.css, *.js)
```

The browser only ever sees same-origin routes. The upstream host, API key, and bot token all live in server-side env vars. No OAuth2 client id/secret is used — login is username + DM code.

---

## Prerequisites

- A Discord account that owns (or can admin) the server with id `1464869872344502424`.
- A GitHub repo containing this project (Render deploys from a repo).
- The upstream AI endpoint + API key (e.g. `https://sh00t.host/v1` and `sk_...`).
- The Discord invite link for your server (`https://discord.gg/yopixita`).

---

## Step 1 — Create the Discord bot

1. Go to **https://discord.com/developers/applications** and click **New Application**.
2. Name it **YopiLemon** and create it.
3. On the **General Information** tab, copy the **Application ID** (a.k.a. Client ID) — you need it to build the bot invite link below.

### Create the bot

4. Open the **Bot** tab and click **Add Bot**.
5. Copy the **Bot Token**. Save it somewhere safe — it's shown once.
6. Under **Privileged Gateway Intents**, enable **Server Members Intent**. This is **required**: the bot lists the guild's members to find a username, and that endpoint needs the intent.
7. Optional: untick **Public Bot** so nobody else can invite it.

> No OAuth2 redirect URI is needed for this flow. You can ignore the OAuth2 tab entirely.

---

## Step 2 — Invite the bot into your server

The login flow uses the bot token to list guild members and to DM them. **The bot must be a member of the guild** for any of this to work.

Visit this URL in your browser, replacing `<CLIENT_ID>` with the Application ID from Step 1.3:

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&permissions=0&scope=bot
```

Select the server `1464869872344502424` and authorize. You should see the bot join the server.

> The bot needs no special permissions. It only reads the member list and sends DMs.
>
> Also make sure members can receive DMs from the bot: in the server, **Server Settings → Safety Setup**, the setting for "DMs from server members" must allow it, and individual users must allow DMs from non-friends (Discord default is usually fine).

---

## Step 3 — Push the project to GitHub

If you haven't already:

```bash
cd wenb
git init
git add .
git commit -m "YopiLemon: Discord-gated chat"
git branch -M main
git remote add origin https://github.com/<you>/yopilemon.git
git push -u origin main
```

Make sure `.env` is **not** committed (it's in `server/.gitignore`). The upstream key and bot token must never be in the repo.

---

## Step 4 — Deploy to Render (free tier)

1. Sign in at **https://render.com** (you can sign in with GitHub).
2. Click **New +** → **Web Service**.
3. Connect your GitHub account and select the **yopilemon** repo.
4. Fill in the form:
   - **Name**: `yopilemon` (this becomes `https://yopilemon.onrender.com`).
   - **Region**: nearest to you.
   - **Branch**: `main`.
   - **Root Directory**: `server`  ← **important**. The Node project lives in `server/`.
   - **Runtime**: Node.
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**.
5. Scroll down to **Environment Variables** and add each one:

   | Key | Value |
   |-----|-------|
   | `DISCORD_BOT_TOKEN` | Bot Token from Step 1.5 |
   | `DISCORD_GUILD_ID` | `1464869872344502424` |
   | `DISCORD_INVITE_LINK` | `https://discord.gg/yopixita` |
   | `UPSTREAM_ENDPOINT` | `https://sh00t.host/v1` (or your endpoint) |
   | `UPSTREAM_API_KEY` | your `sk_...` key |
   | `SESSION_SECRET` | a long random string (see generator below) |
   | `PUBLIC_BASE_URL` | `https://yopilemon.onrender.com` (your Render URL, no trailing slash) |
   | `NODE_ENV` | `production` |

   Generate a `SESSION_SECRET` locally with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

6. Click **Create Web Service**. Render builds and deploys. The first build takes a minute or two.
7. Once it's live, open `https://yopilemon.onrender.com` in your browser. You should see the YopiLemon landing page.

> No OAuth2 redirect URI to configure — there's no OAuth in this flow.

---

## Step 5 — Try it

1. Open your Render URL and click **Sign in** (or **Start free**).
2. On the login page, step 1 shows a **Join Our Discord** button — it opens `https://discord.gg/yopixita` in a new tab. Join the server (or skip if you're already a member), then click **I've joined — continue**.
3. Step 2: type your **Discord username** (without the `@`) and click **Send me a code**.
4. The bot DMs you a 6-digit code on Discord. Step 3: enter it and click **Verify & log in**.
5. If the code matches, you see a **welcome screen** with your Discord profile picture and display name, then you're taken to the chat.
6. If you're **not** a member of the server, no code is ever sent — you'll get a generic "code didn't match" error. Join the server first.

To test the not-member path, use a Discord account that isn't in the server.

---

## Free-tier caveats (Render)

- **Spin-down**: Free webservices sleep after ~15 minutes of inactivity. The first request after sleep takes ~30 seconds to wake the service. This is normal.
- **Because we use REST for the member lookup and DMs (not a persistent gateway connection)**, login still works after a wake. The bot will show as **offline** in Discord — that's expected and fine for this flow. If you want the bot to show as online, you'd need a persistent `discord.js` gateway connection, which the free tier's spin-down will periodically kill. It's off by default.
- **In-memory code store**: login codes are kept in process memory and expire after 10 minutes. If the service restarts/spins down while someone is mid-login, they just request a new code. This is fine for the free tier.
- **Monthly hours**: the free tier gives 750 instance-hours/month, which covers one always-wakeable service. If you exceed it, the service pauses until the next month.

---

## Running locally

1. Install Node 18 or newer (https://nodejs.org).
2. From the `server/` folder:

   ```bash
   cd server
   cp .env.example .env        # Windows: copy .env.example .env
   ```

3. Edit `.env`:
   - Fill in `DISCORD_BOT_TOKEN` from Step 1.5.
   - Set `PUBLIC_BASE_URL=http://localhost:3000`.
   - Leave the invite link and guild id as-is.
4. Install and run:

   ```bash
   npm install
   npm start
   ```

5. Open **http://localhost:3000**. The server serves the site and the API on the same origin, so everything works exactly as it will in production. The bot DMs will come from the same bot account — make sure it's invited to your guild.

> Tip: `npm run dev` runs with `node --watch` so the server auto-restarts on edits.

---

## How the API key stays hidden

- The front-end `config.js` contains **no** `apiKey` and **no** `endpoint`. Only the public model list (for the picker UI) and the default model id.
- `chat.js` calls `fetch("/api/chat", { credentials: "include" })` — a same-origin request. No key, no upstream host, no `Authorization` header.
- The server's `/api/chat` route checks the session cookie, then makes the authenticated call to the upstream endpoint using `UPSTREAM_API_KEY` from the environment. The response stream is piped straight back to the browser.
- A user who opens DevTools → Network sees only `/api/chat`, `/api/me`, and `/auth/*` on your own domain. They cannot see the upstream provider or the key.

The model **names** in the picker (Claude Fable 5, GLM 5.2, etc.) are visible by design — that's the point of the picker. If you'd rather hide which models are available, remove entries from `config.js`'s `models` array (or set the picker to a single default). The server forwards whatever `model` id the client sends, so trimming the list is purely a front-end change.

---

## How login stays secure

- **Username alone is not proof of identity.** Anyone could type "yopix" and, if that user is in the server, log in as them. So we require a **DM code**: the bot DMs the matched member a one-time 6-digit code, and you must enter it. Receiving the DM proves you control the Discord account.
- Codes are **hashed** (SHA-256) in memory — a process dump wouldn't reveal them. They expire after 10 minutes and allow at most 5 attempts.
- The request-code endpoint responds identically whether or not the username was found, so an attacker can't enumerate which usernames are in the server.
- The verify endpoint re-resolves the username to a member id and checks the code against that member's stored hash — the client can't claim a code was for a different user than the one it requested for.
- Login is **impossible** unless the Discord account is a member of guild `1464869872344502424` (the bot only finds and DMs members of that guild).

---

## Troubleshooting

**"No code on file. Request a new one."**
You tried to verify without first requesting a code, or your code expired (10-minute window). Go back and request a new one.

**"That code didn't match, or it expired."**
Either the code is wrong, expired, or the username you entered isn't a member of the server (in which case no code was ever sent). Check the username spelling and that you're in the server.

**"Couldn't send a code right now" / `Discord guild members list failed: 403`**
The **Server Members Intent** is not enabled (Step 1.6), or the bot isn't in the guild (Step 2). Enable the intent in the Developer Portal and redeploy.

**`Discord guild members list failed: 401`**
Wrong `DISCORD_BOT_TOKEN`. Re-copy it from the Bot tab.

**"Couldn't send a code" but the member was found**
The bot couldn't DM the user — the user has DMs disabled, or the server restricts DMs from bots. The user needs to allow DMs from server members (Discord: User Settings → Privacy → allow DMs from server members).

**Chat returns 502 / "Upstream returned ..."**
`UPSTREAM_ENDPOINT` or `UPSTREAM_API_KEY` is wrong, or the upstream is down. Check the server logs in the Render dashboard — the error detail is printed there (but never sent to the browser).

**Changes aren't showing up**
The HTML files are served with `no-cache`, but CSS/JS may be cached by your browser. Hard-refresh (Ctrl+Shift+R / Cmd+Shift+R). On Render, push to `main` to trigger a redeploy.

---

## File map

```
wenb/
├── index.html          ← landing page (YopiLemon)
├── chat.html           ← chat UI
├── login.html          ← multi-step Discord login (join → username → code → welcome)
├── config.js           ← public model list only (no key)
├── auth.js             ← frontend auth (talks to /api/me, /auth/*)
├── login.js            ← login page step controller
├── chat.js             ← chat (streams from /api/chat)
├── script.js           ← landing-page interactivity
├── styles.css          ← design system
├── app.css             ← auth + chat styles
└── server/             ← Node backend (this folder)
    ├── package.json
    ├── server.js       ← express app: static, username/code auth, proxy
    ├── bot.js          ← Discord REST helpers (member search, DM, code)
    ├── .env.example
    ├── .gitignore
    └── README.md       ← you are here
```
