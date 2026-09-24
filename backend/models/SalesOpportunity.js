const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const salesOpportunitySchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 180 },
  stageKey: { type: String, required: true, default: "new", index: true },
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null, index: true },
  primaryContactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", default: null, index: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null, index: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  closerAssignment: {
    assignedAt: { type: Date, default: null },
    source: { type: String, default: "", maxlength: 80 },
    reason: { type: String, default: "", maxlength: 500 },
    history: { type: [{ _id: false, fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, toUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, assignedAt: { type: Date, default: Date.now }, assignedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, source: { type: String, default: "manual", maxlength: 80 }, reason: { type: String, default: "", maxlength: 500 } }], default: [] },
  },
  leadQualification: {
    status: { type: String, enum: ["", "discovered", "evaluating", "qualified", "not_qualified", "needs_review"], default: "", index: true },
    score: { type: Number, default: null, min: 0, max: 100 },
    priority: { type: String, enum: ["", "low", "medium", "high", "urgent"], default: "" },
    confidence: { type: Number, default: null, min: 0, max: 1 },
    reasons: { type: [String], default: [] },
    observedEvidence: { type: [{ _id: false, label: String, url: String, observedAt: Date }], default: [] },
    aiInferences: { type: [String], default: [] },
    likelyNeed: { type: String, default: "", maxlength: 1000 },
    recommendedNextAction: { type: String, default: "", maxlength: 1000 },
    warnings: { type: [String], default: [] },
    method: { type: String, enum: ["", "deterministic", "deterministic_plus_ai"], default: "" },
    evaluatedAt: { type: Date, default: null },
    sourceSignalId: { type: mongoose.Schema.Types.ObjectId, ref: "IntentSignal", default: null, index: true },
  },
  leadLifecycle: {
    status: { type: String, enum: ["", "discovered", "evaluating", "qualified", "assigned", "contacted", "engaged", "application", "won", "lost"], default: "", index: true },
    statusAt: { type: Date, default: null },
    lastOutreachAt: { type: Date, default: null },
    lastEngagedAt: { type: Date, default: null },
  },
  leadAttribution: {
    source: { type: String, default: "", maxlength: 100 },
    monitorId: { type: mongoose.Schema.Types.ObjectId, ref: "ResearchMonitor", default: null },
    signalId: { type: mongoose.Schema.Types.ObjectId, ref: "IntentSignal", default: null },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null },
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", default: null },
    socialProvider: { type: String, default: "", maxlength: 80 },
    contentId: { type: String, default: "", maxlength: 255 },
    interactionType: { type: String, default: "", maxlength: 80 },
    inboundExcerpt: { type: String, default: "", maxlength: 500 },
    lastSocialAt: { type: Date, default: null },
    sourceUrl: { type: String, default: "", maxlength: 2000 },
  },
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachingApplication", default: null, index: true },
  coachingProgramId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachingProgram", default: null, index: true },
  value: { type: Number, default: 0, min: 0 }, // Contracted Revenue — the full deal value, set once from the first successful payment or plan total
  cashCollected: { type: Number, default: 0, min: 0 }, // Cash Collected — running total of what has actually been paid so far, distinct from the contracted value above
  currency: { type: String, default: "USD", uppercase: true, trim: true, maxlength: 3 },
  probability: { type: Number, default: 0, min: 0, max: 100 },
  expectedCloseAt: { type: Date, default: null },
  nextAction: { type: String, default: "", trim: true, maxlength: 500 },
  nextActionAt: { type: Date, default: null },
  notes: { type: String, default: "", trim: true, maxlength: 5000 },
  wonAt: { type: Date, default: null },
  lostAt: { type: Date, default: null },
  lostReason: { type: String, default: "", trim: true, maxlength: 500 },
}, { timestamps: true, collection: "sales_opportunities" });

salesOpportunitySchema.index({ workspaceId: 1, stageKey: 1, updatedAt: -1 });
salesOpportunitySchema.index({ workspaceId: 1, ownerId: 1, "leadLifecycle.status": 1, "leadQualification.priority": 1 });
salesOpportunitySchema.plugin(workspacePlugin);
module.exports = mongoose.model("SalesOpportunity", salesOpportunitySchema);
