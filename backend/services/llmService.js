const OpenAI = require("openai");
const AiUsageRecord = require("../models/AiUsageRecord");
const aiConfigService = require("./aiConfigService");
const { estimateCost } = require("./aiPricingService");

const AGENTS = new Set(["jarvis", "lead", "social", "sales", "content", "coaching", "research", "system"]);
const clean = (value, length) => String(value || "").trim().slice(0, length);
function isEnabled() { return process.env.JARVIS_OPENAI_ENABLED === "true" && Boolean(process.env.OPENAI_API_KEY?.trim()); }
function getStatus() { return { configured: Boolean(process.env.OPENAI_API_KEY?.trim()), enabled: isEnabled(), model: process.env.JARVIS_OPENAI_MODEL || "gpt-4.1-mini", researchModel: process.env.JARVIS_RESEARCH_OPENAI_MODEL || "gpt-5.6-terra", webSearchEnabled: isEnabled(), voiceEnabled: isEnabled(), voiceModel: process.env.JARVIS_TTS_MODEL || "gpt-4o-mini-tts" }; }
function normalizeUsage(response = {}) { const usage = response.usage || {}, inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? null, outputTokens = usage.completion_tokens ?? usage.output_tokens ?? null; return { inputTokens, outputTokens, cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? null, reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? null, totalTokens: usage.total_tokens ?? (inputTokens != null || outputTokens != null ? (Number(inputTokens) || 0) + (Number(outputTokens) || 0) : null) }; }
function safeError(error = {}) { const status = Number(error.status || error.statusCode || 0), rawCode = clean(error.code || error.error?.code || "", 120).replace(/[^a-zA-Z0-9_.-]/g, "_"); return { errorCategory: status === 401 || status === 403 ? "authentication" : status === 429 ? "rate_limit" : status >= 500 ? "provider" : /timeout|abort/i.test(`${error.name || ""} ${rawCode}`) ? "timeout" : status >= 400 ? "request" : "unknown", errorCode: rawCode || (status ? `HTTP_${status}` : "OPENAI_REQUEST_FAILED"), providerRequestId: clean(error.request_id || error.requestId || error.headers?.["x-request-id"], 255) }; }

function createLlmService(dependencies = {}) {
  const UsageModel = dependencies.AiUsageRecord || AiUsageRecord, pricing = dependencies.estimateCost || estimateCost, configCheck = dependencies.assertEnabled || aiConfigService.assertEnabled, now = dependencies.now || (() => Date.now());
  const clientFactory = dependencies.clientFactory || (() => new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() }));
  async function record(values) { if (!values.workspaceId) return; try { await UsageModel.create(values); } catch (error) { console.warn("[AI usage] Ledger write skipped", { code: clean(error.code || "AI_USAGE_LEDGER_WRITE_FAILED", 80) }); } }
  async function executeChat({ workspaceId, userId = null, actorType = "user", principal = "", agent = "system", feature = "generation", model, correlationId = "", messages, responseFormat, temperature }) {
    if (!isEnabled() && !dependencies.allowWhenEnvironmentDisabled) throw Object.assign(new Error("OpenAI is not enabled for Jarvis"), { code: "JARVIS_OPENAI_NOT_ENABLED" });
    const normalizedAgent = AGENTS.has(agent) ? agent : "system", selectedModel = clean(model || process.env.JARVIS_OPENAI_MODEL || "gpt-4.1-mini", 160);
    await configCheck({ workspaceId, agent: normalizedAgent }); const started = now();
    try {
      const request = { model: selectedModel, messages }; if (responseFormat) request.response_format = responseFormat; if (temperature !== undefined) request.temperature = temperature;
      const response = await clientFactory().chat.completions.create(request), usage = normalizeUsage(response), costs = pricing(response.model || selectedModel, usage);
      await record({ workspaceId, userId, actorType: actorType === "system" ? "system" : "user", principal: clean(principal, 80), agent: normalizedAgent, feature: clean(feature, 160) || "generation", provider: "openai", model: response.model || selectedModel, endpoint: "chat.completions", ...usage, estimatedInputCostUsd: costs.inputCostUsd, estimatedOutputCostUsd: costs.outputCostUsd, estimatedTotalCostUsd: costs.totalCostUsd, pricingAvailable: costs.pricingAvailable, pricingVersion: costs.pricingVersion, costIsEstimate: true, latencyMs: Math.max(0, now() - started), success: true, providerRequestId: clean(response._request_id || response.request_id, 255), correlationId: clean(correlationId, 255) });
      return response;
    } catch (error) {
      const safe = safeError(error); await record({ workspaceId, userId, actorType: actorType === "system" ? "system" : "user", principal: clean(principal, 80), agent: normalizedAgent, feature: clean(feature, 160) || "generation", provider: "openai", model: selectedModel, endpoint: "chat.completions", inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, totalTokens: null, estimatedInputCostUsd: null, estimatedOutputCostUsd: null, estimatedTotalCostUsd: null, pricingAvailable: false, costIsEstimate: true, latencyMs: Math.max(0, now() - started), success: false, ...safe, correlationId: clean(correlationId, 255) }); throw error;
    }
  }
  async function generateText(options) { const response = await executeChat(options); return response.choices?.[0]?.message?.content?.trim() || ""; }
  async function generateStructured({ schema, schemaName = "growth_operator_output", ...options }) { const responseFormat = schema ? { type: "json_schema", json_schema: { name: clean(schemaName, 64), strict: true, schema } } : { type: "json_object" }; return JSON.parse(await generateText({ ...options, responseFormat }) || "{}"); }
  async function chat({ message, context, profile = {}, workspaceId, userId, agent = "jarvis", feature = "jarvis.chat", model, correlationId }) {
    return await generateText({
      workspaceId, userId, agent, feature, model, correlationId,
      messages: [
        { role: "system", content: `You are ${profile.name || "Jarvis"}, Growth Operator's growth operator. Respond in a ${profile.responseStyle || "collaborative"} style. Directly answer the user's request by synthesizing the relevant supplied notes and workspace facts. Do not merely repeat the generic workspace summary when more specific note context is available. Prefer plain spoken prose with short headings and minimal emoji. Be concise, clear, and never claim that an action was completed unless the application has confirmed it. Use the supplied operational context only; do not invent metrics, contacts, or integrations. Clearly distinguish verified facts from recommendations.` },
        { role: "user", content: `User request:\n${message}\n\nVerified operational context:\n${context}` },
      ],
    }) || "I could not generate a response.";
  }
  return { chat, executeChat, generateStructured, generateText, getStatus, isEnabled, normalizeUsage, safeError };
}
const service = createLlmService();
module.exports = { ...service, createLlmService, normalizeUsage, safeError };
