/**
 * Shared usage-ledger writer for the several services that call OpenAI
 * directly with `new OpenAI(...)` instead of going through
 * llmService.createLlmService()'s already-tracked executeChat() — business
 * card reading, event audience recommendations, market-question parsing,
 * public people research, and research-monitor signal classification.
 *
 * Real, reported incident (2026-10-04): the owner asked "where is all my
 * OpenAI spend going" and the Usage & Agents page could not fully answer —
 * these five real, costed call sites were writing nothing to AiUsageRecord
 * at all, so a real slice of her actual spend was simply invisible on the
 * one page meant to account for all of it. This extracts the same
 * usage/cost-recording logic llmService.js and geminiService.js each
 * already have (normalizeUsage/estimateCost/safeError) into one shared
 * helper so every future direct-OpenAI call site uses it instead of
 * re-implementing — or, more likely, forgetting to implement — its own
 * tracking.
 */
const AiUsageRecord = require("../models/AiUsageRecord");
const { normalizeUsage, safeError } = require("./llmService");
const { estimateCost } = require("./aiPricingService");

const clean = (value, length) => String(value || "").trim().slice(0, length);

async function recordOpenAiUsage({ workspaceId, userId = null, agent = "system", feature, model, endpoint = "chat.completions", response, error, latencyMs = 0, correlationId = "" }) {
  if (!workspaceId) return;
  const usage = response ? normalizeUsage(response) : { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, totalTokens: null };
  const costs = response ? estimateCost(response.model || model, usage) : { inputCostUsd: null, outputCostUsd: null, totalCostUsd: null, pricingAvailable: false, pricingVersion: "" };
  const safe = error ? safeError(error) : {};
  try {
    await AiUsageRecord.create({
      workspaceId, userId, agent, feature: clean(feature, 160) || "generation", provider: "openai",
      model: response?.model || model, endpoint,
      ...usage,
      estimatedInputCostUsd: costs.inputCostUsd, estimatedOutputCostUsd: costs.outputCostUsd, estimatedTotalCostUsd: costs.totalCostUsd,
      pricingAvailable: costs.pricingAvailable, pricingVersion: costs.pricingVersion, costIsEstimate: true,
      latencyMs: Math.max(0, latencyMs), success: !error,
      ...safe,
      correlationId: clean(correlationId, 255),
    });
  } catch (logError) {
    console.warn("[AI usage] Ledger write skipped", { code: clean(logError.code || "AI_USAGE_LEDGER_WRITE_FAILED", 80) });
  }
}

module.exports = { recordOpenAiUsage };
