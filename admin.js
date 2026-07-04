/* ============================================================
   YopiLemon — admin panel
   Owner-only (server checks isAdminUser on every /api/admin/* call).
   Lists signed-in users with ban controls, and a per-user
   conversation log viewer.
   ============================================================ */
(async function () {
  "use strict";

  /* ---- Auth gate ---- */
  const user = window.Auth ? await Auth.current() : null;
  if (!user) { location.replace("login.html"); return; }
  if (!user.isAdmin) { location.replace("chat.html"); return; }

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) =>
    (s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));

  // Show who's signed in.
  const ownerEl = $("adminOwner");
  if (ownerEl) {
    ownerEl.querySelector("strong").textContent = user.name || user.username;
    ownerEl.hidden = false;
  }

  /* ---- run init when DOM is ready ----
     Same pattern as chat.js: the await above can resolve after
     DOMContentLoaded, so check readyState. */
  function whenReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  /* ============================================================
     State + tabs
     ============================================================ */
  let USERS = [];
  let CONVOS = {};
  let banTarget = null; // { id, username }

  function setTab(name) {
    const isUsers = name === "users";
    $("navUsers").classList.toggle("is-active", isUsers);
    $("navConvos").classList.toggle("is-active", !isUsers);
    $("panelUsers").hidden = !isUsers;
    $("panelConvos").hidden = isUsers;
    $("adminTitle").textContent = isUsers ? "Users" : "Conversations";
  }
  $("navUsers").addEventListener("click", () => setTab("users"));
  $("navConvos").addEventListener("click", () => setTab("convos"));

  /* ============================================================
     Users
     ============================================================ */
  async function loadUsers() {
    try {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load users");
      const data = await res.json();
      USERS = data.users || [];
      renderUsers();
    } catch (err) {
      $("usersEmpty").textContent = err.message;
      $("usersEmpty").hidden = false;
    }
  }

  function fmtDate(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function renderUsers() {
    const q = ($("userSearch").value || "").trim().toLowerCase();
    const body = $("usersBody");
    body.innerHTML = "";
    const filtered = USERS.filter((u) =>
      !q || String(u.username || "").toLowerCase().includes(q) || String(u.name || "").toLowerCase().includes(q)
    );
    $("usersEmpty").hidden = !!filtered.length;
    if (!filtered.length) {
      if (!USERS.length) $("usersEmpty").textContent = "No users yet.";
      else $("usersEmpty").textContent = "No users match your search.";
      return;
    }
    for (const u of filtered) {
      const tr = document.createElement("tr");
      tr.className = u.banned ? "is-banned" : "";
      const avatar = u.avatar
        ? `<img class="admin__avatar" src="${escapeHtml(u.avatar)}" alt="" />`
        : `<span class="admin__avatar admin__avatar--init">${escapeHtml((u.name || u.username || "?")[0].toUpperCase())}</span>`;
      const status = u.banned
        ? `<span class="badge badge--ban">Banned</span>`
        : `<span class="badge badge--ok">Active</span>`;
      const actions = u.isAdmin
        ? `<span class="admin__muted">admin</span>`
        : u.banned
          ? `<button class="btn btn--ghost btn--sm" data-unban="${escapeHtml(u.id)}" type="button">Unban</button>`
          : `<button class="btn btn--ghost btn--sm" data-ban="${escapeHtml(u.id)}" data-name="${escapeHtml(u.username || u.name)}" type="button">Ban</button>`;
      tr.innerHTML = `
        <td class="admin__user-cell">${avatar}<span><strong>${escapeHtml(u.name || u.username || "User")}</strong></span></td>
        <td class="admin__muted">@${escapeHtml(u.username || "—")}</td>
        <td class="admin__muted">${fmtDate(u.firstSeen)}</td>
        <td class="admin__muted">${fmtDate(u.lastSeen)}</td>
        <td>${status}</td>
        <td>${actions}</td>
      `;
      body.appendChild(tr);
    }

    // Wire ban/unban buttons.
    body.querySelectorAll("[data-ban]").forEach((b) =>
      b.addEventListener("click", () => openBanModal(b.dataset.ban, b.dataset.name))
    );
    body.querySelectorAll("[data-unban]").forEach((b) =>
      b.addEventListener("click", () => doUnban(b.dataset.unban))
    );
  }

  $("userSearch").addEventListener("input", renderUsers);
  $("refreshUsers").addEventListener("click", loadUsers);

  /* ============================================================
     Ban modal
     ============================================================ */
  function openBanModal(id, name) {
    banTarget = { id, name };
    $("banModalTitle").textContent = `Ban @${name}?`;
    $("banReason").value = "";
    $("banModal").classList.add("is-open");
    $("banModal").setAttribute("aria-hidden", "false");
  }
  function closeBanModal() {
    banTarget = null;
    $("banModal").classList.remove("is-open");
    $("banModal").setAttribute("aria-hidden", "true");
  }
  $("banCancel").addEventListener("click", closeBanModal);
  $("banModal").addEventListener("click", (e) => {
    if (e.target === $("banModal")) closeBanModal();
  });
  $("banConfirm").addEventListener("click", async () => {
    if (!banTarget) return;
    const reason = $("banReason").value.trim();
    try {
      const res = await fetch("/api/admin/ban", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: banTarget.id, reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Ban failed.");
      closeBanModal();
      await loadUsers();
    } catch (err) {
      alert(err.message);
    }
  });

  async function doUnban(id) {
    if (!confirm("Unban this user?")) return;
    try {
      const res = await fetch("/api/admin/unban", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Unban failed.");
      await loadUsers();
    } catch (err) {
      alert(err.message);
    }
  }

  /* ============================================================
     Conversations
     ============================================================ */
  async function loadConvos() {
    try {
      const res = await fetch("/api/admin/conversations", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load conversations");
      const data = await res.json();
      CONVOS = data.conversations || {};
      renderConvoUserSelect();
      renderConvos();
    } catch (err) {
      $("convosEmpty").textContent = err.message;
      $("convosEmpty").hidden = false;
    }
  }

  function renderConvoUserSelect() {
    const sel = $("convoUserSelect");
    const ids = Object.keys(CONVOS).sort((a, b) => {
      const ua = USERS.find((u) => u.id === a);
      const ub = USERS.find((u) => u.id === b);
      return (ua?.username || a).localeCompare(ub?.username || b);
    });
    const prev = sel.value;
    sel.innerHTML = `<option value="">All users</option>` +
      ids.map((id) => {
        const u = USERS.find((x) => x.id === id);
        const label = u ? `@${u.username || u.name}` : id;
        return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
      }).join("");
    if (prev && ids.includes(prev)) sel.value = prev;
  }

  function renderConvos() {
    const filter = $("convoUserSelect").value;
    const body = $("convosBody");
    body.innerHTML = "";

    const userIds = filter ? [filter] : Object.keys(CONVOS);
    let total = 0;
    for (const uid of userIds) {
      const userConvos = CONVOS[uid] || {};
      const u = USERS.find((x) => x.id === uid);
      const uname = u ? `@${u.username || u.name}` : uid;
      const sorted = Object.values(userConvos).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (!sorted.length) continue;
      total += sorted.length;

      const group = document.createElement("div");
      group.className = "convo-group";
      group.innerHTML = `<div class="convo-group__head"><span class="convo-group__user">${escapeHtml(uname)}</span><span class="convo-group__count">${sorted.length} conversation${sorted.length > 1 ? "s" : ""}</span></div>`;
      for (const c of sorted) {
        const card = document.createElement("details");
        card.className = "convo-card";
        const updated = fmtDate(c.updatedAt);
        const msgCount = (c.messages || []).length;
        card.innerHTML = `
          <summary class="convo-card__head">
            <span class="convo-card__title">${escapeHtml(c.title || "New chat")}</span>
            <span class="convo-card__meta">${escapeHtml(c.model || "—")} · ${msgCount} msg · ${updated}</span>
          </summary>
          <div class="convo-card__body"></div>
        `;
        const bodyEl = card.querySelector(".convo-card__body");
        for (const m of c.messages || []) {
          const row = document.createElement("div");
          row.className = "convo-row convo-row--" + m.role;
          const who = m.role === "user" ? (u?.username || "user") : (m.model || "ai");
          row.innerHTML = `<span class="convo-row__who">${escapeHtml(who)}</span><span class="convo-row__text"></span>`;
          row.querySelector(".convo-row__text").textContent = m.content || "";
          bodyEl.appendChild(row);
        }
        if (!msgCount) bodyEl.innerHTML = `<p class="admin__muted">No messages.</p>`;
        group.appendChild(card);
      }
      body.appendChild(group);
    }

    $("convosEmpty").hidden = total > 0;
    if (total === 0) {
      $("convosEmpty").textContent = filter
        ? "No conversations for this user yet."
        : "No conversations logged yet. Logs accumulate as users chat.";
    }
  }

  $("convoUserSelect").addEventListener("change", renderConvos);
  $("refreshConvos").addEventListener("click", loadConvos);

  /* ---- logout ---- */
  $("adminLogout").addEventListener("click", async () => {
    await Auth.logout();
    location.href = "login.html";
  });

  /* ---- init ---- */
  function init() {
    setTab("users");
    loadUsers();
    loadConvos();
  }
  whenReady(init);
})();
