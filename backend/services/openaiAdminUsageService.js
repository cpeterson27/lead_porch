/**
 * Real OpenAI ORGANIZATION-level spend and hard spend limit, read live from
 * OpenAI's Admin API — not the same thing as this app's own self-imposed
 * per-workspace budget (services/aiConfigService.js). That budget only
 * controls what Lead Porch itself will spend and is enforced entirely
 * locally; this service instead answers "how much of my real OpenAI account
 * is left," the same number shown on platform.openai.com's own billing page.
 *
 * Requires a separate OPENAI_ADMIN_API_KEY (an Admin API key, created under
 * OpenAI org Settings -> Organization -> Admin keys — NOT the regular
 * OPENAI_API_KEY every other OpenAI call in this app uses; admin keys can
 * only call admin/org endpoints, never chat/responses). Disabled — i.e.
 * simply unconfigured — until that key is set; every function degrades to
 * `{ configured: false }` rather than throwing, since this is a
 * nice-to-have dashboard/auto-pause signal, not a gate on any real feature.
 *
 * Endpoints (OpenAI Admin API, verify against OpenAI's current reference
 * before the first live smoke test — https://platform.openai.com/docs/api-reference/usage):
 *   GET /v1/organization/costs        - actual spend, bucketed by day
 *   GET /v1/organization/spend_limit  - the org's configured hard monthly cap
 */
const axios = require("axios");
const { withResilience } = require("./providerResilience");

const BASE_URL = "https://api.openai.com/v1/organization";
const CIRCUIT_KEY = "openai_admin_usage";
const CACHE_TTL_MS = 15 * 60000;

let cached = null; // { value, expiresAt }

function isConfigured() {
  return Boolean(process.env.OPENAI_ADMIN_API_KEY?.trim());
}

function client() {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 10000,
    headers: { Authorization: `Bearer ${process.env.OPENAI_ADMIN_API_KEY.trim()}` },
  });
}

function startOfCurrentUtcMonthSeconds() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
}

function sumCostsResponse(data) {
  // Each bucket's `results` holds line items with an `amount.value` (USD).
  const buckets = Array.isArray(data?.data) ? data.data : [];
  let total = 0;
  for (const bucket of buckets) {
    for (const result of bucket.results || []) {
      const value = Number(result.amount?.value);
      if (Number.isFinite(value)) total += value;
    }
  }
  return total;
}

/**
 * Real month-to-date spend and configured hard spend limit for the whole
 * OpenAI org this Admin key belongs to. Never throws — a transient/auth
 * failure (including a stale or wrong-scoped key) degrades to
 * `{ configured: true, healthy: false, reason }` so the AI Usage page and
 * the provider-availability auto-pause check can both fail open gracefully
 * rather than breaking on OpenAI's own outage or an API shape change.
 */
async function getAccountBalance({ forceRefresh = false } = {}) {
  if (!isConfigured()) return { configured: false };
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const [costsResponse, limitResponse] = await Promise.all([
      withResilience(CIRCUIT_KEY, () => client().get("/costs", { params: { start_time: startOfCurrentUtcMonthSeconds(), limit: 31, bucket_width: "1d" } })),
      withResilience(CIRCUIT_KEY, () => client().get("/spend_limit")).catch(() => null),
    ]);
    const spentUsd = sumCostsResponse(costsResponse.data);
    const limitCents = Number(limitResponse?.data?.threshold_amount);
    const limitUsd = Number.isFinite(limitCents) ? limitCents / 100 : null;
    const value = {
      configured: true,
      healthy: true,
      spentUsd,
      limitUsd,
      remaining: limitUsd == null ? null : Math.max(0, limitUsd - spentUsd),
      fetchedAt: new Date().toISOString(),
    };
    cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  } catch (error) {
    const value = { configured: true, healthy: false, remaining: null, reason: error.category || error.response?.status || "unknown" };
    cached = { value, expiresAt: Date.now() + 60000 };
    return value;
  }
}

module.exports = { isConfigured, getAccountBalance };
