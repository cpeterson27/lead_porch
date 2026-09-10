/**
 * A review queue for optional public-web discovery — kept fully separate
 * from IntentSignal (monitor-driven buyer-intent detection) and
 * PeopleResearchPreview (the OpenAI/Jarvis public-people flow). Every row
 * starts "pending_review" and stays that way until a human explicitly
 * saves or dismisses it — nothing here ever becomes a CRM contact,
 * organization, or lead on its own.
 *
 * Discovery has two independent, optional public-web DISCOVERY sources —
 * either, both, or neither may be enabled — merged and deduplicated into
 * this one queue by services/vertexGroundingDiscoveryService.js:
 *   - "vertex_grounding": Vertex AI Gemini + Google Search grounding
 *     (services/vertexGroundingService.js).
 *   - "openai_web_search": OpenAI's Responses API `web_search` hosted tool
 *     (services/openaiWebSearchService.js) — a different API from the Chat
 *     Completions API OpenAI/Jarvis chat uses elsewhere in this app.
 * PDL and OpenAI/Jarvis never originate a row — they only ever act on one a
 * discovery source already found, evidence-required:
 *   - PDL (people_data_labs): explicit, per-row structured enrichment
 *     (verified email/title/company) via services/peopleDataLabsService.js.
 *   - OpenAI/Jarvis ("openai_jarvis"): explicit, batch program-fit
 *     evaluation/ranking via the same agent system every other AI feature in
 *     this app already uses (services/agentExecutionService.js) — planning
 *     and qualification only, never a discovery/search source.
 * `providers` records which of these actually touched a row (a row found by
 * both discovery sources carries both, e.g. corroborated evidence from two
 * independent public-web providers), for real provenance instead of an
 * assumed single source.
 *
 * A "person" row's `evidenceDate` is required and freshness-checked before
 * the row is ever created (see search()'s cutoff in
 * services/vertexGroundingDiscoveryService.js) — a stale or undated
 * "buyer-intent" post is worthless as a lead signal, so it is excluded up
 * front rather than staged and only flagged later.
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
  // When the underlying evidence was actually published/last active, per the
  // discovery source itself — null when no source could verify a real date.
  // For "person" results this is enforced server-side (never just trusted
  // from the provider): a person result may only be staged if this is set
  // and within services/vertexGroundingDiscoveryService.js's freshness
  // cutoff (DISCOVERY_PERSON_FRESHNESS_DAYS, default 90 days).
  evidenceDate: { type: Date, default: null },
  confidence: { type: String, enum: ["single_source", "corroborated"], default: "single_source" },
  status: { type: String, enum: ["pending_review", "saved", "dismissed"], default: "pending_review", index: true },
  savedContactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", default: null },
  savedOrganizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null },
  // Real provenance: which provider(s) actually produced/touched this row.
  providers: { type: [String], enum: ["vertex_grounding", "openai_web_search", "people_data_labs", "openai_jarvis"], default: [] },
  pdlEnrichment: {
    attempted: { type: Boolean, default: false },
    matched: { type: Boolean, default: false },
    likelihood: { type: Number, default: null },
    email: { type: String, default: "", trim: true, lowercase: true },
    emailState: { type: String, default: "" },
    enrichedAt: { type: Date, default: null },
    // A failed PDL call (disabled, insufficient identity inputs, rate
    // limited, etc.) must still leave a persisted, visible outcome —
    // "attempted: true, error: true" — rather than silently leaving the row
    // looking never-enriched after the attempt is gone from the UI.
    error: { type: Boolean, default: false },
    errorMessage: { type: String, default: "", trim: true, maxlength: 300 },
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
