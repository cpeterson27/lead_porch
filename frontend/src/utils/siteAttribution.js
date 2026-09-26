const STORAGE_KEY = "ellie-site-attribution-v1";
const SESSION_MS = 30 * 60 * 1000;
let memory = null;
export function trackingAllowed() {
  return typeof window !== "undefined" && !navigator.globalPrivacyControl && navigator.doNotTrack !== "1" && window.doNotTrack !== "1";
}
export function anonymousEventId() {
  return window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
export function getSiteAttribution() {
  if (!trackingAllowed()) return null;
  const now = Date.now();
  const params = new URLSearchParams(window.location.search);
  const utmSource = (params.get("utm_source") || "").trim().toLowerCase().slice(0, 160);
  let referrerHost = "";
  try { referrerHost = new URL(document.referrer).hostname; if (referrerHost === window.location.hostname) referrerHost = ""; } catch { /* direct visit */ }
  let saved = memory;
  try { saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY)) || memory; } catch { /* storage is optional */ }
  if (!saved || typeof saved !== "object" || !/^[a-z0-9-]{16,80}$/i.test(saved.sessionId || "") || !Number.isFinite(saved.lastSeen) || now - saved.lastSeen > SESSION_MS || (utmSource && utmSource !== saved.utmSource) || (!saved.utmSource && !saved.referrerHost && referrerHost)) {
    saved = { sessionId: anonymousEventId(), landingPath: window.location.pathname, utmSource, referrerHost, lastSeen: now };
  }
  saved.lastSeen = now;
  memory = saved;
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch { /* use memory for this page */ }
  return { sessionId: saved.sessionId, landingPath: saved.landingPath, utmSource: saved.utmSource, referrerHost: saved.referrerHost };
}
export function resetSiteAttributionForTest() { memory = null; }
