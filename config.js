/* ============================================================
   YopiLemon — runtime config (public, ships to the browser)
   ============================================================
   NO secrets here. The upstream AI endpoint and API key live only
   in the server's environment variables and are used by /api/chat
   on the backend. The browser just talks same-origin to /api/chat.
   ============================================================ */

window.YOPIL_CONFIG = {
  // Models exposed in the picker and on the home page. These are
  // public display names — the actual upstream call happens
  // server-side in /api/chat, which forwards the `id` verbatim to
  // the OpenAI-compatible upstream. `tier` controls grouping,
  // `badge` is an optional flavor label, `maker` maps to makerMeta.
  models: [
    // ---- Flagships ----
    {
      id: "claude-fable-5",
      name: "Claude Fable 5",
      maker: "Anthropic",
      tier: "flagship",
      blurb: "Most intelligent generally available model. Best for hard reasoning.",
      badge: "Smartest",
    },
    {
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      maker: "Anthropic",
      tier: "flagship",
      blurb: "Deep reasoning and long-form writing with a thoughtful tone.",
    },
    {
      id: "glm-5.2",
      name: "GLM 5.2",
      maker: "Zhipu",
      tier: "flagship",
      blurb: "Bilingual powerhouse with strong tool use and reasoning.",
    },
    {
      id: "gpt-5.5",
      name: "GPT-5.5",
      maker: "OpenAI",
      tier: "flagship",
      blurb: "OpenAI's latest flagship with a 1M context window. Great all-around.",
      badge: "New",
    },

    // ---- Balanced ----
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      maker: "Anthropic",
      tier: "balanced",
      blurb: "Strong all-rounder with fast, balanced responses.",
      badge: "Balanced",
    },
    {
      id: "minimax-m3",
      name: "MiniMax M3",
      maker: "MiniMax",
      tier: "balanced",
      blurb: "Creative drafting and multimodal-friendly long context.",
    },
    {
      id: "qwen-3.7-plus",
      name: "Qwen 3.7 Plus",
      maker: "Alibaba",
      tier: "balanced",
      blurb: "Reliable general-purpose model with broad language coverage.",
    },

    // ---- Fast ----
    {
      id: "glm-5.2-fast",
      name: "GLM 5.2 Fast",
      maker: "Zhipu",
      tier: "fast",
      blurb: "Lighter GLM variant tuned for speed and throughput.",
      badge: "Fast",
    },
    {
      id: "gpt-5.4-mini",
      name: "GPT-5.4 mini",
      maker: "OpenAI",
      tier: "fast",
      blurb: "OpenAI's small, fast model. Great for quick everyday tasks.",
    },
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      maker: "OpenAI",
      tier: "fast",
      blurb: "Capable mid-tier OpenAI model with a large context window.",
    },

    // ---- Specialists ----
    {
      id: "kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      maker: "Moonshot",
      tier: "specialist",
      blurb: "Specialized for code generation, refactors, and debugging.",
      badge: "Code",
    },
  ],

  // Maker display meta (color + logo initial), shared by the chat
  // picker and the home-page models grid so they stay in sync.
  // Only makers that appear in `models` above are listed.
  makerMeta: {
    Anthropic: { color: "#D97706", initial: "A" },
    OpenAI:    { color: "#10A37F", initial: "O" },
    Zhipu:     { color: "#7C3AED", initial: "Z" },
    Moonshot:  { color: "#2563EB", initial: "M" },
    MiniMax:   { color: "#DB2777", initial: "X" },
    Alibaba:   { color: "#EA580C", initial: "Q" },
  },

  // Default model id used when a user hasn't picked one
  defaultModel: "claude-fable-5",

  // Reasoning effort options exposed in the chat settings panel.
  // `value` is sent to the upstream API as `effortLevel` (the field
  // name the sh00t.host API uses; values: low/medium/high/xhigh).
  // `label` is what the user sees. "Max" maps to xhigh upstream.
  reasoningEfforts: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Max" },
  ],
  defaultEffort: "medium",

  // Default system instruction. This grounds the model so it doesn't
  // hallucinate tool use — i.e. pretend to "create a file" or "build a
  // game" and narrate the action without ever producing output. The
  // API supports tool use, but our request sends no tools, so the
  // model must answer directly in the message stream. The user can
  // override this from the chat settings panel.
  defaultSystemInstruction:
    "You are YopiLemon, a friendly, concise AI chat assistant. " +
    "You are chatting with the user through a web interface. " +
    "You have NO tools, NO file system, NO code execution, and NO ability to create, open, or save files. " +
    "Never pretend to perform an action you cannot actually do — for example, do not say you are \"creating a file\", \"building an app\", or \"opening an editor\". " +
    "When the user asks for code, a webpage, a script, or anything buildable, deliver it inline in your reply as formatted code blocks the user can copy. " +
    "Answer directly and completely in the message. Do not narrate steps you are not taking. " +
    "Be warm, clear, and genuinely helpful.",

  // Storage keys (namespaced under yopilemon). Chat history is keyed
  // per Discord user id at runtime (see chat.js).
  storage: {
    chats: "yopil.chats",    // { [userId]: { [convoId]: {...} } }
    model: "yopil.model",    // last-selected model id (global pref)
    effort: "yopil.effort",  // last-selected reasoning effort (global pref)
    system: "yopil.system",  // custom system instruction (global pref)
  },
};
