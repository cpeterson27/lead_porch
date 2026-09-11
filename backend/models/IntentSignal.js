const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const intentSignalSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  monitorId: { type: mongoose.Schema.Types.ObjectId, ref: "ResearchMonitor", required: true, index: true },
  source: { type: String, required: true, trim: true, index: true },
  sourceId: { type: String, required: true, trim: true },
  sourceUrl: { type: String, required: true, trim: true },
  title: { type: String, default: "", trim: true, maxlength: 1000 },
  excerpt: { type: String, default: "", trim: true, maxlength: 6000 },
  authorName: { type: String, default: "", trim: true },
  authorUrl: { type: String, default: "", trim: true },
  organizationName: { type: String, default: "", trim: true },
  organizationDomain: { type: String, default: "", trim: true },
  publishedEmails: [{ type: String, lowercase: true, trim: true }],
  people: [{
    name: { type: String, default: "", trim: true },
    title: { type: String, default: "", trim: true },
    evidenceUrl: { type: String, default: "", trim: true },
  }],
  websiteResearchStatus: { type: String, enum: ["not_applicable", "pending", "completed", "blocked", "failed"], default: "not_applicable" },
  publishedAt: { type: Date, default: null },
  discoveredAt: { type: Date, default: Date.now },
  matchedKeywords: [{ type: String, trim: true }],
  score: { type: Number, default: 0, min: 0, max: 100, index: true },
  scoreReasons: [{ type: String, trim: true }],
  classification: { type: String, enum: ["buyer_intent", "hypothetical_or_student", "promotion", "job_seeker", "irrelevant", "uncertain"], default: "uncertain", index: true },
  classificationMethod: { type: String, enum: ["rules", "openai"], default: "rules" },
  classificationReason: { type: String, default: "", trim: true },
  audienceEligible: { type: Boolean, default: true, index: true },
  audienceRejectionReason: { type: String, default: "", trim: true },
  identityResolution: {
    status: { type: String, enum: ["unresolved", "supported", "conflicting"], default: "unresolved" },
    reason: { type: String, default: "" },
    evidenceUrls: [{ type: String, trim: true }],
  },
  status: { type: String, enum: ["new", "reviewing", "qualified", "dismissed", "converted"], default: "new", index: true },
  evidence: [{
    label: { type: String, default: "Public source" },
    url: { type: String, required: true },
    observedAt: { type: Date, default: Date.now },
  }],
  // Discovery-track bucket. Distinct from `status` (CRM review lifecycle):
  // this is where the result belongs in the discovery UI. Recomputed from
  // the current eligibility/scoring rules on every fetch (see
  // routes/audience.js's GET /research/signals) — UNLESS
  // manualBucketOverride is set, in which case the owner's own decision
  // always wins over the automatic classifier.
  bucket: { type: String, enum: ["live_lead", "watchlist", "community_opportunity", "rejected"], default: "live_lead", index: true },
  // An owner's explicit "move this" decision (e.g. Watchlist → Live Leads,
  // or "Not a fit" on any track) — null means no manual decision has been
  // made and the automatic classifier's result is used as-is. Set via
  // PATCH /research/signals/:signalId's optional `bucket` field.
  manualBucketOverride: { type: String, enum: ["live_lead", "watchlist", "community_opportunity", "rejected", null], default: null },
  rejectionReason: {
    type: String,
    enum: ["", "seller_or_promoter", "vendor_lender_agent_recruiter", "wrong_industry", "too_experienced", "no_coaching_intent", "generic_discussion", "homework_or_hypothetical", "old_content", "wrong_location", "no_current_need", "not_a_person", "bot_or_automated", "other"],
    default: "",
  },
  // Explicit, inspectable gate + multi-dimensional score. Every field here
  // must be derivable from `evidence`/`raw` — never an unexplained number.
  scoreBreakdown: {
    firstPersonEvidence: { type: Boolean, default: false },
    currentNeed: { type: Boolean, default: false },
    programMatch: { type: String, default: "" },
    learningIntent: { type: Number, default: 0, min: 0, max: 100 },
    experienceStage: { type: String, enum: ["", "aspiring", "beginner", "intermediate", "experienced"], default: "" },
    urgency: { type: Number, default: 0, min: 0, max: 100 },
    readiness: { type: Number, default: 0, min: 0, max: 100 },
    recency: { type: Number, default: 0, min: 0, max: 100 },
    evidenceQuality: { type: Number, default: 0, min: 0, max: 100 },
    identityConfidence: { type: Number, default: 0, min: 0, max: 100 },
    contactability: { type: Number, default: 0, min: 0, max: 100 },
    exclusionRisk: { type: Number, default: 0, min: 0, max: 100 },
  },
  // Populated only for community_opportunity signals.
  communityProfile: {
    platform: { type: String, default: "" },
    audienceFit: { type: String, default: "" },
    location: { type: String, default: "" },
    activityEvidence: { type: String, default: "" },
    organizerEvidence: { type: String, default: "" },
    promotionRules: { type: String, default: "" },
    recommendedApproach: { type: String, default: "" },
  },
  raw: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

intentSignalSchema.index({ workspaceId: 1, source: 1, sourceId: 1 }, { unique: true });
intentSignalSchema.index({ workspaceId: 1, status: 1, score: -1, publishedAt: -1 });
intentSignalSchema.index({ workspaceId: 1, bucket: 1, score: -1, discoveredAt: -1 });

intentSignalSchema.plugin(workspacePlugin);
module.exports = mongoose.model("IntentSignal", intentSignalSchema);
