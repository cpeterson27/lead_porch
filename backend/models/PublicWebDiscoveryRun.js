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
const JOB_SOURCES = ["vertex", "openai_web_search"];
const JOB_STATUSES = ["pending", "in_progress", "completed", "failed", "skipped"];
const RUN_STATUSES = ["draft", "queued", "running", "paused", "completed", "failed", "canceled"];

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
  includePdlCrossReference: { type: Boolean, default: true },
  pdlCrossReferenceDone: { type: Boolean, default: false },
  retryPolicy: {
    maxAttemptsPerJob: { type: Number, default: 3, min: 1, max: 10 },
  },
  estimatedCreditUse: {
    vertexCalls: { type: Number, default: 0 },
    openaiCalls: { type: Number, default: 0 },
    pdlCandidates: { type: Number, default: 0 },
    estimatedUsd: { type: Number, default: 0 },
    note: { type: String, default: "", trim: true, maxlength: 500 },
  },
  // Running counters checked against the caps above before each unit of
  // work — never retroactive, always checked BEFORE spending more.
  spend: {
    vertexCalls: { type: Number, default: 0 },
    openaiCalls: { type: Number, default: 0 },
    pdlCandidates: { type: Number, default: 0 },
    estimatedUsd: { type: Number, default: 0 },
  },
  runSummary: {
    created: { type: Number, default: 0 },
    merged: { type: Number, default: 0 },
    rejectedSelfMatch: { type: Number, default: 0 },
    rejectedCrmDuplicate: { type: Number, default: 0 },
    rejectedPreviouslyDismissed: { type: Number, default: 0 },
    rejectedAlreadyInQueue: { type: Number, default: 0 },
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
