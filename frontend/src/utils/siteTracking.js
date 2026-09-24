// Every conversion event on the public site (application_start,
// application_submit, discovery_call_booked, etc.) already pushes into
// window.dataLayer in trackSiteEvent below — that part of checklist section
// 11 ("install Google Analytics") was already built. What was missing is
// the actual container script that reads dataLayer and sends it to Google;
// this loads it only when a real GTM container ID is configured, so
// nothing pretends to be tracking before it actually is.
let initialized = false;
export function initSiteTracking() {
  if (initialized || typeof window === "undefined" || typeof document === "undefined") return;
  const containerId = import.meta.env.VITE_GTM_CONTAINER_ID;
  if (!containerId) return;
  initialized = true;
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`;
  document.head.appendChild(script);
}

export function trackSiteEvent(event, parameters = {}) {
  if (typeof window === "undefined") return;
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event,
    ...Object.fromEntries(
      Object.entries(parameters).filter(([, value]) =>
        ["string", "number", "boolean"].includes(typeof value) && value !== "",
      ),
    ),
  });
}
