const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const aiUsageRecordSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  actorType: { type: String, enum: ["user", "system"], default: "user", index: true },
  principal: { type: String, default: "", maxlength: 80, index: true },
  agent: { type: String, enum: ["jarvis", "lead", "social", "sales", "content", "coaching", "research", "system"], required: true, index: true },
  feature: { type: String, required: true, trim: true, maxlength: 160 },
  provider: { type: String, enum: ["openai", "gemini", "vertex"], default: "openai", required: true },
  model: { type: String, required: true, trim: true, maxlength: 160, index: true },
  endpoint: { type: String, required: true, trim: true, maxlength: 80 },
  inputTokens: { type: Number, default: null, min: 0 },
  outputTokens: { type: Number, default: null, min: 0 },
  cachedTokens: { type: Number, default: null, min: 0 },
  reasoningTokens: { type: Number, default: null, min: 0 },
  totalTokens: { type: Number, default: null, min: 0 },
  estimatedInputCostUsd: { type: Number, default: null, min: 0 },
  estimatedOutputCostUsd: { type: Number, default: null, min: 0 },
  estimatedTotalCostUsd: { type: Number, default: null, min: 0 },
  costIsEstimate: { type: Boolean, default: true },
  pricingAvailable: { type: Boolean, default: false },
  pricingVersion: { type: String, default: "", maxlength: 40 },
  latencyMs: { type: Number, required: true, min: 0 },
  success: { type: Boolean, required: true, index: true },
  errorCategory: { type: String, default: "", maxlength: 80 },
  errorCode: { type: String, default: "", maxlength: 120 },
  providerRequestId: { type: String, default: "", maxlength: 255 },
  correlationId: { type: String, default: "", maxlength: 255, index: true },
}, { timestamps: true, collection: "ai_usage_records" });

aiUsageRecordSchema.plugin(workspacePlugin);
aiUsageRecordSchema.index({ workspaceId: 1, createdAt: -1 });
aiUsageRecordSchema.index({ workspaceId: 1, agent: 1, createdAt: -1 });
module.exports = mongoose.model("AiUsageRecord", aiUsageRecordSchema);
