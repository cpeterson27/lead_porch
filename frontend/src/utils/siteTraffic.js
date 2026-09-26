import { getSiteAttribution, anonymousEventId } from "./siteAttribution.js";
export function trackPublicVisit(pathname) {
  const attribution = getSiteAttribution();
  if (!attribution) return;
  const base = (import.meta.env.VITE_API_BASE_URL || "http://localhost:5001/api").replace(/\/$/, "");
  const query = new URLSearchParams({ publicHost: window.location.hostname });
  // No names, emails, full referrer URLs, or query strings are sent.
  fetch(`${base}/public/traffic?${query}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", keepalive: true,
    body: JSON.stringify({ eventId: anonymousEventId(), pagePath: pathname, attribution }),
  }).catch(() => {});
}
