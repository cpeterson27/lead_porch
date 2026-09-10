/**
 * Optional Google Gemini Developer API provider. Disabled by default; every
 * exported function throws immediately (no HTTP call, no cost) unless the
 * platform flags AND the requesting workspace's own settings both explicitly
 * enable the specific capability being called.
 *
 * Two deliberately separate capabilities — do not conflate them:
 *   - workspaceContext: answers a question strictly from THIS workspace's own
 *                      already-approved content (Knowledge Center notes,
 *                      matching CRM organizations) via prompt-stuffing —
 *                      never the open web, and NOT a search index. This is
 *                      NOT Vertex AI Search/Agent Builder; for real indexed,
 *                      tenant-isolated retrieval over Knowledge Center
 *                      documents, see services/discoveryEngineService.js.
 *   - groundedSearch:  controlled public-web discovery via Gemini's Google
 *                      Search grounding tool, for people/organizations/
 *                      events/communities/intent evidence, always with
 *                      citations back to the source Gemini grounded on.
 *
 * Uses its own server-only credential (GEMINI_API_KEY) — never
 * GOOGLE_SEARCH_API_KEY/GOOGLE_SEARCH_ENGINE_ID (the legacy Custom Search
 * adapter in intentSourceService.js), and never the Vertex AI service-account
 * credential (GOOGLE_APPLICATION_CREDENTIALS_JSON) used by
 * services/vertexGroundingService.js / services/discoveryEngineService.js.
 * This provider talks to generativelanguage.googleapis.com (API-key auth),
 * NOT {location}-aiplatform.googleapis.com (Vertex, service-account auth) —
 * they are separate Google products with separate credentials, and all three
 * Gemini-family providers here (this one, Vertex grounding, Discovery
 * Engine) are independent — any subset can be enabled without the others.
 *
 * IMPORTANT: the request/response shapes below follow Gemini's publicly
 * documented generateContent + Google Search grounding API as of this
 * writing, but this integration has NOT been exercised against a live
 * Gemini endpoint (no credentials are configured in this environment). Do
 * not describe this as "live-tested" or "verified" until it has actually
 * been run against real GEMINI_API_KEY credentials — see
 * scripts/gemini-smoke-test.js for the manual verification step.
 */
const axios = require("axios");
const AiUsageRecord = require("../models/AiUsageRecord");
const { estimateCost } = require("./aiPricingService");
const { withResilience } = require("./providerResilience");
const geminiConfigService = require("./geminiConfigService");
const knowledgeService = require("./knowledgeService");
const Organization = require("../models/Organization");

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const CIRCUIT_WORKSPACE_CONTEXT = "gemini_workspace_context";
const CIRCUIT_GROUNDING = "gemini_grounding";
const RESULT_TYPES = ["person", "organization", "event", "community", "intent_signal"];
const clean = (value, length) => String(value || "").trim().slice(0, length);

function masterEnabled() {
  return process.env.GEMINI_ENABLED === "true" && Boolean(process.env.GEMINI_API_KEY?.trim());
}
function workspaceContextPlatformEnabled() { return masterEnabled() && process.env.GEMINI_WORKSPACE_CONTEXT_ENABLED === "true"; }
function groundingPlatformEnabled() { return masterEnabled() && process.env.GEMINI_GROUNDING_ENABLED === "true"; }
function workspaceContextModel() { return clean(process.env.GEMINI_WORKSPACE_CONTEXT_MODEL, 160) || "gemini-2.5-flash"; }
function groundingModel() { return clean(process.env.GEMINI_GROUNDING_MODEL, 160) || "gemini-2.5-flash"; }

function disabledError(code, message) { return Object.assign(new Error(message), { code }); }

async function platformAvailable(dependencies = {}) {
  const check = dependencies.geminiPlatformAvailable || require("./platformConfigService").geminiPlatformAvailable;
  return check(dependencies.PlatformConfig);
}

async function assertWorkspaceContextReady(workspaceId, dependencies) {
  if (!masterEnabled()) throw disabledError("GEMINI_DISABLED", "Gemini is not enabled. Set GEMINI_ENABLED=true and GEMINI_API_KEY to use any Gemini capability.");
  if (!workspaceContextPlatformEnabled()) throw disabledError("GEMINI_WORKSPACE_CONTEXT_DISABLED", "Gemini Workspace Context is not enabled at the platform level. Set GEMINI_WORKSPACE_CONTEXT_ENABLED=true.");
  if (!(await platformAvailable(dependencies))) throw disabledError("GEMINI_PLATFORM_UNAVAILABLE", "A platform administrator has turned off Gemini availability.");
  return geminiConfigService.assertCapabilityEnabled({ workspaceId, capability: "workspaceContextEnabled" }, dependencies);
}
async function assertGroundingReady(workspaceId, dependencies) {
  if (!masterEnabled()) throw disabledError("GEMINI_DISABLED", "Gemini is not enabled. Set GEMINI_ENABLED=true and GEMINI_API_KEY to use any Gemini capability.");
  if (!groundingPlatformEnabled()) throw disabledError("GEMINI_GROUNDING_DISABLED", "Gemini Grounding is not enabled at the platform level. Set GEMINI_GROUNDING_ENABLED=true.");
  if (!(await platformAvailable(dependencies))) throw disabledError("GEMINI_PLATFORM_UNAVAILABLE", "A platform administrator has turned off Gemini availability.");
  return geminiConfigService.assertCapabilityEnabled({ workspaceId, capability: "groundingEnabled" }, dependencies);
}

function client(http = axios) {
  return { post: (model, body) => http.post(`${BASE_URL}/models/${model}:generateContent`, body, { params: { key: process.env.GEMINI_API_KEY.trim() }, timeout: 20000 }) };
}

function normalizeUsage(response = {}) {
  const usage = response.usageMetadata || {};
  return { inputTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount ?? null, cachedTokens: usage.cachedContentTokenCount ?? null, reasoningTokens: usage.thoughtsTokenCount ?? null, totalTokens: usage.totalTokenCount ?? null };
}
function categorize(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  return status === 401 || status === 403 ? "authentication" : status === 429 ? "rate_limit" : status >= 500 ? "provider" : /timeout|abort/i.test(String(error?.code || "")) ? "timeout" : status >= 400 ? "request" : "unknown";
}

async function logUsage({ workspaceId, userId = null, agent = "system", feature, model, endpoint, response, error, latencyMs, correlationId = "" }, models = { AiUsageRecord }) {
  if (!workspaceId) return;
  const usage = response ? normalizeUsage(response) : { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, totalTokens: null };
  const costs = response ? estimateCost(model, usage) : { pricingAvailable: false, pricingVersion: "", inputCostUsd: null, outputCostUsd: null, totalCostUsd: null };
  try {
    await models.AiUsageRecord.create({
      workspaceId, userId, agent, feature, provider: "gemini", model, endpoint,
      ...usage,
      estimatedInputCostUsd: costs.inputCostUsd, estimatedOutputCostUsd: costs.outputCostUsd, estimatedTotalCostUsd: costs.totalCostUsd,
      pricingAvailable: costs.pricingAvailable, pricingVersion: costs.pricingVersion, costIsEstimate: true,
      latencyMs: Math.max(0, latencyMs), success: !error,
      errorCategory: error ? categorize(error) : "", errorCode: error ? clean(error.code || "GEMINI_REQUEST_FAILED", 120) : "",
      correlationId: clean(correlationId, 255),
    });
  } catch (logError) { console.warn("[Gemini] usage ledger write skipped", { code: logError.code || "AI_USAGE_LEDGER_WRITE_FAILED" }); }
}

/** Pull whatever this workspace's approved content actually contains today. */
async function gatherWorkspaceContext({ workspaceId, query, agent }) {
  const knowledge = await knowledgeService.retrieveKnowledge({ workspaceId, query, agent }).catch(() => ({ available: false, sources: [], context: "" }));
  const organizations = await Organization.find({ workspaceId, $or: [{ name: new RegExp(String(query || "").slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { notes: new RegExp(String(query || "").slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }] }).select("name domain notes").limit(10).lean().catch(() => []);
  // Genuinely not built yet (see the Knowledge Center / Ambassador Resource
  // Center work) — surfaced honestly rather than silently omitted.
  const unavailableSources = [
    { source: "uploaded_documents", reason: "Document upload/indexing is not yet implemented." },
    { source: "approved_websites", reason: "A curated approved-website allowlist is not yet implemented." },
  ];
  return { knowledge, organizations, unavailableSources };
}

/**
 * Answers a question strictly from the workspace's own already-approved
 * knowledge + structured CRM data, via prompt-stuffing — never touches the
 * open web, and is NOT a search index (see the module header). Returns with
 * zero Gemini call (and zero cost) if nothing approved matched the query.
 */
async function workspaceContext({ workspaceId, userId = null, agent = "research", feature = "workspace_context", query, correlationId = "" } = {}, dependencies = {}) {
  await assertWorkspaceContextReady(workspaceId, dependencies);
  if (!String(query || "").trim()) throw Object.assign(new Error("A query is required"), { code: "GEMINI_QUERY_REQUIRED" });
  const context = await (dependencies.gatherWorkspaceContext || gatherWorkspaceContext)({ workspaceId, query, agent });
  const hasContext = Boolean(context.knowledge?.available) || context.organizations.length > 0;
  if (!hasContext) {
    return { answer: "", citations: [], sourcesUsed: [], unavailableSources: context.unavailableSources, matched: false, reason: "No approved workspace content matched this query." };
  }
  const model = workspaceContextModel();
  const prompt = `You are answering strictly from the workspace's own APPROVED content below. Never use outside knowledge, never invent facts, and cite which supplied source each claim comes from. If the supplied content does not answer the question, say so plainly instead of guessing.\n\nApproved knowledge notes:\n${context.knowledge?.context || "(none)"}\n\nMatching CRM organizations:\n${context.organizations.map((o) => `- ${o.name}${o.domain ? ` (${o.domain})` : ""}`).join("\n") || "(none)"}\n\nQuestion: ${query}`;
  const started = Date.now();
  try {
    const response = await withResilience(CIRCUIT_WORKSPACE_CONTEXT, () => (dependencies.httpClient || client(dependencies.http)).post(model, { contents: [{ role: "user", parts: [{ text: prompt }] }] }));
    const data = response.data;
    const answer = clean(data?.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") || "", 8000);
    await logUsage({ workspaceId, userId, agent, feature, model, endpoint: "generateContent", response: data, latencyMs: Date.now() - started, correlationId }, dependencies.models);
    return {
      answer,
      citations: context.knowledge?.sources || [],
      sourcesUsed: [context.knowledge?.available ? "approved_knowledge" : null, context.organizations.length ? "structured_data" : null].filter(Boolean),
      unavailableSources: context.unavailableSources,
      matched: true,
    };
  } catch (error) {
    await logUsage({ workspaceId, userId, agent, feature, model, endpoint: "generateContent", error, latencyMs: Date.now() - started, correlationId }, dependencies.models);
    throw error;
  }
}

function normalizeGroundingCitations(candidate) {
  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  return chunks.map((chunk) => ({ url: chunk.web?.uri || "", title: chunk.web?.title || "" })).filter((row) => row.url);
}

/** Extract a fenced ```json ... ``` block if present; otherwise null. */
function extractJsonBlock(text) {
  const match = String(text || "").match(/```json\s*([\s\S]*?)```/i) || String(text || "").match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) return null;
  try { return JSON.parse(match[1] || match[0]); } catch { return null; }
}

function fingerprint(result) {
  return `${result.type}:${String(result.name || "").trim().toLowerCase()}:${String(result.organizationDomain || "").trim().toLowerCase()}`;
}

/**
 * Deduplicates by (type, name, domain) and raises confidence only when the
 * SAME entity is corroborated by evidence from more than one distinct
 * citation domain — never on repetition from a single source.
 */
function deduplicateAndCorroborate(results) {
  const byKey = new Map();
  for (const result of results) {
    const key = fingerprint(result);
    const domains = new Set((result.evidenceUrls || []).map((url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }).filter(Boolean));
    if (!byKey.has(key)) { byKey.set(key, { ...result, evidenceDomains: domains }); continue; }
    const existing = byKey.get(key);
    for (const domain of domains) existing.evidenceDomains.add(domain);
    existing.evidenceUrls = [...new Set([...(existing.evidenceUrls || []), ...(result.evidenceUrls || [])])];
  }
  return [...byKey.values()].map((result) => ({
    ...result,
    confidence: result.evidenceDomains.size >= 2 ? "corroborated" : "single_source",
    evidenceDomains: [...result.evidenceDomains],
  }));
}

/**
 * Controlled public-web discovery via Gemini's Google Search grounding.
 * Every result must carry at least one citation URL Gemini actually
 * grounded on — never scrapes Google directly, never claims access to
 * private Facebook/LinkedIn content (the prompt explicitly forbids it, and
 * results without a real citation are dropped, not fabricated).
 */
async function groundedSearch({ workspaceId, userId = null, agent = "research", feature = "grounded_search", query, resultTypes = RESULT_TYPES, correlationId = "" } = {}, dependencies = {}) {
  await assertGroundingReady(workspaceId, dependencies);
  if (!String(query || "").trim()) throw Object.assign(new Error("A query is required"), { code: "GEMINI_QUERY_REQUIRED" });
  const requestedTypes = resultTypes.filter((type) => RESULT_TYPES.includes(type));
  if (!requestedTypes.length) throw Object.assign(new Error(`resultTypes must include at least one of: ${RESULT_TYPES.join(", ")}`), { code: "GEMINI_RESULT_TYPES_REQUIRED" });
  const model = groundingModel();
  const prompt = `Search the public web for real, currently-findable ${requestedTypes.join("/")} results relevant to: ${query}\n\nRules:\n- Only report something you can point to a real, currently retrievable public source for.\n- Never claim access to private Facebook or LinkedIn content, private groups, or login-only data — public pages only.\n- Never invent a person, organization, email, or fact you did not actually find.\n- After your findings, output a fenced \`\`\`json array where each item is {"type": one of ${JSON.stringify(RESULT_TYPES)}, "name": string, "organizationName": string, "organizationDomain": string, "summary": string, "evidenceUrls": [string]}. Omit anything you are not confident is real.`;
  const started = Date.now();
  try {
    const response = await withResilience(CIRCUIT_GROUNDING, () => (dependencies.httpClient || client(dependencies.http)).post(model, { contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }));
    const data = response.data;
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text).join("") || "";
    const groundingCitations = normalizeGroundingCitations(candidate);
    const parsed = extractJsonBlock(text);
    const rawResults = Array.isArray(parsed) ? parsed : [];
    // Each result's evidence comes ONLY from what the model itself cited for
    // that specific entity — the page-level groundingCitations are kept
    // separate (below) rather than blanket-attached to every result, since
    // that would misattribute a citation to something it may not support.
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
    await logUsage({ workspaceId, userId, agent, feature, model, endpoint: "generateContent", response: data, latencyMs: Date.now() - started, correlationId }, dependencies.models);
    return { results: deduplicateAndCorroborate(results), groundingCitations, rawText: parsed ? "" : clean(text, 4000) };
  } catch (error) {
    await logUsage({ workspaceId, userId, agent, feature, model, endpoint: "generateContent", error, latencyMs: Date.now() - started, correlationId }, dependencies.models);
    throw error;
  }
}

async function healthCheck({ workspaceId, userId = null, correlationId = "" } = {}, dependencies = {}) {
  if (!masterEnabled()) return { enabled: false, configured: Boolean(process.env.GEMINI_API_KEY?.trim()), healthy: false, reason: "disabled" };
  const started = Date.now();
  try {
    const response = await withResilience(CIRCUIT_WORKSPACE_CONTEXT, () => (dependencies.httpClient || client(dependencies.http)).post(workspaceContextModel(), { contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }] }));
    await logUsage({ workspaceId, userId, agent: "system", feature: "health_check", model: workspaceContextModel(), endpoint: "generateContent", response: response.data, latencyMs: Date.now() - started, correlationId }, dependencies.models);
    return { enabled: true, configured: true, healthy: true };
  } catch (error) {
    await logUsage({ workspaceId, userId, agent: "system", feature: "health_check", model: workspaceContextModel(), endpoint: "generateContent", error, latencyMs: Date.now() - started, correlationId }, dependencies.models);
    return { enabled: true, configured: true, healthy: false, reason: categorize(error) };
  }
}

module.exports = {
  RESULT_TYPES,
  masterEnabled,
  workspaceContextPlatformEnabled,
  groundingPlatformEnabled,
  workspaceContextModel,
  groundingModel,
  workspaceContext,
  groundedSearch,
  healthCheck,
  deduplicateAndCorroborate,
  extractJsonBlock,
  gatherWorkspaceContext,
  normalizeGroundingCitations,
};
