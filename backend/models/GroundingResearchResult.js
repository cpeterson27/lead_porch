/**
 * A review queue for optional public-web discovery — kept fully separate
 * from IntentSignal (monitor-driven buyer-intent detection) and
 * PeopleResearchPreview (the OpenAI/Jarvis public-people flow). Every row
 * starts "pending_review" and stays that way until a human explicitly
 * saves or dismisses it — nothing here ever becomes a CRM contact,
 * organization, or lead on its own.
 *
 * Discovery itself currently has exactly one live public-web source, Vertex
 * AI Grounding (`providers` always includes "vertex_grounding" for a
 * discovered row). PDL and OpenAI/Jarvis never originate a row — they only
 * ever act on one Vertex already found, evidence-required:
 *   - PDL (people_data_labs): explicit, per-row structured enrichment
 *     (verified email/title/company) via services/peopleDataLabsService.js.
 *   - OpenAI/Jarvis: explicit, batch program-fit evaluation/ranking via the
 *     same agent system every other AI feature in this app already uses
 *     (services/agentExecutionService.js) — never web search (see
 *     services/vertexGroundingDiscoveryService.js's module header for why).
 * `providers` records which of these actually touched a row, for real
 * provenance instead of an assumed single source.
 */
const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const RESULT_TYPES = ["person", "organization", "event", "community"];

const groundingResearchResultSchema = new mongoose.Schema({
  query: { type: String, required: true, trim: true, maxlength: 2000 },
  type: { type: String, enum: RESULT_TYPES, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  organizationName: { type: String, default: "", trim: true, maxlength: 200 },
  organizationDomain: { type: String, default: "", trim: true, lowercase: true, maxlength: 200 },
  summary: { type: String, default: "", trim: true, maxlength: 1000 },
  evidenceUrls: { type: [String], default: [] },
  confidence: { type: String, enum: ["single_source", "corroborated"], default: "single_source" },
  status: { type: String, enum: ["pending_review", "saved", "dismissed"], default: "pending_review", index: true },
  savedContactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", default: null },
  savedOrganizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null },
  // Real provenance: which provider(s) actually produced/touched this row.
  providers: { type: [String], enum: ["vertex_grounding", "people_data_labs", "openai_jarvis"], default: [] },
  pdlEnrichment: {
    attempted: { type: Boolean, default: false },
    matched: { type: Boolean, default: false },
    likelihood: { type: Number, default: null },
    email: { type: String, default: "", trim: true, lowercase: true },
    emailState: { type: String, default: "" },
    enrichedAt: { type: Date, default: null },
  },
  fitScore: { type: Number, default: null, min: 0, max: 100 },
  fitReasons: { type: [String], default: [] },
  fitEvaluatedAt: { type: Date, default: null },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
  correlationId: { type: String, default: "", trim: true, maxlength: 255 },
}, { timestamps: true, collection: "grounding_research_results" });

groundingResearchResultSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
// Dedup key for merging repeat finds of the same entity across searches —
// not unique (a legitimate re-find should update, not fail), just indexed
// for the lookup vertexGroundingDiscoveryService.js does before inserting.
groundingResearchResultSchema.index({ workspaceId: 1, type: 1, name: 1, organizationDomain: 1 });
groundingResearchResultSchema.plugin(workspacePlugin);

module.exports = mongoose.model("GroundingResearchResult", groundingResearchResultSchema);
module.exports.RESULT_TYPES = RESULT_TYPES;
