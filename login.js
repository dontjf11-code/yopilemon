/* ============================================================
   YopiLemon — login page logic (username + DM-code flow)
   ============================================================
   Four steps, one page:
     1. Join  — opens the Discord invite in a new tab.
     2. Username — POST /auth/request-code -> bot DMs a code.
     3. Code — POST /auth/verify -> session created.
     4. Welcome — shows pfp + display name, then -> chat.html.

   If you're already logged in, you skip straight to chat.
   ============================================================ */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const steps = ["stepJoin", "stepUsername", "stepCode", "stepWelcome"];
  const indicatorItems = $("stepIndicator").querySelectorAll("li");
  const errorBox = $("authError");

  let currentUsername = "";

  /* ---- If already logged in, go straight to chat ---- */
  (async function redirectIfAuthed() {
    if (!window.Auth) return;
    const user = await Auth.current();
    if (user) location.replace("chat.html");
  })();

  function showStep(name) {
    for (const s of steps) {
      const el = $(s);
      if (el) el.hidden = s !== name;
    }
    // Update indicator (Welcome = step 3 visually)
    const idx = steps.indexOf(name);
    indicatorItems.forEach((li, i) => {
      li.classList.toggle("is-active", i === idx);
      li.classList.toggle("is-done", i < idx);
    });
    hideError();
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add("is-visible");
  }
  function hideError() {
    errorBox.classList.remove("is-visible");
  }

  function setBusy(btn, label, busy, busyText = "Working…") {
    btn.disabled = busy;
    label.innerHTML = busy
      ? '<span class="spinner" aria-hidden="true"></span>'
      : label.dataset.label || label.textContent;
  }

  /* ---- Step 1 -> 2: "I've joined" ---- */
  $("joinedBtn").addEventListener("click", () => {
    showStep("stepUsername");
    $("username").focus();
  });

  /* ---- Step 2 -> 3: submit username, request code ---- */
  const usernameForm = $("usernameForm");
  const usernameInput = $("username");
  const usernameSubmit = $("usernameSubmit");
  const usernameSubmitLabel = $("usernameSubmitLabel");
  usernameSubmitLabel.dataset.label = "Send me a code";

  usernameForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError();
    const username = usernameInput.value.trim().replace(/^@/, "");
    if (!username) {
      showError("Enter your Discord username.");
      usernameInput.classList.add("is-invalid");
      return;
    }
    usernameInput.classList.remove("is-invalid");

    setBusy(usernameSubmit, usernameSubmitLabel, true, "Sending…");
    try {
      const res = await fetch("/auth/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't send a code.");

      currentUsername = username;
      $("codeUsername").textContent = "@" + username;
      showStep("stepCode");
      $("code").focus();
    } catch (err) {
      showError(err.message || "Something went wrong. Try again.");
    } finally {
      setBusy(usernameSubmit, usernameSubmitLabel, false);
    }
  });

  /* ---- Step 3 -> 4: submit code, verify ---- */
  const codeForm = $("codeForm");
  const codeInput = $("code");
  const codeSubmit = $("codeSubmit");
  const codeSubmitLabel = $("codeSubmitLabel");
  codeSubmitLabel.dataset.label = "Verify & log in";

  // Auto-format: digits only, max 6
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
    codeInput.classList.remove("is-invalid");
    hideError();
  });

  codeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError();
    const code = codeInput.value.trim();
    if (code.length !== 6) {
      showError("Enter the 6-digit code from your DM.");
      codeInput.classList.add("is-invalid");
      return;
    }
    if (!currentUsername) {
      showStep("stepUsername");
      return;
    }

    setBusy(codeSubmit, codeSubmitLabel, true, "Verifying…");
    try {
      const res = await fetch("/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: currentUsername, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "That code didn't match.");

      const user = data.user;
      renderWelcome(user);
      showStep("stepWelcome");
      // Give the welcome screen a beat, then head to chat.
      setTimeout(() => location.replace("chat.html"), 1800);
    } catch (err) {
      showError(err.message || "Something went wrong. Try again.");
      codeInput.classList.add("is-invalid");
    } finally {
      setBusy(codeSubmit, codeSubmitLabel, false);
    }
  });

  function renderWelcome(user) {
    const avatar = $("welcomeAvatar");
    if (user && user.avatar) {
      avatar.src = user.avatar;
      avatar.hidden = false;
    }
    const name = (user && (user.name || user.username)) || "there";
    $("welcomeTitle").textContent = `Welcome, ${name}! 🍋`;
    $("welcomeSub").textContent = `You're in. Taking you to your chat…`;
  }

  /* ---- Back buttons ---- */
  $("backToJoin").addEventListener("click", () => showStep("stepJoin"));
  $("backToUsername").addEventListener("click", () => {
    codeInput.value = "";
    showStep("stepUsername");
    usernameInput.focus();
  });

  /* ---- Resend code ---- */
  $("resendBtn").addEventListener("click", async () => {
    hideError();
    if (!currentUsername) {
      showStep("stepUsername");
      return;
    }
    try {
      const res = await fetch("/auth/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: currentUsername }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't resend.");
      showError("Sent a new code to your DMs.");
      codeInput.value = "";
      codeInput.focus();
    } catch (err) {
      showError(err.message || "Couldn't resend. Try again.");
    }
  });

  /* ---- Clear error on input ---- */
  [usernameInput, codeInput].forEach((el) =>
    el.addEventListener("input", () => {
      hideError();
      el.classList.remove("is-invalid");
    })
  );

  /* ---- Start on step 1 ---- */
  showStep("stepJoin");
})();
