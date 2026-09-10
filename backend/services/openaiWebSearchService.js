/**
 * Optional OpenAI Responses API `web_search` public-web discovery provider.
 * Disabled by default; throws immediately (no HTTP call, no cost) unless
 * OPENAI_WEB_SEARCH_ENABLED=true AND OPENAI_API_KEY is configured AND the
 * requesting workspace's own AI budget/agent settings
 * (services/aiConfigService.js — the SAME workspace monthly-budget gate every
 * other OpenAI/Jarvis call in this app goes through) allow it. This is a
 * deliberate reuse of the existing budget enforcement, not a parallel one:
 * usage recorded here (provider "openai") counts toward the same workspace
 * monthly total aiUsageService.summary() already sums across every OpenAI
 * call, so the existing monthly limit still applies.
 *
 * `web_search` is a hosted tool on OpenAI's Responses API
 * (`client.responses.create(...)`) — a separate API from the Chat
 * Completions API (`client.chat.completions.create(...)`) that
 * services/llmService.js uses for every other OpenAI/Jarvis feature in this
 * app (see that file's header). Not every model supports this tool on the
 * Responses API, and that support can change over time. Rather than
 * hardcode a guess about which models do, this only ever tries the
 * workspace's actually-configured research model
 * (JARVIS_RESEARCH_OPENAI_MODEL) and, if OpenAI's own API rejects the
 * tool/model combination, surfaces that as a clear
 * OPENAI_WEB_SEARCH_UNSUPPORTED_MODEL configuration error. It never silently
 * retries with a different model and never falls back to Chat Completions
 * (which has no web_search tool at all).
 *
 * A SECOND, independent public-web source alongside
 * services/vertexGroundingService.js (Vertex AI Gemini + Google Search
 * grounding) — either, both, or neither may be enabled;
 * services/vertexGroundingDiscoveryService.js merges whichever are enabled
 * into one deduplicated review queue with per-provider citations preserved.
 */
const OpenAI = require("openai");
const AiUsageRecord = require("../models/AiUsageRecord");
const { estimateCost } = require("./aiPricingService");
const { withResilience } = require("./providerResilience");
const aiConfigService = require("./aiConfigService");
const { RESULT_TYPES, extractJsonBlock, deduplicateAndCorroborate } = require("./geminiService");

const CIRCUIT = "openai_web_search";
const WEB_SEARCH_TIMEOUT_MS = 60000;
const DEFAULT_MAX_RESULTS = 5;
const clean = (value, length) => String(value || "").trim().slice(0, length);

function masterEnabled() {
  return process.env.OPENAI_WEB_SEARCH_ENABLED === "true" && Boolean(process.env.OPENAI_API_KEY?.trim());
}
function model() {
  return clean(process.env.JARVIS_RESEARCH_OPENAI_MODEL, 160) || "gpt-5.6-sol";
}
function disabledError(code, message) { return Object.assign(new Error(message), { code }); }

async function assertReady({ workspaceId }, dependencies = {}) {
  if (!masterEnabled()) throw disabledError("OPENAI_WEB_SEARCH_DISABLED", "OpenAI Web Search is not enabled. Set OPENAI_WEB_SEARCH_ENABLED=true and configure OPENAI_API_KEY to use this capability.");
  const configCheck = dependencies.assertEnabled || aiConfigService.assertEnabled;
  return configCheck({ workspaceId, agent: "research" }, dependencies);
}

function categorize(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  return status === 401 || status === 403 ? "authentication" : status === 429 ? "rate_limit" : status >= 500 ? "provider" : /timeout|abort/i.test(String(error?.code || error?.name || "")) ? "timeout" : status >= 400 ? "request" : "unknown";
}

/**
 * OpenAI's SDK throws an APIError whose exact shape for "this model doesn't
 * support this tool" is not something we can verify without a live call
 * (explicitly out of scope this turn). This is a defensive, best-effort
 * detection of a 400 whose param/message names the tool or model as the
 * problem — never a guess about WHICH models are supported.
 */
function isUnsupportedToolError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  if (status !== 400) return false;
  const message = String(error?.message || error?.error?.message || "").toLowerCase();
  const param = String(error?.param || error?.error?.param || "").toLowerCase();
  return param.includes("tool") || param === "model" || /web_search|does not support|not supported|unsupported tool|invalid tool/.test(message);
}

function normalizeUsage(response = {}) {
  const usage = response.usage || {};
  const inputTokens = usage.input_tokens ?? null, outputTokens = usage.output_tokens ?? null;
  return {
    inputTokens, outputTokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens ?? null,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
    totalTokens: usage.total_tokens ?? (inputTokens != null || outputTokens != null ? (Number(inputTokens) || 0) + (Number(outputTokens) || 0) : null),
  };
}

async function logUsage({ workspaceId, userId = null, agent = "research", feature, response, error, latencyMs, correlationId = "" }, models = { AiUsageRecord }) {
  if (!workspaceId) return;
  const usage = response ? normalizeUsage(response) : { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, totalTokens: null };
  const costs = response ? estimateCost(model(), usage) : { pricingAvailable: false, pricingVersion: "", inputCostUsd: null, outputCostUsd: null, totalCostUsd: null };
  try {
    await models.AiUsageRecord.create({
      workspaceId, userId, agent, feature, provider: "openai", model: model(), endpoint: "responses",
      ...usage,
      estimatedInputCostUsd: costs.inputCostUsd, estimatedOutputCostUsd: costs.outputCostUsd, estimatedTotalCostUsd: costs.totalCostUsd,
      pricingAvailable: costs.pricingAvailable, pricingVersion: costs.pricingVersion, costIsEstimate: true,
      latencyMs: Math.max(0, latencyMs), success: !error,
      errorCategory: error ? categorize(error) : "", errorCode: error ? clean(error.code || "OPENAI_WEB_SEARCH_REQUEST_FAILED", 120) : "",
      correlationId: clean(correlationId, 255),
    });
  } catch (logError) { console.warn("[OpenAI web search] usage ledger write skipped", { code: logError.code || "AI_USAGE_LEDGER_WRITE_FAILED" }); }
}

function extractOutputText(response) {
  if (typeof response.output_text === "string" && response.output_text) return response.output_text;
  const messages = (response.output || []).filter((item) => item.type === "message");
  return messages.flatMap((item) => (item.content || []).filter((part) => part.type === "output_text").map((part) => part.text)).join("");
}

/** OpenAI's web_search tool attaches url_citation annotations to the output_text parts it grounded. */
function extractCitations(response) {
  const messages = (response.output || []).filter((item) => item.type === "message");
  const annotations = messages.flatMap((item) => (item.content || []).filter((part) => part.type === "output_text").flatMap((part) => part.annotations || []));
  return annotations.filter((row) => row.type === "url_citation" && row.url).map((row) => ({ url: row.url, title: row.title || "" }));
}

/**
 * Controlled public-web discovery via OpenAI's Responses API web_search
 * tool. Every result must carry at least one citation URL actually returned
 * by the model — never scrapes anything directly, never claims access to
 * private Facebook/LinkedIn content.
 */
async function groundedSearch({ workspaceId, userId = null, agent = "research", feature = "openai_web_search", query, resultTypes = RESULT_TYPES, maxResults = DEFAULT_MAX_RESULTS, correlationId = "" } = {}, dependencies = {}) {
  await assertReady({ workspaceId }, dependencies);
  if (!String(query || "").trim()) throw Object.assign(new Error("A query is required"), { code: "OPENAI_WEB_SEARCH_QUERY_REQUIRED" });
  const requestedTypes = resultTypes.filter((type) => RESULT_TYPES.includes(type));
  if (!requestedTypes.length) throw Object.assign(new Error(`resultTypes must include at least one of: ${RESULT_TYPES.join(", ")}`), { code: "OPENAI_WEB_SEARCH_RESULT_TYPES_REQUIRED" });
  const cappedMax = Math.max(1, Math.min(DEFAULT_MAX_RESULTS, Number(maxResults) || DEFAULT_MAX_RESULTS));
  const selectedModel = model();
  const prompt = `Search the public web for at most ${cappedMax} real, currently-findable ${requestedTypes.join("/")} results relevant to: ${query}\n\nRules:\n- Only report something you can point to a real, currently retrievable public source for.\n- Never claim access to private Facebook or LinkedIn content, private groups, or login-only data — public pages only.\n- Never invent a person, organization, email, or fact you did not actually find.\n- Return at most ${cappedMax} results.\n- After your findings, output a fenced \`\`\`json array where each item is {"type": one of ${JSON.stringify(requestedTypes)}, "name": string, "organizationName": string, "organizationDomain": string, "summary": string, "evidenceUrls": [string]}. Omit anything you are not confident is real.`;
  const started = Date.now();
  try {
    const client = dependencies.clientFactory ? dependencies.clientFactory() : new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
    // maxRetries: 0 — same reasoning as vertexGroundingService.js: a slow or
    // failed grounded web-search call is not a flaky failure worth silently
    // retrying (and re-retrying would silently multiply real OpenAI spend).
    const response = await withResilience(CIRCUIT, () => client.responses.create({ model: selectedModel, input: prompt, tools: [{ type: "web_search" }] }, { timeout: WEB_SEARCH_TIMEOUT_MS }), { maxRetries: 0 });
    const text = extractOutputText(response);
    const groundingCitations = extractCitations(response);
    const parsed = extractJsonBlock(text);
    const rawResults = Array.isArray(parsed) ? parsed : [];
    const isHttpUrl = (value) => { try { const url = new URL(String(value)); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; } };
    const results = rawResults
      .filter((row) => requestedTypes.includes(row?.type) && String(row?.name || "").trim())
      .map((row) => ({
        type: row.type,
        name: clean(row.name, 200),
        organizationName: clean(row.organizationName, 200),
        organizationDomain: clean(row.organizationDomain, 200),
        summary: clean(row.summary, 1000),
        evidenceUrls: [...new Set((Array.isArray(row.evidenceUrls) ? row.evidenceUrls : []).filter(isHttpUrl))].slice(0, 10),
      }))
      .filter((row) => row.evidenceUrls.length > 0)
      .slice(0, cappedMax);
    await logUsage({ workspaceId, userId, agent, feature, response, latencyMs: Date.now() - started, correlationId });
    return { results: deduplicateAndCorroborate(results), groundingCitations, rawText: parsed ? "" : clean(text, 4000) };
  } catch (error) {
    await logUsage({ workspaceId, userId, agent, feature, error, latencyMs: Date.now() - started, correlationId });
    if (isUnsupportedToolError(error)) {
      throw Object.assign(
        new Error(`The configured OpenAI research model ("${selectedModel}") does not support the Responses API web_search tool. Set JARVIS_RESEARCH_OPENAI_MODEL to a model that supports web_search, or turn off OPENAI_WEB_SEARCH_ENABLED.`),
        { code: "OPENAI_WEB_SEARCH_UNSUPPORTED_MODEL", httpStatus: 409 },
      );
    }
    const category = categorize(error);
    if (category === "timeout") throw Object.assign(new Error("OpenAI web search is taking longer than usual and did not finish in time. Please try again in a moment."), { code: "OPENAI_WEB_SEARCH_TIMEOUT", httpStatus: 504 });
    if (category === "authentication") throw Object.assign(new Error("OpenAI authentication failed. Contact your platform administrator."), { code: "OPENAI_WEB_SEARCH_AUTH_FAILED", httpStatus: 502 });
    if (category === "rate_limit") throw Object.assign(new Error("OpenAI rate limit reached. Please try again in a moment."), { code: "OPENAI_WEB_SEARCH_RATE_LIMITED", httpStatus: 429 });
    throw Object.assign(new Error("OpenAI web search could not complete right now. Please try again."), { code: "OPENAI_WEB_SEARCH_FAILED", httpStatus: 502 });
  }
}

module.exports = { masterEnabled, model, groundedSearch, DEFAULT_MAX_RESULTS };
