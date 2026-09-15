/**
 * Apollo.io server-side integration (API key, no OAuth/customer credentials).
 * Disabled by default. When disabled, every exported function throws
 * immediately without making any HTTP request or spending any credit.
 *
 * Endpoints match Apollo's documented REST API (v1). Verify against
 * Apollo's current API reference before the first live smoke test — see
 * scripts/apollo-smoke-test.js.
 */
const axios = require("axios");
const ProviderApiUsage = require("../models/ProviderApiUsage");
const { withResilience } = require("./providerResilience");

const BASE_URL = "https://api.apollo.io/api/v1";
const CIRCUIT_KEY = "apollo";
const CACHE_TTL_MS = 5 * 60000;
const cache = new Map();

function isEnabled() {
  return process.env.APOLLO_ENABLED === "true" && Boolean(process.env.APOLLO_API_KEY?.trim());
}

function assertEnabled() {
  if (!isEnabled()) {
    const error = new Error("Apollo is not enabled for this workspace. Set APOLLO_ENABLED=true and APOLLO_API_KEY to use it.");
    error.code = "APOLLO_DISABLED";
    throw error;
  }
}

function client() {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 10000,
    headers: { "Content-Type": "application/json", "x-api-key": process.env.APOLLO_API_KEY.trim() },
  });
}

function cacheKey(operation, params) { return `${operation}:${JSON.stringify(params)}`; }
function readCache(key) { const hit = cache.get(key); return hit && hit.expiresAt > Date.now() ? hit.value : null; }
function writeCache(key, value) { cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS }); }
function resetApolloCache() { cache.clear(); }

function cleanText(value, max = 1000) { return String(value ?? "").trim().slice(0, max); }
function cleanList(value, maxItems = 100, maxLength = 300) {
  // Apollo's own technology_names list commonly repeats entries (confirmed
  // live) — dedupe so the UI doesn't show the same technology 2-3 times.
  return [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}
function cleanNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }

// Apollo returns a locked placeholder instead of a real address when the
// email requires unlocking with credits. Never treat this as a real email.
function isPlaceholderEmail(email) {
  return !email || /email_not_unlocked|^unlock@|no_email@/i.test(String(email));
}

/**
 * Classify an Apollo email per its real semantics: `email_status` measures
 * Apollo's own confidence, and only a *revealed*, verified address counts as
 * provider-verified. Apollo's own data is still never "guaranteed accurate."
 */
function classifyEmail({ email, emailStatus }) {
  if (isPlaceholderEmail(email)) return { state: "unavailable", providerVerified: false, revealed: false };
  const status = String(emailStatus || "").toLowerCase();
  if (status === "verified") return { state: "verified", providerVerified: true, revealed: true };
  if (status === "extrapolated") return { state: "extrapolated", providerVerified: false, revealed: true };
  if (["catch_all", "catchall", "accept_all"].includes(status)) return { state: "catch_all", providerVerified: false, revealed: true };
  if (status === "unavailable") return { state: "unavailable", providerVerified: false, revealed: false };
  return { state: "unverified", providerVerified: false, revealed: true };
}

function normalizePerson(raw = {}) {
  const emailInfo = classifyEmail({ email: raw.email, emailStatus: raw.email_status });
  const organization = raw.organization || {};
  return {
    provider: "apollo",
    externalId: raw.id || "",
    fullName: raw.name || [raw.first_name, raw.last_name].filter(Boolean).join(" "),
    firstName: raw.first_name || "",
    lastName: raw.last_name || "",
    title: raw.title || "",
    headline: cleanText(raw.headline, 500),
    photoUrl: cleanText(raw.photo_url, 1000),
    seniority: cleanText(raw.seniority, 100),
    departments: cleanList(raw.departments),
    subdepartments: cleanList(raw.subdepartments),
    functions: cleanList(raw.functions),
    company: raw.organization?.name || raw.organization_name || "",
    companyDomain: raw.organization?.primary_domain || raw.organization?.website_url?.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "") || "",
    linkedinUrl: raw.linkedin_url || "",
    facebookUrl: cleanText(raw.facebook_url, 1000),
    twitterUrl: cleanText(raw.twitter_url, 1000),
    githubUrl: cleanText(raw.github_url, 1000),
    city: cleanText(raw.city, 150),
    state: cleanText(raw.state, 150),
    country: cleanText(raw.country, 150),
    location: [raw.city, raw.state, raw.country].filter(Boolean).join(", "),
    email: emailInfo.revealed ? raw.email : "",
    emailState: emailInfo.state,
    emailProviderVerified: emailInfo.providerVerified,
    phoneNumbers: (raw.phone_numbers || []).map((item) => item.sanitized_number || item.raw_number).filter(Boolean),
    employmentHistory: (raw.employment_history || []).slice(0, 30).map((job) => ({
      title: cleanText(job.title, 200),
      organizationName: cleanText(job.organization_name || job.organization?.name, 200),
      startDate: cleanText(job.start_date, 30),
      endDate: cleanText(job.end_date, 30),
      current: Boolean(job.current),
    })),
    organization: {
      id: cleanText(organization.id, 100),
      name: cleanText(organization.name, 200),
      domain: cleanText(organization.primary_domain, 300),
      websiteUrl: cleanText(organization.website_url, 1000),
      linkedinUrl: cleanText(organization.linkedin_url, 1000),
      facebookUrl: cleanText(organization.facebook_url, 1000),
      twitterUrl: cleanText(organization.twitter_url, 1000),
      industry: cleanText(organization.industry, 200),
      employeeCount: cleanNumber(organization.estimated_num_employees),
      phone: cleanText(organization.phone, 100),
      city: cleanText(organization.city, 150),
      state: cleanText(organization.state, 150),
      country: cleanText(organization.country, 150),
      shortDescription: cleanText(organization.short_description, 2000),
      keywords: cleanList(organization.keywords),
      // Apollo's real field names (confirmed live against a raw enrichment
      // response) are `technology_names` and `organization_revenue` — a
      // plain `technologies`/`annual_revenue` key does not exist on the
      // response, so reading those silently produced an empty result every
      // time regardless of what Apollo actually had on file.
      technologies: cleanList(organization.technology_names),
      annualRevenue: cleanNumber(organization.organization_revenue),
      totalFunding: cleanNumber(organization.total_funding),
      foundedYear: cleanNumber(organization.founded_year),
    },
    retrievedAt: new Date().toISOString(),
    raw: { id: raw.id, organizationId: raw.organization?.id },
  };
}

function normalizeCompany(raw = {}) {
  return {
    provider: "apollo",
    externalId: raw.id || "",
    name: raw.name || "",
    domain: raw.primary_domain || "",
    industry: raw.industry || "",
    employeeCount: raw.estimated_num_employees ?? null,
    location: [raw.city, raw.state, raw.country].filter(Boolean).join(", "),
    linkedinUrl: raw.linkedin_url || "",
    retrievedAt: new Date().toISOString(),
    raw: { id: raw.id },
  };
}

async function logUsage({ workspaceId, userId = null, endpoint, operation, success, resultCount = null, latencyMs, errorCategory = "", errorCode = "", cacheHit = false, correlationId = "" }, models = { ProviderApiUsage }) {
  if (!workspaceId) return;
  try { await models.ProviderApiUsage.create({ workspaceId, userId, provider: "apollo", endpoint, operation, success, resultCount, latencyMs, errorCategory, errorCode, cacheHit, correlationId }); }
  catch (error) { console.warn("[Apollo] usage ledger write skipped", { code: error.code || "USAGE_LEDGER_WRITE_FAILED" }); }
}

function dedupePeople(people) {
  const seen = new Map();
  for (const person of people) {
    const key = person.externalId || person.email || `${person.fullName}|${person.company}`;
    if (!seen.has(key)) seen.set(key, person);
  }
  return [...seen.values()];
}

/**
 * Search for people. `filters` mirrors Apollo's documented search filters
 * (person_titles, organization_domains, person_locations, etc.) passed
 * through as-is; this function only adds pagination limits, normalization,
 * caching, and usage logging.
 */
async function searchPeople({ workspaceId, userId = null, filters = {}, page = 1, perPage = 25, correlationId = "" } = {}) {
  assertEnabled();
  const safePerPage = Math.min(100, Math.max(1, Number(perPage) || 25));
  const key = cacheKey("searchPeople", { filters, page, perPage: safePerPage });
  const cached = readCache(key);
  if (cached) { await logUsage({ workspaceId, userId, endpoint: "mixed_people/api_search", operation: "search_people", success: true, resultCount: cached.people.length, latencyMs: 0, cacheHit: true, correlationId }); return cached; }
  const started = Date.now();
  try {
    // Apollo's People API Search accepts its filters as query parameters.
    // Posting them as a JSON body can return HTTP 200 with an empty result
    // set because the requested titles/locations were never applied.
    const response = await withResilience(CIRCUIT_KEY, () => client().post(
      "/mixed_people/api_search",
      null,
      { params: { ...filters, page: Math.max(1, Number(page) || 1), per_page: safePerPage } },
    ));
    const people = dedupePeople((response.data?.people || []).map(normalizePerson));
    const result = { people, pagination: { page: response.data?.pagination?.page || page, totalEntries: response.data?.pagination?.total_entries ?? people.length, totalPages: response.data?.pagination?.total_pages ?? 1 } };
    writeCache(key, result);
    await logUsage({ workspaceId, userId, endpoint: "mixed_people/api_search", operation: "search_people", success: true, resultCount: people.length, latencyMs: Date.now() - started, correlationId });
    return result;
  } catch (error) {
    await logUsage({ workspaceId, userId, endpoint: "mixed_people/api_search", operation: "search_people", success: false, latencyMs: Date.now() - started, errorCategory: error.category || "unknown", errorCode: String(error.response?.status || error.code || ""), correlationId });
    throw error;
  }
}

async function searchCompanies({ workspaceId, userId = null, filters = {}, page = 1, perPage = 25, correlationId = "" } = {}) {
  assertEnabled();
  const safePerPage = Math.min(100, Math.max(1, Number(perPage) || 25));
  const started = Date.now();
  try {
    const response = await withResilience(CIRCUIT_KEY, () => client().post("/mixed_companies/search", { ...filters, page: Math.max(1, Number(page) || 1), per_page: safePerPage }));
    const companies = (response.data?.organizations || []).map(normalizeCompany);
    await logUsage({ workspaceId, userId, endpoint: "mixed_companies/search", operation: "search_companies", success: true, resultCount: companies.length, latencyMs: Date.now() - started, correlationId });
    return { companies, pagination: { page: response.data?.pagination?.page || page, totalEntries: response.data?.pagination?.total_entries ?? companies.length, totalPages: response.data?.pagination?.total_pages ?? 1 } };
  } catch (error) {
    await logUsage({ workspaceId, userId, endpoint: "mixed_companies/search", operation: "search_companies", success: false, latencyMs: Date.now() - started, errorCategory: error.category || "unknown", errorCode: String(error.response?.status || error.code || ""), correlationId });
    throw error;
  }
}

/** Enrichment (Apollo "match") reveals contact details for one identified person — costs credits. */
async function enrichPerson({ workspaceId, userId = null, matchInput = {}, revealEmail = true, correlationId = "" } = {}) {
  assertEnabled();
  const started = Date.now();
  try {
    const response = await withResilience(CIRCUIT_KEY, () => client().post("/people/match", { ...matchInput, reveal_personal_emails: Boolean(revealEmail) }));
    const person = response.data?.person ? normalizePerson(response.data.person) : null;
    if (person) person.matchConfidence = cleanText(response.data?.match_confidence, 30);
    await logUsage({ workspaceId, userId, endpoint: "people/match", operation: "enrich_person", success: true, resultCount: person ? 1 : 0, latencyMs: Date.now() - started, correlationId });
    return person;
  } catch (error) {
    await logUsage({ workspaceId, userId, endpoint: "people/match", operation: "enrich_person", success: false, latencyMs: Date.now() - started, errorCategory: error.category || "unknown", errorCode: String(error.response?.status || error.code || ""), correlationId });
    throw error;
  }
}

async function enrichCompany({ workspaceId, userId = null, domain, correlationId = "" } = {}) {
  assertEnabled();
  if (!domain) { const error = new Error("A domain is required to enrich a company"); error.code = "APOLLO_DOMAIN_REQUIRED"; throw error; }
  const started = Date.now();
  try {
    const response = await withResilience(CIRCUIT_KEY, () => client().get("/organizations/enrich", { params: { domain } }));
    const company = response.data?.organization ? normalizeCompany(response.data.organization) : null;
    await logUsage({ workspaceId, userId, endpoint: "organizations/enrich", operation: "enrich_company", success: true, resultCount: company ? 1 : 0, latencyMs: Date.now() - started, correlationId });
    return company;
  } catch (error) {
    await logUsage({ workspaceId, userId, endpoint: "organizations/enrich", operation: "enrich_company", success: false, latencyMs: Date.now() - started, errorCategory: error.category || "unknown", errorCode: String(error.response?.status || error.code || ""), correlationId });
    throw error;
  }
}

async function healthCheck({ workspaceId, userId = null, correlationId = "" } = {}) {
  if (!isEnabled()) return { enabled: false, configured: Boolean(process.env.APOLLO_API_KEY?.trim()), healthy: false, reason: "disabled" };
  const started = Date.now();
  try {
    await withResilience(CIRCUIT_KEY, () => client().get("/auth/health"));
    await logUsage({ workspaceId, userId, endpoint: "auth/health", operation: "health_check", success: true, latencyMs: Date.now() - started, correlationId });
    return { enabled: true, configured: true, healthy: true };
  } catch (error) {
    await logUsage({ workspaceId, userId, endpoint: "auth/health", operation: "health_check", success: false, latencyMs: Date.now() - started, errorCategory: error.category || "unknown", correlationId });
    return { enabled: true, configured: true, healthy: false, reason: error.category || "unknown" };
  }
}

module.exports = { isEnabled, assertEnabled, classifyEmail, isPlaceholderEmail, normalizePerson, normalizeCompany, dedupePeople, searchPeople, searchCompanies, enrichPerson, enrichCompany, healthCheck, resetApolloCache };
