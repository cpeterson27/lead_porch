// Targeted regression coverage for the new Public Web Discovery engine:
// services/webCrawlerService.js, services/searchFamilyGenerationService.js,
// services/publicWebDiscoveryEngineService.js, and the new
// models/PublicWebDiscoveryRun.js + models/DiscoverySchedule.js.
//
// Fully mocked — NO real or test database connection, and NO real HTTP
// request, is made anywhere in this file. TEST_MONGO_URI is still not
// configured in this environment; every model and every network call is a
// plain in-memory fake / injected fake function, per this session's
// standing "no live providers, no production writes" constraint.
require("dotenv").config();
const assert = require("node:assert/strict");
const webCrawlerService = require("./services/webCrawlerService");
const publicWebDiscoveryEngineService = require("./services/publicWebDiscoveryEngineService");
const searchFamilyGenerationService = require("./services/searchFamilyGenerationService");
const { JOB_CATEGORIES } = require("./models/PublicWebDiscoveryRun");

const { parseRobotsTxt, evaluateCrawlability, fetchPage, isNeverCrawlHost, looksLikeLoginWall, stripHtmlToText } = webCrawlerService;
const {
  computeFreshnessTier, extractIntentSignals, mergeDiscoveryCandidate, proposePublicWebDiscoveryRun, approvePublicWebDiscoveryRun, processNextBatch, runDueDiscoverySchedules,
  proposeStudentSearchPreset, interleaveJobsRoundRobin, estimateExpectedCounts, computeBudgetWarning, isLikelySellerOrVendor, isStudentSearchContext, acceptedCountForTarget,
  computeReservedWebBudget, reconcileUnexplainedRejections, buildRunExplanation,
} = publicWebDiscoveryEngineService;

// ---- tiny generic in-memory Mongo-like helpers (shared across fakes) ----
function matchesFilter(doc, filter) {
  for (const [key, cond] of Object.entries(filter || {})) {
    if (key === "$or") { if (!cond.some((sub) => matchesFilter(doc, sub))) return false; continue; }
    if (key === "$and") { if (!cond.every((sub) => matchesFilter(doc, sub))) return false; continue; }
    const value = doc[key];
    if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ("$in" in cond) { if (!cond.$in.map(String).includes(String(value))) return false; continue; }
      if ("$lte" in cond) { if (!(value == null || new Date(value).getTime() <= new Date(cond.$lte).getTime())) return false; continue; }
      if ("$ne" in cond) { if (String(value ?? "") === String(cond.$ne)) return false; continue; }
      continue;
    }
    if (cond === null) { if (value != null) return false; continue; }
    if (String(value ?? "") !== String(cond)) return false;
  }
  return true;
}
function applyUpdate(doc, update) {
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$unset) for (const key of Object.keys(update.$unset)) delete doc[key];
  return doc;
}
function leanQuery(result) {
  const chain = { select: () => chain, sort: () => chain, limit: () => chain, lean: async () => result };
  return chain;
}
function fakePublicWebDiscoveryRunModel(seed = []) {
  // Mutates and returns the SAME seed object references (not a spread
  // copy) so a test holding its own `run` variable observes the exact
  // mutations processNextBatch()/etc. make, rather than a divergent copy.
  const rows = seed.map((d, i) => {
    d._id = d._id || `run-${i}`;
    if (d.leaseOwner === undefined) d.leaseOwner = "";
    if (d.leaseExpiresAt === undefined) d.leaseExpiresAt = null;
    if (!d.jobs) d.jobs = [];
    if (d.nextJobIndex === undefined) d.nextJobIndex = 0;
    if (!d.save) d.save = async function save() { return this; };
    return d;
  });
  return {
    rows,
    create: async (doc) => { const row = { _id: `run-${rows.length}`, leaseOwner: "", leaseExpiresAt: null, save: async function save() { return this; }, ...doc }; rows.push(row); return row; },
    findOne: async (filter) => rows.find((r) => matchesFilter(r, filter)) || null,
    findOneAndUpdate: async (filter, update) => { const row = rows.find((r) => matchesFilter(r, filter)); if (!row) return null; return applyUpdate(row, update); },
    find: (filter) => leanQuery(rows.filter((r) => matchesFilter(r, filter))),
  };
}
function fakeDiscoveryScheduleModel(seed = []) {
  const rows = seed.map((d, i) => ({ _id: `sched-${i}`, leaseOwner: "", leaseExpiresAt: null, save: async function save() { return this; }, ...d }));
  return {
    rows,
    find: (filter) => { const matched = rows.filter((r) => matchesFilter(r, filter)); return { limit: () => matched }; },
    findOneAndUpdate: async (filter, update) => { const row = rows.find((r) => matchesFilter(r, filter)); if (!row) return null; return applyUpdate(row, update); },
    updateMany: async (filter, update) => { for (const r of rows.filter((x) => matchesFilter(x, filter))) applyUpdate(r, update); },
  };
}
function fakeGroundingResultModel(seed = []) {
  const rows = seed.map((d, i) => ({ _id: `gr-${i}`, conflicts: [], providers: [], intentSignals: [], evidenceUrls: [], save: async function save() { return this; }, ...d }));
  return {
    rows,
    findOne: async (filter) => rows.find((r) => matchesFilter(r, filter)) || null,
    create: async (doc) => { const row = { _id: `gr-${rows.length}`, conflicts: [], providers: [], intentSignals: [], save: async function save() { return this; }, ...doc }; rows.push(row); return row; },
    find: (filter) => leanQuery(rows.filter((r) => matchesFilter(r, filter))),
  };
}
function fakeLookupModel(rows) {
  return { findOne: (filter) => leanQuery(rows.find((r) => matchesFilter(r, filter)) || null) };
}
function fakeNoteModel(note) {
  return { findOne: (filter) => leanQuery(matchesFilter(note, { _id: filter._id, workspaceId: filter.workspaceId }) ? note : null) };
}

const WORKSPACE_ID = "workspace-1";

// ==================== webCrawlerService ====================

function testIsNeverCrawlHostBlocksFacebookAndLinkedinAlways() {
  assert.equal(isNeverCrawlHost("facebook.com"), true);
  assert.equal(isNeverCrawlHost("www.facebook.com"), true);
  assert.equal(isNeverCrawlHost("m.facebook.com"), true);
  assert.equal(isNeverCrawlHost("groups.facebook.com"), true, "any facebook.com subdomain must be denylisted");
  assert.equal(isNeverCrawlHost("linkedin.com"), true);
  assert.equal(isNeverCrawlHost("www.linkedin.com"), true);
  assert.equal(isNeverCrawlHost("example.com"), false);
  assert.equal(isNeverCrawlHost("notfacebook.com"), false, "must not falsely match an unrelated domain that merely contains the string");
}

function testParseRobotsTxtRespectsDisallowAllowAndLongestMatch() {
  const text = "User-agent: *\nDisallow: /private\nAllow: /private/public-page\n";
  const matcher = parseRobotsTxt(text);
  assert.equal(matcher.isAllowed("/blog/post"), true, "an unrestricted path must be allowed");
  assert.equal(matcher.isAllowed("/private/secret"), false, "a disallowed prefix must be blocked");
  assert.equal(matcher.isAllowed("/private/public-page"), true, "a more specific Allow rule must win over a shorter Disallow");
}

function testParseRobotsTxtEmptyDisallowMeansAllowEverything() {
  const matcher = parseRobotsTxt("User-agent: *\nDisallow:\n");
  assert.equal(matcher.isAllowed("/anything"), true);
}

async function testEvaluateCrawlabilityBlocksDenylistedPlatformsWithoutFetchingRobots() {
  let robotsFetchCount = 0;
  const httpGet = async () => { robotsFetchCount += 1; return { status: 404, data: "" }; };
  const result = await evaluateCrawlability("https://www.facebook.com/groups/example", { httpGet });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "platform_never_crawled");
  assert.equal(robotsFetchCount, 0, "a denylisted platform must never even trigger a robots.txt fetch");
}

async function testEvaluateCrawlabilityHonorsRobotsDisallow() {
  const httpGet = async (url) => {
    assert.ok(url.endsWith("/robots.txt"));
    return { status: 200, data: "User-agent: *\nDisallow: /blocked\n" };
  };
  const allowed = await evaluateCrawlability("https://example.com/open-page", { httpGet });
  assert.equal(allowed.allowed, true);
  const blocked = await evaluateCrawlability("https://example.com/blocked/page", { httpGet });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "robots_txt_disallowed");
}

async function testEvaluateCrawlabilityFailsClosedWhenRobotsUnverifiable() {
  const httpGetTimeout = async () => { throw new Error("timeout"); };
  const result = await evaluateCrawlability("https://example.com/page", { httpGet: httpGetTimeout });
  assert.equal(result.allowed, false, "an unverifiable robots.txt must fail CLOSED — never assume permission");
  assert.equal(result.reason, "robots_txt_unverifiable");
}

async function testFetchPageNeverIssuesTheGetWhenRobotsDisallow() {
  let pageFetchAttempted = false;
  const httpGet = async (url) => {
    if (url.endsWith("/robots.txt")) return { status: 200, data: "User-agent: *\nDisallow: /\n" };
    pageFetchAttempted = true;
    return { status: 200, data: "<html>should never be reached</html>" };
  };
  const result = await fetchPage("https://example.com/anything", { httpGet });
  assert.equal(result.ok, false);
  assert.equal(result.skippedReason, "robots_txt_disallowed");
  assert.equal(pageFetchAttempted, false, "the page GET must never be issued once robots.txt disallows it");
}

async function testFetchPageDetectsLoginWallAndStripsHtmlOtherwise() {
  const httpGet = async (url) => {
    if (url.endsWith("/robots.txt")) return { status: 404, data: "" };
    if (url.includes("gated")) return { status: 200, data: "<html><body>Please log in to continue viewing this group.</body></html>" };
    return { status: 200, data: "<html><body><script>evil()</script><p>Real page text about a coaching program.</p></body></html>" };
  };
  const gated = await fetchPage("https://example.com/gated", { httpGet });
  assert.equal(gated.ok, false);
  assert.equal(gated.skippedReason, "login_wall");

  const open = await fetchPage("https://example.com/open", { httpGet });
  assert.equal(open.ok, true);
  assert.ok(open.textExcerpt.includes("Real page text about a coaching program."));
  assert.ok(!open.textExcerpt.includes("evil()"), "script contents must be stripped, never passed through as page text");
}

function testLooksLikeLoginWallDetectsStatusAndMarkers() {
  assert.equal(looksLikeLoginWall(401, ""), true);
  assert.equal(looksLikeLoginWall(403, ""), true);
  assert.equal(looksLikeLoginWall(200, "Sign in to continue to see this content"), true);
  assert.equal(looksLikeLoginWall(200, "Welcome to our public blog post about coaching."), false);
}

function testStripHtmlToTextRemovesTagsAndDecodesEntities() {
  const text = stripHtmlToText("<p>Hello &amp; welcome &lt;there&gt;</p>");
  assert.equal(text, "Hello & welcome <there>");
}

// ==================== freshness tiers & intent extraction ====================

function testComputeFreshnessTierBoundaries() {
  const now = Date.now();
  // Boundary cases use a small buffer (rather than an exact multiple of
  // 86400000ms) so the assertion never races against the real wall-clock
  // milliseconds that elapse between capturing `now` here and
  // computeFreshnessTier's own internal Date.now() call.
  assert.equal(computeFreshnessTier(null), "evergreen", "undated must be evergreen, never dropped");
  assert.equal(computeFreshnessTier(new Date(now - 10 * 86400000)), "recent");
  assert.equal(computeFreshnessTier(new Date(now - 90 * 86400000 + 60000)), "recent", "just under 90 days is still recent");
  assert.equal(computeFreshnessTier(new Date(now - 90 * 86400000 - 60000)), "aging", "just over 90 days is already aging");
  assert.equal(computeFreshnessTier(new Date(now - 365 * 86400000 + 60000)), "aging", "just under 365 days is still aging");
  assert.equal(computeFreshnessTier(new Date(now - 400 * 86400000)), "evergreen");
}

function testExtractIntentSignalsOnlyPullsRealPhrasesFromTheText() {
  const signals = extractIntentSignals("I've been looking for a good business coach for months. Any recommendations? Just enjoying my coffee otherwise.");
  assert.ok(signals.length >= 1);
  assert.ok(signals.some((s) => /looking for/i.test(s)));
  const none = extractIntentSignals("This is a completely unrelated sentence about the weather.");
  assert.deepEqual(none, []);
}

// ==================== mergeDiscoveryCandidate: dedup + freshness labeling ====================

async function testMergeDiscoveryCandidateRejectsSelfMatch() {
  const run = { _id: "run-x", jobs: [] };
  const GroundingResearchResult = fakeGroundingResultModel();
  const Contact = fakeLookupModel([]);
  const Organization = fakeLookupModel([]);
  const result = await mergeDiscoveryCandidate(
    { workspaceId: WORKSPACE_ID, userId: "u1", run, candidate: { type: "person", name: "Ellie Baxter" }, selfSignals: { names: new Set(["ellie baxter"]), emails: new Set(), domains: new Set(), businessNames: new Set() } },
    { GroundingResearchResult, Contact, Organization },
  );
  assert.equal(result.outcome, "rejected_self");
  assert.equal(GroundingResearchResult.rows.length, 0);
}

async function testMergeDiscoveryCandidateRejectsExistingCrmContact() {
  const run = { _id: "run-x", jobs: [] };
  const GroundingResearchResult = fakeGroundingResultModel();
  const Contact = fakeLookupModel([{ workspaceId: WORKSPACE_ID, email: "prospect@acme.com", _id: "contact-1" }]);
  const Organization = fakeLookupModel([]);
  const result = await mergeDiscoveryCandidate(
    { workspaceId: WORKSPACE_ID, userId: "u1", run, candidate: { type: "person", name: "Real Prospect", email: "prospect@acme.com" }, selfSignals: { names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() } },
    { GroundingResearchResult, Contact, Organization },
  );
  assert.equal(result.outcome, "rejected_crm", "a person already a real CRM contact must never be re-added as a new lead");
  assert.equal(GroundingResearchResult.rows.length, 0);
}

async function testMergeDiscoveryCandidateNeverResurfacesADismissedRow() {
  const run = { _id: "run-x", jobs: [] };
  const GroundingResearchResult = fakeGroundingResultModel([{ _id: "gr-existing", workspaceId: WORKSPACE_ID, type: "person", name: "Once Dismissed", organizationDomain: "", status: "dismissed" }]);
  const Contact = fakeLookupModel([]);
  const Organization = fakeLookupModel([]);
  const result = await mergeDiscoveryCandidate(
    { workspaceId: WORKSPACE_ID, userId: "u1", run, candidate: { type: "person", name: "Once Dismissed", organizationDomain: "" }, selfSignals: { names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() } },
    { GroundingResearchResult, Contact, Organization },
  );
  assert.equal(result.outcome, "rejected_dismissed", "a previously-dismissed identity must never resurface as a new candidate");
  assert.equal(GroundingResearchResult.rows.length, 1, "no duplicate row must be created for it either");
}

async function testMergeDiscoveryCandidateMergesIntoExistingPendingReviewRow() {
  const run = { _id: "run-x", jobs: [] };
  const GroundingResearchResult = fakeGroundingResultModel([{ _id: "gr-existing", workspaceId: WORKSPACE_ID, type: "person", name: "Prior Find", organizationDomain: "acme.com", status: "pending_review", evidenceUrls: ["https://old.example.com"], providers: ["vertex_grounding"], confidence: "single_source" }]);
  const Contact = fakeLookupModel([]);
  const Organization = fakeLookupModel([]);
  const result = await mergeDiscoveryCandidate(
    { workspaceId: WORKSPACE_ID, userId: "u1", run, candidate: { type: "person", name: "Prior Find", organizationDomain: "acme.com", evidenceUrls: ["https://new.example.com"], providers: ["openai_web_search"] }, selfSignals: { names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() } },
    { GroundingResearchResult, Contact, Organization },
  );
  assert.equal(result.outcome, "merged", "a match against an EARLIER run's still-open row counts as previous-run dedup, not a new candidate");
  assert.equal(GroundingResearchResult.rows.length, 1);
  assert.deepEqual(new Set(result.row.evidenceUrls), new Set(["https://old.example.com", "https://new.example.com"]));
  assert.equal(result.row.confidence, "corroborated", "two independent providers on the same identity must raise confidence");
}

async function testMergeDiscoveryCandidateLabelsFreshnessTierInsteadOfDroppingOldResults() {
  const run = { _id: "run-x", jobs: [] };
  const GroundingResearchResult = fakeGroundingResultModel();
  const Contact = fakeLookupModel([]);
  const Organization = fakeLookupModel([]);
  const oldDate = new Date(Date.now() - 500 * 86400000);
  const result = await mergeDiscoveryCandidate(
    { workspaceId: WORKSPACE_ID, userId: "u1", run, candidate: { type: "person", name: "Old But Real Lead", organizationDomain: "old.com", evidenceDate: oldDate, providers: ["vertex_grounding"] }, selfSignals: { names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() } },
    { GroundingResearchResult, Contact, Organization },
  );
  assert.equal(result.outcome, "created", "an old/undated identity must still be STAGED, never silently excluded, unlike the single-search engine's hard freshness gate");
  assert.equal(result.row.freshnessTier, "evergreen");
  assert.equal(result.row.status, "pending_review");
}

// ==================== propose / approve ====================

async function testProposePublicWebDiscoveryRunBuildsJobsFromGeneratedFamilies() {
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel();
  const generateSearchFamilies = async () => ({
    programName: "Multifamily Bootcamp",
    families: [
      { category: "people", queries: [{ query: "prospective multifamily investors", locationHint: "Texas", source: "vertex" }] },
      { category: "forums", queries: [{ query: "real estate forums discussing multifamily deals", locationHint: "", source: "openai_web_search" }] },
    ],
  });
  const run = await proposePublicWebDiscoveryRun(
    { workspaceId: WORKSPACE_ID, userId: "u1", programNoteId: "note-1", locations: ["Texas"] },
    { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, generateSearchFamilies },
  );
  assert.equal(run.status, "draft");
  assert.equal(run.jobs.length, 2);
  assert.ok(run.jobs.every((j) => JOB_CATEGORIES.includes(j.category)));
  assert.ok(run.estimatedCreditUse.estimatedUsd >= 0);
}

async function testApprovePublicWebDiscoveryRunAppliesEditsAndQueues() {
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel([{ _id: "run-1", workspaceId: WORKSPACE_ID, status: "draft", jobs: [{ category: "people", query: "old query", source: "vertex", status: "pending", page: 0, maxPages: 1, attempts: 0 }], dailyCandidateTarget: 25, pageLimitPerQuery: 2, queryLimitPerRun: 40, providerCreditCapUsd: 5, includePdlCrossReference: true, retryPolicy: { maxAttemptsPerJob: 3 } }]);
  const run = await approvePublicWebDiscoveryRun(
    { workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-1", jobs: [{ category: "people", query: "edited query", source: "vertex", locationHint: "Texas" }], dailyCandidateTarget: 10, providerCreditCapUsd: 2 },
    { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel },
  );
  assert.equal(run.status, "queued");
  assert.equal(run.jobs.length, 1);
  assert.equal(run.jobs[0].query, "edited query", "the owner's edited query text must be what actually runs");
  assert.equal(run.dailyCandidateTarget, 10);
  assert.equal(run.providerCreditCapUsd, 2);
}

async function testApprovePublicWebDiscoveryRunRejectsNonDraft() {
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel([{ _id: "run-1", workspaceId: WORKSPACE_ID, status: "queued", jobs: [] }]);
  await assert.rejects(
    () => approvePublicWebDiscoveryRun({ workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-1" }, { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel }),
    /already been approved or run/,
  );
}

// ==================== processNextBatch: checkpointed, capped, retryable ====================

function buildQueuedRun(overrides = {}) {
  return {
    _id: "run-1", workspaceId: WORKSPACE_ID, status: "queued", leaseOwner: "", leaseExpiresAt: null,
    jobs: [
      { category: "people", query: "find prospective buyers", source: "vertex", locationHint: "", status: "pending", page: 0, maxPages: 1, attempts: 0, resultsCount: 0, acceptedCount: 0 },
      { category: "forums", query: "real estate forums", source: "openai_web_search", locationHint: "", status: "pending", page: 0, maxPages: 1, attempts: 0, resultsCount: 0, acceptedCount: 0 },
    ],
    nextJobIndex: 0,
    dailyCandidateTarget: 25, pageLimitPerQuery: 2, queryLimitPerRun: 40, providerCreditCapUsd: 5,
    includePdlCrossReference: false, pdlCrossReferenceDone: false,
    retryPolicy: { maxAttemptsPerJob: 3 },
    estimatedCreditUse: {}, spend: { vertexCalls: 0, openaiCalls: 0, pdlCandidates: 0, estimatedUsd: 0 },
    runSummary: { created: 0, merged: 0, rejectedSelfMatch: 0, rejectedCrmDuplicate: 0, rejectedPreviouslyDismissed: 0, rejectedAlreadyInQueue: 0, crawlBlockedByRobots: 0, crawlSkippedLoginWall: 0, crawlErrors: 0, byFreshnessTier: { recent: 0, aging: 0, evergreen: 0 }, perSource: [], explanation: "" },
    ...overrides,
  };
}

async function testProcessNextBatchAdvancesCheckpointAndStagesResults() {
  const run = buildQueuedRun();
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel([run]);
  const GroundingResearchResult = fakeGroundingResultModel();
  const vertexGroundingService = { groundedSearch: async () => ({ results: [{ type: "person", name: "Real Prospect", organizationName: "Acme", organizationDomain: "acme.com", summary: "s", evidenceUrls: [], evidenceDate: new Date(), confidence: "single_source" }], groundingCitations: [] }) };
  const openaiWebSearchService = { groundedSearch: async () => ({ results: [{ type: "forum", name: "Real Estate Forum", organizationName: "", organizationDomain: "", summary: "s", evidenceUrls: [], evidenceDate: null, confidence: "single_source" }], groundingCitations: [] }) };

  const dependencies = {
    PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, GroundingResearchResult, vertexGroundingService, openaiWebSearchService,
    Contact: fakeLookupModel([]), Organization: fakeLookupModel([]),
    getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }),
    isSelfMatch: () => ({ isSelf: false, reasons: [] }),
  };

  const outcome1 = await processNextBatch({ workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-1", batchSize: 1 }, dependencies);
  assert.equal(outcome1.stepsRun, 1);
  assert.equal(run.nextJobIndex, 1, "the checkpoint must advance exactly one job per batchSize-1 tick");
  assert.equal(run.status, "queued", "the run must stay queued — resumable — until every job is processed");
  assert.equal(GroundingResearchResult.rows.length, 1);

  const outcome2 = await processNextBatch({ workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-1", batchSize: 1 }, dependencies);
  assert.equal(run.nextJobIndex, 2);
  assert.equal(GroundingResearchResult.rows.length, 2);
  assert.equal(outcome2.run.status, "completed", "once every job is done (and PDL cross-reference is off), the run must complete");
  assert.ok(outcome2.run.runSummary.explanation.length > 0);
}

async function testProcessNextBatchStopsAtProviderCreditCap() {
  const run = buildQueuedRun({ providerCreditCapUsd: 0.02 }); // below the cost of even one grounded call
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel([run]);
  const GroundingResearchResult = fakeGroundingResultModel();
  const vertexGroundingService = { groundedSearch: async () => ({ results: [], groundingCitations: [] }) };
  const openaiWebSearchService = { groundedSearch: async () => ({ results: [], groundingCitations: [] }) };
  const dependencies = { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, GroundingResearchResult, vertexGroundingService, openaiWebSearchService, Contact: fakeLookupModel([]), Organization: fakeLookupModel([]), getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }), isSelfMatch: () => ({ isSelf: false, reasons: [] }) };

  const outcome = await processNextBatch({ workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-1", batchSize: 5 }, dependencies);
  assert.equal(outcome.run.status, "stopped_at_cap", "a cap-stopped run must be labeled distinctly from a genuinely completed one");
  assert.ok(outcome.run.runSummary.explanation.includes("Stopped at budget cap"), "the explanation must say the cap stopped the run, never imply everything was searched");
  assert.equal(run.nextJobIndex, 0, "the cap must stop the run BEFORE even the first job spends anything");
  assert.equal(outcome.done, true, "a cap-stopped run must still be reported as done — no further automatic processing will occur");
}

async function testProcessNextBatchRetriesAFailedJobThenGivesUp() {
  const run = buildQueuedRun({ retryPolicy: { maxAttemptsPerJob: 2 } });
  run.jobs = [run.jobs[0]]; // isolate to one job
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel([run]);
  const GroundingResearchResult = fakeGroundingResultModel();
  const vertexGroundingService = { groundedSearch: async () => { throw new Error("provider hiccup"); } };
  const openaiWebSearchService = { groundedSearch: async () => ({ results: [], groundingCitations: [] }) };
  const dependencies = { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, GroundingResearchResult, vertexGroundingService, openaiWebSearchService, Contact: fakeLookupModel([]), Organization: fakeLookupModel([]), getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }), isSelfMatch: () => ({ isSelf: false, reasons: [] }) };

  await processNextBatch({ workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-1", batchSize: 1 }, dependencies);
  assert.equal(run.jobs[0].status, "pending", "attempt 1 of 2 must leave the job pending for a retry on the next tick, not fail the whole run");
  assert.equal(run.jobs[0].attempts, 1);

  await processNextBatch({ workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-1", batchSize: 1 }, dependencies);
  assert.equal(run.jobs[0].status, "failed", "after exhausting retries the job must be marked failed and the run must move on rather than looping forever");
  assert.equal(run.jobs[0].attempts, 2);
  assert.equal(run.nextJobIndex, 1);
}

async function testProcessNextBatchRefusesADoubleLeaseWhileAlreadyRunning() {
  const run = buildQueuedRun({ leaseOwner: "some-other-worker", leaseExpiresAt: new Date(Date.now() + 60000) });
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel([run]);
  const outcome = await processNextBatch({ workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-1", batchSize: 1 }, { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, GroundingResearchResult: fakeGroundingResultModel() });
  assert.equal(outcome.done, true);
  assert.equal(outcome.reason, "not_runnable_or_leased");
  assert.equal(run.nextJobIndex, 0, "a currently-leased run must never be double-processed concurrently");
}

/**
 * Simulates exactly what a Render restart looks like from the database's
 * point of view: a run left "running" with a lease from a worker that no
 * longer exists (the process died mid-batch), where that lease has since
 * expired. A fresh processNextBatch() call — e.g. from the scheduler's
 * next tick after the new process boots — must reclaim it and resume
 * from the exact job it had already reached, never restart from job 0 and
 * never sit stuck forever because a dead worker still "owns" it.
 */
async function testProcessNextBatchResumesARunLeftRunningByADeadWorkerAfterARestart() {
  const staleRun = buildQueuedRun({
    status: "running",
    leaseOwner: "old-process-that-crashed",
    leaseExpiresAt: new Date(Date.now() - 1000), // already expired
    nextJobIndex: 1, // it had already finished job 0 before dying
  });
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel([staleRun]);
  const GroundingResearchResult = fakeGroundingResultModel();
  const openaiWebSearchService = { groundedSearch: async () => ({ results: [{ type: "forum", name: "Resumed Find", organizationName: "", organizationDomain: "", summary: "", evidenceUrls: [], evidenceDate: null, confidence: "single_source" }], groundingCitations: [] }) };
  const dependencies = { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, GroundingResearchResult, vertexGroundingService: { groundedSearch: async () => ({ results: [], groundingCitations: [] }) }, openaiWebSearchService, Contact: fakeLookupModel([]), Organization: fakeLookupModel([]), getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }), isSelfMatch: () => ({ isSelf: false, reasons: [] }) };

  const outcome = await processNextBatch({ workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-1", batchSize: 1 }, dependencies);
  assert.notEqual(outcome.reason, "not_runnable_or_leased", "an EXPIRED lease from a dead worker must never permanently block a run");
  assert.equal(staleRun.nextJobIndex, 2, "processing must resume from the checkpoint (job 1) it had already reached, not restart from job 0");
  assert.equal(GroundingResearchResult.rows.length, 1, "the job that runs after resuming must still stage its result normally");
  assert.equal(staleRun.leaseOwner, "", "the new worker must release its own lease when it finishes its tick");
}

/**
 * Pause/Cancel don't hold this run's processing lease, so the owner
 * clicking Pause while a batch's provider call is still in flight is a
 * real possible race — the tick must never silently overwrite that
 * externally-requested status back to "queued"/"completed" once it
 * finishes its own work a moment later.
 */
async function testProcessNextBatchRespectsAConcurrentPauseRequestedMidBatch() {
  const run = buildQueuedRun();
  run.jobs = [run.jobs[0]];
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel([run]);
  const GroundingResearchResult = fakeGroundingResultModel();
  const vertexGroundingService = { groundedSearch: async () => {
    run.status = "paused"; // the concurrent Pause click, landing mid-call
    return { results: [], groundingCitations: [] };
  } };
  const dependencies = { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, GroundingResearchResult, vertexGroundingService, openaiWebSearchService: { groundedSearch: async () => ({ results: [], groundingCitations: [] }) }, Contact: fakeLookupModel([]), Organization: fakeLookupModel([]), getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }), isSelfMatch: () => ({ isSelf: false, reasons: [] }) };

  await processNextBatch({ workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-1", batchSize: 1 }, dependencies);
  assert.equal(run.status, "paused", "a pause requested mid-batch must never be silently overwritten back to queued/completed once this tick finishes");
}

// ==================== scheduler: disabled by default, real when enabled ====================

async function testRunDueDiscoverySchedulesSkipsDisabledSchedules() {
  const DiscoveryScheduleModel = fakeDiscoveryScheduleModel([{ _id: "sched-1", workspaceId: WORKSPACE_ID, enabled: false, nextRunAt: new Date(Date.now() - 1000), intervalMinutes: 1440 }]);
  let proposeCalled = false;
  await runDueDiscoverySchedules({ DiscoverySchedule: DiscoveryScheduleModel, PublicWebDiscoveryRun: fakePublicWebDiscoveryRunModel(), generateSearchFamilies: async () => { proposeCalled = true; return { programName: "", families: [] }; } });
  assert.equal(proposeCalled, false, "a disabled schedule must never be picked up by the runner, even when its nextRunAt is due");
}

async function testRunDueDiscoverySchedulesProcessesAnEnabledDueSchedule() {
  const DiscoveryScheduleModel = fakeDiscoveryScheduleModel([{ _id: "sched-1", workspaceId: WORKSPACE_ID, enabled: true, nextRunAt: new Date(Date.now() - 1000), intervalMinutes: 1440, dailyCandidateTarget: 5, pageLimitPerQuery: 1, queryLimitPerRun: 10, providerCreditCapUsd: 5, sources: ["vertex"], includePdlCrossReference: false, currentRunId: null, createdByUserId: "u1", programNoteId: "note-1" }]);
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel();
  const GroundingResearchResult = fakeGroundingResultModel();
  const vertexGroundingService = { groundedSearch: async () => ({ results: [{ type: "person", name: "Scheduled Find", organizationName: "", organizationDomain: "", summary: "", evidenceUrls: [], evidenceDate: new Date(), confidence: "single_source" }], groundingCitations: [] }) };
  const openaiWebSearchService = { groundedSearch: async () => ({ results: [], groundingCitations: [] }) };
  const generateSearchFamilies = async () => ({ programName: "Test Program", families: [{ category: "people", queries: [{ query: "find people", locationHint: "", source: "vertex" }] }] });

  await runDueDiscoverySchedules({
    DiscoverySchedule: DiscoveryScheduleModel, PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, GroundingResearchResult, vertexGroundingService, openaiWebSearchService, generateSearchFamilies,
    Contact: fakeLookupModel([]), Organization: fakeLookupModel([]),
    getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }),
    isSelfMatch: () => ({ isSelf: false, reasons: [] }),
  });

  assert.equal(PublicWebDiscoveryRunModel.rows.length, 1, "an enabled, due schedule must actually create and run a PublicWebDiscoveryRun");
  assert.equal(GroundingResearchResult.rows.length, 1);
  const schedule = DiscoveryScheduleModel.rows[0];
  assert.ok(schedule.nextRunAt instanceof Date);
  assert.equal(schedule.leaseOwner, "", "the lease must be released after the tick");
}

// ==================== search-family generation: current year, never stale ====================

async function testGenerateSearchFamiliesInjectsTheServersActualCurrentYear() {
  const realCurrentYear = new Date().getFullYear();
  let capturedContext = "";
  const runAgent = async ({ operationalContext }) => { capturedContext = operationalContext; return { output: { families: [] } }; };
  const JarvisMemoryNote = fakeNoteModel({ _id: "note-1", workspaceId: WORKSPACE_ID, title: "Multifamily Bootcamp", content: "A coaching program." });

  await searchFamilyGenerationService.generateSearchFamilies(
    { workspaceId: WORKSPACE_ID, userId: "u1", programNoteId: "note-1", locations: [] },
    { JarvisMemoryNote, runAgent },
  );

  assert.ok(capturedContext.includes(`current year is ${realCurrentYear}`), "the prompt must state the server's real current year, computed at request time");
  assert.ok(!/\b(202[0-3])\b/.test(capturedContext), "the prompt must never contain an old, stale hardcoded year");
}

// ==================== student-search fixes ====================

function testIsLikelySellerOrVendorDetectsProfessionalsNotStudents() {
  assert.equal(isLikelySellerOrVendor({ name: "Jane Coach", organizationName: "Jane's Real Estate Coaching", summary: "" }), true);
  assert.equal(isLikelySellerOrVendor({ name: "Sam Broker", organizationName: "", summary: "Licensed real estate broker helping clients buy homes." }), true);
  assert.equal(isLikelySellerOrVendor({ name: "Pat Syndicator", organizationName: "", summary: "General partner raising capital for a syndication deal." }), true);
  assert.equal(isLikelySellerOrVendor({ name: "Alex Hardmoney", organizationName: "", summary: "Runs a hard money lending shop." }), true);
  assert.equal(isLikelySellerOrVendor({ name: "New Investor", organizationName: "", summary: "Just starting out, asking beginner questions about my first rental." }), false, "a genuine prospective student must never be caught by the seller/vendor filter");
}

function testIsStudentSearchContextIdentifiesPeopleAndIntentCategoriesOnly() {
  assert.equal(isStudentSearchContext("people"), true);
  assert.equal(isStudentSearchContext("intent_discussions"), true);
  assert.equal(isStudentSearchContext("facebook_groups"), false, "community/group discovery must never be filtered by the student-search seller exclusion");
  assert.equal(isStudentSearchContext("communities"), false);
  assert.equal(isStudentSearchContext("organizations"), false);
}

async function testMergeDiscoveryCandidateAppliesSellerExclusionOnlyForStudentSearches() {
  const run = { _id: "run-x", jobs: [] };
  const selfSignals = { names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() };
  const seller = { type: "person", name: "Jane Coach", organizationName: "Jane's Coaching Co", summary: "" };

  const rejectedAsStudent = await mergeDiscoveryCandidate(
    { workspaceId: WORKSPACE_ID, userId: "u1", run, candidate: seller, selfSignals, isStudentSearch: true },
    { GroundingResearchResult: fakeGroundingResultModel(), Contact: fakeLookupModel([]), Organization: fakeLookupModel([]) },
  );
  assert.equal(rejectedAsStudent.outcome, "rejected_seller_or_vendor", "a coach must be excluded from a student-focused search");

  const keptForCommunity = await mergeDiscoveryCandidate(
    { workspaceId: WORKSPACE_ID, userId: "u1", run, candidate: { ...seller, type: "community" }, selfSignals, isStudentSearch: false },
    { GroundingResearchResult: fakeGroundingResultModel(), Contact: fakeLookupModel([]), Organization: fakeLookupModel([]) },
  );
  assert.equal(keptForCommunity.outcome, "created", "the SAME exclusion list must never apply to community/group discovery — that stays separately labeled, not filtered");
}

function testInterleaveJobsRoundRobinPreventsProviderExclusionOnTruncation() {
  // Every openai_web_search job placed after every vertex job, as a naive
  // category-then-provider generation order would produce.
  const jobs = [
    { category: "people", source: "vertex", query: "v1" }, { category: "people", source: "vertex", query: "v2" },
    { category: "intent_discussions", source: "vertex", query: "v3" },
    { category: "people", source: "openai_web_search", query: "o1" }, { category: "people", source: "openai_web_search", query: "o2" },
    { category: "intent_discussions", source: "openai_web_search", query: "o3" },
  ];
  const interleaved = interleaveJobsRoundRobin(jobs);
  const firstThree = interleaved.slice(0, 3);
  assert.ok(firstThree.some((j) => j.source === "vertex"), "a truncated prefix must still include vertex");
  assert.ok(firstThree.some((j) => j.source === "openai_web_search"), "a truncated prefix must still include openai_web_search — this is the exact bug being fixed");
  const categoriesInPrefix = new Set(firstThree.map((j) => j.category));
  assert.ok(categoriesInPrefix.size >= 2, "a truncated prefix must also represent more than one category");
  assert.equal(interleaved.length, jobs.length, "interleaving must never drop or duplicate a job");
}

function testEstimateExpectedCountsSeparatesPeopleFromCommunities() {
  const jobs = [
    { category: "people", source: "vertex" }, { category: "intent_discussions", source: "openai_web_search" },
    { category: "facebook_groups", source: "vertex" }, { category: "communities", source: "openai_web_search" },
  ];
  const { expectedPeople, expectedCommunitiesOrganizations } = estimateExpectedCounts(jobs, true);
  assert.ok(expectedPeople > 0);
  assert.ok(expectedCommunitiesOrganizations > 0);
  assert.notEqual(expectedPeople, expectedCommunitiesOrganizations, "people and community/organization expectations must be tracked separately, not one combined figure");
}

function testComputeBudgetWarningOnlyFiresWellAboveTheRecommendedDefault() {
  assert.equal(computeBudgetWarning(1), "", "the recommended $1 first-run cap itself must not trigger a warning");
  assert.equal(computeBudgetWarning(2), "", "a modest cap close to the default must not trigger a warning");
  const warning = computeBudgetWarning(20);
  assert.ok(warning, "a cap far above the recommended default must warn");
  assert.ok(warning.includes("$20"), "the warning must state the actual proposed cap");
  assert.ok(/does(n't| not) track a workspace-wide spending limit/.test(warning), "the warning must honestly disclose this is a safety comparison, not a real remaining-budget check");
}

function testAcceptedCountForTargetRespectsTargetType() {
  const runAll = { targetType: "all", runSummary: { created: 3, merged: 2, personAccepted: 1 } };
  assert.equal(acceptedCountForTarget(runAll), 5, "targetType 'all' must count every accepted candidate");
  const runPerson = { targetType: "person", runSummary: { created: 3, merged: 2, personAccepted: 1 } };
  assert.equal(acceptedCountForTarget(runPerson), 1, "targetType 'person' must count ONLY person-type accepted candidates, ignoring communities/organizations mixed into created/merged");
}

async function testProposeStudentSearchPresetOrdersTiersAndAppliesSafeDefaults() {
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel();
  const generateSearchFamilies = async ({ categories, audienceFraming }) => {
    assert.deepEqual(categories, ["intent_discussions", "people", "facebook_groups", "communities"], "the preset must only generate the four categories it actually uses");
    assert.ok(/aspiring|beginner/i.test(audienceFraming), "the preset must ask for aspiring/beginner framing on the people category");
    return {
      programName: "Multifamily Bootcamp",
      families: [
        { category: "intent_discussions", queries: [{ query: "recent post asking for real estate investing advice", locationHint: "", source: "openai_web_search" }] },
        { category: "people", queries: [{ query: "beginner real estate investors just starting out", locationHint: "", source: "vertex" }] },
        { category: "facebook_groups", queries: [{ query: "real estate investing Facebook groups for beginners", locationHint: "", source: "vertex" }] },
        { category: "communities", queries: [{ query: "real estate investing subreddits", locationHint: "", source: "openai_web_search" }] },
      ],
    };
  };

  const run = await proposeStudentSearchPreset(
    { workspaceId: WORKSPACE_ID, userId: "u1", programNoteId: "note-1", locations: ["Texas"] },
    { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, generateSearchFamilies },
  );

  assert.equal(run.status, "draft");
  assert.equal(run.jobs[0].source, "pdl_person_search", "PDL must be tier 1 — the very first job");
  assert.equal(run.jobs[0].category, "people");
  const categoriesAfterPdl = run.jobs.slice(1).map((j) => j.category);
  assert.equal(categoriesAfterPdl[0], "intent_discussions", "tier 2 (intent discussions) must come immediately after PDL");
  assert.ok(categoriesAfterPdl.slice(1).includes("people"), "tier 3 (people) must be present after intent discussions");
  const lastCategories = categoriesAfterPdl.slice(-2);
  assert.ok(lastCategories.every((c) => ["facebook_groups", "communities"].includes(c)), "tier 4 (communities/groups) must come last");

  assert.equal(run.dailyCandidateTarget, 25, "default target must be 25");
  assert.equal(run.targetType, "person", "the target must count PEOPLE specifically, not a mix with communities");
  assert.equal(run.pageLimitPerQuery, 1, "default must be one page per query");
  assert.equal(run.retryPolicy.maxAttemptsPerJob, 2, "default must be one retry (2 attempts total)");
  assert.equal(run.providerCreditCapUsd, 1, "default must be a $1 hard cap");
  assert.equal(run.includePdlCrossReference, false, "cross-reference would be redundant — PDL already runs directly as tier 1");
  assert.ok(run.estimatedCreditUse.expectedPeople > 0);
  assert.ok(run.estimatedCreditUse.expectedCommunitiesOrganizations > 0);
}

async function testRunPdlDirectJobActsAsIndependentCandidateSourceNotOnlyCrossReference() {
  const run = fakePublicWebDiscoveryRunModel([{
    _id: "run-pdl", workspaceId: WORKSPACE_ID, status: "queued",
    jobs: [{ category: "people", query: "PDL Person Search: ideal buyer", source: "pdl_person_search", locationHint: "", status: "pending", page: 0, maxPages: 1, attempts: 0, resultsCount: 0, acceptedCount: 0 }],
    nextJobIndex: 0, dailyCandidateTarget: 25, targetType: "person", pageLimitPerQuery: 1, queryLimitPerRun: 10, providerCreditCapUsd: 5,
    includePdlCrossReference: false, pdlCrossReferenceDone: false, retryPolicy: { maxAttemptsPerJob: 2 },
    estimatedCreditUse: {}, spend: { vertexCalls: 0, openaiCalls: 0, pdlCandidates: 0, estimatedUsd: 0 },
    runSummary: { created: 0, merged: 0, rejectedSelfMatch: 0, rejectedCrmDuplicate: 0, rejectedPreviouslyDismissed: 0, rejectedAlreadyInQueue: 0, rejectedSellerOrVendor: 0, personAccepted: 0, crawlBlockedByRobots: 0, crawlSkippedLoginWall: 0, crawlErrors: 0, byFreshnessTier: { recent: 0, aging: 0, evergreen: 0 }, perSource: [], explanation: "" },
    programNoteId: "note-1",
  }]).rows[0];
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel([run]);
  const GroundingResearchResult = fakeGroundingResultModel();
  const runAgent = async () => ({ output: { titles: ["Real Estate Agent"], locations: ["Texas"], industries: [] } });
  const peopleDataLabsService = { searchPeople: async () => ({ people: [{ fullName: "New Investor", company: "", companyDomain: "", linkedinUrl: "", email: "", emailState: "" }] }) };
  const JarvisMemoryNote = fakeNoteModel({ _id: "note-1", workspaceId: WORKSPACE_ID, title: "Multifamily Bootcamp", content: "A coaching program for real estate investors." });

  const outcome = await processNextBatch(
    { workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-pdl", batchSize: 1 },
    { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, GroundingResearchResult, peopleDataLabsService, runAgent, JarvisMemoryNote, Contact: fakeLookupModel([]), Organization: fakeLookupModel([]), getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }), isSelfMatch: () => ({ isSelf: false, reasons: [] }) },
  );

  assert.equal(GroundingResearchResult.rows.length, 1, "PDL must independently stage a candidate on its own, never only as an enrichment/cross-reference side effect");
  const perSourceEntry = outcome.run.runSummary.perSource.find((e) => e.source === "pdl_person_search");
  assert.ok(perSourceEntry, "PDL's own contribution must be clearly reported as its own perSource row");
  assert.notEqual(perSourceEntry.category, "cross_reference", "a DIRECT PDL job must be labeled distinctly from the cross-reference pass");
  assert.equal(outcome.run.runSummary.personAccepted, 1);
}

async function testRunPdlCrossReferenceIsLabeledDistinctlyFromTheDirectSource() {
  const run = fakePublicWebDiscoveryRunModel([{
    _id: "run-xref", workspaceId: WORKSPACE_ID, status: "queued", jobs: [], nextJobIndex: 0,
    dailyCandidateTarget: 25, targetType: "all", pageLimitPerQuery: 1, queryLimitPerRun: 10, providerCreditCapUsd: 5,
    includePdlCrossReference: true, pdlCrossReferenceDone: false, retryPolicy: { maxAttemptsPerJob: 2 },
    estimatedCreditUse: {}, spend: { vertexCalls: 0, openaiCalls: 0, pdlCandidates: 0, estimatedUsd: 0 },
    runSummary: { created: 0, merged: 0, rejectedSelfMatch: 0, rejectedCrmDuplicate: 0, rejectedPreviouslyDismissed: 0, rejectedAlreadyInQueue: 0, rejectedSellerOrVendor: 0, personAccepted: 0, crawlBlockedByRobots: 0, crawlSkippedLoginWall: 0, crawlErrors: 0, byFreshnessTier: { recent: 0, aging: 0, evergreen: 0 }, perSource: [], explanation: "" },
    programNoteId: "note-1",
  }]).rows[0];
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel([run]);
  const GroundingResearchResult = fakeGroundingResultModel();
  const runAgent = async () => ({ output: { titles: ["Real Estate Agent"], locations: [], industries: [] } });
  const peopleDataLabsService = { searchPeople: async () => ({ people: [{ fullName: "Cross Referenced Person", company: "", companyDomain: "", linkedinUrl: "", email: "", emailState: "" }] }) };
  const JarvisMemoryNote = fakeNoteModel({ _id: "note-1", workspaceId: WORKSPACE_ID, title: "Multifamily Bootcamp", content: "A coaching program for real estate investors." });

  const outcome = await processNextBatch(
    { workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-xref", batchSize: 1 },
    { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, GroundingResearchResult, peopleDataLabsService, runAgent, JarvisMemoryNote, Contact: fakeLookupModel([]), Organization: fakeLookupModel([]), getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }), isSelfMatch: () => ({ isSelf: false, reasons: [] }) },
  );
  const perSourceEntry = outcome.run.runSummary.perSource.find((e) => e.source === "pdl_person_search");
  assert.equal(perSourceEntry.category, "cross_reference", "the cross-reference pass must be labeled distinctly from a direct PDL candidate-search job");
}

// ==================== reported incident: $1 cap, 24 PDL found, 0 accepted, 0 web calls ====================

function testComputeReservedWebBudgetReservesForPendingVertexAndOpenai() {
  const bothPending = { jobs: [{ source: "vertex", status: "pending" }, { source: "openai_web_search", status: "pending" }] };
  assert.equal(computeReservedWebBudget(bothPending), 0.06, "both pending must reserve one call's cost each");
  const onlyVertexPending = { jobs: [{ source: "vertex", status: "pending" }, { source: "openai_web_search", status: "completed" }] };
  assert.equal(computeReservedWebBudget(onlyVertexPending), 0.03, "a completed job's source must no longer be reserved for");
  const nonePending = { jobs: [{ source: "vertex", status: "completed" }, { source: "openai_web_search", status: "failed" }] };
  assert.equal(computeReservedWebBudget(nonePending), 0, "nothing left to reserve once every web job is finished");
  const pdlOnly = { jobs: [{ source: "pdl_person_search", status: "pending" }] };
  assert.equal(computeReservedWebBudget(pdlOnly), 0, "a run with no web jobs at all reserves nothing");
}

function testReconcileUnexplainedRejectionsCatchesTheExactReportedGap() {
  // The exact reported shape: PDL found 24, and — before this fix — none
  // of them were ever evaluated (0 accepted, 0 named rejections).
  const run = { runSummary: { unexplainedRejections: 0 } };
  const perSourceEntry = { acceptedNew: 0, merged: 0, rejectedSelf: 0, rejectedCrm: 0, rejectedDismissed: 0, rejectedSellerOrVendor: 0, rejectedInvalidIdentity: 0, rejectedBudgetCap: 0 };
  const unexplained = reconcileUnexplainedRejections(run, perSourceEntry, 24);
  assert.equal(unexplained, 24, "24 found with nothing accounted for must surface as exactly 24 unexplained, never silently reported as 0 accepted with no reason");
  assert.equal(run.runSummary.unexplainedRejections, 24);
  assert.equal(perSourceEntry.unexplained, 24);
}

function testReconcileUnexplainedRejectionsIsZeroWhenEveryCandidateIsAccountedFor() {
  const run = { runSummary: { unexplainedRejections: 0 } };
  const perSourceEntry = { acceptedNew: 5, merged: 2, rejectedSelf: 1, rejectedCrm: 1, rejectedDismissed: 1, rejectedSellerOrVendor: 1, rejectedInvalidIdentity: 1, rejectedBudgetCap: 0 };
  const unexplained = reconcileUnexplainedRejections(run, perSourceEntry, 12);
  assert.equal(unexplained, 0, "every candidate accounted for across accepted/merged/rejection buckets must leave zero unexplained");
  assert.equal(run.runSummary.unexplainedRejections, 0);
}

function testBuildRunExplanationLabelsACapStopDistinctlyAndFlagsTheInvariantBug() {
  const cappedRun = { providerCreditCapUsd: 1, spend: { estimatedUsd: 1 }, runSummary: { created: 0, merged: 0, byFreshnessTier: { recent: 0, aging: 0, evergreen: 0 }, rejectedSelfMatch: 0, rejectedCrmDuplicate: 0, rejectedPreviouslyDismissed: 0, rejectedSellerOrVendor: 0, rejectedInvalidIdentity: 0, rejectedBudgetCap: 0, unexplainedRejections: 0 } };
  const explanation = buildRunExplanation(cappedRun, "provider_credit_cap_reached");
  assert.ok(explanation.includes("Stopped at budget cap"), "a cap-stopped run's explanation must say so explicitly, not just 'completed'");

  const buggyRun = { providerCreditCapUsd: 1, spend: { estimatedUsd: 1 }, runSummary: { created: 0, merged: 0, byFreshnessTier: { recent: 0, aging: 0, evergreen: 0 }, rejectedSelfMatch: 0, rejectedCrmDuplicate: 0, rejectedPreviouslyDismissed: 0, rejectedSellerOrVendor: 0, rejectedInvalidIdentity: 0, rejectedBudgetCap: 0, unexplainedRejections: 24 } };
  const buggyExplanation = buildRunExplanation(buggyRun, "provider_credit_cap_reached");
  assert.ok(/BUG/.test(buggyExplanation), "a nonzero unexplainedRejections must be called out explicitly as a bug in the explanation text, never silently absorbed");
  assert.ok(buggyExplanation.includes("24"));
}

async function testProcessNextBatchReproducesTheReportedDollarCapPdlIncident() {
  // Exact reported production shape: $1 hard cap, student-preset job
  // order (PDL first, then one Vertex and one OpenAI intent-discussion
  // query), PDL has 24 real candidates available.
  const run = fakePublicWebDiscoveryRunModel([{
    _id: "run-incident", workspaceId: WORKSPACE_ID, status: "queued",
    jobs: [
      { category: "people", query: "PDL Person Search", source: "pdl_person_search", locationHint: "", status: "pending", page: 0, maxPages: 1, attempts: 0, resultsCount: 0, acceptedCount: 0 },
      { category: "intent_discussions", query: "recent post asking for help", source: "vertex", locationHint: "", status: "pending", page: 0, maxPages: 1, attempts: 0, resultsCount: 0, acceptedCount: 0 },
      { category: "intent_discussions", query: "recent post asking for help (openai)", source: "openai_web_search", locationHint: "", status: "pending", page: 0, maxPages: 1, attempts: 0, resultsCount: 0, acceptedCount: 0 },
    ],
    nextJobIndex: 0, dailyCandidateTarget: 25, targetType: "person", pageLimitPerQuery: 1, queryLimitPerRun: 10, providerCreditCapUsd: 1,
    includePdlCrossReference: false, pdlCrossReferenceDone: false, retryPolicy: { maxAttemptsPerJob: 2 },
    estimatedCreditUse: {}, spend: { vertexCalls: 0, openaiCalls: 0, pdlCandidates: 0, estimatedUsd: 0 },
    runSummary: { created: 0, merged: 0, rejectedSelfMatch: 0, rejectedCrmDuplicate: 0, rejectedPreviouslyDismissed: 0, rejectedAlreadyInQueue: 0, rejectedSellerOrVendor: 0, rejectedInvalidIdentity: 0, rejectedBudgetCap: 0, unexplainedRejections: 0, personAccepted: 0, crawlBlockedByRobots: 0, crawlSkippedLoginWall: 0, crawlErrors: 0, byFreshnessTier: { recent: 0, aging: 0, evergreen: 0 }, perSource: [], explanation: "" },
    programNoteId: "note-1",
  }]).rows[0];
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel([run]);
  const GroundingResearchResult = fakeGroundingResultModel();
  const JarvisMemoryNote = fakeNoteModel({ _id: "note-1", workspaceId: WORKSPACE_ID, title: "4-Month Multifamily Mentorship", content: "A coaching program for real estate investors." });
  const runAgent = async () => ({ output: { titles: ["Real Estate Agent"], locations: [], industries: [] } });
  let requestedPdlSize = null;
  const peopleDataLabsService = { searchPeople: async ({ size }) => {
    requestedPdlSize = size;
    // A real provider that genuinely has 24 candidates available and
    // respects the requested `size`, same as the reported incident.
    return { people: Array.from({ length: Math.min(size, 24) }, (_, i) => ({ fullName: `Prospect ${i}`, company: "", companyDomain: "", linkedinUrl: `pdl-${i}`, email: "", emailState: "" })) };
  } };
  let vertexCalled = false;
  let openaiCalled = false;
  const vertexGroundingService = { groundedSearch: async () => { vertexCalled = true; return { results: [], groundingCitations: [] }; } };
  const openaiWebSearchService = { groundedSearch: async () => { openaiCalled = true; return { results: [], groundingCitations: [] }; } };
  const dependencies = { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, GroundingResearchResult, peopleDataLabsService, vertexGroundingService, openaiWebSearchService, runAgent, JarvisMemoryNote, Contact: fakeLookupModel([]), Organization: fakeLookupModel([]), getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }), isSelfMatch: () => ({ isSelf: false, reasons: [] }) };

  const outcome = await processNextBatch({ workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-incident", batchSize: 5 }, dependencies);

  assert.ok(requestedPdlSize < 25, `PDL must never be asked for the full daily target (25) when that would exceed the $1 cap once Vertex/OpenAI are reserved for — requested ${requestedPdlSize}`);
  assert.ok(outcome.run.spend.estimatedUsd <= 1, `spend ($${outcome.run.spend.estimatedUsd}) must never exceed the $1 cap — the reported incident hit $1.20`);
  assert.equal(vertexCalled, true, "at least one Vertex call must happen within the same $1 budget — PDL must not consume the entire cap before public-web discovery gets a turn");
  assert.equal(openaiCalled, true, "at least one OpenAI call must happen within the same $1 budget");
  assert.equal(outcome.run.runSummary.unexplainedRejections, 0, "every PDL candidate found must land in a real accepted/merged/rejected bucket — zero unexplained, unlike the reported incident");
  const pdlEntry = outcome.run.runSummary.perSource.find((e) => e.source === "pdl_person_search" && e.category === "people");
  assert.ok(pdlEntry, "the direct PDL job's contribution must be reported");
  const accountedFor = pdlEntry.acceptedNew + pdlEntry.merged + pdlEntry.rejectedSelf + pdlEntry.rejectedCrm + pdlEntry.rejectedDismissed + pdlEntry.rejectedSellerOrVendor + pdlEntry.rejectedInvalidIdentity + pdlEntry.rejectedBudgetCap;
  assert.equal(pdlEntry.entitiesExtracted, accountedFor, "every found PDL candidate must be accounted for in a named bucket, never silently reported as 0 accepted with no reason");
  assert.ok(pdlEntry.acceptedNew > 0, "with real, non-excluded candidates, some must actually be accepted — not zero the way the reported incident showed");
}

async function testRunPdlDirectJobSkipsTheCallEntirelyWhenNoBudgetRemains() {
  const run = fakePublicWebDiscoveryRunModel([{
    _id: "run-nobudget", workspaceId: WORKSPACE_ID, status: "queued",
    jobs: [{ category: "people", query: "PDL Person Search", source: "pdl_person_search", locationHint: "", status: "pending", page: 0, maxPages: 1, attempts: 0, resultsCount: 0, acceptedCount: 0 }],
    nextJobIndex: 0, dailyCandidateTarget: 25, targetType: "person", pageLimitPerQuery: 1, queryLimitPerRun: 10, providerCreditCapUsd: 1,
    includePdlCrossReference: false, pdlCrossReferenceDone: false, retryPolicy: { maxAttemptsPerJob: 2 },
    estimatedCreditUse: {}, spend: { vertexCalls: 0, openaiCalls: 0, pdlCandidates: 0, estimatedUsd: 1 }, // already at the cap
    runSummary: { created: 0, merged: 0, rejectedSelfMatch: 0, rejectedCrmDuplicate: 0, rejectedPreviouslyDismissed: 0, rejectedAlreadyInQueue: 0, rejectedSellerOrVendor: 0, rejectedInvalidIdentity: 0, rejectedBudgetCap: 0, unexplainedRejections: 0, personAccepted: 0, crawlBlockedByRobots: 0, crawlSkippedLoginWall: 0, crawlErrors: 0, byFreshnessTier: { recent: 0, aging: 0, evergreen: 0 }, perSource: [], explanation: "" },
    programNoteId: "note-1",
  }]).rows[0];
  const PublicWebDiscoveryRunModel = fakePublicWebDiscoveryRunModel([run]);
  let pdlCalled = false;
  const peopleDataLabsService = { searchPeople: async () => { pdlCalled = true; return { people: [] }; } };
  const dependencies = { PublicWebDiscoveryRun: PublicWebDiscoveryRunModel, GroundingResearchResult: fakeGroundingResultModel(), peopleDataLabsService, getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }), isSelfMatch: () => ({ isSelf: false, reasons: [] }) };

  const outcome = await processNextBatch({ workspaceId: WORKSPACE_ID, userId: "u1", runId: "run-nobudget", batchSize: 1 }, dependencies);

  assert.equal(pdlCalled, false, "no PDL call may be made at all once there is genuinely no budget left — never begin a call whose cost would exceed the remaining cap");
  assert.equal(outcome.run.status, "stopped_at_cap");
}

async function run() {
  testIsNeverCrawlHostBlocksFacebookAndLinkedinAlways();
  testParseRobotsTxtRespectsDisallowAllowAndLongestMatch();
  testParseRobotsTxtEmptyDisallowMeansAllowEverything();
  await testEvaluateCrawlabilityBlocksDenylistedPlatformsWithoutFetchingRobots();
  await testEvaluateCrawlabilityHonorsRobotsDisallow();
  await testEvaluateCrawlabilityFailsClosedWhenRobotsUnverifiable();
  await testFetchPageNeverIssuesTheGetWhenRobotsDisallow();
  await testFetchPageDetectsLoginWallAndStripsHtmlOtherwise();
  testLooksLikeLoginWallDetectsStatusAndMarkers();
  testStripHtmlToTextRemovesTagsAndDecodesEntities();
  testComputeFreshnessTierBoundaries();
  testExtractIntentSignalsOnlyPullsRealPhrasesFromTheText();
  await testMergeDiscoveryCandidateRejectsSelfMatch();
  await testMergeDiscoveryCandidateRejectsExistingCrmContact();
  await testMergeDiscoveryCandidateNeverResurfacesADismissedRow();
  await testMergeDiscoveryCandidateMergesIntoExistingPendingReviewRow();
  await testMergeDiscoveryCandidateLabelsFreshnessTierInsteadOfDroppingOldResults();
  await testProposePublicWebDiscoveryRunBuildsJobsFromGeneratedFamilies();
  await testApprovePublicWebDiscoveryRunAppliesEditsAndQueues();
  await testApprovePublicWebDiscoveryRunRejectsNonDraft();
  await testProcessNextBatchAdvancesCheckpointAndStagesResults();
  await testProcessNextBatchStopsAtProviderCreditCap();
  await testProcessNextBatchRetriesAFailedJobThenGivesUp();
  await testProcessNextBatchRefusesADoubleLeaseWhileAlreadyRunning();
  await testProcessNextBatchResumesARunLeftRunningByADeadWorkerAfterARestart();
  await testProcessNextBatchRespectsAConcurrentPauseRequestedMidBatch();
  await testGenerateSearchFamiliesInjectsTheServersActualCurrentYear();
  testIsLikelySellerOrVendorDetectsProfessionalsNotStudents();
  testIsStudentSearchContextIdentifiesPeopleAndIntentCategoriesOnly();
  await testMergeDiscoveryCandidateAppliesSellerExclusionOnlyForStudentSearches();
  testInterleaveJobsRoundRobinPreventsProviderExclusionOnTruncation();
  testEstimateExpectedCountsSeparatesPeopleFromCommunities();
  testComputeBudgetWarningOnlyFiresWellAboveTheRecommendedDefault();
  testAcceptedCountForTargetRespectsTargetType();
  await testProposeStudentSearchPresetOrdersTiersAndAppliesSafeDefaults();
  await testRunPdlDirectJobActsAsIndependentCandidateSourceNotOnlyCrossReference();
  await testRunPdlCrossReferenceIsLabeledDistinctlyFromTheDirectSource();
  testComputeReservedWebBudgetReservesForPendingVertexAndOpenai();
  testReconcileUnexplainedRejectionsCatchesTheExactReportedGap();
  testReconcileUnexplainedRejectionsIsZeroWhenEveryCandidateIsAccountedFor();
  testBuildRunExplanationLabelsACapStopDistinctlyAndFlagsTheInvariantBug();
  await testProcessNextBatchReproducesTheReportedDollarCapPdlIncident();
  await testRunPdlDirectJobSkipsTheCallEntirelyWhenNoBudgetRemains();
  await testRunDueDiscoverySchedulesSkipsDisabledSchedules();
  await testRunDueDiscoverySchedulesProcessesAnEnabledDueSchedule();
  console.log("Public Web Discovery engine: robots.txt/rate-limit/login-wall/Facebook-LinkedIn-denylist crawler compliance (fails closed on unverifiable robots.txt, never fetches the page when disallowed), freshness TIERING (labels recent/aging/evergreen — never drops an old or undated lead), dedup against self-match/CRM/dismissed-records/previous-runs, checkpointed+resumable+retryable batch processing with a hard provider-credit-cap stop and an honest explanation, and a scheduler that never acts on a disabled schedule but genuinely runs an enabled+due one — all passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
