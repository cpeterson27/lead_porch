/**
 * High-volume Public Web Discovery engine: for an approved program, runs
 * MANY editable search-family queries (people, public Facebook groups,
 * communities, organizations, events, forums, podcasts, directories, and
 * recent problem/intent discussions — see searchFamilyGenerationService.js)
 * through Vertex/OpenAI grounded search via a queued, paginated,
 * checkpointed worker, crawls only the publicly-accessible, robots.txt-
 * permitting citation pages (services/webCrawlerService.js — never
 * login-only Facebook/LinkedIn content), extracts structured entities and
 * evidence-grounded intent signals, cross-references PDL candidate search
 * against this run's own public-web evidence, and merges everything into
 * the existing GroundingResearchResult review queue with the SAME
 * review-only guarantee every other discovery path in this app has —
 * nothing here ever creates a CRM Contact/Organization, enriches, enables
 * a monitor, or sends outreach on its own.
 *
 * Deliberately separate from, and never calls into,
 * services/vertexGroundingDiscoveryService.js's search() or
 * services/leadGenerationCoordinatorService.js's approveAndRunSearch() —
 * those existing single-query flows, their hard 90-day freshness gate, and
 * their own dedup/self-exclusion logic are left completely unchanged. This
 * engine calls the lower-level services/vertexGroundingService.js and
 * services/openaiWebSearchService.js directly, and labels freshness in
 * TIERS (recent/aging/evergreen) rather than excluding anything.
 */
const PublicWebDiscoveryRun = require("../models/PublicWebDiscoveryRun");
const DiscoverySchedule = require("../models/DiscoverySchedule");
const GroundingResearchResult = require("../models/GroundingResearchResult");
const JarvisMemoryNote = require("../models/JarvisMemoryNote");
const Contact = require("../models/Contact");
const Organization = require("../models/Organization");
const vertexGroundingService = require("./vertexGroundingService");
const openaiWebSearchService = require("./openaiWebSearchService");
const peopleDataLabsService = require("./peopleDataLabsService");
const agentExecutionService = require("./agentExecutionService");
const auditService = require("./auditService");
const workspaceSelfExclusionService = require("./workspaceSelfExclusionService");
const webCrawlerService = require("./webCrawlerService");
const searchFamilyGenerationService = require("./searchFamilyGenerationService");
const leadGenerationCoordinatorService = require("./leadGenerationCoordinatorService");
const { JOB_CATEGORIES, JOB_SOURCES } = require("../models/PublicWebDiscoveryRun");
// The two grounded-search providers a search-family QUERY can run
// through — PDL is a valid job source but is never assigned a natural-
// language query the way these two are (see runPdlPersonSearchPhase).
const GROUNDED_SEARCH_SOURCES = ["vertex", "openai_web_search"];

const clean = (value, length) => String(value || "").trim().slice(0, length);
const WORKER_ID = `discovery-runner-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const LEASE_MS = 5 * 60 * 1000;
const RUNNER_INTERVAL_MS = Number(process.env.DISCOVERY_RUNNER_INTERVAL_MS) || 60000;
// Rough per-unit cost estimates only, surfaced with an explicit "estimate"
// label everywhere they're shown — never billed against a real invoice.
const COST_PER_GROUNDED_CALL_USD = 0.03;
const COST_PER_PDL_CANDIDATE_USD = 0.05;

const CATEGORY_RESULT_TYPES = {
  people: ["person"],
  intent_discussions: ["person"],
  facebook_groups: ["community"],
  communities: ["community"],
  organizations: ["organization"],
  events: ["event"],
  forums: ["forum"],
  podcasts: ["podcast"],
  directories: ["directory"],
};

const INTENT_PHRASE_PATTERNS = [
  /[^.?!\n]*\b(looking for|any recommendations?|need help with|how do i get started|trying to (decide|choose) between|considering (a |an )?(coach|program|course)|does anyone know a good)\b[^.?!\n]*[.?!]/gi,
];

// A student-focused search (people/intent_discussions categories, or the
// direct PDL job) must never stage a professional who serves this same
// audience rather than being part of it — a coach, course seller,
// established syndicator, broker, lender, vendor, or capital-raising
// service is not a prospective student. Community/group discovery is
// NOT filtered by this list — those categories legitimately include
// organizers, brokers, etc., and stay separately labeled.
const SELLER_OR_VENDOR_PATTERNS = [
  /\bcoach(ing)?\b/i, /\bmentor(ing|ship)?\b/i, /\bcourse (creator|seller)\b/i, /\bsells? (a |an |the )?(course|program|coaching)\b/i,
  /\bsyndicat(or|ion sponsor)\b/i, /\bgeneral partner\b/i, /\bfund manager\b/i, /\bsponsor(ed)? (deal|syndication)\b/i,
  /\bbroker\b/i, /\breal estate broker\b/i, /\bmortgage broker\b/i,
  /\blender\b/i, /\bhard money\b/i, /\bprivate money lend/i,
  /\bvendor\b/i, /\bsupplier\b/i, /\bsoftware provider\b/i,
  /\bcapital rais(ing|er)\b/i, /\bcapital partner(s)?\b/i, /\baccredited investor relations\b/i,
];
const STUDENT_SEARCH_CATEGORIES = new Set(["people", "intent_discussions"]);

function isStudentSearchContext(category) {
  return STUDENT_SEARCH_CATEGORIES.has(category);
}

function isLikelySellerOrVendor(candidate) {
  const text = `${candidate.name || ""} ${candidate.organizationName || ""} ${candidate.summary || ""}`;
  return SELLER_OR_VENDOR_PATTERNS.some((pattern) => pattern.test(text));
}

let timer = null;
let polling = false;

/** The count to compare against dailyCandidateTarget — every accepted candidate, or just people, depending on targetType. */
function acceptedCountForTarget(run) {
  return run.targetType === "person" ? run.runSummary.personAccepted : (run.runSummary.created + run.runSummary.merged);
}

function computeFreshnessTier(evidenceDate) {
  if (!evidenceDate) return "evergreen";
  const ageDays = (Date.now() - new Date(evidenceDate).getTime()) / 86400000;
  if (ageDays <= 90) return "recent";
  if (ageDays <= 365) return "aging";
  return "evergreen";
}

/** Real, evidence-grounded intent snippets pulled from crawled page text — never invented beyond what the page actually said. */
function extractIntentSignals(text) {
  const snippets = new Set();
  for (const pattern of INTENT_PHRASE_PATTERNS) {
    for (const match of String(text || "").matchAll(pattern)) {
      const snippet = clean(match[0], 220);
      if (snippet) snippets.add(snippet);
      if (snippets.size >= 3) break;
    }
  }
  return [...snippets];
}

const PEOPLE_LIKE_CATEGORIES = new Set(["people", "intent_discussions"]);
// A conservative, clearly-labeled reference point — this app tracks no
// real workspace-wide spending limit (see computeBudgetWarning below).
const RECOMMENDED_FIRST_RUN_CAP_USD = 1;

/**
 * Groups jobs by category, and within each category by source, then
 * round-robins across BOTH so that truncating this list to a smaller
 * queryLimitPerRun never systematically excludes an entire provider or
 * category just because it happened to be generated last — e.g. every
 * OpenAI-sourced query landing at the end of the array while Vertex
 * queries fill the front.
 */
function interleaveJobsRoundRobin(jobs) {
  const byCategory = new Map();
  for (const job of jobs) { if (!byCategory.has(job.category)) byCategory.set(job.category, []); byCategory.get(job.category).push(job); }
  const categoryOrder = [...byCategory.keys()];
  for (const category of categoryOrder) {
    const list = byCategory.get(category);
    const bySource = new Map();
    for (const job of list) { if (!bySource.has(job.source)) bySource.set(job.source, []); bySource.get(job.source).push(job); }
    const sourceGroups = [...bySource.values()];
    const merged = [];
    for (let i = 0; merged.length < list.length; i += 1) { for (const group of sourceGroups) if (group[i]) merged.push(group[i]); }
    byCategory.set(category, merged);
  }
  const categoryGroups = categoryOrder.map((category) => byCategory.get(category));
  const result = [];
  for (let i = 0; result.length < jobs.length; i += 1) { for (const group of categoryGroups) if (group[i]) result.push(group[i]); }
  return result;
}

/**
 * Rough, clearly-labeled estimate of people vs. community/organization
 * results — never a promise. `jobs` here is always the web (Vertex/OpenAI)
 * job list — a direct PDL job is never a member of it (see
 * includePdlPersonSearch / runPdlPersonSearchPhase), so `includesPdlDirect`
 * is passed separately to account for its own expected-people contribution.
 */
function estimateExpectedCounts(jobs, includesPdlDirect) {
  const peopleJobs = jobs.filter((j) => PEOPLE_LIKE_CATEGORIES.has(j.category)).length;
  const otherJobs = jobs.length - peopleJobs;
  const expectedPeople = peopleJobs * 3 + (includesPdlDirect ? 10 : 0);
  const expectedCommunitiesOrganizations = otherJobs * 2;
  return { expectedPeople, expectedCommunitiesOrganizations };
}

/**
 * Groups jobs by source and round-robins across ALL of them GLOBALLY —
 * unlike interleaveJobsRoundRobin (which preserves category grouping and
 * only alternates sources within a category), this ignores category
 * boundaries entirely so that truncating to queryLimitPerRun always
 * schedules one call for each enabled web provider before either gets a
 * second one, regardless of how many categories or how unevenly they're
 * split across providers. Used only on the final web-job list at approval
 * time, right before the queryLimitPerRun slice — the exact point where
 * the reported incident lost every OpenAI query to a 2-job limit.
 */
function roundRobinBySourceGlobally(jobs) {
  const bySource = new Map();
  for (const job of jobs) { if (!bySource.has(job.source)) bySource.set(job.source, []); bySource.get(job.source).push(job); }
  const sourceGroups = [...bySource.values()];
  const result = [];
  for (let i = 0; result.length < jobs.length; i += 1) { for (const group of sourceGroups) if (group[i]) result.push(group[i]); }
  return result;
}

/**
 * This app does not track a real workspace-wide provider spending limit
 * (no such config exists anywhere in this codebase) — this compares the
 * proposed cap against a conservative, clearly-labeled reference instead
 * of a real "remaining budget", and says so explicitly rather than
 * implying more certainty than this check actually has.
 */
function computeBudgetWarning(providerCreditCapUsd) {
  if (providerCreditCapUsd > RECOMMENDED_FIRST_RUN_CAP_USD * 5) {
    return `This plan's provider credit cap ($${providerCreditCapUsd}) is ${Math.round(providerCreditCapUsd / RECOMMENDED_FIRST_RUN_CAP_USD)}x the recommended $${RECOMMENDED_FIRST_RUN_CAP_USD} first-run cap. This app doesn't track a workspace-wide spending limit, so this is a safety comparison against that conservative default, not a real "remaining budget" check — confirm this is intentional, and separately check your actual PDL/OpenAI account limits if you're unsure.`;
  }
  return "";
}

function emptyRunSummary() {
  return { created: 0, merged: 0, rejectedSelfMatch: 0, rejectedCrmDuplicate: 0, rejectedPreviouslyDismissed: 0, rejectedAlreadyInQueue: 0, rejectedSellerOrVendor: 0, rejectedInvalidIdentity: 0, rejectedBudgetCap: 0, unexplainedRejections: 0, personAccepted: 0, crawlBlockedByRobots: 0, crawlSkippedLoginWall: 0, crawlErrors: 0, byFreshnessTier: { recent: 0, aging: 0, evergreen: 0 }, perSource: [], explanation: "", zeroCallReasons: [] };
}

/**
 * Proposes a new run: generates editable search families for an approved
 * program (zero provider spend) and stores them as a "draft" PublicWebDiscoveryRun
 * for the owner to edit before approving. Mirrors DiscoverySearch's
 * propose→approve pattern. Jobs are round-robin interleaved across
 * category and source before storage (see interleaveJobsRoundRobin).
 */
async function proposePublicWebDiscoveryRun({ workspaceId, userId, auth, programNoteId, locations, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.PublicWebDiscoveryRun || PublicWebDiscoveryRun;
  const generateSearchFamilies = dependencies.generateSearchFamilies || searchFamilyGenerationService.generateSearchFamilies;

  const { programName, families } = await generateSearchFamilies({ workspaceId, userId, auth, programNoteId, locations, correlationId }, dependencies);
  const rawJobs = families.flatMap((family) => family.queries.map((q) => ({
    category: family.category, query: q.query, source: q.source, locationHint: q.locationHint, status: "pending", page: 0, maxPages: 2, attempts: 0, resultsCount: 0, acceptedCount: 0,
  })));
  const jobs = interleaveJobsRoundRobin(rawJobs);

  const vertexCalls = jobs.filter((j) => j.source === "vertex").reduce((sum, j) => sum + j.maxPages, 0);
  const openaiCalls = jobs.filter((j) => j.source === "openai_web_search").reduce((sum, j) => sum + j.maxPages, 0);
  // Web cash estimate ONLY (Vertex + OpenAI) — PDL is never a member of
  // `jobs` and is never converted into a dollar figure here; its own
  // credit ceiling is reported separately below.
  const estimatedUsd = Math.round((vertexCalls + openaiCalls) * COST_PER_GROUNDED_CALL_USD * 100) / 100;
  const { expectedPeople, expectedCommunitiesOrganizations } = estimateExpectedCounts(jobs, false);
  // The custom "Generate custom search families" flow has never included a
  // direct PDL job (searchFamilyGenerationService only ever generates
  // Vertex/OpenAI queries) — preserved unchanged; cross-reference remains
  // the only PDL involvement here unless the owner explicitly turns the
  // direct toggle on after generating.
  const includePdlPersonSearch = false;
  const maxPdlPersonSearchCredits = 25;
  const maxPdlCrossReferenceCredits = 25;

  // Set explicitly rather than relying on the schema's own nested-subdocument
  // defaults — keeps a freshly-created run's document fully self-describing
  // (every field a later step reads is actually present) regardless of how
  // it was persisted.
  const run = await Model.create({
    workspaceId, programNoteId, programName, status: "draft", jobs, nextJobIndex: 0,
    dailyCandidateTarget: 25, pageLimitPerQuery: 2, queryLimitPerRun: 40, providerCreditCapUsd: 5, targetType: "all",
    retryPolicy: { maxAttemptsPerJob: 3 },
    estimatedCreditUse: {
      vertexCalls, openaiCalls, pdlCandidates: (includePdlPersonSearch ? maxPdlPersonSearchCredits : 0) + maxPdlCrossReferenceCredits,
      estimatedUsd, expectedPeople, expectedCommunitiesOrganizations,
      maxPdlPersonSearchCredits: includePdlPersonSearch ? maxPdlPersonSearchCredits : 0,
      maxPdlCrossReferenceCredits,
      budgetWarning: computeBudgetWarning(5),
      note: "Rough estimate only, assuming every generated query runs its full page limit and PDL cross-reference finds a full batch — actual spend depends on real results and the caps set at approval. PDL credits are tracked separately and are never converted into the web cash estimate above.",
    },
    spend: { vertexCalls: 0, openaiCalls: 0, pdlCandidates: 0, pdlPersonSearchCredits: 0, pdlCrossReferenceCredits: 0, estimatedUsd: 0 },
    runSummary: emptyRunSummary(),
    includePdlPersonSearch, maxPdlPersonSearchCredits, maxPdlCrossReferenceCredits,
    pdlCrossReferenceDone: false, includePdlCrossReference: true,
    enabledSources: ["vertex", "openai_web_search"],
    createdByUserId: userId, correlationId: clean(correlationId, 255),
  });
  return run;
}

/**
 * The "Find prospective students" one-click preset: assembles a plan in
 * strict priority order — (1) PDL Person Search as an independent,
 * paginated candidate source, (2) recent public problem/intent
 * discussions, (3) aspiring/beginner-investor people searches, then
 * (4) relevant communities and groups — round-robins WITHIN each tier
 * (never across tiers, so the priority order itself is never disturbed),
 * and applies conservative, safe-by-default first-run limits.
 */
async function proposeStudentSearchPreset({ workspaceId, userId, auth, programNoteId, locations, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.PublicWebDiscoveryRun || PublicWebDiscoveryRun;
  const generateSearchFamilies = dependencies.generateSearchFamilies || searchFamilyGenerationService.generateSearchFamilies;

  const { programName, families } = await generateSearchFamilies({
    workspaceId, userId, auth, programNoteId, locations, correlationId,
    categories: ["intent_discussions", "people", "facebook_groups", "communities"],
    audienceFraming: "For the 'people' category specifically: frame queries around ASPIRING or BEGINNER investors — people just starting out, asking introductory questions, or new to real estate investing — not established professionals.",
  }, dependencies);

  const byCategory = new Map(families.map((family) => [family.category, family.queries]));
  const toJobs = (category, queries) => (queries || []).map((q) => ({ category, query: q.query, source: q.source, locationHint: q.locationHint, status: "pending", page: 0, maxPages: 1, attempts: 0, resultsCount: 0, acceptedCount: 0 }));

  // Priority 1: recent problem/intent discussions.
  const intentTier = interleaveJobsRoundRobin(toJobs("intent_discussions", byCategory.get("intent_discussions")));
  // Priority 2: aspiring/beginner-investor people searches.
  const peopleTier = interleaveJobsRoundRobin(toJobs("people", byCategory.get("people")));
  // Priority 3: relevant communities and groups — separately labeled, never
  // filtered by the seller/vendor exclusion (see isStudentSearchContext).
  const communityTier = interleaveJobsRoundRobin([...toJobs("facebook_groups", byCategory.get("facebook_groups")), ...toJobs("communities", byCategory.get("communities"))]);

  // PDL Person Search is NOT a member of `jobs` — it's an independent,
  // boolean-gated phase (includePdlPersonSearch / runPdlPersonSearchPhase)
  // that always runs first, before any web job, so it keeps its top
  // priority without occupying a query-limit slot or being removable via
  // job-list editing (see model comment on includePdlPersonSearch for why).
  const jobs = [...intentTier, ...peopleTier, ...communityTier];
  const vertexCalls = jobs.filter((j) => j.source === "vertex").reduce((sum, j) => sum + j.maxPages, 0);
  const openaiCalls = jobs.filter((j) => j.source === "openai_web_search").reduce((sum, j) => sum + j.maxPages, 0);
  const estimatedUsd = Math.round((vertexCalls + openaiCalls) * COST_PER_GROUNDED_CALL_USD * 100) / 100;
  const { expectedPeople, expectedCommunitiesOrganizations } = estimateExpectedCounts(jobs, true);
  const providerCreditCapUsd = 1;
  const includePdlPersonSearch = true;
  const maxPdlPersonSearchCredits = 25;
  const maxPdlCrossReferenceCredits = 25;

  const run = await Model.create({
    workspaceId, programNoteId, programName, status: "draft", jobs, nextJobIndex: 0,
    // Defaults for the first run of this preset: 25 unique PEOPLE (not a
    // mix with communities — targetType:"person"), one page per query,
    // one retry (2 attempts total), and a $1 hard WEB CASH cap (Vertex +
    // OpenAI only — PDL's own credit ceiling is separate, see above).
    dailyCandidateTarget: 25, targetType: "person", pageLimitPerQuery: 1, queryLimitPerRun: Math.max(jobs.length, 20), providerCreditCapUsd,
    retryPolicy: { maxAttemptsPerJob: 2 },
    estimatedCreditUse: {
      vertexCalls, openaiCalls, pdlCandidates: maxPdlPersonSearchCredits, // cross-reference is off by default for this preset — see below.
      estimatedUsd, expectedPeople, expectedCommunitiesOrganizations,
      maxPdlPersonSearchCredits, maxPdlCrossReferenceCredits: 0,
      budgetWarning: computeBudgetWarning(providerCreditCapUsd),
      note: "Find prospective students preset: PDL Person Search runs first as an independent candidate source (its own credit ceiling, never counted as web cash), then recent intent discussions, then aspiring/beginner people searches, then communities/groups — coaches, course sellers, syndicators, brokers, lenders, vendors, and capital-raising services are excluded from the people/intent/PDL results, never from community discovery.",
    },
    spend: { vertexCalls: 0, openaiCalls: 0, pdlCandidates: 0, pdlPersonSearchCredits: 0, pdlCrossReferenceCredits: 0, estimatedUsd: 0 },
    runSummary: emptyRunSummary(),
    includePdlPersonSearch, maxPdlPersonSearchCredits, maxPdlCrossReferenceCredits,
    pdlCrossReferenceDone: false, includePdlCrossReference: false, // PDL already runs directly — cross-reference would be redundant here.
    enabledSources: ["vertex", "openai_web_search"],
    createdByUserId: userId, correlationId: clean(correlationId, 255),
  });
  return run;
}

/**
 * Applies the owner's edits (add/remove/edit jobs, adjust targets/limits/
 * caps) and moves the run from "draft" to "queued" — nothing is spent
 * until a processNextBatch() tick actually runs.
 */
/**
 * The SINGLE finalization step for the web (Vertex/OpenAI) job list:
 * filters to real, enabled-source web queries, round-robins them by
 * source GLOBALLY (not just within a category — see
 * roundRobinBySourceGlobally), and slices to queryLimitPerRun, applying
 * pageLimitPerQuery as every surviving job's maxPages. PDL is never a
 * candidate here — it's excluded by the source filter itself.
 *
 * Used identically by approvePublicWebDiscoveryRun (what actually runs)
 * and computeRunPlanPreview (what the draft editor shows before running),
 * so the pre-run plan can never diverge from execution again — a low
 * query limit previously starved a whole provider (or, before PDL became
 * an independent phase, got squeezed out entirely by a PDL job) because
 * the shown estimate was computed from the unsliced draft query
 * collection instead of this exact finalized list.
 */
function finalizeWebJobPlan({ jobs, sources, queryLimitPerRun, pageLimitPerQuery, fallbackQueryLimit = 40, fallbackPageLimit = 2 }) {
  const allowedSources = Array.isArray(sources) && sources.length ? sources.filter((s) => GROUNDED_SEARCH_SOURCES.includes(s)) : null;
  const webJobs = (jobs || [])
    .filter((j) => JOB_CATEGORIES.includes(j.category) && String(j.query || "").trim() && GROUNDED_SEARCH_SOURCES.includes(j.source))
    .filter((j) => !allowedSources || allowedSources.includes(j.source));
  const resolvedPageLimit = Math.max(1, Math.min(10, Number(pageLimitPerQuery) || fallbackPageLimit));
  const resolvedQueryLimit = Math.max(1, Math.min(500, Number(queryLimitPerRun) || fallbackQueryLimit));
  return roundRobinBySourceGlobally(webJobs)
    .slice(0, resolvedQueryLimit)
    .map((j) => ({ category: j.category, query: clean(j.query, 500), source: j.source, locationHint: clean(j.locationHint, 200), status: "pending", page: 0, maxPages: resolvedPageLimit, attempts: 0, resultsCount: 0, acceptedCount: 0 }));
}

/**
 * The exact pre-run plan the owner sees before approving — built from
 * finalizeWebJobPlan(), the SAME finalization step approvePublicWebDiscoveryRun
 * uses, so this can never diverge from what a "Run once now" click will
 * actually do (the reported bug: the draft preview showed the unsliced
 * draft query collection's totals — e.g. "22 Vertex calls" — while a
 * query limit of 2 meant execution could only ever make 1 Vertex + 1
 * OpenAI call).
 *
 * Distinguishes INITIAL planned calls (what will definitely be attempted)
 * from RETRY EXPOSURE (extra calls only consumed if an initial attempt
 * fails) — the two must never be silently summed into one "maximum",
 * since retries are conditional, not guaranteed spend. The web cash
 * figure is clamped to providerCreditCapUsd because execution enforces
 * that as a hard stop regardless of how many retries occur, so a number
 * larger than the cap could never actually happen.
 */
function computeRunPlanPreview({ jobs, sources, queryLimitPerRun, pageLimitPerQuery, providerCreditCapUsd, includePdlPersonSearch, maxPdlPersonSearchCredits, includePdlCrossReference, maxPdlCrossReferenceCredits, maxAttemptsPerJob }) {
  const finalJobs = finalizeWebJobPlan({ jobs, sources, queryLimitPerRun, pageLimitPerQuery });
  const maxVertexCallsInitial = finalJobs.filter((j) => j.source === "vertex").reduce((sum, j) => sum + j.maxPages, 0);
  const maxOpenaiCallsInitial = finalJobs.filter((j) => j.source === "openai_web_search").reduce((sum, j) => sum + j.maxPages, 0);

  const attempts = Math.max(1, Math.min(10, Number(maxAttemptsPerJob) || 1));
  const retryMultiplier = attempts - 1; // extra attempts beyond the guaranteed first one, only spent on failure
  const maxVertexRetryExposure = maxVertexCallsInitial * retryMultiplier;
  const maxOpenaiRetryExposure = maxOpenaiCallsInitial * retryMultiplier;

  const cap = Math.max(0, Number(providerCreditCapUsd) || 0);
  const maxWebCashInitial = Math.round((maxVertexCallsInitial + maxOpenaiCallsInitial) * COST_PER_GROUNDED_CALL_USD * 100) / 100;
  const maxWebCashWithRetries = Math.round((maxVertexCallsInitial + maxVertexRetryExposure + maxOpenaiCallsInitial + maxOpenaiRetryExposure) * COST_PER_GROUNDED_CALL_USD * 100) / 100;
  const maxWebCashEnforced = Math.min(maxWebCashWithRetries, cap);

  const resolvedMaxPdlPersonSearchCredits = includePdlPersonSearch ? Math.max(0, Math.min(500, Number(maxPdlPersonSearchCredits) || 0)) : 0;
  const resolvedMaxPdlCrossReferenceCredits = includePdlCrossReference ? Math.max(0, Math.min(500, Number(maxPdlCrossReferenceCredits) || 0)) : 0;

  const anyWebJobs = maxVertexCallsInitial > 0 || maxOpenaiCallsInitial > 0;
  let validationError = "";
  if (!anyWebJobs && !includePdlPersonSearch && !includePdlCrossReference) {
    validationError = "Nothing is configured to run: no Vertex/OpenAI queries survived your provider/query-limit settings, and both PDL sources are off.";
  } else if (anyWebJobs && cap < COST_PER_GROUNDED_CALL_USD) {
    validationError = `The web cash cap ($${cap}) is below the cost of a single query ($${COST_PER_GROUNDED_CALL_USD}) — no Vertex/OpenAI query could ever run at this cap. Raise the cap or disable these providers.`;
  }

  return {
    maxPdlPersonSearchCredits: resolvedMaxPdlPersonSearchCredits,
    maxPdlCrossReferenceCredits: resolvedMaxPdlCrossReferenceCredits,
    maxVertexCallsInitial, maxOpenaiCallsInitial,
    maxVertexRetryExposure, maxOpenaiRetryExposure,
    maxWebCashInitial, maxWebCashWithRetries, maxWebCashEnforced,
    providerCreditCapUsd: cap,
    finalJobCount: finalJobs.length,
    validationError,
  };
}

async function approvePublicWebDiscoveryRun({ workspaceId, userId, runId, jobs, dailyCandidateTarget, pageLimitPerQuery, queryLimitPerRun, providerCreditCapUsd, includePdlCrossReference, includePdlPersonSearch, maxPdlPersonSearchCredits, maxPdlCrossReferenceCredits, sources, maxAttemptsPerJob }, dependencies = {}) {
  const Model = dependencies.PublicWebDiscoveryRun || PublicWebDiscoveryRun;
  const run = await Model.findOne({ _id: runId, workspaceId });
  if (!run) { const error = new Error("Discovery run not found"); error.code = "DISCOVERY_RUN_NOT_FOUND"; throw error; }
  if (run.status !== "draft") { const error = new Error("This run has already been approved or run"); error.code = "DISCOVERY_RUN_ALREADY_APPROVED"; throw error; }

  // includePdlPersonSearch is the ONLY thing that controls whether the
  // direct PDL phase runs (see model comment) — a `pdl_person_search`
  // entry in a submitted `jobs` payload is always stripped out here
  // regardless of client state, so a stale/edited job list can never
  // silently re-enable or disable it. `sources`/queryLimitPerRun apply only
  // to the real web (Vertex/OpenAI) query list, via finalizeWebJobPlan.
  const allowedSources = Array.isArray(sources) && sources.length ? sources.filter((s) => GROUNDED_SEARCH_SOURCES.includes(s)) : null;
  const submittedJobs = Array.isArray(jobs) && jobs.length ? jobs : run.jobs;
  run.jobs = finalizeWebJobPlan({
    jobs: submittedJobs, sources,
    queryLimitPerRun: queryLimitPerRun != null ? queryLimitPerRun : run.queryLimitPerRun,
    pageLimitPerQuery: pageLimitPerQuery != null ? pageLimitPerQuery : run.pageLimitPerQuery,
    fallbackQueryLimit: run.queryLimitPerRun, fallbackPageLimit: run.pageLimitPerQuery,
  });
  if (!run.jobs.length) { const error = new Error("At least one search-family query is required to approve this run"); error.code = "DISCOVERY_RUN_NO_JOBS"; throw error; }

  if (dailyCandidateTarget != null) run.dailyCandidateTarget = Math.max(1, Math.min(500, Number(dailyCandidateTarget) || run.dailyCandidateTarget));
  if (pageLimitPerQuery != null) run.pageLimitPerQuery = Math.max(1, Math.min(10, Number(pageLimitPerQuery) || run.pageLimitPerQuery));
  if (queryLimitPerRun != null) run.queryLimitPerRun = Math.max(1, Math.min(500, Number(queryLimitPerRun) || run.queryLimitPerRun));
  if (providerCreditCapUsd != null) run.providerCreditCapUsd = Math.max(0, Math.min(1000, Number(providerCreditCapUsd) || run.providerCreditCapUsd));
  if (includePdlCrossReference != null) run.includePdlCrossReference = Boolean(includePdlCrossReference);
  if (includePdlPersonSearch != null) run.includePdlPersonSearch = Boolean(includePdlPersonSearch);
  if (maxPdlPersonSearchCredits != null) run.maxPdlPersonSearchCredits = Math.max(0, Math.min(500, Number(maxPdlPersonSearchCredits) || 0));
  if (maxPdlCrossReferenceCredits != null) run.maxPdlCrossReferenceCredits = Math.max(0, Math.min(500, Number(maxPdlCrossReferenceCredits) || 0));
  if (maxAttemptsPerJob != null) run.retryPolicy.maxAttemptsPerJob = Math.max(1, Math.min(10, Number(maxAttemptsPerJob) || run.retryPolicy.maxAttemptsPerJob));
  run.enabledSources = allowedSources || run.enabledSources || ["vertex", "openai_web_search"];

  run.nextJobIndex = 0;
  run.status = "queued";
  run.approvedByUserId = userId;
  run.approvedAt = new Date();
  await run.save();
  return run;
}

/**
 * Deduplicates and stages one candidate against self-match signals, the
 * CRM, the review queue (any status — including "dismissed", so a
 * previously-rejected identity never resurfaces), and every earlier run
 * (GroundingResearchResult persists across runs, so this same fingerprint
 * lookup already covers "previous runs" with no extra field needed).
 * Never deletes an older/undated result — labels its freshness tier
 * instead.
 */
async function mergeDiscoveryCandidate({ workspaceId, userId, run, candidate, selfSignals, isStudentSearch = false, correlationId }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const ContactModel = dependencies.Contact || Contact;
  const OrganizationModel = dependencies.Organization || Organization;
  const isSelfMatchCheck = dependencies.isSelfMatch || workspaceSelfExclusionService.isSelfMatch;

  if (!candidate.name || !String(candidate.name).trim()) return { outcome: "rejected_invalid_identity" };
  if (isSelfMatchCheck(candidate, selfSignals).isSelf) return { outcome: "rejected_self" };
  if (isStudentSearch && isLikelySellerOrVendor(candidate)) return { outcome: "rejected_seller_or_vendor" };

  if (candidate.type === "person" && candidate.email) {
    const contact = await ContactModel.findOne({ workspaceId, email: candidate.email.toLowerCase() }).select("_id").lean();
    if (contact) return { outcome: "rejected_crm" };
  }
  if (candidate.type === "organization" && candidate.organizationDomain) {
    const org = await OrganizationModel.findOne({ workspaceId, domain: candidate.organizationDomain }).select("_id").lean();
    if (org) return { outcome: "rejected_crm" };
  }

  const existing = await Model.findOne({ workspaceId, type: candidate.type, name: candidate.name, organizationDomain: candidate.organizationDomain || "" });
  const freshnessTier = computeFreshnessTier(candidate.evidenceDate);
  if (existing) {
    if (existing.status === "dismissed") return { outcome: "rejected_dismissed" };
    const mergedUrls = [...new Set([...(existing.evidenceUrls || []), ...(candidate.evidenceUrls || [])])];
    const candidateProviders = candidate.providers || (candidate.provider ? [candidate.provider] : []);
    const mergedProviders = [...new Set([...(existing.providers || []), ...candidateProviders])];
    existing.evidenceUrls = mergedUrls;
    existing.providers = mergedProviders;
    if (candidate.evidenceDate && (!existing.evidenceDate || new Date(candidate.evidenceDate) > new Date(existing.evidenceDate))) {
      existing.evidenceDate = candidate.evidenceDate;
      existing.freshnessTier = freshnessTier;
    } else if (!existing.freshnessTier) {
      existing.freshnessTier = computeFreshnessTier(existing.evidenceDate);
    }
    if (candidate.intentSignals?.length) existing.intentSignals = [...new Set([...(existing.intentSignals || []), ...candidate.intentSignals])].slice(0, 10);
    if (mergedProviders.length >= 2) existing.confidence = "corroborated";
    existing.discoveryRunId = existing.discoveryRunId || run._id;
    await existing.save();
    return { outcome: "merged", row: existing };
  }

  const created = await Model.create({
    workspaceId, query: candidate.query || `discovery_run:${run._id}:${candidate.discoveryCategory || ""}`, type: candidate.type, name: candidate.name,
    organizationName: candidate.organizationName || "", organizationDomain: candidate.organizationDomain || "",
    email: candidate.email || "", emailState: candidate.emailState || "",
    summary: candidate.summary || "", evidenceUrls: candidate.evidenceUrls || [], evidenceDate: candidate.evidenceDate || null,
    confidence: candidate.confidence || "single_source", providers: candidate.providers || (candidate.provider ? [candidate.provider] : []),
    discoveryMode: "public_web_high_volume", discoveryCategory: candidate.discoveryCategory || "",
    freshnessTier, intentSignals: (candidate.intentSignals || []).slice(0, 10),
    linkedinUrl: candidate.linkedinUrl || "", discoveryRunId: run._id,
    status: "pending_review", createdByUserId: userId, correlationId,
  });
  return { outcome: "created", row: created };
}

/** Single choke point for recording a mergeDiscoveryCandidate() outcome — used by every job type so counting never drifts between them. */
function tallyMergeOutcome(run, merge, candidateType) {
  if ((merge.outcome === "created" || merge.outcome === "merged") && candidateType === "person") run.runSummary.personAccepted += 1;
  if (merge.outcome === "created") run.runSummary.created += 1;
  else if (merge.outcome === "merged") run.runSummary.merged += 1;
  else if (merge.outcome === "rejected_self") run.runSummary.rejectedSelfMatch += 1;
  else if (merge.outcome === "rejected_crm") run.runSummary.rejectedCrmDuplicate += 1;
  else if (merge.outcome === "rejected_dismissed") run.runSummary.rejectedPreviouslyDismissed += 1;
  else if (merge.outcome === "rejected_seller_or_vendor") run.runSummary.rejectedSellerOrVendor += 1;
  else if (merge.outcome === "rejected_invalid_identity") run.runSummary.rejectedInvalidIdentity += 1;
}

/**
 * The safety-net invariant from the reported incident: a provider that
 * returns N candidates must account for every one of them in exactly one
 * bucket — accepted, merged, or a named rejection reason. Any shortfall
 * is a bug in the accounting itself and must be surfaced explicitly,
 * never silently folded into "0 accepted" with no explanation.
 */
function reconcileUnexplainedRejections(run, perSourceEntry, foundCount) {
  const accountedFor = perSourceEntry.acceptedNew + perSourceEntry.merged + perSourceEntry.rejectedSelf + perSourceEntry.rejectedCrm
    + perSourceEntry.rejectedDismissed + perSourceEntry.rejectedSellerOrVendor + perSourceEntry.rejectedInvalidIdentity + perSourceEntry.rejectedBudgetCap;
  const unexplained = Math.max(0, foundCount - accountedFor);
  perSourceEntry.unexplained = unexplained;
  if (unexplained > 0) run.runSummary.unexplainedRejections += unexplained;
  return unexplained;
}

function tallyFreshnessTier(run, tier) {
  if (tier === "recent") run.runSummary.byFreshnessTier.recent += 1;
  else if (tier === "aging") run.runSummary.byFreshnessTier.aging += 1;
  else run.runSummary.byFreshnessTier.evergreen += 1;
}

/**
 * Runs one search-family job's current "page" (see module header re:
 * pagination) and merges every result. `run.jobs` only ever holds
 * Vertex/OpenAI web-search jobs now — PDL Person Search is an independent,
 * boolean-gated phase (includePdlPersonSearch / runPdlPersonSearchPhase)
 * that never occupies a job-array slot or a queryLimitPerRun budget.
 */
async function runJob({ workspaceId, userId, auth, run, job, selfSignals, correlationId }, dependencies = {}) {
  if (job.source === "pdl_person_search") {
    // A run created before this fix may still have a legacy PDL job row
    // queued from when PDL was a job-array member — never execute it (it
    // has no query to run and would otherwise be mis-dispatched to
    // OpenAI); the independent PDL phase already covers this run's PDL
    // sourcing via includePdlPersonSearch. No-op: no call, no charge.
    job.lastError = "Superseded by the independent PDL Person Search phase — not executed.";
    return;
  }

  const vertex = dependencies.vertexGroundingService || vertexGroundingService;
  const openaiWebSearch = dependencies.openaiWebSearchService || openaiWebSearchService;
  const caller = job.source === "vertex" ? vertex : openaiWebSearch;
  const resultTypes = CATEGORY_RESULT_TYPES[job.category] || ["person"];
  const isStudentSearch = isStudentSearchContext(job.category);

  const alreadyFound = job.page > 0 ? await (dependencies.GroundingResearchResult || GroundingResearchResult).find({ workspaceId, discoveryRunId: run._id, discoveryCategory: job.category }).select("name").limit(20).lean() : [];
  const refinement = job.page > 0 && alreadyFound.length ? ` (find different results than: ${alreadyFound.map((r) => r.name).slice(0, 10).join(", ")})` : "";
  const queryText = `${job.query}${refinement}`;

  const outcome = await caller.groundedSearch({ workspaceId, userId, query: queryText, resultTypes, correlationId }, dependencies);
  if (job.source === "vertex") { run.spend.vertexCalls += 1; } else { run.spend.openaiCalls += 1; }
  run.spend.estimatedUsd = Math.round((run.spend.estimatedUsd + COST_PER_GROUNDED_CALL_USD) * 100) / 100;
  job.resultsCount += outcome.results.length;

  const perSourceEntry = { source: job.source, category: job.category, queriesRun: 1, urlsCrawled: 0, urlsSkippedRobots: 0, urlsSkippedLoginWall: 0, entitiesExtracted: outcome.results.length, accepted: 0, error: null };

  for (const result of outcome.results) {
    if (run.spend.estimatedUsd >= run.providerCreditCapUsd) break;
    if (acceptedCountForTarget(run) >= run.dailyCandidateTarget) break;

    let intentSignals = [];
    const citationUrl = (result.evidenceUrls || [])[0];
    if (citationUrl) {
      const page = await webCrawlerService.fetchPage(citationUrl, dependencies);
      if (page.ok) { perSourceEntry.urlsCrawled += 1; intentSignals = extractIntentSignals(page.textExcerpt); }
      else if (page.skippedReason === "robots_txt_disallowed" || page.skippedReason === "robots_txt_unverifiable") { perSourceEntry.urlsSkippedRobots += 1; run.runSummary.crawlBlockedByRobots += 1; }
      else if (page.skippedReason === "login_wall" || page.skippedReason === "platform_never_crawled") { perSourceEntry.urlsSkippedLoginWall += 1; run.runSummary.crawlSkippedLoginWall += 1; }
      else if (page.skippedReason) { run.runSummary.crawlErrors += 1; }
    }

    const candidate = { ...result, discoveryCategory: job.category, intentSignals, providers: [job.source === "vertex" ? "vertex_grounding" : "openai_web_search"] };
    // eslint-disable-next-line no-await-in-loop
    const merge = await mergeDiscoveryCandidate({ workspaceId, userId, run, candidate, selfSignals, isStudentSearch, correlationId }, dependencies);
    if (merge.outcome === "created" || merge.outcome === "merged") {
      job.acceptedCount += 1;
      perSourceEntry.accepted += 1;
      tallyFreshnessTier(run, merge.row.freshnessTier || computeFreshnessTier(result.evidenceDate));
    }
    tallyMergeOutcome(run, merge, candidate.type);
  }
  run.runSummary.perSource = [...(run.runSummary.perSource || []), perSourceEntry];
  job.lastRunAt = new Date();
}

/**
 * The direct PDL Person Search phase: an independent candidate source, not
 * only enrichment/cross-reference (see model comment on
 * includePdlPersonSearch). Runs at most once per run, before any web job,
 * gated SOLELY by run.includePdlPersonSearch — never by a removable job
 * row, and never charged against the web cash cap
 * (providerCreditCapUsd/spend.estimatedUsd). Sized against its own credit
 * ceiling (maxPdlPersonSearchCredits) instead: the reported incident's
 * root cause was billing PDL's FULL returned batch as cash BEFORE
 * evaluating any candidate, which let one call blow past a $0.10 cap by
 * itself and starve Vertex/OpenAI — separating credits from cash removes
 * that failure mode entirely rather than reserving around it.
 */
async function runPdlPersonSearchPhase({ workspaceId, userId, auth, run, selfSignals, correlationId }, dependencies = {}) {
  const pdl = dependencies.peopleDataLabsService || peopleDataLabsService;
  if (!run.includePdlPersonSearch) return; // off — never enqueued, called, estimated, or charged.

  const perSourceEntry = {
    source: "pdl_person_search", category: "people", queriesRun: 0, entitiesExtracted: 0, accepted: 0, error: null,
    acceptedNew: 0, merged: 0, rejectedSelf: 0, rejectedCrm: 0, rejectedDismissed: 0, rejectedSellerOrVendor: 0, rejectedInvalidIdentity: 0, rejectedBudgetCap: 0, unexplained: 0,
  };
  const remainingCredits = Math.max(0, run.maxPdlPersonSearchCredits - run.spend.pdlPersonSearchCredits);
  const remainingTarget = Math.max(0, run.dailyCandidateTarget - acceptedCountForTarget(run));
  const desiredCount = Math.min(remainingCredits, remainingTarget, 100);
  if (desiredCount <= 0) {
    perSourceEntry.error = remainingCredits <= 0
      ? `Skipped — the ${run.maxPdlPersonSearchCredits}-credit PDL Person Search limit for this run was already reached. No PDL call was made — no credits were used.`
      : `Skipped — the daily candidate target (${run.dailyCandidateTarget}) was already reached. No PDL call was made.`;
    run.runSummary.perSource = [...(run.runSummary.perSource || []), perSourceEntry];
    run.pdlPersonSearchDone = true; // attempted (and skipped) exactly once — never re-queried on a later tick.
    return;
  }

  try {
    const icp = await derivePdlIcpForProgram({ workspaceId, userId, auth, run, correlationId }, dependencies);
    const sql = leadGenerationCoordinatorService.buildPdlSql(icp);
    if (!sql) throw Object.assign(new Error("No realistic ICP criteria (titles, locations, or industries) could be derived from the program for PDL."), { code: "PDL_ICP_EMPTY" });
    perSourceEntry.queriesRun = 1;
    const outcome = await pdl.searchPeople({ workspaceId, userId, sql, size: desiredCount, correlationId });
    perSourceEntry.entitiesExtracted = outcome.people.length;
    run.spend.pdlPersonSearchCredits += outcome.people.length;
    run.spend.pdlCandidates += outcome.people.length; // legacy aggregate — kept in sync

    for (const person of outcome.people) {
      // Defensive only — correct pre-sizing above should make this
      // unreachable, but every remaining candidate is counted honestly
      // rather than silently vanishing.
      if (run.spend.pdlPersonSearchCredits > run.maxPdlPersonSearchCredits || acceptedCountForTarget(run) >= run.dailyCandidateTarget) {
        perSourceEntry.rejectedBudgetCap += 1;
        run.runSummary.rejectedBudgetCap += 1;
        continue;
      }
      const candidate = leadGenerationCoordinatorService.normalizePdlCandidate(person);
      candidate.discoveryCategory = "people";
      candidate.providers = [candidate.provider];
      // eslint-disable-next-line no-await-in-loop
      const merge = await mergeDiscoveryCandidate({ workspaceId, userId, run, candidate, selfSignals, isStudentSearch: true, correlationId }, dependencies);
      if (merge.outcome === "created" || merge.outcome === "merged") { perSourceEntry.accepted += 1; tallyFreshnessTier(run, merge.row.freshnessTier); }
      if (merge.outcome === "created") perSourceEntry.acceptedNew += 1;
      else if (merge.outcome === "merged") perSourceEntry.merged += 1;
      else if (merge.outcome === "rejected_self") perSourceEntry.rejectedSelf += 1;
      else if (merge.outcome === "rejected_crm") perSourceEntry.rejectedCrm += 1;
      else if (merge.outcome === "rejected_dismissed") perSourceEntry.rejectedDismissed += 1;
      else if (merge.outcome === "rejected_seller_or_vendor") perSourceEntry.rejectedSellerOrVendor += 1;
      else if (merge.outcome === "rejected_invalid_identity") perSourceEntry.rejectedInvalidIdentity += 1;
      tallyMergeOutcome(run, merge, "person");
    }
    reconcileUnexplainedRejections(run, perSourceEntry, perSourceEntry.entitiesExtracted);
  } catch (error) {
    // Unlike a web job, the direct PDL phase is not a retryable job-array
    // member — an ICP-derivation or PDL API failure is recorded and the
    // phase is simply marked done, matching how cross-reference already
    // handles its own failures.
    perSourceEntry.error = clean(error.message, 300);
  } finally {
    run.runSummary.perSource = [...(run.runSummary.perSource || []), perSourceEntry];
    run.pdlPersonSearchDone = true;
  }
}

const PDL_ICP_SCHEMA = {
  type: "object",
  properties: {
    titles: { type: "array", items: { type: "string" }, description: "Real, searchable professional job titles only — never skill levels, experience descriptors, or audience labels like 'beginner' or 'students'." },
    locations: { type: "array", items: { type: "string" } },
    industries: { type: "array", items: { type: "string" } },
  },
  required: ["titles", "locations", "industries"],
  additionalProperties: false,
};

/**
 * Derives a PDL ICP (real job titles, locations, industries) from the
 * run's program note — shared by the direct PDL job and the cross-
 * reference pass so both use identical, already-tested logic
 * (isRealisticJobTitle rejects skill-level/audience phrases like
 * "beginner") rather than two copies that could drift apart.
 */
async function derivePdlIcpForProgram({ workspaceId, userId, auth, run, correlationId }, dependencies = {}) {
  const NoteModel = dependencies.JarvisMemoryNote || JarvisMemoryNote;
  const runAgent = dependencies.runAgent || agentExecutionService.runAgent;
  const note = run.programNoteId ? await NoteModel.findOne({ _id: run.programNoteId, workspaceId }).select("title content").lean() : null;
  if (!note) { const error = new Error("No program note available for PDL ICP derivation."); error.code = "PDL_ICP_NO_PROGRAM"; throw error; }

  const locations = [...new Set(run.jobs.map((j) => j.locationHint).filter(Boolean))].slice(0, 10);
  const icpResult = await runAgent({
    workspaceId, userId, auth, agent: "lead", task: "derive_pdl_icp_for_public_web_discovery", correlationId,
    operationalContext: `Program: ${clean(note.title, 200)}\n${clean(note.content, 3000)}\n${locations.length ? `Target locations: ${locations.join(", ")}\n` : ""}Extract real, searchable professional job titles (never skill levels or audience labels), locations, and industries for a structured people-database search matching this program's ideal buyer.`,
    input: {}, options: { responseSchema: PDL_ICP_SCHEMA, schemaName: "public_web_discovery_pdl_icp" },
  });
  return {
    titles: (icpResult.output.titles || []).map((t) => clean(t, 120)).filter(leadGenerationCoordinatorService.isRealisticJobTitle),
    locations: (icpResult.output.locations || []).map((l) => clean(l, 120)),
    industries: (icpResult.output.industries || []).map((i) => clean(i, 120)),
  };
}

/**
 * Cross-references PDL Person Search against this run's OWN accumulated
 * public-web evidence: a PDL candidate that matches an already-created
 * web-evidence row for the same name+company is merged into it (raising
 * confidence rather than creating a second row). Distinct from, and in
 * addition to, the direct PDL job above — its perSource entries use
 * category "cross_reference" specifically so the two PDL contributions
 * are never conflated in reporting.
 */
async function runPdlCrossReference({ workspaceId, userId, auth, run, selfSignals, correlationId }, dependencies = {}) {
  const pdl = dependencies.peopleDataLabsService || peopleDataLabsService;
  if (!run.includePdlCrossReference) return;

  const perSourceEntry = {
    source: "pdl_person_search", category: "cross_reference", queriesRun: 0, entitiesExtracted: 0, accepted: 0, error: null,
    acceptedNew: 0, merged: 0, rejectedSelf: 0, rejectedCrm: 0, rejectedDismissed: 0, rejectedSellerOrVendor: 0, rejectedInvalidIdentity: 0, rejectedBudgetCap: 0, unexplained: 0,
  };
  const remainingCredits = Math.max(0, run.maxPdlCrossReferenceCredits - run.spend.pdlCrossReferenceCredits);
  const remainingTarget = Math.max(0, run.dailyCandidateTarget - acceptedCountForTarget(run));
  const desiredCount = Math.min(remainingCredits, remainingTarget, 25);
  if (desiredCount <= 0) {
    perSourceEntry.error = remainingCredits <= 0
      ? `Skipped — the ${run.maxPdlCrossReferenceCredits}-credit PDL cross-reference limit for this run was already reached. No PDL call was made — no credits were used.`
      : `Skipped — the daily candidate target (${run.dailyCandidateTarget}) was already reached. No PDL call was made.`;
    run.runSummary.perSource = [...(run.runSummary.perSource || []), perSourceEntry];
    run.pdlCrossReferenceDone = true;
    return;
  }

  let icp;
  try {
    icp = await derivePdlIcpForProgram({ workspaceId, userId, auth, run, correlationId }, dependencies);
  } catch (error) {
    perSourceEntry.error = clean(error.message, 300);
    run.runSummary.perSource = [...(run.runSummary.perSource || []), perSourceEntry];
    run.pdlCrossReferenceDone = true;
    return;
  }
  const sql = leadGenerationCoordinatorService.buildPdlSql(icp);
  if (!sql) { perSourceEntry.error = "No realistic ICP criteria could be derived for PDL — skipped."; run.runSummary.perSource = [...(run.runSummary.perSource || []), perSourceEntry]; run.pdlCrossReferenceDone = true; return; }

  try {
    perSourceEntry.queriesRun = 1;
    const outcome = await pdl.searchPeople({ workspaceId, userId, sql, size: desiredCount, correlationId });
    perSourceEntry.entitiesExtracted = outcome.people.length;
    run.spend.pdlCrossReferenceCredits += outcome.people.length;
    run.spend.pdlCandidates += outcome.people.length; // legacy aggregate — kept in sync
    for (const person of outcome.people) {
      if (run.spend.pdlCrossReferenceCredits > run.maxPdlCrossReferenceCredits || acceptedCountForTarget(run) >= run.dailyCandidateTarget) {
        perSourceEntry.rejectedBudgetCap += 1;
        run.runSummary.rejectedBudgetCap += 1;
        continue;
      }
      const candidate = leadGenerationCoordinatorService.normalizePdlCandidate(person);
      candidate.discoveryCategory = "people";
      candidate.providers = [candidate.provider];
      // eslint-disable-next-line no-await-in-loop
      const merge = await mergeDiscoveryCandidate({ workspaceId, userId, run, candidate, selfSignals, isStudentSearch: true, correlationId }, dependencies);
      if (merge.outcome === "created" || merge.outcome === "merged") { perSourceEntry.accepted += 1; tallyFreshnessTier(run, merge.row.freshnessTier); }
      if (merge.outcome === "created") perSourceEntry.acceptedNew += 1;
      else if (merge.outcome === "merged") perSourceEntry.merged += 1;
      else if (merge.outcome === "rejected_self") perSourceEntry.rejectedSelf += 1;
      else if (merge.outcome === "rejected_crm") perSourceEntry.rejectedCrm += 1;
      else if (merge.outcome === "rejected_dismissed") perSourceEntry.rejectedDismissed += 1;
      else if (merge.outcome === "rejected_seller_or_vendor") perSourceEntry.rejectedSellerOrVendor += 1;
      else if (merge.outcome === "rejected_invalid_identity") perSourceEntry.rejectedInvalidIdentity += 1;
      tallyMergeOutcome(run, merge, "person");
    }
    reconcileUnexplainedRejections(run, perSourceEntry, perSourceEntry.entitiesExtracted);
  } catch (error) {
    perSourceEntry.error = clean(error.message, 300);
  }
  run.runSummary.perSource = [...(run.runSummary.perSource || []), perSourceEntry];
  run.pdlCrossReferenceDone = true;
}

/**
 * The checkpointed worker tick: acquires a short lease on the run,
 * processes up to `batchSize` job-steps (each a bounded, single grounded-
 * search call plus its citation crawls), persists progress after every
 * step, and releases the lease — so a crash or restart between ticks loses
 * at most the in-flight step, never the run's overall progress. Stops
 * early, with an explanation, the moment the credit cap or daily target is
 * reached; retries a failed job up to retryPolicy.maxAttemptsPerJob before
 * marking it "failed" and moving on.
 */
async function processNextBatch({ workspaceId, userId = null, auth = null, runId, batchSize = 1, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.PublicWebDiscoveryRun || PublicWebDiscoveryRun;
  const now = new Date();
  const run = await Model.findOneAndUpdate(
    { _id: runId, workspaceId, status: { $in: ["queued", "running"] }, $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] },
    { $set: { status: "running", leaseOwner: WORKER_ID, leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
    { new: true },
  );
  if (!run) return { done: true, reason: "not_runnable_or_leased" };

  const selfSignals = await (dependencies.getWorkspaceSelfSignals || workspaceSelfExclusionService.getWorkspaceSelfSignals)({ workspaceId }, dependencies);
  let stoppedReason = "";
  let stepsRun = 0;

  // The direct PDL Person Search phase runs at most once per run, before
  // any web job, and independently of the web job loop/queryLimitPerRun —
  // gated solely by includePdlPersonSearch (see model comment) and priced
  // in its own credits, never the web cash cap below.
  if (run.includePdlPersonSearch && !run.pdlPersonSearchDone) {
    await runPdlPersonSearchPhase({ workspaceId, userId, auth, run, selfSignals, correlationId }, dependencies);
    stepsRun += 1;
  }

  while (stepsRun < batchSize) {
    if (acceptedCountForTarget(run) >= run.dailyCandidateTarget) { stoppedReason = "daily_candidate_target_reached"; break; }
    if (run.nextJobIndex >= run.jobs.length) {
      if (run.includePdlCrossReference && !run.pdlCrossReferenceDone) {
        // runPdlCrossReference() does its own precise pre-call credit check
        // internally — no separate gate needed here.
        // eslint-disable-next-line no-await-in-loop
        await runPdlCrossReference({ workspaceId, userId, auth, run, selfSignals, correlationId }, dependencies);
      }
      stoppedReason = "all_jobs_complete";
      break;
    }
    const job = run.jobs[run.nextJobIndex];
    // run.jobs only ever holds Vertex/OpenAI web-search jobs now (PDL is
    // the independent phase above) — a real HARD cap: stop before the next
    // call would push web cash spend over providerCreditCapUsd, not only
    // after it already has.
    if (run.spend.estimatedUsd + COST_PER_GROUNDED_CALL_USD > run.providerCreditCapUsd) { stoppedReason = "provider_credit_cap_reached"; break; }
    job.status = "in_progress";
    job.attempts += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      await runJob({ workspaceId, userId, auth, run, job, selfSignals, correlationId }, dependencies);
      job.status = job.page + 1 >= job.maxPages ? "completed" : "pending";
      if (job.status === "pending") job.page += 1; else run.nextJobIndex += 1;
    } catch (error) {
      job.lastError = clean(error.message, 500);
      if (job.attempts >= run.retryPolicy.maxAttemptsPerJob) { job.status = "failed"; run.nextJobIndex += 1; }
      else job.status = "pending";
      run.runSummary.crawlErrors += 1;
    }
    stepsRun += 1;
  }

  // The owner may have clicked Pause or Cancel WHILE this batch's own
  // provider/crawl calls were still in flight — the pause/cancel endpoints
  // don't hold this run's lease, so they can (and should be able to)
  // change status without waiting for us. Re-check the persisted status
  // right before committing so this tick's own "queued"/"completed"
  // conclusion never silently overwrites an externally-requested pause or
  // cancel — the real progress made this tick (jobs advanced, candidates
  // staged, spend counted) is still saved either way, just under whichever
  // status the owner actually asked for.
  const externallyChanged = await Model.findOne({ _id: run._id, workspaceId });
  if (externallyChanged && (externallyChanged.status === "paused" || externallyChanged.status === "canceled")) {
    run.status = externallyChanged.status;
  } else {
    const allDone = run.nextJobIndex >= run.jobs.length
      && (!run.includePdlCrossReference || run.pdlCrossReferenceDone)
      && (!run.includePdlPersonSearch || run.pdlPersonSearchDone);
    if (stoppedReason === "provider_credit_cap_reached") {
      // Distinct from "completed" — a run stopped early by the budget cap
      // must never be reported the same way as one that finished all its
      // queued work.
      run.status = "stopped_at_cap";
      run.runSummary.explanation = buildRunExplanation(run, stoppedReason);
      run.runSummary.zeroCallReasons = explainZeroCallProviders(run);
    } else if (stoppedReason === "daily_candidate_target_reached" || allDone) {
      run.status = "completed";
      run.runSummary.explanation = buildRunExplanation(run, stoppedReason || "all_jobs_complete");
      run.runSummary.zeroCallReasons = explainZeroCallProviders(run);
    } else {
      run.status = "queued"; // still has work left for the next tick
    }
  }
  run.leaseOwner = "";
  run.leaseExpiresAt = null;
  await run.save();

  if (run.status === "completed" || run.status === "stopped_at_cap") {
    await auditService.record({ workspaceId, actorUserId: userId, action: "provider.request", targetType: "PublicWebDiscoveryRun", targetId: run._id, after: { status: run.status, created: run.runSummary.created, merged: run.runSummary.merged }, provider: "public_web_discovery_engine", success: true });
  }
  return { done: run.status === "completed" || run.status === "stopped_at_cap", stepsRun, run };
}

/**
 * Per-provider "why zero calls" reasons for every provider the owner
 * actually enabled — computed once a run reaches a terminal status so an
 * enabled provider that ended up with zero calls/credits is never left
 * unexplained the way the reported incident was (OpenAI enabled, 0 calls,
 * no reason given anywhere in the report).
 */
function explainZeroCallProviders(run) {
  const notes = [];
  const SOURCE_LABEL = { vertex: "Vertex", openai_web_search: "OpenAI Web Search" };
  for (const source of run.enabledSources || []) {
    if (!GROUNDED_SEARCH_SOURCES.includes(source)) continue;
    const calls = source === "vertex" ? run.spend.vertexCalls : run.spend.openaiCalls;
    if (calls > 0) continue;
    const hasJobs = (run.jobs || []).some((j) => j.source === source);
    if (!hasJobs) { notes.push(`${SOURCE_LABEL[source]} was enabled but no queries for it were included in this run's job list (check the query limit or your edits).`); continue; }
    const sourceJobs = run.jobs.filter((j) => j.source === source);
    if (sourceJobs.every((j) => j.status === "failed")) {
      const firstError = sourceJobs.find((j) => j.lastError)?.lastError;
      notes.push(`${SOURCE_LABEL[source]} was enabled but every one of its queries failed${firstError ? `: ${firstError}` : "."}`);
      continue;
    }
    if (run.status === "stopped_at_cap") { notes.push(`${SOURCE_LABEL[source]} was enabled but the $${run.providerCreditCapUsd} web cash cap was reached before any of its queries ran.`); continue; }
    notes.push(`${SOURCE_LABEL[source]} was enabled but received zero calls for an undetermined reason — this may be a bug.`);
  }
  if (run.includePdlPersonSearch && run.spend.pdlPersonSearchCredits === 0) {
    const entry = (run.runSummary.perSource || []).find((p) => p.source === "pdl_person_search" && p.category !== "cross_reference");
    notes.push(`PDL Person Search was enabled but used 0 credits${entry?.error ? `: ${entry.error}` : "."}`);
  }
  if (run.includePdlCrossReference && run.spend.pdlCrossReferenceCredits === 0) {
    const entry = (run.runSummary.perSource || []).find((p) => p.category === "cross_reference");
    notes.push(`PDL cross-reference was enabled but used 0 credits${entry?.error ? `: ${entry.error}` : "."}`);
  }
  return notes;
}

function buildRunExplanation(run, stoppedReason) {
  const total = run.runSummary.created + run.runSummary.merged;
  const reasonText = {
    provider_credit_cap_reached: `Stopped at budget cap — the $${run.providerCreditCapUsd} web search cash cap (Vertex + OpenAI only; PDL credits are tracked separately) was reached ($${run.spend.estimatedUsd} spent)`,
    daily_candidate_target_reached: `stopped because the daily target of ${run.dailyCandidateTarget} was reached`,
    all_jobs_complete: "completed every queued search-family query",
  }[stoppedReason] || "completed";
  const tierText = `${run.runSummary.byFreshnessTier.recent} recent (0-90d), ${run.runSummary.byFreshnessTier.aging} aging (91-365d), ${run.runSummary.byFreshnessTier.evergreen} evergreen/undated`;
  const rejectedText = [
    run.runSummary.rejectedSelfMatch ? `${run.runSummary.rejectedSelfMatch} self-match` : "",
    run.runSummary.rejectedCrmDuplicate ? `${run.runSummary.rejectedCrmDuplicate} already in CRM` : "",
    run.runSummary.rejectedPreviouslyDismissed ? `${run.runSummary.rejectedPreviouslyDismissed} previously dismissed` : "",
    run.runSummary.rejectedSellerOrVendor ? `${run.runSummary.rejectedSellerOrVendor} coach/seller/vendor excluded from student search` : "",
    run.runSummary.rejectedInvalidIdentity ? `${run.runSummary.rejectedInvalidIdentity} missing a usable name` : "",
    run.runSummary.rejectedBudgetCap ? `${run.runSummary.rejectedBudgetCap} found but never evaluated (budget cap reached mid-batch)` : "",
  ].filter(Boolean).join(", ");
  // This must never happen after the cap fix above — surfaced loudly
  // rather than silently folded into "0 accepted" the way the reported
  // incident shipped (24 PDL candidates found, 0 accepted, no reason
  // given anywhere in the report).
  const invariantWarning = run.runSummary.unexplainedRejections
    ? ` BUG: ${run.runSummary.unexplainedRejections} candidate(s) were found but not accounted for in any known outcome — this is an accounting defect, not a legitimate result.`
    : "";
  return `This run ${reasonText}: ${total} new/updated review-queue entries (${run.runSummary.created} new, ${run.runSummary.merged} merged) — ${tierText}. Only the recent tier may be treated as recent intent.${rejectedText ? ` Excluded: ${rejectedText}.` : ""}${invariantWarning}`;
}

async function runDueDiscoverySchedules(dependencies = {}) {
  if (polling) return;
  polling = true;
  try {
    const ScheduleModel = dependencies.DiscoverySchedule || DiscoverySchedule;
    const RunModel = dependencies.PublicWebDiscoveryRun || PublicWebDiscoveryRun;
    const now = new Date();
    await ScheduleModel.updateMany({ leaseExpiresAt: { $lte: now }, leaseOwner: { $ne: "" } }, { $set: { leaseOwner: "", leaseExpiresAt: null } });
    const due = await ScheduleModel.find({ enabled: true, $and: [{ $or: [{ runRequestedAt: { $lte: now } }, { nextRunAt: { $lte: now } }] }, { $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] }] }).limit(10);
    for (const schedule of due) {
      // eslint-disable-next-line no-await-in-loop
      const claimed = await ScheduleModel.findOneAndUpdate({ _id: schedule._id, $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] }, { $set: { leaseOwner: WORKER_ID, leaseExpiresAt: new Date(Date.now() + LEASE_MS) }, $unset: { runRequestedAt: 1 } }, { new: true });
      if (!claimed) continue;
      try {
        let run = claimed.currentRunId ? await RunModel.findOne({ _id: claimed.currentRunId, workspaceId: claimed.workspaceId, status: { $in: ["queued", "running"] } }) : null;
        if (!run) {
          // eslint-disable-next-line no-await-in-loop
          run = await proposePublicWebDiscoveryRun({ workspaceId: claimed.workspaceId, userId: claimed.createdByUserId, programNoteId: claimed.programNoteId, locations: [] }, dependencies);
          // eslint-disable-next-line no-await-in-loop
          run = await approvePublicWebDiscoveryRun({ workspaceId: claimed.workspaceId, userId: claimed.createdByUserId, runId: run._id, dailyCandidateTarget: claimed.dailyCandidateTarget, pageLimitPerQuery: claimed.pageLimitPerQuery, queryLimitPerRun: claimed.queryLimitPerRun, providerCreditCapUsd: claimed.providerCreditCapUsd, includePdlCrossReference: claimed.includePdlCrossReference, includePdlPersonSearch: claimed.includePdlPersonSearch, maxPdlPersonSearchCredits: claimed.maxPdlPersonSearchCredits, maxPdlCrossReferenceCredits: claimed.maxPdlCrossReferenceCredits, sources: claimed.sources, maxAttemptsPerJob: claimed.maxAttemptsPerJob }, dependencies);
          claimed.currentRunId = run._id;
        }
        // eslint-disable-next-line no-await-in-loop
        const outcome = await processNextBatch({ workspaceId: claimed.workspaceId, userId: claimed.createdByUserId, runId: run._id, batchSize: 3 }, dependencies);
        claimed.lastRunAt = now;
        claimed.lastRunStatus = outcome.run?.status === "completed" ? "completed" : "partial";
        claimed.lastRunMessage = outcome.run?.runSummary?.explanation || "In progress — resumes next tick.";
        claimed.nextRunAt = outcome.run?.status === "completed" ? new Date(Date.now() + claimed.intervalMinutes * 60000) : new Date(Date.now() + 60000);
        if (outcome.run?.status === "completed") claimed.currentRunId = null;
      } catch (error) {
        claimed.lastRunStatus = "failed";
        claimed.lastRunMessage = error.message;
        claimed.nextRunAt = new Date(Date.now() + Math.max(15, claimed.intervalMinutes) * 60000);
      }
      claimed.leaseOwner = "";
      claimed.leaseExpiresAt = null;
      // eslint-disable-next-line no-await-in-loop
      await claimed.save();
    }
  } finally {
    polling = false;
  }
}

/**
 * Starts the always-on poller (mirrors every other runner in server.js).
 * Safe to start unconditionally: it only ever acts on DiscoverySchedule
 * documents with `enabled: true`, and every schedule defaults to
 * `enabled: false` — a fresh install with no schedule explicitly turned on
 * spends and crawls nothing on its own.
 */
function startPublicWebDiscoveryRunner() {
  if (timer) return timer;
  timer = setInterval(() => runDueDiscoverySchedules().catch((error) => console.error("Public Web Discovery worker failed:", error.message)), RUNNER_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

async function requestScheduleRunNow({ workspaceId, scheduleId }, dependencies = {}) {
  const ScheduleModel = dependencies.DiscoverySchedule || DiscoverySchedule;
  return ScheduleModel.findOneAndUpdate({ _id: scheduleId, workspaceId }, { $set: { runRequestedAt: new Date(), nextRunAt: new Date() } }, { new: true });
}

module.exports = {
  proposePublicWebDiscoveryRun,
  proposeStudentSearchPreset,
  approvePublicWebDiscoveryRun,
  finalizeWebJobPlan,
  computeRunPlanPreview,
  processNextBatch,
  mergeDiscoveryCandidate,
  computeFreshnessTier,
  extractIntentSignals,
  runDueDiscoverySchedules,
  startPublicWebDiscoveryRunner,
  requestScheduleRunNow,
  CATEGORY_RESULT_TYPES,
  // Exported for direct unit testing — pure/deterministic helpers.
  interleaveJobsRoundRobin,
  roundRobinBySourceGlobally,
  estimateExpectedCounts,
  computeBudgetWarning,
  isLikelySellerOrVendor,
  isStudentSearchContext,
  acceptedCountForTarget,
  reconcileUnexplainedRejections,
  buildRunExplanation,
  explainZeroCallProviders,
};
