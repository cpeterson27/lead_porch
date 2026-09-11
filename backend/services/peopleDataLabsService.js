/**
 * People Data Labs (PDL) server-side integration (API key, no OAuth/customer
 * credentials). Disabled by default. When disabled, every exported function
 * throws immediately without making any HTTP request or spending any credit.
 *
 * Endpoints match PDL's documented v5 REST API. Verify against PDL's current
 * API reference before the first live smoke test — see
 * scripts/pdl-smoke-test.js.
 */
const axios = require("axios");
const ProviderApiUsage = require("../models/ProviderApiUsage");
const { withResilience } = require("./providerResilience");

const BASE_URL = "https://api.peopledatalabs.com/v5";
const CIRCUIT_KEY = "people_data_labs";
const MIN_LIKELIHOOD = 6;
const cache = new Map();
const CACHE_TTL_MS = 5 * 60000;

function isEnabled() {
  return process.env.PDL_ENABLED === "true" && Boolean(process.env.PDL_API_KEY?.trim());
}

function assertEnabled() {
  if (!isEnabled()) {
    const error = new Error("People Data Labs is not enabled for this workspace. Set PDL_ENABLED=true and PDL_API_KEY to use it.");
    error.code = "PDL_DISABLED";
    throw error;
  }
}

function client() {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 10000,
    headers: { "Content-Type": "application/json", "X-Api-Key": process.env.PDL_API_KEY.trim() },
  });
}

function cacheKey(operation, params) { return `${operation}:${JSON.stringify(params)}`; }
function readCache(key) { const hit = cache.get(key); return hit && hit.expiresAt > Date.now() ? hit.value : null; }
function writeCache(key, value) { cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS }); }
function resetPdlCache() { cache.clear(); }

/**
 * PDL's `likelihood` (1-10) measures confidence that the matched *identity*
 * is correct — it says nothing about whether the returned email is
 * deliverable. Only accept matches at or above the documented
 * high-accuracy threshold for enrichment.
 */
function meetsMatchThreshold(likelihood) {
  return Number(likelihood) >= MIN_LIKELIHOOD;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * PDL's `work_email` field is documented as a plain string, but real
 * responses have been observed returning it as an object (e.g.
 * `{ address, first_seen, last_seen }`) or as an array of such entries —
 * a shape variance that previously reached `.toLowerCase()` downstream
 * uncaught (`candidate.email.toLowerCase is not a function`), crashing
 * mid-run after PDL had already returned real candidates. This extracts
 * a plain, validated email STRING from any of those shapes — a bare
 * string, an array (first valid entry wins), or an object (checked under
 * its common field names) — and returns "" for anything that doesn't
 * resolve to a real address. It never calls String()/toString() on an
 * object or array, which would fabricate a garbage value like
 * "[object Object]" and silently pass it off as a real email.
 */
function extractEmailString(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return EMAIL_PATTERN.test(trimmed) ? trimmed : "";
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const extracted = extractEmailString(entry);
      if (extracted) return extracted;
    }
    return "";
  }
  if (value && typeof value === "object") {
    return extractEmailString(value.address || value.email || value.value || "");
  }
  return "";
}

/** PDL's top-level `work_email` is PDL-validated, never independently verified. */
function classifyWorkEmail(email) {
  const value = extractEmailString(email);
  if (!value) return { email: "", state: "unavailable" };
  return { email: value, state: "provider_validated" };
}

function normalizePerson(raw = {}) {
  const workEmail = classifyWorkEmail(raw.work_email);
  return {
    provider: "people_data_labs",
    externalId: raw.id || "",
    fullName: raw.full_name || "",
    firstName: raw.first_name || "",
    lastName: raw.last_name || "",
    title: raw.job_title || "",
    company: raw.job_company_name || "",
    companyDomain: raw.job_company_website || "",
    linkedinUrl: raw.linkedin_url || "",
    location: raw.location_name || "",
    email: workEmail.email,
    emailState: workEmail.state,
    likelihood: raw.likelihood ?? null,
    provenance: {
      datasetVersion: raw.dataset_version || "",
      jobLastVerified: raw.job_last_verified || null,
      jobLastChanged: raw.job_last_changed || null,
      locationLastUpdated: raw.location_last_updated || null,
    },
    conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
    retrievedAt: new Date().toISOString(),
    raw: { id: raw.id },
  };
}

function normalizeCompany(raw = {}) {
  return {
    provider: "people_data_labs",
    externalId: raw.id || "",
    name: raw.name || "",
    domain: raw.website || "",
    industry: raw.industry || "",
    employeeCount: raw.employee_count ?? null,
    location: raw.location?.name || "",
    linkedinUrl: raw.linkedin_url || "",
    retrievedAt: new Date().toISOString(),
    raw: { id: raw.id },
  };
}

async function logUsage({ workspaceId, userId = null, endpoint, operation, success, resultCount = null, latencyMs, errorCategory = "", errorCode = "", cacheHit = false, correlationId = "" }, models = { ProviderApiUsage }) {
  if (!workspaceId) return;
  try { await models.ProviderApiUsage.create({ workspaceId, userId, provider: "people_data_labs", endpoint, operation, success, resultCount, latencyMs, errorCategory, errorCode, cacheHit, correlationId }); }
  catch (error) { console.warn("[PDL] usage ledger write skipped", { code: error.code || "USAGE_LEDGER_WRITE_FAILED" }); }
}

async function searchPeople({ workspaceId, userId = null, sql, size = 25, correlationId = "" } = {}) {
  assertEnabled();
  if (!sql) { const error = new Error("A search query (sql) is required"); error.code = "PDL_QUERY_REQUIRED"; throw error; }
  const safeSize = Math.min(100, Math.max(1, Number(size) || 25));
  const key = cacheKey("searchPeople", { sql, size: safeSize });
  const cached = readCache(key);
  if (cached) { await logUsage({ workspaceId, userId, endpoint: "person/search", operation: "search_people", success: true, resultCount: cached.people.length, latencyMs: 0, cacheHit: true, correlationId }); return cached; }
  const started = Date.now();
  try {
    const response = await withResilience(CIRCUIT_KEY, () => client().post("/person/search", { sql, size: safeSize }));
    const people = (response.data?.data || []).map(normalizePerson);
    const result = { people, total: response.data?.total ?? people.length };
    writeCache(key, result);
    await logUsage({ workspaceId, userId, endpoint: "person/search", operation: "search_people", success: true, resultCount: people.length, latencyMs: Date.now() - started, correlationId });
    return result;
  } catch (error) {
    await logUsage({ workspaceId, userId, endpoint: "person/search", operation: "search_people", success: false, latencyMs: Date.now() - started, errorCategory: error.category || "unknown", errorCode: String(error.response?.status || error.code || ""), correlationId });
    throw error;
  }
}

/**
 * Enrichment requires multiple corroborating identity inputs (never a single
 * loose field) and enforces the documented high-accuracy likelihood
 * threshold before accepting a match.
 */
async function enrichPerson({ workspaceId, userId = null, inputs = {}, minLikelihood = MIN_LIKELIHOOD, correlationId = "" } = {}) {
  assertEnabled();
  const providedInputs = Object.entries(inputs).filter(([, value]) => value != null && String(value).trim());
  if (providedInputs.length < 2) { const error = new Error("PDL enrichment requires at least two corroborating identity inputs (e.g. name + company, or email + name)"); error.code = "PDL_INSUFFICIENT_INPUTS"; throw error; }
  const started = Date.now();
  try {
    const response = await withResilience(CIRCUIT_KEY, () => client().get("/person/enrich", { params: { ...inputs, min_likelihood: Math.max(MIN_LIKELIHOOD, Number(minLikelihood) || MIN_LIKELIHOOD), pretty: false } }));
    const data = response.data?.data;
    const likelihood = response.data?.likelihood ?? data?.likelihood;
    const matched = Boolean(data) && meetsMatchThreshold(likelihood);
    await logUsage({ workspaceId, userId, endpoint: "person/enrich", operation: "enrich_person", success: true, resultCount: matched ? 1 : 0, latencyMs: Date.now() - started, correlationId });
    if (!matched) return { matched: false, likelihood: likelihood ?? null, person: null };
    return { matched: true, likelihood, person: normalizePerson({ ...data, likelihood }) };
  } catch (error) {
    if (Number(error.response?.status) === 404) {
      await logUsage({ workspaceId, userId, endpoint: "person/enrich", operation: "enrich_person", success: true, resultCount: 0, latencyMs: Date.now() - started, correlationId });
      return { matched: false, likelihood: null, person: null };
    }
    await logUsage({ workspaceId, userId, endpoint: "person/enrich", operation: "enrich_person", success: false, latencyMs: Date.now() - started, errorCategory: error.category || "unknown", errorCode: String(error.response?.status || error.code || ""), correlationId });
    throw error;
  }
}

async function enrichCompany({ workspaceId, userId = null, website, name, correlationId = "" } = {}) {
  assertEnabled();
  if (!website && !name) { const error = new Error("A website or company name is required"); error.code = "PDL_COMPANY_INPUT_REQUIRED"; throw error; }
  const started = Date.now();
  try {
    const response = await withResilience(CIRCUIT_KEY, () => client().get("/company/enrich", { params: { website, name } }));
    const company = response.data ? normalizeCompany(response.data) : null;
    await logUsage({ workspaceId, userId, endpoint: "company/enrich", operation: "enrich_company", success: true, resultCount: company ? 1 : 0, latencyMs: Date.now() - started, correlationId });
    return company;
  } catch (error) {
    if (Number(error.response?.status) === 404) {
      await logUsage({ workspaceId, userId, endpoint: "company/enrich", operation: "enrich_company", success: true, resultCount: 0, latencyMs: Date.now() - started, correlationId });
      return null;
    }
    await logUsage({ workspaceId, userId, endpoint: "company/enrich", operation: "enrich_company", success: false, latencyMs: Date.now() - started, errorCategory: error.category || "unknown", errorCode: String(error.response?.status || error.code || ""), correlationId });
    throw error;
  }
}

async function healthCheck({ workspaceId, userId = null, correlationId = "" } = {}) {
  if (!isEnabled()) return { enabled: false, configured: Boolean(process.env.PDL_API_KEY?.trim()), healthy: false, reason: "disabled" };
  const started = Date.now();
  try {
    await withResilience(CIRCUIT_KEY, () => client().get("/person/enrich", { params: { name: "health check", min_likelihood: 10 } }).catch((error) => { if (Number(error.response?.status) === 404) return { data: null }; throw error; }));
    await logUsage({ workspaceId, userId, endpoint: "person/enrich", operation: "health_check", success: true, latencyMs: Date.now() - started, correlationId });
    return { enabled: true, configured: true, healthy: true };
  } catch (error) {
    await logUsage({ workspaceId, userId, endpoint: "person/enrich", operation: "health_check", success: false, latencyMs: Date.now() - started, errorCategory: error.category || "unknown", correlationId });
    return { enabled: true, configured: true, healthy: false, reason: error.category || "unknown" };
  }
}

module.exports = { MIN_LIKELIHOOD, isEnabled, assertEnabled, meetsMatchThreshold, classifyWorkEmail, extractEmailString, normalizePerson, normalizeCompany, searchPeople, enrichPerson, enrichCompany, healthCheck, resetPdlCache };
