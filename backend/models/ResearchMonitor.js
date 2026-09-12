const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const researchMonitorSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  // Set only for a monitor suggested by PDF knowledge ingestion
  // (pdfKnowledgeIngestionService.js) — traceability back to the source
  // note. Such a monitor is always created with enabled: false; the
  // scheduler and manual "Run now" both require enabled: true, so it can
  // never run until a human explicitly turns it on via the existing
  // Discovery UI.
  sourceNoteId: { type: mongoose.Schema.Types.ObjectId, ref: "JarvisMemoryNote", default: null },
  monitorType: { type: String, enum: ["buyer_intent", "community_partner", "investor_profile"], default: null, index: true },
  query: { type: String, required: true, trim: true, maxlength: 1200 },
  keywords: [{ type: String, trim: true }],
  intentCategories: [{
    name: { type: String, trim: true },
    phrases: [{ type: String, trim: true }],
  }],
  negativeKeywords: [{ type: String, trim: true }],
  locations: [{ type: String, trim: true }],
  sources: [{ type: String, enum: ["google_web", "bing_web", "bing_news", "linkedin_public", "facebook_public", "meetup_public", "community_directories", "gdelt", "sec_form_d", "bluesky", "hacker_news", "stack_exchange", "discourse", "rss", "reddit_rss", "duckduckgo"] }],
  feedUrls: [{ type: String, trim: true }],
  watchedProfiles: [{
    _id: false,
    url: { type: String, trim: true, maxlength: 500 },
    role: { type: String, enum: ["you", "competitor", "teammate", "expert", "partner"], default: "expert" },
  }],
  enabled: { type: Boolean, default: true, index: true },
  intervalMinutes: { type: Number, default: 60, min: 15, max: 10080 },
  maxResultsPerSource: { type: Number, default: 25, min: 5, max: 100 },
  lastRunAt: { type: Date, default: null },
  nextRunAt: { type: Date, default: Date.now, index: true },
  lastRunStatus: { type: String, enum: ["never", "running", "completed", "partial", "failed"], default: "never" },
  lastRunMessage: { type: String, default: "" },
  runRequestedAt: { type: Date, default: Date.now, index: true },
  leaseOwner: { type: String, default: "" },
  leaseExpiresAt: { type: Date, default: null, index: true },
  sourceHealth: [{
    source: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    lastSuccessfulCheck: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    resultsCollected: { type: Number, default: 0 },
    state: { type: String, enum: ["healthy", "empty", "rate_limited", "blocked", "failed", "never"], default: "never" },
    nextScheduledAttempt: { type: Date, default: null },
  }],
  totals: {
    runs: { type: Number, default: 0 },
    signalsFound: { type: Number, default: 0 },
    signalsQualified: { type: Number, default: 0 },
  },
  lastRunFunnel: {
    engineVersion: { type: String, default: "" },
    candidatesFetched: { type: Number, default: 0 },
    uniqueEvidenceEvaluated: { type: Number, default: 0 },
    weakMatchesRejected: { type: Number, default: 0 },
    qualifiedOpportunities: { type: Number, default: 0 },
    sourceContributions: [{ source: String, candidates: Number }],
    measuredAt: { type: Date, default: null },
  },
}, { timestamps: true });

researchMonitorSchema.index({ workspaceId: 1, enabled: 1, nextRunAt: 1 });
researchMonitorSchema.index({ enabled: 1, runRequestedAt: 1, leaseExpiresAt: 1 });

researchMonitorSchema.plugin(workspacePlugin);
module.exports = mongoose.model("ResearchMonitor", researchMonitorSchema);
