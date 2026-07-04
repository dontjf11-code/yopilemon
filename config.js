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
      id: "gpt-4o",
      name: "GPT-4o",
      maker: "OpenAI",
      tier: "flagship",
      blurb: "OpenAI's flagship multimodal model. Great all-around.",
    },
    {
      id: "o1",
      name: "o1",
      maker: "OpenAI",
      tier: "flagship",
      blurb: "Reasoning-first model that thinks before it answers.",
      badge: "Reasoning",
    },
    {
      id: "glm-5.2",
      name: "GLM 5.2",
      maker: "Zhipu",
      tier: "flagship",
      blurb: "Bilingual powerhouse with strong tool use and reasoning.",
    },
    {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      maker: "Google",
      tier: "flagship",
      blurb: "Google's top model with a huge context window.",
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
    {
      id: "gemini-2.0-flash",
      name: "Gemini 2.0 Flash",
      maker: "Google",
      tier: "balanced",
      blurb: "Fast, capable, and light on its feet for everyday tasks.",
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
      id: "gpt-4o-mini",
      name: "GPT-4o mini",
      maker: "OpenAI",
      tier: "fast",
      blurb: "OpenAI's small, fast, cheap-to-run model. Great for quick tasks.",
    },
    {
      id: "deepseek-chat",
      name: "DeepSeek V3",
      maker: "DeepSeek",
      tier: "fast",
      blurb: "Fast open-weights model with strong general chat quality.",
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
    {
      id: "deepseek-reasoner",
      name: "DeepSeek R1",
      maker: "DeepSeek",
      tier: "specialist",
      blurb: "Open reasoning model that shows its work step by step.",
      badge: "Reasoning",
    },
    {
      id: "grok-3",
      name: "Grok 3",
      maker: "xAI",
      tier: "specialist",
      blurb: "xAI's model with a witty, direct voice and current knowledge.",
    },
  ],

  // Maker display meta (color + logo initial), shared by the chat
  // picker and the home-page models grid so they stay in sync.
  makerMeta: {
    Anthropic: { color: "#D97706", initial: "A" },
    OpenAI:    { color: "#10A37F", initial: "O" },
    Google:    { color: "#4285F4", initial: "G" },
    Zhipu:     { color: "#7C3AED", initial: "Z" },
    Moonshot:  { color: "#2563EB", initial: "M" },
    MiniMax:   { color: "#DB2777", initial: "X" },
    Alibaba:   { color: "#EA580C", initial: "Q" },
    DeepSeek:  { color: "#4D6BFE", initial: "D" },
    xAI:       { color: "#111827", initial: "x" },
  },

  // Default model id used when a user hasn't picked one
  defaultModel: "claude-fable-5",

  // Storage keys (namespaced under yopilemon). Chat history is keyed
  // per Discord user id at runtime (see chat.js).
  storage: {
    chats: "yopil.chats", // { [userId]: { [convoId]: {...} } }
    model: "yopil.model", // last-selected model id (global pref)
  },
};
