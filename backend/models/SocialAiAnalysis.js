const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  threadId: { type: mongoose.Schema.Types.ObjectId, ref: "ConversationThread", required: true, index: true },
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: "ConversationMessage", default: null, index: true },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", default: null, index: true },
  opportunityId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesOpportunity", default: null, index: true },
  analysisVersion: { type: String, required: true, maxlength: 80 },
  interactionHash: { type: String, required: true, maxlength: 64 },
  action: { type: String, required: true, maxlength: 80 },
  platform: { type: String, enum: ["instagram", "facebook", "linkedin", "x"], required: true },
  interactionType: { type: String, default: "message", maxlength: 80 },
  intent: { type: String, enum: ["general_question", "program_interest", "pricing_question", "application_interest", "coaching_interest", "buying_intent", "objection", "support", "partnership", "spam", "irrelevant", "human_requested", "unknown"], default: "unknown", index: true },
  confidence: { type: Number, min: 0, max: 1, default: 0 },
  sentiment: { type: String, enum: ["", "positive", "neutral", "negative", "mixed"], default: "" },
  leadPotential: { type: String, enum: ["none", "low", "medium", "high"], default: "none", index: true },
  objections: { type: [String], default: [] },
  urgency: { type: String, enum: ["", "low", "medium", "high"], default: "" },
  programFit: { type: String, default: "", maxlength: 300 },
  qualificationSignals: { type: [String], default: [] },
  observedEvidence: { type: [String], default: [] },
  inference: { type: [String], default: [] },
  recommendedAction: { type: String, default: "", maxlength: 1200 },
  suggestedReply: { type: String, default: "", maxlength: 4000 },
  reason: { type: String, default: "", maxlength: 1200 },
  requiresHuman: { type: Boolean, default: true },
  handoffState: { type: String, enum: ["ai_assistance_available", "human_review_required", "closer_attention_required", "human_handling", "resolved"], default: "human_review_required", index: true },
  aiUsed: { type: Boolean, default: false },
  aiDecisionReason: { type: String, default: "", maxlength: 300 },
  correlationId: { type: String, default: "", maxlength: 200 },
  analyzedAt: { type: Date, default: Date.now },
}, { timestamps: true, collection: "social_ai_analyses" });
schema.index({ workspaceId: 1, threadId: 1, action: 1, analysisVersion: 1, interactionHash: 1 }, { unique: true });
schema.index({ workspaceId: 1, platform: 1, leadPotential: 1, analyzedAt: -1 });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("SocialAiAnalysis", schema);
