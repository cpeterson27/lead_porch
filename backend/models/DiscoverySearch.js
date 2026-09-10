/**
 * A Jarvis-coordinated lead-generation search plan: proposed (free, no
 * provider call), reviewed by the owner, then approved to actually run.
 * Owned by services/leadGenerationCoordinatorService.js. New, additive —
 * does not replace or modify GroundingResearchResult's existing
 * Vertex/OpenAI search() flow in services/vertexGroundingDiscoveryService.js;
 * an approved DiscoverySearch calls into that existing flow for the
 * vertex/openai_web_search sources and into new PDL/Apollo Person Search
 * code for the other two, merging everything into the same
 * GroundingResearchResult review queue.
 *
 * A search is never auto-run — "proposed" is a pure preview (ICP, sources,
 * freshness, requested count, estimated credit use) the owner reviews
 * before "approve" spends anything.
 */
const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const SOURCES = ["vertex", "openai_web_search", "pdl_person_search", "apollo_person_search", "all"];

const discoverySearchSchema = new mongoose.Schema({
  requestedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  naturalLanguageRequest: { type: String, required: true, trim: true, maxlength: 2000 },
  programNoteId: { type: mongoose.Schema.Types.ObjectId, ref: "JarvisMemoryNote", default: null },
  programName: { type: String, default: "", trim: true, maxlength: 200 },
  // Editable ICP — deliberately Mixed rather than a rigid sub-schema so the
  // owner can adjust any field before approving without a migration.
  icp: {
    titles: { type: [String], default: [] },
    industries: { type: [String], default: [] },
    locations: { type: [String], default: [] },
    keywords: { type: [String], default: [] },
    seniority: { type: [String], default: [] },
    companySizeRange: { type: String, default: "", trim: true, maxlength: 80 },
    notes: { type: String, default: "", trim: true, maxlength: 1000 },
  },
  sources: { type: [String], enum: SOURCES, default: ["all"] },
  freshnessDays: { type: Number, default: 90, min: 1, max: 365 },
  requestedCount: { type: Number, default: 10, min: 1, max: 25 },
  estimatedCreditUse: {
    pdl: { type: Number, default: 0 },
    apollo: { type: Number, default: 0 },
    vertex: { type: String, default: "" },
    openai: { type: String, default: "" },
    note: { type: String, default: "", trim: true, maxlength: 500 },
  },
  status: { type: String, enum: ["proposed", "approved", "running", "completed", "failed"], default: "proposed", index: true },
  approvedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  approvedAt: { type: Date, default: null },
  runSummary: {
    created: { type: Number, default: 0 },
    merged: { type: Number, default: 0 },
    withConflicts: { type: Number, default: 0 },
    excludedForFreshness: { type: Number, default: 0 },
    sourceErrors: { type: mongoose.Schema.Types.Mixed, default: [] },
  },
  monitorSuggestionId: { type: mongoose.Schema.Types.ObjectId, ref: "LeadMonitorSuggestion", default: null },
  correlationId: { type: String, default: "", trim: true, maxlength: 255 },
}, { timestamps: true, collection: "discovery_searches" });

discoverySearchSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
discoverySearchSchema.plugin(workspacePlugin);

module.exports = mongoose.model("DiscoverySearch", discoverySearchSchema);
module.exports.SOURCES = SOURCES;
