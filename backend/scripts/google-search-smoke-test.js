#!/usr/bin/env node
/**
 * MANUAL smoke test only — never run in CI or automated tests.
 *
 * Google Programmable Search / Custom Search JSON API is closed to new
 * customers and is scheduled to sunset for existing customers on
 * January 1, 2027 (see https://developers.google.com/custom-search/v1/overview).
 * services/intentSourceService.js keeps google_web only as an optional
 * legacy adapter — never the primary research source (that's OpenAI
 * Responses web_search, with Bing/direct public sources as fallback) — and
 * a monitor that hits a 401/403 from this adapter is now automatically
 * disabled for that source by services/researchMonitorService.js.
 *
 * This script makes the smallest possible real query against the
 * configured GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_ENGINE_ID and reports,
 * honestly, exactly one of:
 *   - not configured (no key/CX set — nothing to test)
 *   - working (returned real results)
 *   - blocked (401/403 — API closed to new customers, revoked key, or CX
 *     misconfigured — this is what triggers auto-disable in production)
 *   - rate limited (429 — daily/query quota exhausted)
 *   - failed (any other error — network, malformed response, etc.)
 * It never claims success without a real response, and never fabricates
 * result data.
 *
 * Usage:
 *   GOOGLE_SEARCH_API_KEY=... GOOGLE_SEARCH_ENGINE_ID=... node scripts/google-search-smoke-test.js
 */
require("dotenv").config();
const axios = require("axios");

async function main() {
  const key = String(process.env.GOOGLE_SEARCH_API_KEY || "").trim();
  const cx = String(process.env.GOOGLE_SEARCH_ENGINE_ID || "").trim();
  if (!key || !cx) {
    console.log("Google Programmable Search is not configured (GOOGLE_SEARCH_API_KEY and/or GOOGLE_SEARCH_ENGINE_ID unset). Nothing to test — this is expected if you're not using the legacy Google adapter.");
    return;
  }
  console.log("Making the smallest possible real Google Custom Search request...");
  try {
    const response = await axios.get("https://customsearch.googleapis.com/customsearch/v1", {
      params: { key, cx, q: "real estate investing coaching", num: 1 },
      timeout: 15000,
    });
    const items = response.data?.items || [];
    if (!items.length) {
      console.log("Google returned a successful response but zero results — the key/CX are valid, but this specific query returned nothing. That's a working (if narrow) configuration, not a failure.");
      return;
    }
    console.log(`Working. Google returned ${items.length} real result(s). Sample: "${items[0].title}" — ${items[0].link}`);
    console.log("Reminder: this API is closed to new customers and sunsets for existing customers on 2027-01-01. Do not rely on it as a primary or sole research source.");
  } catch (error) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      console.error(`Blocked (HTTP ${status}). This is the exact failure mode services/researchMonitorService.js auto-disables google_web for on any monitor that hits it — likely a revoked/invalid key, a misconfigured CX, or an account Google has closed to new customers.`);
      process.exitCode = 1;
      return;
    }
    if (status === 429) {
      console.error("Rate limited (HTTP 429) — daily or per-second quota exhausted. Not a permanent failure; safe to retry later.");
      process.exitCode = 1;
      return;
    }
    console.error(`Failed (${status ? `HTTP ${status}` : error.code || "unknown error"}): ${error.message}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Google search smoke test crashed unexpectedly:", error.message);
  process.exitCode = 1;
});
