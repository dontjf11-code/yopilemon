/* ============================================================
   YopiLemon — on-disk JSON store
   ============================================================
   Persists three things to JSON files under ./data (created on
   first write):
     users.json          — known users + last-seen + banned flag
     conversations.json  — per-user conversation logs (admin view)
     (bans live inside users.json as a flag, not a separate file)

   Render's free-tier disk is ephemeral: it survives idle spin-down
   within a single deploy but is wiped on every redeploy. So this
   store is best-effort for live oversight, not a durable archive.
   Every read/write is wrapped so a corrupt file never crashes the
   app — it just resets to empty.

   All functions are synchronous-ish via a simple write queue so we
   don't lose writes when two requests land at once.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const CONVOS_FILE = path.join(DATA_DIR, "conversations.json");

// Ensure the data directory exists (best-effort; ignore if present).
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* already exists or unwritable — reads will fall back to empty */
}

/* ---- safe JSON read/write ---- */
function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// Serialize writes so concurrent requests don't clobber each other.
let writeChain = Promise.resolve();
function writeJson(file, data) {
  writeChain = writeChain
    .then(
      () =>
        new Promise((resolve) => {
          try {
            fs.writeFileSync(file, JSON.stringify(data, null, 2));
          } catch (err) {
            console.error(`[YopiLemon] store write failed (${path.basename(file)}):`, err.message);
          }
          resolve();
        })
    )
    .catch(() => {});
  return writeChain;
}

/* ============================================================
   Users
   ============================================================ */
/* users = { [discordId]: { id, username, name, avatar, lastSeen, banned, bannedAt, bannedReason } } */

export function getUsers() {
  return readJson(USERS_FILE, {});
}

export function getUser(id) {
  const users = getUsers();
  return users[id] || null;
}

export function isBanned(id) {
  const u = getUser(id);
  return !!(u && u.banned);
}

// Upsert a known user (called on successful login). Never overwrites
// the banned flag — that's admin-controlled.
export function upsertUser(user) {
  const users = getUsers();
  const existing = users[user.id] || {};
  users[user.id] = {
    id: user.id,
    username: user.username,
    name: user.name,
    avatar: user.avatar,
    firstSeen: existing.firstSeen || Date.now(),
    lastSeen: Date.now(),
    banned: existing.banned || false,
    bannedAt: existing.bannedAt || null,
    bannedReason: existing.bannedReason || null,
  };
  writeJson(USERS_FILE, users);
}

export function banUser(id, reason = "") {
  const users = getUsers();
  if (!users[id]) return false;
  users[id].banned = true;
  users[id].bannedAt = Date.now();
  users[id].bannedReason = reason;
  writeJson(USERS_FILE, users);
  return true;
}

export function unbanUser(id) {
  const users = getUsers();
  if (!users[id]) return false;
  users[id].banned = false;
  users[id].bannedAt = null;
  users[id].bannedReason = null;
  writeJson(USERS_FILE, users);
  return true;
}

/* ============================================================
   Conversation logs (admin view)
   ============================================================
   convos = {
     [discordId]: {
       [convoId]: {
         id, title, model, createdAt, updatedAt,
         messages: [ { role, content, model, at } ]
       }
     }
   }
   We cap stored messages per conversation to keep the file from
   growing without bound (older messages drop off the admin view).
*/
const MAX_MSGS_PER_CONVO = 200;

export function getConversationsForUser(userId) {
  const all = readJson(CONVOS_FILE, {});
  return all[userId] || {};
}

export function getAllConversations() {
  return readJson(CONVOS_FILE, {});
}

// Ensure a conversation record exists and return it.
function ensureConvo(all, userId, convoId, title, model) {
  if (!all[userId]) all[userId] = {};
  if (!all[userId][convoId]) {
    all[userId][convoId] = {
      id: convoId,
      title: title || "New chat",
      model: model || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
  }
  return all[userId][convoId];
}

// Append a message to a conversation log. Called from /api/chat as
// messages stream in. Title/model are updated from the latest turn.
export function appendMessage(userId, convoId, { role, content, model, title }) {
  const all = readJson(CONVOS_FILE, {});
  const convo = ensureConvo(all, userId, convoId, title, model);
  if (title) convo.title = title;
  if (model) convo.model = model;
  convo.updatedAt = Date.now();
  convo.messages.push({ role, content, model: role === "ai" ? model : null, at: Date.now() });
  // Trim oldest if over cap.
  if (convo.messages.length > MAX_MSGS_PER_CONVO) {
    convo.messages = convo.messages.slice(-MAX_MSGS_PER_CONVO);
  }
  writeJson(CONVOS_FILE, all);
}

// Delete a single conversation log (admin or user cleanup).
export function deleteConversation(userId, convoId) {
  const all = readJson(CONVOS_FILE, {});
  if (!all[userId] || !all[userId][convoId]) return false;
  delete all[userId][convoId];
  writeJson(CONVOS_FILE, all);
  return true;
}
