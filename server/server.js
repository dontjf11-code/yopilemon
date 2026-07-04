/* ============================================================
   YopiLemon — server
   ============================================================
   One Express app that:
     1. Serves the static site (the parent directory).
     2. Runs a Discord username + DM-code login flow:
        - Client submits a Discord username.
        - Bot looks that user up in the guild; if found, DMs them a
          one-time 6-digit code.
        - Client submits the code; on match, a session is created.
        - Login is impossible unless the Discord account is a member
          of the required guild AND can receive the DM.
     3. Proxies chat requests to the upstream OpenAI-compatible
        endpoint so the API key and provider stay server-side.

   The browser only ever talks to same-origin /auth/* and /api/*
   routes. The upstream host and key are never shipped to the client.
   ============================================================ */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieSession from "cookie-session";

import {
  findMemberByUsername,
  createDM,
  sendDM,
  getMember,
} from "./bot.js";
import {
  getUsers,
  upsertUser,
  isBanned,
  banUser,
  unbanUser,
  getAllConversations,
  getConversationsForUser,
  deleteConversation,
  appendMessage,
} from "./store.js";

/* ---- env ---- */
const REQUIRED = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_INVITE_LINK",
  "UPSTREAM_ENDPOINT",
  "UPSTREAM_API_KEY",
  "SESSION_SECRET",
];
for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(`[YopiLemon] Missing required env var: ${k}`);
    process.exit(1);
  }
}
const CONFIG = {
  botToken: process.env.DISCORD_BOT_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID,
  inviteLink: process.env.DISCORD_INVITE_LINK,
  upstream: process.env.UPSTREAM_ENDPOINT.replace(/\/$/, ""),
  upstreamKey: process.env.UPSTREAM_API_KEY,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  port: parseInt(process.env.PORT || "3000", 10),
  // Discord username (without @) that owns the admin panel. Override
  // with ADMIN_USERNAME if you ever change it; defaults to "yopixs".
  adminUsername: (process.env.ADMIN_USERNAME || "yopixs").trim().toLowerCase(),
};

/* ---- admin check ----
   Admin is whoever controls the designated Discord account. We match
   case-insensitively on the stored username. The flag is attached to
   the session user so the client can show the Admin button. */
function isAdminUser(user) {
  return !!user && String(user.username || "").trim().toLowerCase() === CONFIG.adminUsername;
}

/* ---- app ---- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.resolve(__dirname, ".."); // the wenb/ folder
// SESSION_SECRET may be a single string or comma-separated keys
// (cookie-session rotates through multiple keys for graceful rotation).
const SESSION_KEYS = process.env.SESSION_SECRET.split(/,/).filter(Boolean);

const app = express();
app.disable("x-powered-by");
// Render (and most PaaS) terminate TLS at a proxy and forward plain
// HTTP to the app. Trust one hop of X-Forwarded-* so req.protocol,
// req.secure, and req.ip reflect what the browser actually saw.
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(
  cookieSession({
    name: "yopil_session",
    keys: SESSION_KEYS,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
  })
);

/* ---- DM-code store (in-memory; fine for single-instance) ----
   pending[userId] = { codeHash, expiresAt, attempts }
   We hash the code so a process memory dump wouldn't reveal it. */
const PENDING = new Map();
const CODE_TTL_MS = 10 * 60 * 1000;     // 10 minutes
const MAX_ATTEMPTS = 5;
function newCode() {
  // 6-digit numeric code, zero-padded
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}
function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}
// Tidy expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of PENDING) if (p.expiresAt < now) PENDING.delete(id);
}, 5 * 60 * 1000).unref();

/* ---- auth middleware ---- */
function requireUser(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: "Not authenticated" });
}

/* ---- helpers for the username/code flow ---- */
function toPublicUser(member) {
  return {
    id: member.id,
    name: member.global_name || member.nick || member.username || "User",
    avatar: member.avatar,
    username: member.username,
  };
}

/* ============================================================
   Auth routes — username + DM-code flow
   ============================================================ */

/* Public config the login page needs (invite link). No secrets. */
app.get("/auth/config", (req, res) => {
  res.json({ inviteLink: CONFIG.inviteLink });
});

/* Step 1 — look up a username in the guild and DM a code.
   Responds the same way whether or not the username was found,
   to avoid leaking which usernames exist in the server. */
app.post("/auth/request-code", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  if (!username) return res.status(400).json({ error: "Enter your Discord username." });

  try {
    const member = await findMemberByUsername(CONFIG.guildId, username, CONFIG.botToken);
    if (!member) {
      // Don't reveal that the username wasn't found.
      return res.json({ ok: true, sent: true });
    }

    const code = newCode();
    PENDING.set(member.id, {
      codeHash: hashCode(code),
      expiresAt: Date.now() + CODE_TTL_MS,
      attempts: 0,
    });

    const channelId = await createDM(member.id, CONFIG.botToken);
    await sendDM(
      channelId,
      `🍋 Your YopiLemon login code is **${code}**.\n\n` +
        `It expires in 10 minutes. Don't share it with anyone — we'll never ask for it outside this DM.`,
      CONFIG.botToken
    );

    // Remember which user this code is for, keyed by a handle the
    // client holds, so /auth/verify doesn't have to re-prompt for
    // the username. We use the user id (already known to the bot).
    PENDING.get(member.id).handle = member.id;

    return res.json({ ok: true, sent: true });
  } catch (err) {
    console.error("[YopiLemon] request-code error:", err.message);
    // Surface a generic error; never expose Discord API details.
    return res.status(500).json({ error: "Couldn't send a code right now. Try again." });
  }
});

/* Step 2 — verify the code. Body: { username, code }.
   We re-resolve the username to a member id (so the client can't
   claim a code was for a different user than the one it requested
   for), then check the code against the stored hash. */
app.post("/auth/verify", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const code = String(req.body?.code || "").trim();
  if (!username) return res.status(400).json({ error: "Enter your Discord username." });
  if (!code) return res.status(400).json({ error: "Enter the code we DM'd you." });

  try {
    const member = await findMemberByUsername(CONFIG.guildId, username, CONFIG.botToken);
    if (!member) {
      // Same neutral message as request-code to avoid leaking.
      return res.status(401).json({ error: "That code didn't match, or it expired." });
    }

    const pending = PENDING.get(member.id);
    if (!pending) {
      return res.status(401).json({ error: "No code on file. Request a new one." });
    }
    if (Date.now() > pending.expiresAt) {
      PENDING.delete(member.id);
      return res.status(401).json({ error: "That code expired. Request a new one." });
    }
    if (pending.attempts >= MAX_ATTEMPTS) {
      PENDING.delete(member.id);
      return res.status(429).json({ error: "Too many tries. Request a new code." });
    }

    pending.attempts += 1;
    if (hashCode(code) !== pending.codeHash) {
      return res.status(401).json({ error: "That code didn't match, or it expired." });
    }

    // Success — consume the code and create the session.
    PENDING.delete(member.id);

    // Refresh the member's pfp/name in case it changed since lookup.
    const fresh = await getMember(CONFIG.guildId, member.id, CONFIG.botToken);
    const user = toPublicUser(fresh || member);

    // Reject banned users before issuing a session.
    if (isBanned(user.id)) {
      console.log("[YopiLemon] /auth/verify rejected banned user:", user.username);
      return res.status(403).json({ error: "Your account has been suspended. Contact an admin if you think this is a mistake." });
    }

    // Persist/refresh the known user and stamp the admin flag.
    upsertUser(user);
    user.isAdmin = isAdminUser(user);

    req.session.user = user;
    console.log("[YopiLemon] /auth/verify OK — session set for", user.username, "admin?", user.isAdmin, "secure?", req.secure, "proto", req.protocol);
    return res.json({ ok: true, user });
  } catch (err) {
    console.error("[YopiLemon] verify error:", err.message);
    return res.status(500).json({ error: "Couldn't verify right now. Try again." });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const hasSession = !!req.session && !!req.session.user;
  console.log("[YopiLemon] /api/me — hasSession:", hasSession, "secure?", req.secure, "cookies?", !!req.headers.cookie);
  if (!hasSession) return res.status(401).json({ error: "Not authenticated" });

  const user = req.session.user;
  // Re-check ban on every /api/me so a ban issued mid-session kicks in
  // on the next page load. Admins can't be banned via the panel.
  if (isBanned(user.id) && !isAdminUser(user)) {
    req.session = null;
    return res.status(403).json({ error: "Your account has been suspended." });
  }
  // Keep the admin flag fresh in case ADMIN_USERNAME changed.
  user.isAdmin = isAdminUser(user);
  res.json({ user });
});

/* ============================================================
   Chat proxy — keeps the upstream key + endpoint server-side
   ============================================================ */

// Load the allowed model ids once from the public config so the
// server and the client picker stay in sync. The file lives in the
// parent directory (the static root).
const ALLOWED_MODELS = (() => {
  try {
    const raw = fs.readFileSync(path.join(STATIC_ROOT, "config.js"), "utf8");
    const match = raw.match(/models:\s*\[([\s\S]*?)\n\s*\]/);
    if (!match) return new Set();
    const ids = new Set();
    for (const m of match[1].matchAll(/id:\s*"([^"]+)"/g)) ids.add(m[1]);
    return ids;
  } catch {
    return new Set();
  }
})();

app.post("/api/chat", requireUser, async (req, res) => {
  const { model, messages, convoId, title, effort, system } = req.body || {};
  if (!model || typeof model !== "string") {
    return res.status(400).json({ error: "Missing 'model'." });
  }
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "Missing 'messages' array." });
  }
  // Reject models we don't expose. Saves an upstream call and stops
  // anyone bypassing the picker with an arbitrary id.
  if (ALLOWED_MODELS.size && !ALLOWED_MODELS.has(model)) {
    return res.status(400).json({ error: "That model isn't available." });
  }

  // Reasoning effort: validate against the values the upstream API
  // accepts (effortLevel: low/medium/high/xhigh). Defaults to medium.
  const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
  const effortLevel = ALLOWED_EFFORTS.has(effort) ? effort : "medium";

  // System instruction: the client sends the user's custom instruction
  // (or the default). We inject it as a leading system message so the
  // model is grounded every turn. If the history already starts with a
  // system message (it won't, since the client only sends user/assistant
  // turns), replace it instead of duplicating.
  const sysContent = typeof system === "string" && system.trim()
    ? system.trim().slice(0, 4000)
    : null;
  const upstreamMessages = [];
  if (sysContent) {
    upstreamMessages.push({ role: "system", content: sysContent });
  }
  for (const m of messages) {
    // Skip any client-supplied system messages — only the server's
    // injected one is trusted.
    if (m.role === "system") continue;
    if (typeof m.content !== "string") continue;
    upstreamMessages.push({ role: m.role, content: m.content });
  }
  if (upstreamMessages.length === 0 || upstreamMessages[upstreamMessages.length - 1].role !== "user") {
    // Need at least one user turn to make a completion.
    if (upstreamMessages.length === 0) {
      return res.status(400).json({ error: "Missing a user message." });
    }
  }

  const user = req.session.user;
  // Admins can't be banned; everyone else is checked here too.
  if (isBanned(user.id) && !isAdminUser(user)) {
    req.session = null;
    return res.status(403).json({ error: "Your account has been suspended." });
  }

  // Log the user's latest message before streaming. We log only the
  // final user turn (the last user-role entry) plus the streamed
  // assistant reply, which is enough for admin oversight without
  // re-sending the whole history every turn.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const logConvoId = String(convoId || `c_${Date.now()}`);
  if (lastUser && typeof lastUser.content === "string") {
    try {
      appendMessage(user.id, logConvoId, {
        role: "user",
        content: lastUser.content,
        title: title || null,
        model,
      });
    } catch (err) {
      console.error("[YopiLemon] log user msg failed:", err.message);
    }
  }

  let upstream;
  try {
    upstream = await fetch(`${CONFIG.upstream}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.upstreamKey}`,
      },
      body: JSON.stringify({
        model,
        messages: upstreamMessages,
        stream: true,
        temperature: 0.7,
        // Reasoning effort — field name + values per the upstream
        // (sh00t.host) docs example: "effortLevel": "xhigh".
        effortLevel,
      }),
    });
  } catch (err) {
    console.error("[YopiLemon] upstream fetch error:", err.message);
    return res.status(502).json({ error: "Upstream request failed." });
  }

  if (!upstream.ok || !upstream.body) {
    let detail = "";
    try {
      detail = await upstream.text();
    } catch {
      /* ignore */
    }
    console.error(`[YopiLemon] upstream ${upstream.status}: ${detail.slice(0, 200)}`);
    return res.status(502).json({
      error: `Upstream returned ${upstream.status} ${upstream.statusText}.`,
    });
  }

  // Pass the SSE stream to the client AND tee it so we can capture
  // the assistant's reply for the admin conversation log.
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.status(200);

  const reader = upstream.body.getReader();
  let aiBuffer = "";          // accumulated assistant text for logging
  let sseCarry = "";          // partial SSE line across chunks
  const decoder = new TextDecoder();

  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);

        // Parse SSE deltas out of this chunk so we can log the reply.
        sseCarry += decoder.decode(value, { stream: true });
        const lines = sseCarry.split("\n");
        sseCarry = lines.pop(); // keep the last (possibly partial) line
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload);
            const delta = json?.choices?.[0]?.delta?.content || "";
            if (delta) aiBuffer += delta;
          } catch {
            /* partial JSON — wait for more */
          }
        }
      }
    } catch (err) {
      // Client disconnected or stream errored — best-effort end.
    } finally {
      try { res.end(); } catch { /* ignore */ }
      // Persist the assistant reply (best-effort; never block on it).
      if (aiBuffer.trim()) {
        try {
          appendMessage(user.id, logConvoId, {
            role: "ai",
            content: aiBuffer,
            model,
            title: title || null,
          });
        } catch (err) {
          console.error("[YopiLemon] log ai msg failed:", err.message);
        }
      }
    }
  })();
});

/* ============================================================
   Admin routes — owner only (isAdminUser on the session)
   ============================================================ */
function requireAdmin(req, res, next) {
  const user = req.session && req.session.user;
  if (!user || !isAdminUser(user)) {
    return res.status(403).json({ error: "Admin only." });
  }
  next();
}

// List all known users with their ban status + last seen.
app.get("/api/admin/users", requireAdmin, (req, res) => {
  const users = getUsers();
  const list = Object.values(users).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  res.json({ users: list, admin: req.session.user.username });
});

// Ban a user by discord id. Body: { id, reason? }.
app.post("/api/admin/ban", requireAdmin, (req, res) => {
  const id = String(req.body?.id || "");
  if (!id) return res.status(400).json({ error: "Missing 'id'." });
  // Never allow banning the admin account.
  const target = getUsers()[id];
  if (target && isAdminUser(target)) {
    return res.status(400).json({ error: "Can't ban the admin account." });
  }
  const ok = banUser(id, String(req.body?.reason || ""));
  if (!ok) return res.status(404).json({ error: "User not found." });
  console.log(`[YopiLemon] admin banned ${target?.username || id}`);
  res.json({ ok: true });
});

// Unban a user by discord id.
app.post("/api/admin/unban", requireAdmin, (req, res) => {
  const id = String(req.body?.id || "");
  if (!id) return res.status(400).json({ error: "Missing 'id'." });
  const ok = unbanUser(id);
  if (!ok) return res.status(404).json({ error: "User not found." });
  console.log(`[YopiLemon] admin unbanned ${id}`);
  res.json({ ok: true });
});

// All conversations, grouped by user id.
app.get("/api/admin/conversations", requireAdmin, (req, res) => {
  res.json({ conversations: getAllConversations() });
});

// Conversations for a single user.
app.get("/api/admin/conversations/:userId", requireAdmin, (req, res) => {
  res.json({ conversations: getConversationsForUser(req.params.userId) });
});

// Delete a specific conversation log.
app.delete("/api/admin/conversations/:userId/:convoId", requireAdmin, (req, res) => {
  const ok = deleteConversation(req.params.userId, req.params.convoId);
  if (!ok) return res.status(404).json({ error: "Conversation not found." });
  res.json({ ok: true });
});

/* ============================================================
   Static site (served from the parent directory)
   ============================================================ */
app.use(
  express.static(STATIC_ROOT, {
    index: "index.html",
    extensions: ["html"],
    setHeaders: (res, filePath) => {
      // Never cache the auth/chat entry points so role changes appear fast.
      if (/(index|login|chat)\.html$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  })
);

// Anything else → landing page (single-page-ish fallback).
app.get("*", (req, res) => {
  res.sendFile(path.join(STATIC_ROOT, "index.html"));
});

app.listen(CONFIG.port, () => {
  console.log(`[YopiLemon] listening on :${CONFIG.port}`);
  console.log(`[YopiLemon] static root: ${STATIC_ROOT}`);
  console.log(`[YopiLemon] guild: ${CONFIG.guildId}`);
  console.log(`[YopiLemon] invite: ${CONFIG.inviteLink}`);
});