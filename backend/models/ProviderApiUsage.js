/**
 * Usage/cost/health ledger for external data-provider API calls (Apollo,
 * People Data Labs, and future providers). Separate from AiUsageRecord,
 * which tracks OpenAI usage specifically.
 */
const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  provider: { type: String, enum: ["apollo", "people_data_labs"], required: true, index: true },
  endpoint: { type: String, required: true, maxlength: 120 },
  operation: { type: String, required: true, maxlength: 80 },
  success: { type: Boolean, required: true, index: true },
  creditsUsed: { type: Number, default: null, min: 0 },
  resultCount: { type: Number, default: null, min: 0 },
  latencyMs: { type: Number, required: true, min: 0 },
  errorCategory: { type: String, default: "", maxlength: 80 },
  errorCode: { type: String, default: "", maxlength: 120 },
  cacheHit: { type: Boolean, default: false },
  correlationId: { type: String, default: "", maxlength: 200 },
}, { timestamps: true, collection: "provider_api_usage" });

schema.index({ workspaceId: 1, provider: 1, createdAt: -1 });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("ProviderApiUsage", schema);
