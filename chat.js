/* ============================================================
   YopiLemon — chat
   Streaming chat against the same-origin /api/chat proxy (which
   forwards to the upstream AI endpoint with the secret key), with
   a model picker and per-user conversation history persisted in
   localStorage. Auth is Discord, server-backed; the user object
   comes from /api/me.
   ============================================================ */
(async function () {
  "use strict";

  /* ---- Auth gate (async — backed by /api/me) ---- */
  const user = window.Auth ? await Auth.current() : null;
  if (!user) {
    location.replace("login.html");
    return;
  }

  const CFG = window.YOPIL_CONFIG;
  const MODELS = CFG.models;
  const MODEL_BY_ID = Object.fromEntries(MODELS.map((m) => [m.id, m]));

  /* ---- Maker colors (for the model logos) ----
     Sourced from config.js makerMeta so every maker listed there
     gets the right color + initial. Falls back to a neutral chip. */
  const MAKER_META = (CFG && CFG.makerMeta) || {};
  const makerColor = (maker) =>
    (MAKER_META[maker] && MAKER_META[maker].color) || "#6B6B57";
  const makerInitial = (maker) =>
    (MAKER_META[maker] && MAKER_META[maker].initial) || "✦";

  /* ---- tiny DOM helpers ---- */
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /* ---- state ---- */
  let conversations = {};      // { [id]: { id, title, model, createdAt, updatedAt, messages: [] } }
  let activeId = null;
  let currentModel = CFG.defaultModel;
  let isStreaming = false;
  let abortCtrl = null;

  /* ---- persistence (keyed by Discord user id) ---- */
  const userKey = () => `${CFG.storage.chats}:${user.id}`;
  const loadConversations = () => {
    try {
      conversations = JSON.parse(localStorage.getItem(userKey()) || "{}") || {};
    } catch { conversations = {}; }
  };
  const saveConversations = () => {
    localStorage.setItem(userKey(), JSON.stringify(conversations));
  };

  /* ---- model preference (global, not per-user) ---- */
  const loadModel = () => {
    const saved = localStorage.getItem(CFG.storage.model);
    if (saved && MODEL_BY_ID[saved]) currentModel = saved;
  };
  const saveModel = (id) => localStorage.setItem(CFG.storage.model, id);

  /* ============================================================
     Render: sidebar (conversations + user foot)
     ============================================================ */
  function renderSidebar() {
    // User foot — Discord avatar (or initial) + username
    const initial = (user.name || user.username || "?")[0].toUpperCase();
    const avatarHtml = user.avatar
      ? `<img class="nav__avatar nav__avatar-img" src="${escapeAttr(user.avatar)}" alt="" />`
      : `<span class="nav__avatar" aria-hidden="true">${escapeHtml(initial)}</span>`;
    $("sidebarFoot").innerHTML = `
      ${avatarHtml}
      <span>
        <span class="chat__user-name">${escapeHtml(user.name || user.username)}</span>
        <span class="chat__user-email">${escapeHtml(user.username ? "@" + user.username : "")}</span>
      </span>
      <button class="chat__logout" id="logoutBtn" type="button">Log out</button>
    `;
    $("logoutBtn").addEventListener("click", async () => {
      await Auth.logout();
      location.href = "login.html";
    });

    // Reveal the topbar Admin link only for the owner account.
    const adminLink = $("chatAdminLink");
    if (adminLink) adminLink.hidden = !user.isAdmin;

    // Conversation list (most recent first)
    const list = $("convoList");
    list.innerHTML = "";
    const sorted = Object.values(conversations).sort(
      (a, b) => b.updatedAt - a.updatedAt
    );
    if (!sorted.length) {
      const empty = el("div", "convo");
      empty.style.color = "var(--ink-300)";
      empty.style.fontSize = "13px";
      empty.style.padding = "8px 10px";
      empty.textContent = "No chats yet — start one!";
      list.appendChild(empty);
      return;
    }
    for (const c of sorted) {
      const row = el("div", "convo" + (c.id === activeId ? " is-active" : ""));
      row.dataset.id = c.id;
      row.innerHTML = `
        <span class="convo__icon">💬</span>
        <span class="convo__title">${escapeHtml(c.title || "New chat")}</span>
        <button class="convo__del" aria-label="Delete chat" title="Delete">✕</button>
      `;
      row.addEventListener("click", (e) => {
        if (e.target.closest(".convo__del")) return;
        openConversation(c.id);
      });
      row.querySelector(".convo__del").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteConversation(c.id);
      });
      list.appendChild(row);
    }
  }

  function deleteConversation(id) {
    delete conversations[id];
    if (activeId === id) {
      activeId = null;
      renderMessages();
      renderSidebar();
    } else {
      renderSidebar();
    }
    saveConversations();
  }

  /* ============================================================
     Render: model picker
     ============================================================ */
  const TIER_LABEL = {
    flagship: "Flagships",
    balanced: "Balanced",
    fast: "Fast",
    specialist: "Specialists",
  };
  const TIER_ORDER = ["flagship", "balanced", "fast", "specialist"];

  function renderModelMenu() {
    const menu = $("modelMenu");
    menu.innerHTML = "";
    for (const tier of TIER_ORDER) {
      const items = MODELS.filter((m) => m.tier === tier);
      if (!items.length) continue;
      menu.appendChild(el("div", "modelpicker__group", TIER_LABEL[tier]));
      for (const m of items) {
        const opt = el("div", "modelopt" + (m.id === currentModel ? " is-selected" : ""));
        opt.setAttribute("role", "option");
        opt.dataset.id = m.id;
        const color = makerColor(m.maker);
        opt.innerHTML = `
          <div class="modelopt__logo" style="background:${color}">${escapeHtml(makerInitial(m.maker))}</div>
          <div class="modelopt__body">
            <div class="modelopt__name">
              ${escapeHtml(m.name)}
              ${m.badge ? `<span class="modelpicker__badge">${escapeHtml(m.badge)}</span>` : ""}
              <span class="modelopt__maker">${escapeHtml(m.maker)}</span>
            </div>
            <div class="modelopt__blurb">${escapeHtml(m.blurb)}</div>
          </div>
          <svg class="modelopt__check" width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        `;
        opt.addEventListener("click", () => {
          selectModel(m.id);
          closeModelMenu();
        });
        menu.appendChild(opt);
      }
    }
  }

  function renderModelButton() {
    const m = MODEL_BY_ID[currentModel] || MODELS[0];
    $("modelBtnText").textContent = m.name;
    const color = makerColor(m.maker);
    $("modelLogoMini").replaceWith(
      (() => {
        const node = el("span", "modelopt__logo modelpicker__logo-mini", makerInitial(m.maker));
        node.style.cssText = `width:22px;height:22px;font-size:11px;border-radius:7px;background:${color}`;
        node.id = "modelLogoMini";
        return node;
      })()
    );
    const badge = $("modelBtnBadge");
    if (m.badge) {
      badge.textContent = m.badge;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function selectModel(id) {
    if (!MODEL_BY_ID[id] || id === currentModel) return;
    currentModel = id;
    saveModel(id);
    renderModelButton();
    renderModelMenu();
    // Persist the active conversation's model
    if (activeId && conversations[activeId]) {
      conversations[activeId].model = id;
      saveConversations();
    }
  }

  function openModelMenu() {
    $("modelpicker").classList.add("is-open");
    $("modelBtn").setAttribute("aria-expanded", "true");
  }
  function closeModelMenu() {
    $("modelpicker").classList.remove("is-open");
    $("modelBtn").setAttribute("aria-expanded", "false");
  }

  /* ============================================================
     Render: messages
     ============================================================ */
  function renderMessages() {
    const wrap = $("messages");
    wrap.innerHTML = "";
    const c = activeId ? conversations[activeId] : null;

    if (!c || !c.messages.length) {
      renderEmptyState(wrap);
      $("chatTitle").textContent = "New chat";
      return;
    }

    $("chatTitle").textContent = c.title || "New chat";
    for (const m of c.messages) {
      wrap.appendChild(buildMessageNode(m));
    }
    scrollToBottom();
  }

  function renderEmptyState(wrap) {
    const empty = el("div", "chat__empty");
    const m = MODEL_BY_ID[currentModel];
    empty.innerHTML = `
      <div class="chat__empty-emoji">🍋</div>
      <h2>What can I squeeze for you?</h2>
      <p>You're on <strong>${escapeHtml(m.name)}</strong> — free, unlimited, and switchable anytime. Pick a starter or ask anything.</p>
      <div class="chat__suggestions">
        ${SUGGESTIONS.map((s) => `
          <button class="suggestion" type="button" data-prompt="${escapeAttr(s.prompt)}">
            <div class="suggestion__icon">${s.icon}</div>
            <div class="suggestion__text">${escapeHtml(s.text)}</div>
          </button>
        `).join("")}
      </div>
    `;
    wrap.appendChild(empty);
    empty.querySelectorAll(".suggestion").forEach((b) =>
      b.addEventListener("click", () => {
        $("chatInput").value = b.dataset.prompt;
        autoGrow($("chatInput"));
        updateSendState();
        send();
      })
    );
  }

  function buildMessageNode(m) {
    const node = el("div", "msg msg--" + m.role);
    const initial = (user.name || user.username || "?")[0].toUpperCase();
    let avatar;
    if (m.role === "user" && user.avatar) {
      avatar = el("img", "msg__avatar msg__avatar-img");
      avatar.src = user.avatar;
      avatar.alt = "";
    } else {
      avatar = el("div", "msg__avatar", m.role === "user" ? initial : "✦");
    }
    const body = el("div", "msg__body");

    const meta = el("div", "msg__meta");
    meta.appendChild(
      el("span", "msg__name", m.role === "user" ? (user.name || user.username || "You") : "YopiLemon")
    );
    if (m.role === "ai" && m.model) {
      const mm = MODEL_BY_ID[m.model];
      meta.appendChild(el("span", "msg__model", mm ? mm.name : m.model));
    }
    body.appendChild(meta);

    const content = el("div", "msg__content");
    content.dataset.raw = m.content || "";
    if (m.role === "ai") {
      content.innerHTML = renderMarkdown(m.content || "");
    } else {
      content.textContent = m.content || "";
    }
    body.appendChild(content);

    // Actions (copy / regenerate)
    if (m.role === "ai") {
      const actions = el("div", "msg__actions");
      actions.appendChild(makeAction("Copy", () => copyText(m.content)));
      actions.appendChild(makeAction("Regenerate", () => regenerate(m)));
      body.appendChild(actions);
    } else {
      const actions = el("div", "msg__actions");
      actions.appendChild(makeAction("Copy", () => copyText(m.content)));
      actions.appendChild(makeAction("Edit", () => editUserMessage(m)));
      body.appendChild(actions);
    }

    node.appendChild(avatar);
    node.appendChild(body);
    return node;
  }

  function makeAction(label, onClick) {
    const b = el("button", "msg__action", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function scrollToBottom() {
    const s = $("chatScroll");
    requestAnimationFrame(() => { s.scrollTop = s.scrollHeight; });
  }

  /* ============================================================
     Conversation management
     ============================================================ */
  function newConversation() {
    activeId = null;
    renderMessages();
    renderSidebar();
    $("chatInput").focus();
    closeSidebarMobile();
  }

  function openConversation(id) {
    if (!conversations[id]) return;
    activeId = id;
    const c = conversations[id];
    if (c.model && MODEL_BY_ID[c.model]) {
      currentModel = c.model;
      renderModelButton();
      renderModelMenu();
    }
    renderMessages();
    renderSidebar();
    closeSidebarMobile();
    $("chatInput").focus();
  }

  function ensureConversation(firstUserText) {
    if (activeId && conversations[activeId]) return conversations[activeId];
    const id = "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const c = {
      id,
      title: deriveTitle(firstUserText),
      model: currentModel,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    conversations[id] = c;
    activeId = id;
    return c;
  }

  function deriveTitle(text) {
    const clean = (text || "").trim().replace(/\s+/g, " ");
    if (!clean) return "New chat";
    return clean.length > 40 ? clean.slice(0, 40) + "…" : clean;
  }

  /* ============================================================
     Send / stream
     ============================================================ */
  async function send() {
    if (isStreaming) return;
    const input = $("chatInput");
    const text = input.value.trim();
    if (!text) return;

    const c = ensureConversation(text);
    c.model = currentModel;
    c.messages.push({ role: "user", content: text, at: Date.now() });
    c.updatedAt = Date.now();

    input.value = "";
    autoGrow(input);
    updateSendState();
    renderMessages();
    renderSidebar();
    saveConversations();

    // Build the AI placeholder node (streaming target)
    const aiMsg = { role: "ai", content: "", model: currentModel, at: Date.now() };
    c.messages.push(aiMsg);
    const node = buildMessageNode(aiMsg);
    $("messages").appendChild(node);
    const contentEl = node.querySelector(".msg__content");
    // "Thinking..." affordance until the first token arrives, so the
    // user knows the model is working and hasn't stalled.
    contentEl.classList.add("msg__thinking");
    contentEl.innerHTML = renderThinking();
    scrollToBottom();

    setStreaming(true);
    abortCtrl = new AbortController();
    let firstToken = true;

    try {
      const full = await streamCompletion({
        model: currentModel,
        convoId: c.id,
        title: c.title,
        messages: c.messages
          .filter((m) => m !== aiMsg)
          .map((m) => ({ role: m.role === "ai" ? "assistant" : "user", content: m.content })),
        signal: abortCtrl.signal,
        onDelta: (delta) => {
          if (firstToken) {
            firstToken = false;
            contentEl.classList.remove("msg__thinking");
            contentEl.classList.add("msg__cursor");
          }
          aiMsg.content += delta;
          contentEl.innerHTML = renderMarkdown(aiMsg.content);
          scrollToBottom();
        },
      });

      aiMsg.content = full || aiMsg.content;
      contentEl.classList.remove("msg__cursor", "msg__thinking");
      contentEl.innerHTML = renderMarkdown(aiMsg.content);
      c.updatedAt = Date.now();
      saveConversations();
      renderSidebar();
    } catch (err) {
      contentEl.classList.remove("msg__cursor", "msg__thinking");
      if (err.name === "AbortError") {
        aiMsg.content += "\n\n_(stopped)_";
      } else {
        aiMsg.content += `\n\n⚠️ **Error:** ${err.message}`;
      }
      contentEl.innerHTML = renderMarkdown(aiMsg.content);
      saveConversations();
    } finally {
      setStreaming(false);
      abortCtrl = null;
    }
  }

  async function regenerate(aiMsg) {
    if (isStreaming) return;
    const c = conversations[activeId];
    if (!c) return;
    const idx = c.messages.indexOf(aiMsg);
    if (idx < 0) return;

    // Drop this AI message and re-run from the prior user message
    c.messages.splice(idx, 1);
    // If the regen request named a model, keep using currentModel; else current
    aiMsg.content = "";
    aiMsg.model = currentModel;
    c.messages.push(aiMsg);
    renderMessages();
    saveConversations();

    const node = [...$("messages").children].pop();
    const contentEl = node.querySelector(".msg__content");
    contentEl.classList.add("msg__thinking");
    contentEl.innerHTML = renderThinking();

    setStreaming(true);
    abortCtrl = new AbortController();
    let firstToken = true;
    try {
      const full = await streamCompletion({
        model: currentModel,
        convoId: c.id,
        title: c.title,
        messages: c.messages
          .filter((m) => m !== aiMsg)
          .map((m) => ({ role: m.role === "ai" ? "assistant" : "user", content: m.content })),
        signal: abortCtrl.signal,
        onDelta: (delta) => {
          if (firstToken) {
            firstToken = false;
            contentEl.classList.remove("msg__thinking");
            contentEl.classList.add("msg__cursor");
          }
          aiMsg.content += delta;
          contentEl.innerHTML = renderMarkdown(aiMsg.content);
          scrollToBottom();
        },
      });
      aiMsg.content = full || aiMsg.content;
      contentEl.classList.remove("msg__cursor", "msg__thinking");
      contentEl.innerHTML = renderMarkdown(aiMsg.content);
      c.updatedAt = Date.now();
      saveConversations();
    } catch (err) {
      contentEl.classList.remove("msg__cursor", "msg__thinking");
      aiMsg.content += err.name === "AbortError" ? "\n\n_(stopped)_" : `\n\n⚠️ **Error:** ${err.message}`;
      contentEl.innerHTML = renderMarkdown(aiMsg.content);
      saveConversations();
    } finally {
      setStreaming(false);
      abortCtrl = null;
    }
  }

  function editUserMessage(userMsg) {
    const input = $("chatInput");
    input.value = userMsg.content;
    autoGrow(input);
    input.focus();
    // Remove this user message (and any AI reply after it) on send
    const c = conversations[activeId];
    if (!c) return;
    const idx = c.messages.indexOf(userMsg);
    if (idx < 0) return;
    // Truncate everything from this user message onward; sending will re-append
    c.messages = c.messages.slice(0, idx);
    saveConversations();
    renderMessages();
    renderSidebar();
    updateSendState();
  }

  function stop() {
    if (abortCtrl) abortCtrl.abort();
  }

  function setStreaming(on) {
    isStreaming = on;
    const btn = $("sendBtn");
    if (on) {
      btn.disabled = false;
      btn.classList.add("is-stop");
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
      btn.setAttribute("aria-label", "Stop");
      btn.onclick = stop;
    } else {
      btn.classList.remove("is-stop");
      updateSendState();
      btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      btn.setAttribute("aria-label", "Send message");
      btn.onclick = send;
    }
  }

  /* ============================================================
     API call — same-origin /api/chat proxy (no key in the browser)
     The server forwards to the upstream OpenAI-compatible endpoint
     with the secret API key and pipes the SSE stream back to us.
     ============================================================ */
  async function streamCompletion({ model, messages, convoId, title, signal, onDelta }) {
    const res = await fetch("/api/chat", {
      method: "POST",
      signal,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, convoId, title }),
    });

    if (!res.ok || !res.body) {
      let detail = "";
      try {
        const errJson = await res.json();
        detail = errJson?.error || JSON.stringify(errJson);
      } catch {
        try { detail = await res.text(); } catch { detail = ""; }
      }
      if (res.status === 401) {
        // Session expired — bounce to login.
        location.replace("login.html");
      }
      if (res.status === 403) {
        // Banned/suspended — bounce to login with the server's reason.
        location.replace("login.html?banned=" + encodeURIComponent(detail || "suspended"));
      }
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE chunks are split by blank lines
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep the last (possibly partial) line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // comment/keepalive
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return full;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content || "";
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          // ignore malformed partial JSON
        }
      }
    }
    return full;
  }

  /* ============================================================
     Composer behavior
     ============================================================ */
  function autoGrow(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 180) + "px";
  }
  function updateSendState() {
    const has = $("chatInput").value.trim().length > 0;
    $("sendBtn").disabled = !has || isStreaming;
  }

  /* ============================================================
     Mobile sidebar
     ============================================================ */
  function openSidebarMobile() {
    $("sidebar").classList.add("is-open");
    $("scrim").classList.add("is-open");
  }
  function closeSidebarMobile() {
    $("sidebar").classList.remove("is-open");
    $("scrim").classList.remove("is-open");
  }

  /* ============================================================
     Utilities
     ============================================================ */
  function escapeHtml(s) {
    return (s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

  function renderMarkdown(text) {
    let html;
    if (window.marked && marked.parse) {
      try {
        html = marked.parse(text || "", { breaks: true });
      } catch {
        return escapeHtml(text).replace(/\n/g, "<br>");
      }
    } else {
      return escapeHtml(text).replace(/\n/g, "<br>");
    }
    if (window.DOMPurify) html = DOMPurify.sanitize(html);
    return enhanceCodeBlocks(html);
  }

  // "Thinking..." affordance shown in the AI bubble before the first
  // token arrives. Three bouncing dots + a label.
  function renderThinking() {
    return `<span class="thinking"><span class="thinking__dots"><i></i><i></i><i></i></span><span class="thinking__label">Thinking…</span></span>`;
  }

  // Walk the rendered HTML and upgrade <pre><code> blocks: detect
  // JSON and pretty-print it, add a language tag + copy button.
  function enhanceCodeBlocks(html) {
    // Operate on a temporary container so we can use the DOM parser
    // rather than fragile regex on HTML.
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const pres = tpl.content.querySelectorAll("pre code");
    pres.forEach((code) => {
      const pre = code.parentElement;
      const langClass = [...(code.className || "").split(/\s+/)].find((c) => c.startsWith("language-"));
      let lang = langClass ? langClass.replace("language-", "") : "";

      // If the content looks like JSON and isn't already pretty, try
      // to pretty-print it. Keep the original on parse failure.
      const raw = code.textContent || "";
      if (!lang || lang === "json") {
        const trimmed = raw.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            const parsed = JSON.parse(trimmed);
            code.textContent = JSON.stringify(parsed, null, 2);
            lang = "json";
          } catch { /* not valid JSON — leave it */ }
        }
      }

      // Wrap the <pre> in a toolbar (lang label + copy button).
      const wrap = document.createElement("div");
      wrap.className = "codeblock";
      const bar = document.createElement("div");
      bar.className = "codeblock__bar";
      const label = document.createElement("span");
      label.className = "codeblock__lang";
      label.textContent = lang || "code";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "codeblock__copy";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => {
        copyText(raw).then(() => {
          copy.textContent = "Copied!";
          setTimeout(() => (copy.textContent = "Copy"), 1200);
        });
      });
      bar.appendChild(label);
      bar.appendChild(copy);
      pre.replaceWith(wrap);
      wrap.appendChild(bar);
      wrap.appendChild(pre);
    });
    return tpl.innerHTML;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text || "");
    } catch {
      /* clipboard blocked — silently ignore */
    }
  }

  /* ============================================================
     Suggestions
     ============================================================ */
  const SUGGESTIONS = [
    { icon: "✍️", text: "Write a friendly launch email", prompt: "Draft a short, friendly product launch email — one headline, three feature bullets, and a clear call to action." },
    { icon: "💡", text: "Explain a tricky concept simply", prompt: "Explain how vector embeddings work, simply, with one everyday analogy." },
    { icon: "🧑‍💻", text: "Refactor this code", prompt: "Refactor this function for readability:\n\n```js\nfunction f(a){let r=[];for(let i=0;i<a.length;i++){if(a[i]%2==0){r.push(a[i]*2)}}return r}\n```" },
    { icon: "🧾", text: "Summarize my notes into bullets", prompt: "Summarize these notes into 5 concise bullets:\n\n- Q3 launch slipped to Aug 14\n- Design needs 2 more days\n- Beta waitlist grew 38% this week\n- Need a kickoff email drafted\n- Engineering wants a release checklist" },
  ];

  /* ============================================================
     Wire up events
     ============================================================ */
  function init() {
    loadConversations();
    loadModel();
    renderModelButton();
    renderModelMenu();
    renderSidebar();
    renderMessages();

    // Composer
    const input = $("chatInput");
    input.addEventListener("input", () => { autoGrow(input); updateSendState(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    $("sendBtn").onclick = send;

    // New chat
    $("newChatBtn").addEventListener("click", newConversation);

    // Model picker
    $("modelBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      $("modelpicker").classList.contains("is-open") ? closeModelMenu() : openModelMenu();
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#modelpicker")) closeModelMenu();
    });

    // Mobile sidebar
    $("menuToggle").addEventListener("click", openSidebarMobile);
    $("scrim").addEventListener("click", closeSidebarMobile);

    // Focus the composer
    input.focus();
  }

  // The auth `await` above can resolve after DOMContentLoaded has
  // already fired (this script lives at the end of <body>), so a plain
  // addEventListener would miss the event and init() would never run.
  // Run now if the DOM is ready, otherwise wait for it.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
