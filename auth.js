/* ============================================================
   YopiLemon — auth (Discord, server-backed session)
   ============================================================
   There is no client-side user store. Identity comes from the
   server session cookie set during Discord OAuth2. This module is
   a thin wrapper around two same-origin endpoints:

     GET  /api/me         -> { user: { id, name, avatar, username } } | 401
     POST /auth/logout    -> clears the session

   The server enforces that the Discord user is a member of the
   required guild before it ever sets a session.
   ============================================================ */
(function () {
  "use strict";

  let cachedUser = null;      // resolved per page load
  let cachedPromise = null;   // dedupes concurrent fetches

  /* ---- public API ---- */
  const Auth = {
    // Resolves to { id, name, avatar, username } or null.
    // Cached for the lifetime of the page.
    current() {
      if (cachedUser) return cachedUser;
      if (cachedPromise) return cachedPromise;
      cachedPromise = fetch("/api/me", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          cachedUser = data ? data.user : null;
          cachedPromise = null;
          return cachedUser;
        })
        .catch(() => {
          cachedUser = null;
          cachedPromise = null;
          return null;
        });
      return cachedPromise;
    },

    isLoggedIn() {
      // Synchronous best-effort; use Auth.current() for the real answer.
      return !!cachedUser;
    },

    async logout() {
      try {
        await fetch("/auth/logout", {
          method: "POST",
          credentials: "include",
        });
      } catch {
        /* ignore — we navigate away regardless */
      }
      cachedUser = null;
    },
  };

  /* ---- expose ---- */
  window.Auth = Auth;

  /* ---- shared nav auth state ----
     Renders the right-side nav actions on every page that has a
     [data-auth-slot]. Runs on DOMContentLoaded. */
  async function renderAuthInNav() {
    const slots = document.querySelectorAll("[data-auth-slot]");
    if (!slots.length) return;
    const user = await Auth.current();

    let html;
    if (user) {
      const initial = (user.name || user.username || "?")[0].toUpperCase();
      const avatar = user.avatar
        ? `<img class="nav__avatar nav__avatar-img" src="${escapeAttr(user.avatar)}" alt="" />`
        : `<span class="nav__avatar" aria-hidden="true">${escapeHtml(initial)}</span>`;
      // Admin button only renders for the owner account (isAdmin is
      // stamped server-side from ADMIN_USERNAME).
      const adminBtn = user.isAdmin
        ? `<a href="admin.html" class="btn btn--ghost nav__admin">Admin</a>`
        : "";
      html = `${adminBtn}
         <a href="chat.html" class="btn btn--ghost">Chat</a>
         <span class="nav__user" title="${escapeAttr(user.username || user.name)}">
           ${avatar}
           <span class="nav__username">${escapeHtml(user.name || user.username)}</span>
         </span>
         <button class="btn btn--ghost" id="logoutBtn" type="button">Log out</button>`;
    } else {
      html = `<a href="login.html" class="btn btn--ghost">Sign in</a>
         <a href="login.html?mode=signup" class="btn btn--primary">Start free</a>`;
    }
    slots.forEach((s) => (s.innerHTML = html));

    if (user) {
      const btn = document.getElementById("logoutBtn");
      if (btn) {
        btn.addEventListener("click", async () => {
          await Auth.logout();
          location.href = "index.html";
        });
      }
    }
  }

  /* ---- tiny escape helpers (kept local so this file is standalone) ---- */
  function escapeHtml(s) {
    return (s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

  // Run on every page that includes this script
  document.addEventListener("DOMContentLoaded", renderAuthInNav);
  window.YopilAuth = { renderAuthInNav };
})();
