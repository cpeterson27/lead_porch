/**
 * One execution of the Public Web Discovery engine
 * (services/publicWebDiscoveryEngineService.js) for one approved program: a
 * queued, paginated, checkpointed batch of search-family jobs run against
 * Vertex/OpenAI grounded search, with an optional PDL cross-reference pass,
 * merged into the existing GroundingResearchResult review queue.
 *
 * Named "PublicWebDiscoveryRun" (not "DiscoveryRun") because this app
 * already has an unrelated `DiscoveryRun` model (models/DiscoveryRun.js,
 * audience organization-discovery runs, owned by services/audience.js /
 * services/organizationImportService.js) — this is a completely separate
 * feature and must never collide with that model name or collection.
 *
 * Never auto-executes end-to-end in one call — `jobs` + `nextJobIndex` is
 * the checkpoint a worker tick (processNextBatch()) advances one bounded
 * slice at a time, so a run survives a process restart and resumes exactly
 * where it left off (a fresh tick just reads this same document). A run is
 * always created in "draft" so an owner can edit the generated search
 * families before anything is spent — mirrors DiscoverySearch's
 * propose→approve pattern.
 *
 * "Paginated" here means repeating a job's query with an evolving
 * refinement (excluding names already found) rather than a literal
 * provider page-token — services/vertexGroundingService.js and
 * services/openaiWebSearchService.js's groundedSearch() are single-shot
 * grounded search calls with no cursor of their own to page through.
 */
const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const JOB_CATEGORIES = ["people", "facebook_groups", "communities", "organizations", "events", "forums", "podcasts", "directories", "intent_discussions"];
// "pdl_person_search" is an INDEPENDENT candidate-search job source, not
// only a post-hoc cross-reference/enrichment step — see
// publicWebDiscoveryEngineService.js's runJob() PDL branch and the
// "Find prospective students" preset, which puts it first in priority.
const JOB_SOURCES = ["vertex", "openai_web_search", "pdl_person_search"];
const JOB_STATUSES = ["pending", "in_progress", "completed", "failed", "skipped"];
// "stopped_at_cap" is distinct from "completed" — a run that stopped
// early because the provider credit cap was reached must never be
// reported the same way as one that genuinely finished all its work.
const RUN_STATUSES = ["draft", "queued", "running", "paused", "completed", "stopped_at_cap", "failed", "canceled"];

const jobSchema = new mongoose.Schema({
  category: { type: String, enum: JOB_CATEGORIES, required: true },
  query: { type: String, required: true, trim: true, maxlength: 500 },
  source: { type: String, enum: JOB_SOURCES, required: true },
  locationHint: { type: String, default: "", trim: true, maxlength: 200 },
  status: { type: String, enum: JOB_STATUSES, default: "pending" },
  // How many times this job's query has been (re)run with a "find
  // different results than already found" refinement — the pagination
  // checkpoint. Bounded by maxPages.
  page: { type: Number, default: 0 },
  maxPages: { type: Number, default: 1, min: 1, max: 10 },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: "", trim: true, maxlength: 500 },
  resultsCount: { type: Number, default: 0 },
  acceptedCount: { type: Number, default: 0 },
  lastRunAt: { type: Date, default: null },
}, { _id: true });

const publicWebDiscoveryRunSchema = new mongoose.Schema({
  programNoteId: { type: mongoose.Schema.Types.ObjectId, ref: "JarvisMemoryNote", default: null },
  programName: { type: String, default: "", trim: true, maxlength: 200 },
  status: { type: String, enum: RUN_STATUSES, default: "draft", index: true },
  jobs: { type: [jobSchema], default: [] },
  // Checkpoint: index into `jobs` the next processNextBatch() tick should
  // resume from. Combined with each job's own `page`, this makes a run
  // fully resumable from a persisted document alone.
  nextJobIndex: { type: Number, default: 0 },
  // Owner-configurable controls — all editable before/at approval time.
  dailyCandidateTarget: { type: Number, default: 25, min: 1, max: 500 },
  pageLimitPerQuery: { type: Number, default: 2, min: 1, max: 10 },
  queryLimitPerRun: { type: Number, default: 40, min: 1, max: 500 },
  // Hard spending cap in USD-equivalent — processNextBatch() stops issuing
  // new provider/PDL calls once the NEXT call would push spend over this,
  // regardless of how many jobs remain.
  providerCreditCapUsd: { type: Number, default: 5, min: 0, max: 1000 },
  // "person": dailyCandidateTarget/stop-checks count ONLY person-type
  // accepted candidates (runSummary.personAccepted) — used by the "Find
  // prospective students" preset, whose target is explicitly "25 unique
  // PEOPLE", not a mix of people and communities/organizations.
  // "all" (default): counts every accepted candidate of any type, as
  // every run before this preset already did.
  targetType: { type: String, enum: ["all", "person"], default: "all" },
  // The SINGLE source of truth for whether the direct PDL Person Search
  // phase runs at all — independent of includePdlCrossReference below, and
  // independent of `jobs` (a direct PDL job is never a member of `jobs`;
  // it runs as its own one-shot phase — see
  // publicWebDiscoveryEngineService.js's runPdlPersonSearchPhase). This
  // fixes a reported incident where the owner removed an editable "PDL
  // Person Search" row and left cross-reference unchecked, yet PDL still
  // ran anyway — a removable row is not a reliable on/off switch; this
  // boolean is, and is enforced on the backend regardless of what a client
  // submits.
  includePdlPersonSearch: { type: Boolean, default: true },
  pdlPersonSearchDone: { type: Boolean, default: false },
  // PDL is billed in its own per-record credits, never dollars — these caps
  // (and their spend.pdlPersonSearchCredits/pdlCrossReferenceCredits
  // counters below) are tracked entirely separately from
  // providerCreditCapUsd/spend.estimatedUsd, which apply only to
  // Vertex/OpenAI web-search cash. Free PDL credits must never be
  // converted into "cash spent" against the web cash cap.
  maxPdlPersonSearchCredits: { type: Number, default: 25, min: 0, max: 500 },
  maxPdlCrossReferenceCredits: { type: Number, default: 25, min: 0, max: 500 },
  includePdlCrossReference: { type: Boolean, default: true },
  pdlCrossReferenceDone: { type: Boolean, default: false },
  // The owner's provider selection at approval time, persisted so a
  // completed/capped run can honestly report WHY an enabled provider ended
  // up with zero calls (query limit, edits, cap, or every query failing)
  // instead of leaving that unexplained.
  enabledSources: { type: [String], enum: ["vertex", "openai_web_search"], default: ["vertex", "openai_web_search"] },
  retryPolicy: {
    maxAttemptsPerJob: { type: Number, default: 3, min: 1, max: 10 },
  },
  estimatedCreditUse: {
    vertexCalls: { type: Number, default: 0 },
    openaiCalls: { type: Number, default: 0 },
    pdlCandidates: { type: Number, default: 0 },
    estimatedUsd: { type: Number, default: 0 },
    note: { type: String, default: "", trim: true, maxlength: 500 },
    // Rough, separate estimates of how many results will plausibly be
    // people vs. communities/organizations — a person can move toward
    // direct outreach; a community/organization needs a different kind of
    // follow-up, so the owner should see them apart before approving.
    expectedPeople: { type: Number, default: 0 },
    expectedCommunitiesOrganizations: { type: Number, default: 0 },
    // The exact pre-run plan, shown to the owner before anything is spent —
    // PDL credits are deliberately separate numbers from the web cash
    // estimate below, never combined into one figure.
    maxPdlPersonSearchCredits: { type: Number, default: 0 },
    maxPdlCrossReferenceCredits: { type: Number, default: 0 },
    // Set only when providerCreditCapUsd is well above the conservative
    // recommended default — this app does not track a workspace-wide
    // spending limit, so this is a relative safety comparison, not a real
    // "remaining budget" check. Empty string means no warning.
    budgetWarning: { type: String, default: "", trim: true, maxlength: 500 },
  },
  // Running counters checked against the caps above before each unit of
  // work — never retroactive, always checked BEFORE spending more.
  spend: {
    vertexCalls: { type: Number, default: 0 },
    openaiCalls: { type: Number, default: 0 },
    // Legacy aggregate (pdlPersonSearchCredits + pdlCrossReferenceCredits),
    // kept for any existing reader of this field — always kept in sync by
    // whichever PDL phase records credits.
    pdlCandidates: { type: Number, default: 0 },
    pdlPersonSearchCredits: { type: Number, default: 0 },
    pdlCrossReferenceCredits: { type: Number, default: 0 },
    // Web-search cash ONLY (Vertex + OpenAI calls) — PDL is never added
    // here. Checked directly against providerCreditCapUsd.
    estimatedUsd: { type: Number, default: 0 },
  },
  runSummary: {
    created: { type: Number, default: 0 },
    merged: { type: Number, default: 0 },
    rejectedSelfMatch: { type: Number, default: 0 },
    rejectedCrmDuplicate: { type: Number, default: 0 },
    rejectedPreviouslyDismissed: { type: Number, default: 0 },
    rejectedAlreadyInQueue: { type: Number, default: 0 },
    // Coaches, course sellers, established syndicators, brokers, lenders,
    // vendors, and capital-raising services found by a student-focused
    // search (people/intent_discussions categories, or the direct PDL
    // job) — these are professionals, not prospective students, so they
    // are excluded here rather than staged. Community/group discovery is
    // NOT filtered this way — those results are legitimately meant to
    // include organizers, brokers, etc., and stay in their own
    // separately-labeled category.
    rejectedSellerOrVendor: { type: Number, default: 0 },
    // A candidate PDL/Apollo returned with no usable name — cannot be
    // staged as a review-queue row (name is required) — rejected here
    // explicitly rather than throwing and silently failing the whole job.
    rejectedInvalidIdentity: { type: Number, default: 0 },
    // A candidate a provider genuinely returned but that was never
    // evaluated because the credit cap was reached mid-batch — distinct
    // from every rejection reason above, which all mean a candidate WAS
    // evaluated and didn't qualify. Should be rare-to-zero now that the
    // cap is enforced BEFORE each call (see computeReservedWebBudget()/
    // the pre-call affordability check in
    // publicWebDiscoveryEngineService.js) — kept as an honest fallback
    // bucket rather than ever silently dropping a found-but-unprocessed
    // candidate the way the original bug did (24 found, 0 accepted, no
    // reason given).
    rejectedBudgetCap: { type: Number, default: 0 },
    // Safety-net invariant: found candidates that ended up in NEITHER an
    // accepted/merged outcome NOR any named rejection bucket above. This
    // must always be 0 — a nonzero value is a bug in the accounting
    // itself, never a legitimate outcome, and is called out explicitly in
    // the run explanation rather than being folded into "0 accepted" with
    // no reason, which is exactly what shipped in the reported incident.
    unexplainedRejections: { type: Number, default: 0 },
    // Accepted (created OR merged) candidates of type "person" specifically
    // — the basis for targetType:"person" runs, where the target is a
    // people count, not a mix of people and communities/organizations.
    personAccepted: { type: Number, default: 0 },
    crawlBlockedByRobots: { type: Number, default: 0 },
    crawlSkippedLoginWall: { type: Number, default: 0 },
    crawlErrors: { type: Number, default: 0 },
    byFreshnessTier: {
      recent: { type: Number, default: 0 },
      aging: { type: Number, default: 0 },
      evergreen: { type: Number, default: 0 },
    },
    perSource: { type: mongoose.Schema.Types.Mixed, default: [] },
    explanation: { type: String, default: "", trim: true, maxlength: 2000 },
    // Explicit, per-provider reasons computed whenever a provider the owner
    // enabled (enabledSources / includePdlPersonSearch / includePdlCrossReference)
    // ends this run with zero calls/credits — never left as an unexplained
    // "0 calls" the way the reported incident was.
    zeroCallReasons: { type: [String], default: [] },
  },
  // Same lease pattern as services/researchMonitorService.js's
  // ResearchMonitor runner — guards against two ticks (a manual trigger and
  // the scheduler) processing the same run concurrently.
  leaseOwner: { type: String, default: "" },
  leaseExpiresAt: { type: Date, default: null },
  approvedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  approvedAt: { type: Date, default: null },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  scheduleId: { type: mongoose.Schema.Types.ObjectId, ref: "DiscoverySchedule", default: null },
  correlationId: { type: String, default: "", trim: true, maxlength: 255 },
}, { timestamps: true, collection: "public_web_discovery_runs" });

publicWebDiscoveryRunSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
publicWebDiscoveryRunSchema.plugin(workspacePlugin);

module.exports = mongoose.model("PublicWebDiscoveryRun", publicWebDiscoveryRunSchema);
module.exports.JOB_CATEGORIES = JOB_CATEGORIES;
module.exports.JOB_SOURCES = JOB_SOURCES;
module.exports.JOB_STATUSES = JOB_STATUSES;
module.exports.RUN_STATUSES = RUN_STATUSES;
