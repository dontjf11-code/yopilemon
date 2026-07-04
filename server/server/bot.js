/* ============================================================
   YopiLemon — Discord helpers (REST, no persistent gateway)
   ============================================================
   We talk to the Discord REST API directly with fetch. This keeps
   the service stateless: Render's free tier spins idle webservices
   down after ~15 min, and a REST-only approach survives that
   wake/sleep cycle (a logged-in gateway would not). The trade-off
   is the bot shows as offline — see README.md if you want it online.
   ============================================================ */

const API = "https://discord.com/api/v10";

/* ---- Fetch a Discord user from their OAuth2 access token ---- */
export async function getDiscordUser(accessToken) {
  const res = await fetch(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord /users/@me failed: ${res.status} ${body}`);
  }
  const u = await res.json();
  return {
    id: u.id,
    username: u.username,
    global_name: u.global_name || null,
    avatar: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
      : null,
  };
}

/* ---- Is this user a member of the required guild? ----
   Uses the bot token (Authorization: Bot ...). The bot must be a
   member of the guild for this lookup to succeed. Returns a boolean;
   never throws on a normal 404 (user not in guild). */
export async function isMember(guildId, userId, botToken) {
  const res = await fetch(`${API}/guilds/${guildId}/members/${userId}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (res.ok) return true;
  if (res.status === 404) return false; // not a member
  // Anything else (403, 401, rate limit, 5xx) — fail closed.
  const body = await res.text().catch(() => "");
  throw new Error(
    `Discord guild member lookup failed: ${res.status} ${body}. ` +
      `Make sure the bot is in the guild and the Server Members Intent is enabled.`
  );
}

/* ---- Build the OAuth2 authorize URL ---- */
export function authorizeUrl({ clientId, redirectUri, state, scope = "identify" }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope,
    state,
    prompt: "consent",
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

/* ---- Exchange an authorization code for tokens ---- */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord token exchange failed: ${res.status} ${text}`);
  }
  return res.json(); // { access_token, ... }
}

/* ============================================================
   Bot-token helpers for the username + DM-code login flow
   ============================================================
   The bot searches the guild member list for a username, opens a
   DM channel with that member, and sends a one-time code. This
   proves the person at the keyboard received the DM — i.e. they
   control that Discord account — without OAuth2.
   ============================================================ */

/* ---- Find a guild member by Discord username (exact, case-insensitive).
   `query` is the username (without the @). We fetch the guild's member
   list (paginated, 1000 at a time) and match on `user.username` or the
   member's server nickname. Returns the full member object or null.
   Requires the bot to have View Channels / Read Messages in the guild
   (default for bots) and the Server Members Intent enabled in the
   Developer Portal for the /members endpoint to return non-empty. */
export async function findMemberByUsername(guildId, query, botToken) {
  const want = String(query || "").trim().toLowerCase().replace(/^@/, "");
  if (!want) return null;

  let after = "0";
  for (let page = 0; page < 10; page++) {
    const url = `${API}/guilds/${guildId}/members?limit=1000&after=${after}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Discord guild members list failed: ${res.status} ${body}. ` +
          `Make sure the bot is in the guild and Server Members Intent is enabled.`
      );
    }
    const members = await res.json();
    if (!members.length) return null;

    for (const m of members) {
      const u = m.user || {};
      const username = (u.username || "").toLowerCase();
      const nick = (m.nick || "").toLowerCase();
      const globalName = (u.global_name || "").toLowerCase();
      if (username === want || nick === want || globalName === want) {
        return {
          id: u.id,
          username: u.username,
          global_name: u.global_name || null,
          avatar: u.avatar
            ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=256`
            : null,
          nick: m.nick || null,
        };
      }
    }
    // Next page
    const lastId = members[members.length - 1]?.user?.id;
    if (!lastId || members.length < 1000) return null;
    after = lastId;
  }
  return null;
}

/* ---- Open a DM channel with a user (returns a channel id) ---- */
export async function createDM(userId, botToken) {
  const res = await fetch(`${API}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord createDM failed: ${res.status} ${body}`);
  }
  const ch = await res.json();
  return ch.id;
}

/* ---- Send a message to a channel ---- */
export async function sendDM(channelId, content, botToken) {
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord sendDM failed: ${res.status} ${body}`);
  }
  return res.json();
}

/* ---- Fetch a member by id (used after verify to refresh pfp/name) ---- */
export async function getMember(guildId, userId, botToken) {
  const res = await fetch(`${API}/guilds/${guildId}/members/${userId}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!res.ok) return null;
  const m = await res.json();
  const u = m.user || {};
  return {
    id: u.id,
    username: u.username,
    global_name: u.global_name || null,
    avatar: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=256`
      : null,
    nick: m.nick || null,
  };
}

