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
