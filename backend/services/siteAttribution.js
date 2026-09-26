const AI_SOURCES = {
  chatgpt: ["chatgpt", "chatgpt.com", "chat.openai.com"],
  perplexity: ["perplexity", "perplexity.ai"],
  claude: ["claude", "claude.ai"],
  gemini: ["gemini", "gemini.google.com", "bard.google.com"],
  copilot: ["copilot", "copilot.microsoft.com"],
  grok: ["grok", "grok.com"],
};
const SOURCE_LABELS = { chatgpt: "ChatGPT", perplexity: "Perplexity", claude: "Claude", gemini: "Gemini", copilot: "Microsoft Copilot", grok: "Grok" };
function hostname(value) {
  try { const host = new URL(String(value).includes("://") ? value : `https://${value}`).hostname.toLowerCase(); return /^[a-z0-9.-]{1,253}$/.test(host) ? host : ""; } catch { return ""; }
}
function aiSource(value) {
  const raw = String(value || "").trim().toLowerCase();
  const host = hostname(raw);
  return Object.keys(AI_SOURCES).find((key) => AI_SOURCES[key].some((alias) => raw === alias || (alias.includes(".") && (host === alias || host.endsWith(`.${alias}`))))) || "";
}
function publicPath(value) {
  if (typeof value !== "string" || value.length > 300) return "";
  const path = String(value || "").split(/[?#]/)[0].replace(/\/$/, "") || "/";
  if (/^\/ref\/[^/]+$/.test(path)) return "/apply";
  return /^(?:\/$|\/(?:about|coaching-programs|faq|resources|sitemap|testimonials|contact|privacy|privacy-policy|terms|refund-policy|data-deletion|apply|book-a-call|free-guide)$|\/(?:coaching-programs|people)\/[a-z0-9-]+$)/i.test(path) ? path : "";
}
function normalizeAttribution(input = {}) {
  if (!input || typeof input !== "object" || typeof input.sessionId !== "string" || !/^[a-z0-9-]{16,80}$/i.test(input.sessionId || "")) return null;
  const landingPath = publicPath(input.landingPath);
  if (!landingPath) return null;
  const referrerHost = hostname(input.referrerHost || "");
  const taggedSource = aiSource(input.utmSource);
  const referredSource = aiSource(referrerHost);
  // An explicit campaign takes precedence over a referrer. Never label
  // ordinary Google/Bing traffic as AI: those referrals don't prove it.
  const source = input.utmSource ? taggedSource || "other" : referredSource || "other";
  return { sessionId: input.sessionId, landingPath, referrerHost, source, sourceGroup: source === "other" ? "other" : "ai", evidence: input.utmSource ? "utm" : referrerHost ? "referrer" : "unknown" };
}
module.exports = { AI_SOURCES, SOURCE_LABELS, aiSource, publicPath, normalizeAttribution };
