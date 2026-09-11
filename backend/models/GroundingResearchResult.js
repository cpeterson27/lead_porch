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
 *
 * services/leadGenerationCoordinatorService.js additively extends this same
 * queue with two more discovery providers — PDL Person Search and Apollo
 * People Search — which actively match a program ICP rather than finding
 * public-web buyer-intent evidence. `discoveryMode` records which kind of
 * row this is ("public_web_evidence" for Vertex/OpenAI, unchanged; or
 * "icp_match" for PDL/Apollo). ICP-match rows deliberately do NOT go
 * through the evidenceDate freshness gate above — a structured database
 * match has no "post date" to check — so that existing gate is left fully
 * intact rather than loosened to accommodate a fundamentally different kind
 * of evidence. `apolloEnrichment` mirrors `pdlEnrichment` as Apollo's own
 * separate, explicit, second-stage cross-check (never a discovery source in
 * that role). `linkedinUrl`/`socialProfileUrls`, `emailVerificationStatus`,
 * and `identityConfidence` are populated from whichever provider(s)
 * actually supplied them and are never upgraded past what a provider itself
 * reports (an Apollo "unverified" or PDL "provider_validated" email is
 * never displayed or stored as "verified"). `conflicts` lists any
 * field-level disagreement between providers on the same merged identity —
 * a non-empty `conflicts` array keeps a row in "pending_review" for closer
 * human review rather than letting automatic corroboration paper over it.
 */
const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

// "forum"/"podcast"/"directory" added for the Public Web Discovery engine
// (services/publicWebDiscoveryEngineService.js) — additive, existing values
// and every existing row's `type` are unaffected.
const RESULT_TYPES = ["person", "organization", "event", "community", "forum", "podcast", "directory"];

const groundingResearchResultSchema = new mongoose.Schema({
  query: { type: String, required: true, trim: true, maxlength: 2000 },
  type: { type: String, enum: RESULT_TYPES, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  organizationName: { type: String, default: "", trim: true, maxlength: 200 },
  organizationDomain: { type: String, default: "", trim: true, lowercase: true, maxlength: 200 },
  // The email a DISCOVERY source (PDL/Apollo Person Search) supplied
  // directly, if any — distinct from pdlEnrichment.email/apolloEnrichment.email,
  // which represent a deliberate, separate later verification/cross-check
  // step. Vertex/OpenAI never populate this (public-web grounding doesn't
  // surface an email). Never upgraded past whatever emailState the
  // originating provider itself reported.
  email: { type: String, default: "", trim: true, lowercase: true },
  emailState: { type: String, default: "" },
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
  providers: { type: [String], enum: ["vertex_grounding", "openai_web_search", "people_data_labs", "openai_jarvis", "pdl_person_search", "apollo_person_search", "apollo"], default: [] },
  // "public_web_evidence" (Vertex/OpenAI, subject to the evidenceDate
  // freshness gate) vs "icp_match" (PDL/Apollo Person Search, matched
  // against a program ICP — no evidence date/URL concept applies) vs
  // "public_web_high_volume" (services/publicWebDiscoveryEngineService.js —
  // many search-family queries per program, crawled citations, LABELED
  // freshness tiers instead of a hard evidenceDate cutoff; see
  // `freshnessTier` below). The high-volume engine writes its own rows
  // through its own merge path — it never calls into, and never weakens,
  // vertexGroundingDiscoveryService.js's existing freshness gate.
  discoveryMode: { type: String, enum: ["public_web_evidence", "icp_match", "public_web_high_volume"], default: "public_web_evidence" },
  // Which Public Web Discovery search-family category (see
  // publicWebDiscoveryEngineService.js's JOB_CATEGORIES) produced this row,
  // if any — purely for per-source/per-category reporting.
  discoveryCategory: { type: String, default: "", trim: true, maxlength: 60 },
  // Set only for discoveryMode "public_web_high_volume": a labeled
  // freshness tier rather than a hard include/exclude gate — an older or
  // undated identity lead is kept and labeled, never deleted. Only
  // "recent" (0-90 days) may ever be described to the owner as "recent
  // intent"; "aging" (91-365 days) and "evergreen" (no date, or older than
  // 365 days) are shown as exactly that, never mislabeled as recent.
  freshnessTier: { type: String, enum: ["recent", "aging", "evergreen"], default: null },
  // Short, evidence-grounded notes on why this row suggests real buyer
  // intent (e.g. "asked for program recommendations in a public post") —
  // populated only by the high-volume engine's structured extraction step,
  // never invented beyond what the cited page actually said.
  intentSignals: { type: [String], default: [] },
  // Which Public Web Discovery run (services/publicWebDiscoveryEngineService.js)
  // produced/merged into this row, if any — nullable, for traceability and
  // per-run reporting, parallel to discoverySearchId above.
  discoveryRunId: { type: mongoose.Schema.Types.ObjectId, ref: "PublicWebDiscoveryRun", default: null },
  linkedinUrl: { type: String, default: "", trim: true, maxlength: 500 },
  socialProfileUrls: { type: [String], default: [] },
  // Which discovery search (services/leadGenerationCoordinatorService.js)
  // produced/merged into this row, if any — nullable, purely for
  // traceability back to the approved search plan and its ICP.
  discoverySearchId: { type: mongoose.Schema.Types.ObjectId, ref: "DiscoverySearch", default: null },
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
  // Mirrors pdlEnrichment exactly — Apollo's own separate, explicit,
  // second-stage cross-check of a person already found by any source.
  apolloEnrichment: {
    attempted: { type: Boolean, default: false },
    matched: { type: Boolean, default: false },
    email: { type: String, default: "", trim: true, lowercase: true },
    emailState: { type: String, default: "" },
    enrichedAt: { type: Date, default: null },
    error: { type: Boolean, default: false },
    errorMessage: { type: String, default: "", trim: true, maxlength: 300 },
  },
  // A short, display-only rollup of the best email-verification signal any
  // provider actually reported — never a value stronger than what was
  // reported (e.g. "provider_validated" from PDL is never shown as
  // "verified"; only Apollo's own literal "verified" status counts as that).
  emailVerificationStatus: { type: String, default: "" },
  // Separate axis from `confidence` above: `confidence` is about EVIDENCE
  // corroboration (independent citation domains / independent discovery
  // providers agreeing); `identityConfidence` is about how sure we are this
  // is a real, correctly-identified person (derived from email-verification
  // strength and whether multiple providers independently matched the same
  // identity) — kept distinct rather than overloading `confidence`.
  // "conflict" added: providers disagree on a material identity field (see
  // `conflicts` below) — a distinct state from "low", since the problem
  // isn't insufficient evidence, it's contradictory evidence that needs a
  // human decision. Computed deterministically from real signals
  // (provider count, evidence corroboration, verified identifiers,
  // conflicts) — see computeIdentityConfidence() in
  // vertexGroundingDiscoveryService.js — never trusted from an LLM guess.
  identityConfidence: { type: String, enum: ["low", "medium", "high", "conflict"], default: "low" },
  // Field-level disagreements between providers on the same merged
  // identity (e.g. differing company/title) — a non-empty list keeps the
  // row in pending_review for closer human attention rather than letting
  // automatic corroboration paper over a real conflict.
  conflicts: { type: [String], default: [] },
  // `programNoteId` is set ONLY to a real, currently-approved Offers &
  // Programs note's own _id — never free text the model could invent.
  // See leadGenerationCoordinatorService.js's qualifyAndRecommend(): the
  // schema constrains the model to choose from the workspace's actual
  // approved program IDs (or "none"), and the result is discarded rather
  // than stored if it doesn't match a real, still-approved program.
  recommendedProgram: {
    programNoteId: { type: mongoose.Schema.Types.ObjectId, ref: "JarvisMemoryNote", default: null },
    name: { type: String, default: "", trim: true, maxlength: 200 },
    reason: { type: String, default: "", trim: true, maxlength: 1000 },
  },
  // `fitScore`/`fitReasons` = PROGRAM FIT specifically (does this person
  // resemble the program's intended buyer) — deliberately a separate axis
  // from `identityConfidence` (is this the right person) and
  // `buyerIntentLevel` below (does the evidence show they currently want/
  // need help). A job title or real-estate role alone affects fit, never
  // buyer intent.
  fitScore: { type: Number, default: null, min: 0, max: 100 },
  fitReasons: { type: [String], default: [] },
  fitEvaluatedAt: { type: Date, default: null },
  // Third distinct qualification axis: evidence the person currently
  // wants/needs help, never inferred from a title/role alone.
  buyerIntentLevel: { type: String, enum: ["", "strong", "weak", "none"], default: "" },
  buyerIntentEvidence: { type: String, default: "", trim: true, maxlength: 1000 },
  // The combined, human-facing qualification verdict — computed from all
  // three axes together (see qualifyAndRecommend()), never just the
  // program-fit score alone.
  qualificationLabel: { type: String, enum: ["", "qualified", "needs_review", "not_a_fit"], default: "" },
  // ICP exclusions this candidate appears to match (coach, broker, lender,
  // vendor, wrong_country, established_syndicator, no_personal_investing_evidence,
  // etc.) — surfaced for review, never silently used to auto-dismiss.
  exclusionFlags: { type: [String], default: [] },
  recommendedNextAction: { type: String, default: "", trim: true, maxlength: 300 },
  // True ONLY when identity is sufficiently reliable AND program fit is
  // genuine AND there is real buyer-intent evidence — never based on a
  // title/role alone. Still just a recommendation surfaced for the human
  // reviewer; nothing here ever sends outreach automatically.
  outreachRecommended: { type: Boolean, default: false },
  outreachDraft: { type: String, default: "", trim: true, maxlength: 2000 },
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
