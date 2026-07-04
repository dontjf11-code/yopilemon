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
};

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

    req.session.user = user;
    console.log("[YopiLemon] /auth/verify OK — session set for", user.username, "secure?", req.secure, "proto", req.protocol);
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
  res.json({ user: req.session.user });
});

/* ============================================================
   Chat proxy — keeps the upstream key + endpoint server-side
   ============================================================ */
app.post("/api/chat", requireUser, async (req, res) => {
  const { model, messages } = req.body || {};
  if (!model || typeof model !== "string") {
    return res.status(400).json({ error: "Missing 'model'." });
  }
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "Missing 'messages' array." });
  }

  let upstream;
  try {
    upstream = await fetch(`${CONFIG.upstream}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.upstreamKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true, temperature: 0.7 }),
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

  // Pass the SSE stream straight through to the client unchanged.
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.status(200);
  const reader = upstream.body.getReader();
  const closed = () => {};
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch (err) {
      // Client disconnected or stream errored — best-effort end.
    } finally {
      try { res.end(); } catch { closed(); }
    }
  })();
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