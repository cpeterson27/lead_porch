/**
 * Optional Vertex AI Gemini + Google Search grounding provider. Disabled by
 * default; throws immediately (no HTTP call, no cost) unless the platform
 * flags AND the requesting workspace's own settings both explicitly enable
 * it. A SEPARATE Google product from services/geminiService.js's own
 * "Grounding" capability: this one calls Vertex AI
 * ({location}-aiplatform.googleapis.com) with a server-side service-account
 * credential via services/googleAuthService.js, never GEMINI_API_KEY. The
 * two Grounding providers are fully independent — either, both, or neither
 * may be enabled — and never share a budget or usage ledger row.
 *
 * IMPORTANT: this integration has NOT been exercised against a live Google
 * Cloud project (no credentials are configured in this environment). Do not
 * describe this as "live-tested" or "verified" until it has actually been
 * run against a real Google Cloud project with real credentials — see
 * scripts/vertex-smoke-test.js for the manual verification step.
 */
const axios = require("axios");
const AiUsageRecord = require("../models/AiUsageRecord");
const { estimateCost } = require("./aiPricingService");
const { withResilience } = require("./providerResilience");
const vertexConfigService = require("./vertexConfigService");
const googleAuthService = require("./googleAuthService");
const { RESULT_TYPES, extractJsonBlock, deduplicateAndCorroborate, normalizeGroundingCitations } = require("./geminiService");

const CIRCUIT = "vertex_grounding";
const clean = (value, length) => String(value || "").trim().slice(0, length);

function masterEnabled() {
  return process.env.VERTEX_ENABLED === "true" && googleAuthService.configured();
}
function groundingPlatformEnabled() {
  return masterEnabled() && process.env.VERTEX_GROUNDING_ENABLED === "true";
}
function model() {
  return clean(process.env.VERTEX_GEMINI_MODEL, 160) || "gemini-2.5-flash-002";
}
function location() {
  return clean(process.env.VERTEX_AI_LOCATION, 60) || "us-central1";
}

function disabledError(code, message) { return Object.assign(new Error(message), { code }); }

async function platformAvailable(dependencies = {}) {
  const check = dependencies.vertexPlatformAvailable || require("./platformConfigService").vertexPlatformAvailable;
  return check(dependencies.PlatformConfig);
}

async function assertGroundingReady(workspaceId, dependencies) {
  if (!masterEnabled()) throw disabledError("VERTEX_DISABLED", "Vertex AI is not enabled. Set VERTEX_ENABLED=true and configure GOOGLE_APPLICATION_CREDENTIALS_JSON/VERTEX_PROJECT_ID to use any Vertex capability.");
  if (!groundingPlatformEnabled()) throw disabledError("VERTEX_GROUNDING_DISABLED", "Vertex Grounding is not enabled at the platform level. Set VERTEX_GROUNDING_ENABLED=true.");
  if (!(await platformAvailable(dependencies))) throw disabledError("VERTEX_PLATFORM_UNAVAILABLE", "A platform administrator has turned off Vertex AI availability.");
  return vertexConfigService.assertCapabilityEnabled({ workspaceId, capability: "groundingEnabled" }, dependencies);
}

function endpoint() {
  const project = clean(process.env.VERTEX_PROJECT_ID, 160);
  if (!project) throw disabledError("VERTEX_PROJECT_MISSING", "VERTEX_PROJECT_ID is not configured");
  return `https://${location()}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location()}/publishers/google/models/${model()}:generateContent`;
}

async function client(http = axios, dependencies = {}) {
  const token = await (dependencies.getAccessToken || googleAuthService.getAccessToken)();
  return { post: (body) => http.post(endpoint(), body, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }) };
}

function normalizeUsage(response = {}) {
  const usage = response.usageMetadata || {};
  return { inputTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount ?? null, cachedTokens: usage.cachedContentTokenCount ?? null, reasoningTokens: usage.thoughtsTokenCount ?? null, totalTokens: usage.totalTokenCount ?? null };
}
function categorize(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  return status === 401 || status === 403 ? "authentication" : status === 429 ? "rate_limit" : status >= 500 ? "provider" : /timeout|abort/i.test(String(error?.code || "")) ? "timeout" : status >= 400 ? "request" : "unknown";
}

async function logUsage({ workspaceId, userId = null, agent = "system", feature, response, error, latencyMs, correlationId = "" }, models = { AiUsageRecord }) {
  if (!workspaceId) return;
  const usage = response ? normalizeUsage(response) : { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, totalTokens: null };
  const costs = response ? estimateCost(model(), usage) : { pricingAvailable: false, pricingVersion: "", inputCostUsd: null, outputCostUsd: null, totalCostUsd: null };
  try {
    await models.AiUsageRecord.create({
      workspaceId, userId, agent, feature, provider: "vertex", model: model(), endpoint: "generateContent",
      ...usage,
      estimatedInputCostUsd: costs.inputCostUsd, estimatedOutputCostUsd: costs.outputCostUsd, estimatedTotalCostUsd: costs.totalCostUsd,
      pricingAvailable: costs.pricingAvailable, pricingVersion: costs.pricingVersion, costIsEstimate: true,
      latencyMs: Math.max(0, latencyMs), success: !error,
      errorCategory: error ? categorize(error) : "", errorCode: error ? clean(error.code || "VERTEX_REQUEST_FAILED", 120) : "",
      correlationId: clean(correlationId, 255),
    });
  } catch (logError) { console.warn("[Vertex grounding] usage ledger write skipped", { code: logError.code || "AI_USAGE_LEDGER_WRITE_FAILED" }); }
}

/**
 * Controlled public-web discovery via Vertex AI Gemini's Google Search
 * grounding. Every result must carry at least one citation URL Vertex
 * actually grounded on — never scrapes Google directly, never claims access
 * to private Facebook/LinkedIn content.
 */
async function groundedSearch({ workspaceId, userId = null, agent = "research", feature = "vertex_grounded_search", query, resultTypes = RESULT_TYPES, correlationId = "" } = {}, dependencies = {}) {
  await assertGroundingReady(workspaceId, dependencies);
  if (!String(query || "").trim()) throw Object.assign(new Error("A query is required"), { code: "VERTEX_QUERY_REQUIRED" });
  const requestedTypes = resultTypes.filter((type) => RESULT_TYPES.includes(type));
  if (!requestedTypes.length) throw Object.assign(new Error(`resultTypes must include at least one of: ${RESULT_TYPES.join(", ")}`), { code: "VERTEX_RESULT_TYPES_REQUIRED" });
  const prompt = `Search the public web for real, currently-findable ${requestedTypes.join("/")} results relevant to: ${query}\n\nRules:\n- Only report something you can point to a real, currently retrievable public source for.\n- Never claim access to private Facebook or LinkedIn content, private groups, or login-only data — public pages only.\n- Never invent a person, organization, email, or fact you did not actually find.\n- After your findings, output a fenced \`\`\`json array where each item is {"type": one of ${JSON.stringify(RESULT_TYPES)}, "name": string, "organizationName": string, "organizationDomain": string, "summary": string, "evidenceUrls": [string]}. Omit anything you are not confident is real.`;
  const started = Date.now();
  try {
    // Vertex's REST tool key is camelCase ("googleSearch"), unlike the Gemini
    // Developer API's snake_case ("google_search") used in geminiService.js
    // — a real, documented difference between the two APIs, not a typo.
    const httpClient = dependencies.httpClient || await client(dependencies.http, dependencies);
    const response = await withResilience(CIRCUIT, () => httpClient.post({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ googleSearch: {} }] }));
    const data = response.data;
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text).join("") || "";
    const groundingCitations = normalizeGroundingCitations(candidate);
    const parsed = extractJsonBlock(text);
    const rawResults = Array.isArray(parsed) ? parsed : [];
    const isHttpUrl = (value) => { try { const url = new URL(String(value)); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; } };
    const results = rawResults
      .filter((row) => RESULT_TYPES.includes(row?.type) && String(row?.name || "").trim())
      .map((row) => ({
        type: row.type,
        name: clean(row.name, 200),
        organizationName: clean(row.organizationName, 200),
        organizationDomain: clean(row.organizationDomain, 200),
        summary: clean(row.summary, 1000),
        evidenceUrls: [...new Set((Array.isArray(row.evidenceUrls) ? row.evidenceUrls : []).filter(isHttpUrl))].slice(0, 10),
      }))
      .filter((row) => row.evidenceUrls.length > 0);
    await logUsage({ workspaceId, userId, agent, feature, response: data, latencyMs: Date.now() - started, correlationId }, dependencies.models);
    return { results: deduplicateAndCorroborate(results), groundingCitations, rawText: parsed ? "" : clean(text, 4000) };
  } catch (error) {
    await logUsage({ workspaceId, userId, agent, feature, error, latencyMs: Date.now() - started, correlationId }, dependencies.models);
    throw error;
  }
}

async function healthCheck({ workspaceId, userId = null, correlationId = "" } = {}, dependencies = {}) {
  if (!masterEnabled()) return { enabled: false, configured: googleAuthService.configured(), healthy: false, reason: "disabled" };
  const started = Date.now();
  try {
    const httpClient = dependencies.httpClient || await client(dependencies.http, dependencies);
    const response = await withResilience(CIRCUIT, () => httpClient.post({ contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }] }));
    await logUsage({ workspaceId, userId, agent: "system", feature: "health_check", response: response.data, latencyMs: Date.now() - started, correlationId }, dependencies.models);
    return { enabled: true, configured: true, healthy: true };
  } catch (error) {
    await logUsage({ workspaceId, userId, agent: "system", feature: "health_check", error, latencyMs: Date.now() - started, correlationId }, dependencies.models);
    return { enabled: true, configured: true, healthy: false, reason: categorize(error) };
  }
}

module.exports = { masterEnabled, groundingPlatformEnabled, model, location, groundedSearch, healthCheck };
