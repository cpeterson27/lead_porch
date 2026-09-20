const assert = require("node:assert/strict");

// Real, reported incident: connecting Google Calendar from the Coach Portal
// landed on "This site can't be reached" — the address bar showed
// "leadporch.co,https//www.leadporch.co,https://elliescoaching.com,https://www.elliescoaching.com/coach/sch...",
// every comma-separated origin in FRONTEND_URL jammed into one broken URL.
// Both the Google Calendar and Zoom OAuth callbacks built their post-connect
// redirect from the raw env var instead of picking a single origin the way
// every other redirect-building site in the app already does.
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = "a".repeat(44);
process.env.GOOGLE_CALENDAR_CLIENT_ID = "test-client";
process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_CALENDAR_REDIRECT_URI = "http://localhost:5001/api/coaching/calendar/oauth/callback";
process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "test-zoom-client";
process.env.ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || "test-zoom-secret";
process.env.ZOOM_REDIRECT_URI = process.env.ZOOM_REDIRECT_URI || "http://localhost:5001/api/coaching/zoom/oauth/callback";

const { frontendOrigin } = require("./routes/coaching");

function withFrontendUrl(value, fn) {
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = value;
  try { return fn(); } finally { if (previous === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = previous; }
}

// The exact value that produced the broken redirect: a scheme-less first
// entry ("leadporch.co") ahead of the real, working origins.
withFrontendUrl("leadporch.co,https://www.leadporch.co,https://elliescoaching.com,https://www.elliescoaching.com", () => {
  const origin = frontendOrigin();
  assert.equal(origin, "https://www.leadporch.co", "must skip the scheme-less entry and land on the first genuinely valid absolute URL, never on a jammed-together string");
  assert(!origin.includes(","), "must never contain a comma — that was the actual bug");
});

// The normal, expected shape used everywhere else in the app.
withFrontendUrl("https://ellie-ai-frontend.onrender.com,https://elliescoaching.com", () => {
  assert.equal(frontendOrigin(), "https://ellie-ai-frontend.onrender.com");
});

// A single origin, no comma at all.
withFrontendUrl("https://elliescoaching.com/", () => {
  assert.equal(frontendOrigin(), "https://elliescoaching.com", "must still strip a trailing slash");
});

// Nothing configured at all — falls back to the documented local default
// instead of throwing or returning something empty/malformed.
withFrontendUrl("", () => {
  assert.equal(frontendOrigin(), "http://localhost:5173");
});

const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "routes/coaching.js"), "utf8");
assert(!/const frontend = String\(process\.env\.FRONTEND_URL/.test(source), "the Google Calendar and Zoom OAuth callbacks must not go back to reading the raw, un-split FRONTEND_URL value");
assert((source.match(/const frontend = frontendOrigin\(\);/g) || []).length === 2, "both OAuth callbacks (Google Calendar and Zoom) must use the shared, safe helper");

console.log("Coaching OAuth callback redirects always resolve to a single valid frontend origin, never a jammed-together FRONTEND_URL string.");
