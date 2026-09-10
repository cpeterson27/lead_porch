/**
 * Real OpenAI image generation, behind its own explicit flag (separate from
 * general chat) so turning on Jarvis chat never silently enables image
 * spend. Disabled unless OPENAI_IMAGE_GENERATION_ENABLED, JARVIS_OPENAI_ENABLED,
 * and OPENAI_API_KEY are all set. Generated images are uploaded through the
 * same Cloudinary pipeline as every other asset — never a bare OpenAI URL,
 * which expires.
 */
const OpenAI = require("openai");
const AiUsageRecord = require("../models/AiUsageRecord");
const imageAssetService = require("./imageAssetService");

// USD per image. Deliberately small, versioned, and honest about being an
// estimate — matches the convention in services/aiPricingService.js.
const PRICING_VERSION = "2026-09-10";
const IMAGE_PRICING = Object.freeze({
  "gpt-image-1": { "1024x1024": 0.04, "1024x1536": 0.06, "1536x1024": 0.06 },
});

function isEnabled() {
  return process.env.OPENAI_IMAGE_GENERATION_ENABLED === "true" && process.env.JARVIS_OPENAI_ENABLED === "true" && Boolean(process.env.OPENAI_API_KEY?.trim());
}

function assertEnabled() {
  if (!isEnabled()) {
    const error = new Error("OpenAI image generation is not enabled. Set OPENAI_IMAGE_GENERATION_ENABLED=true, JARVIS_OPENAI_ENABLED=true, and OPENAI_API_KEY.");
    error.code = "IMAGE_GENERATION_DISABLED";
    throw error;
  }
}

function estimateImageCost(model, size) {
  const table = IMAGE_PRICING[model];
  const perImage = table?.[size];
  return { pricingAvailable: Boolean(perImage), pricingVersion: PRICING_VERSION, totalCostUsd: perImage ?? null, costIsEstimate: true };
}

async function recordUsage(values, models = { AiUsageRecord }) {
  if (!values.workspaceId) return;
  try { await models.AiUsageRecord.create(values); }
  catch (error) { console.warn("[Image generation] usage ledger write skipped", { code: error.code || "USAGE_LEDGER_WRITE_FAILED" }); }
}

/**
 * Generate one image, upload it to Cloudinary, and log usage/cost. Never
 * returns a bare OpenAI-hosted URL (those expire) — the caller always gets
 * back a real, permanent asset URL plus everything needed for provenance:
 * prompt, model, generation ID, usage/cost, campaign, tenant, timestamp.
 */
async function generateImage({ workspaceId, userId = null, actorType = "user", principal = "", prompt, size = "1024x1024", quality = "standard", campaignId = null, agent = "content", feature = "image.generate", correlationId = "", folder }, dependencies = {}) {
  assertEnabled();
  const cleanPrompt = String(prompt || "").trim().slice(0, 4000);
  if (!cleanPrompt) { const error = new Error("A prompt is required to generate an image"); error.code = "IMAGE_PROMPT_REQUIRED"; throw error; }
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const client = dependencies.clientFactory ? dependencies.clientFactory() : new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
  const started = Date.now();
  try {
    const response = await client.images.generate({ model, prompt: cleanPrompt, size, quality, n: 1 });
    const generation = response.data?.[0];
    if (!generation?.b64_json && !generation?.url) throw new Error("OpenAI did not return image data");
    const fileData = generation.b64_json ? `data:image/png;base64,${generation.b64_json}` : generation.url;
    const uploader = dependencies.uploadImage || imageAssetService.uploadImage;
    const asset = await uploader({ file: fileData, folder: folder || `growth-operator/generated/${workspaceId}` });
    const costs = estimateImageCost(model, size);
    await recordUsage({ workspaceId, userId, actorType, principal, agent, feature, provider: "openai", model, endpoint: "images.generate", inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, totalTokens: null, estimatedInputCostUsd: null, estimatedOutputCostUsd: costs.totalCostUsd, estimatedTotalCostUsd: costs.totalCostUsd, pricingAvailable: costs.pricingAvailable, pricingVersion: costs.pricingVersion, costIsEstimate: true, latencyMs: Date.now() - started, success: true, correlationId }, dependencies.models);
    return { url: asset.url, publicId: asset.publicId, width: asset.width, height: asset.height, prompt: cleanPrompt, model, generationId: response.id || response.created ? String(response.id || response.created) : "", usage: { estimatedCostUsd: costs.totalCostUsd, pricingAvailable: costs.pricingAvailable }, campaignId, workspaceId, generatedAt: new Date() };
  } catch (error) {
    const status = Number(error?.status || error?.response?.status || 0);
    const errorCategory = status === 401 || status === 403 ? "authentication" : status === 429 ? "rate_limit" : status >= 500 ? "provider" : "request";
    await recordUsage({ workspaceId, userId, actorType, principal, agent, feature, provider: "openai", model, endpoint: "images.generate", latencyMs: Date.now() - started, success: false, errorCategory, errorCode: String(status || error.code || ""), correlationId }, dependencies.models);
    throw error;
  }
}

module.exports = { isEnabled, assertEnabled, estimateImageCost, generateImage, IMAGE_PRICING, PRICING_VERSION };
