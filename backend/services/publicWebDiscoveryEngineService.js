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
const { JOB_CATEGORIES } = require("../models/PublicWebDiscoveryRun");

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

let timer = null;
let polling = false;

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

/**
 * Proposes a new run: generates editable search families for an approved
 * program (zero provider spend) and stores them as a "draft" PublicWebDiscoveryRun
 * for the owner to edit before approving. Mirrors DiscoverySearch's
 * propose→approve pattern.
 */
async function proposePublicWebDiscoveryRun({ workspaceId, userId, auth, programNoteId, locations, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.PublicWebDiscoveryRun || PublicWebDiscoveryRun;
  const generateSearchFamilies = dependencies.generateSearchFamilies || searchFamilyGenerationService.generateSearchFamilies;

  const { programName, families } = await generateSearchFamilies({ workspaceId, userId, auth, programNoteId, locations, correlationId }, dependencies);
  const jobs = families.flatMap((family) => family.queries.map((q) => ({
    category: family.category, query: q.query, source: q.source, locationHint: q.locationHint, status: "pending", page: 0, maxPages: 2, attempts: 0, resultsCount: 0, acceptedCount: 0,
  })));

  const vertexCalls = jobs.filter((j) => j.source === "vertex").reduce((sum, j) => sum + j.maxPages, 0);
  const openaiCalls = jobs.filter((j) => j.source === "openai_web_search").reduce((sum, j) => sum + j.maxPages, 0);
  const pdlCandidates = 25;
  const estimatedUsd = Math.round(((vertexCalls + openaiCalls) * COST_PER_GROUNDED_CALL_USD + pdlCandidates * COST_PER_PDL_CANDIDATE_USD) * 100) / 100;

  // Set explicitly rather than relying on the schema's own nested-subdocument
  // defaults — keeps a freshly-created run's document fully self-describing
  // (every field a later step reads is actually present) regardless of how
  // it was persisted.
  const run = await Model.create({
    workspaceId, programNoteId, programName, status: "draft", jobs, nextJobIndex: 0,
    dailyCandidateTarget: 25, pageLimitPerQuery: 2, queryLimitPerRun: 40, providerCreditCapUsd: 5,
    retryPolicy: { maxAttemptsPerJob: 3 },
    estimatedCreditUse: { vertexCalls, openaiCalls, pdlCandidates, estimatedUsd, note: "Rough estimate only, assuming every generated query runs its full page limit and PDL cross-reference finds a full batch — actual spend depends on real results and the caps set at approval." },
    spend: { vertexCalls: 0, openaiCalls: 0, pdlCandidates: 0, estimatedUsd: 0 },
    runSummary: { created: 0, merged: 0, rejectedSelfMatch: 0, rejectedCrmDuplicate: 0, rejectedPreviouslyDismissed: 0, rejectedAlreadyInQueue: 0, crawlBlockedByRobots: 0, crawlSkippedLoginWall: 0, crawlErrors: 0, byFreshnessTier: { recent: 0, aging: 0, evergreen: 0 }, perSource: [], explanation: "" },
    pdlCrossReferenceDone: false, includePdlCrossReference: true,
    createdByUserId: userId, correlationId: clean(correlationId, 255),
  });
  return run;
}

/**
 * Applies the owner's edits (add/remove/edit jobs, adjust targets/limits/
 * caps) and moves the run from "draft" to "queued" — nothing is spent
 * until a processNextBatch() tick actually runs.
 */
async function approvePublicWebDiscoveryRun({ workspaceId, userId, runId, jobs, dailyCandidateTarget, pageLimitPerQuery, queryLimitPerRun, providerCreditCapUsd, includePdlCrossReference, sources }, dependencies = {}) {
  const Model = dependencies.PublicWebDiscoveryRun || PublicWebDiscoveryRun;
  const run = await Model.findOne({ _id: runId, workspaceId });
  if (!run) { const error = new Error("Discovery run not found"); error.code = "DISCOVERY_RUN_NOT_FOUND"; throw error; }
  if (run.status !== "draft") { const error = new Error("This run has already been approved or run"); error.code = "DISCOVERY_RUN_ALREADY_APPROVED"; throw error; }

  if (Array.isArray(jobs) && jobs.length) {
    const allowedSources = Array.isArray(sources) && sources.length ? sources.filter((s) => ["vertex", "openai_web_search"].includes(s)) : null;
    run.jobs = jobs
      .filter((j) => JOB_CATEGORIES.includes(j.category) && String(j.query || "").trim() && ["vertex", "openai_web_search"].includes(j.source))
      .filter((j) => !allowedSources || allowedSources.includes(j.source))
      .slice(0, Math.max(1, Math.min(500, Number(queryLimitPerRun) || run.queryLimitPerRun)))
      .map((j) => ({ category: j.category, query: clean(j.query, 500), source: j.source, locationHint: clean(j.locationHint, 200), status: "pending", page: 0, maxPages: Math.max(1, Math.min(10, Number(pageLimitPerQuery) || run.pageLimitPerQuery)), attempts: 0, resultsCount: 0, acceptedCount: 0 }));
  } else {
    for (const job of run.jobs) job.maxPages = Math.max(1, Math.min(10, Number(pageLimitPerQuery) || job.maxPages));
  }
  if (!run.jobs.length) { const error = new Error("At least one search-family query is required to approve this run"); error.code = "DISCOVERY_RUN_NO_JOBS"; throw error; }

  if (dailyCandidateTarget != null) run.dailyCandidateTarget = Math.max(1, Math.min(500, Number(dailyCandidateTarget) || run.dailyCandidateTarget));
  if (pageLimitPerQuery != null) run.pageLimitPerQuery = Math.max(1, Math.min(10, Number(pageLimitPerQuery) || run.pageLimitPerQuery));
  if (queryLimitPerRun != null) run.queryLimitPerRun = Math.max(1, Math.min(500, Number(queryLimitPerRun) || run.queryLimitPerRun));
  if (providerCreditCapUsd != null) run.providerCreditCapUsd = Math.max(0, Math.min(1000, Number(providerCreditCapUsd) || run.providerCreditCapUsd));
  if (includePdlCrossReference != null) run.includePdlCrossReference = Boolean(includePdlCrossReference);

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
async function mergeDiscoveryCandidate({ workspaceId, userId, run, candidate, selfSignals, correlationId }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const ContactModel = dependencies.Contact || Contact;
  const OrganizationModel = dependencies.Organization || Organization;
  const isSelfMatchCheck = dependencies.isSelfMatch || workspaceSelfExclusionService.isSelfMatch;

  if (isSelfMatchCheck(candidate, selfSignals).isSelf) return { outcome: "rejected_self" };

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

function tallyFreshnessTier(run, tier) {
  if (tier === "recent") run.runSummary.byFreshnessTier.recent += 1;
  else if (tier === "aging") run.runSummary.byFreshnessTier.aging += 1;
  else run.runSummary.byFreshnessTier.evergreen += 1;
}

/** Runs one search-family job's current "page" (see module header re: pagination) and merges every result. */
async function runJob({ workspaceId, userId, auth, run, job, selfSignals, correlationId }, dependencies = {}) {
  const vertex = dependencies.vertexGroundingService || vertexGroundingService;
  const openaiWebSearch = dependencies.openaiWebSearchService || openaiWebSearchService;
  const caller = job.source === "vertex" ? vertex : openaiWebSearch;
  const resultTypes = CATEGORY_RESULT_TYPES[job.category] || ["person"];

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
    if (run.runSummary.created + run.runSummary.merged >= run.dailyCandidateTarget) break;

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
    const merge = await mergeDiscoveryCandidate({ workspaceId, userId, run, candidate, selfSignals, correlationId }, dependencies);
    if (merge.outcome === "created" || merge.outcome === "merged") {
      job.acceptedCount += 1;
      perSourceEntry.accepted += 1;
      tallyFreshnessTier(run, merge.row.freshnessTier || computeFreshnessTier(result.evidenceDate));
    }
    if (merge.outcome === "created") run.runSummary.created += 1;
    else if (merge.outcome === "merged") run.runSummary.merged += 1;
    else if (merge.outcome === "rejected_self") run.runSummary.rejectedSelfMatch += 1;
    else if (merge.outcome === "rejected_crm") run.runSummary.rejectedCrmDuplicate += 1;
    else if (merge.outcome === "rejected_dismissed") run.runSummary.rejectedPreviouslyDismissed += 1;
  }
  run.runSummary.perSource = [...(run.runSummary.perSource || []), perSourceEntry];
  job.lastRunAt = new Date();
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
 * Cross-references PDL Person Search against this run's OWN accumulated
 * public-web evidence: a PDL candidate that matches an already-created
 * web-evidence row for the same name+company is merged into it (raising
 * confidence rather than creating a second row), so the run is never
 * relying on one web query — or PDL alone — to find everyone.
 */
async function runPdlCrossReference({ workspaceId, userId, auth, run, selfSignals, correlationId }, dependencies = {}) {
  const pdl = dependencies.peopleDataLabsService || peopleDataLabsService;
  const NoteModel = dependencies.JarvisMemoryNote || JarvisMemoryNote;
  const runAgent = dependencies.runAgent || agentExecutionService.runAgent;
  if (!run.includePdlCrossReference) return;
  if (run.spend.estimatedUsd >= run.providerCreditCapUsd) return;
  const remaining = Math.max(0, run.dailyCandidateTarget - (run.runSummary.created + run.runSummary.merged));
  if (remaining <= 0) return;

  const note = run.programNoteId ? await NoteModel.findOne({ _id: run.programNoteId, workspaceId }).select("title content").lean() : null;
  if (!note) { run.runSummary.perSource = [...(run.runSummary.perSource || []), { source: "pdl_person_search", category: "people", error: "No program note available for PDL ICP derivation." }]; return; }

  const locations = [...new Set(run.jobs.map((j) => j.locationHint).filter(Boolean))].slice(0, 10);
  const icpResult = await runAgent({
    workspaceId, userId, auth, agent: "lead", task: "derive_pdl_icp_for_public_web_discovery", correlationId,
    operationalContext: `Program: ${clean(note.title, 200)}\n${clean(note.content, 3000)}\n${locations.length ? `Target locations: ${locations.join(", ")}\n` : ""}Extract real, searchable professional job titles (never skill levels or audience labels), locations, and industries for a structured people-database search matching this program's ideal buyer.`,
    input: {}, options: { responseSchema: PDL_ICP_SCHEMA, schemaName: "public_web_discovery_pdl_icp" },
  });
  const icp = {
    titles: (icpResult.output.titles || []).map((t) => clean(t, 120)).filter(leadGenerationCoordinatorService.isRealisticJobTitle),
    locations: (icpResult.output.locations || []).map((l) => clean(l, 120)),
    industries: (icpResult.output.industries || []).map((i) => clean(i, 120)),
  };
  const sql = leadGenerationCoordinatorService.buildPdlSql(icp);
  const perSourceEntry = { source: "pdl_person_search", category: "people", queriesRun: sql ? 1 : 0, entitiesExtracted: 0, accepted: 0, error: null };
  if (!sql) { perSourceEntry.error = "No realistic ICP criteria could be derived for PDL — skipped."; run.runSummary.perSource = [...(run.runSummary.perSource || []), perSourceEntry]; return; }

  try {
    const outcome = await pdl.searchPeople({ workspaceId, userId, sql, size: Math.min(remaining, 25), correlationId });
    perSourceEntry.entitiesExtracted = outcome.people.length;
    run.spend.pdlCandidates += outcome.people.length;
    run.spend.estimatedUsd = Math.round((run.spend.estimatedUsd + outcome.people.length * COST_PER_PDL_CANDIDATE_USD) * 100) / 100;
    for (const person of outcome.people) {
      if (run.spend.estimatedUsd >= run.providerCreditCapUsd) break;
      if (run.runSummary.created + run.runSummary.merged >= run.dailyCandidateTarget) break;
      const candidate = leadGenerationCoordinatorService.normalizePdlCandidate(person);
      candidate.discoveryCategory = "people";
      candidate.providers = [candidate.provider];
      // eslint-disable-next-line no-await-in-loop
      const merge = await mergeDiscoveryCandidate({ workspaceId, userId, run, candidate, selfSignals, correlationId }, dependencies);
      if (merge.outcome === "created" || merge.outcome === "merged") { perSourceEntry.accepted += 1; tallyFreshnessTier(run, merge.row.freshnessTier); }
      if (merge.outcome === "created") run.runSummary.created += 1;
      else if (merge.outcome === "merged") run.runSummary.merged += 1;
      else if (merge.outcome === "rejected_self") run.runSummary.rejectedSelfMatch += 1;
      else if (merge.outcome === "rejected_crm") run.runSummary.rejectedCrmDuplicate += 1;
      else if (merge.outcome === "rejected_dismissed") run.runSummary.rejectedPreviouslyDismissed += 1;
    }
  } catch (error) {
    perSourceEntry.error = error.message;
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

  while (stepsRun < batchSize) {
    // A real HARD cap: stop before the next call would push spend over it,
    // not only after it already has — the job's own source determines
    // which per-call estimate applies.
    if (run.spend.estimatedUsd + COST_PER_GROUNDED_CALL_USD > run.providerCreditCapUsd) { stoppedReason = "provider_credit_cap_reached"; break; }
    if (run.runSummary.created + run.runSummary.merged >= run.dailyCandidateTarget) { stoppedReason = "daily_candidate_target_reached"; break; }
    if (run.nextJobIndex >= run.jobs.length) {
      if (run.includePdlCrossReference && !run.pdlCrossReferenceDone) {
        // eslint-disable-next-line no-await-in-loop
        await runPdlCrossReference({ workspaceId, userId, auth, run, selfSignals, correlationId }, dependencies);
      }
      stoppedReason = "all_jobs_complete";
      break;
    }
    const job = run.jobs[run.nextJobIndex];
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

  const allDone = run.nextJobIndex >= run.jobs.length && (!run.includePdlCrossReference || run.pdlCrossReferenceDone);
  if (stoppedReason === "provider_credit_cap_reached" || stoppedReason === "daily_candidate_target_reached" || allDone) {
    run.status = "completed";
    run.runSummary.explanation = buildRunExplanation(run, stoppedReason || "all_jobs_complete");
  } else {
    run.status = "queued"; // still has work left for the next tick
  }
  run.leaseOwner = "";
  run.leaseExpiresAt = null;
  await run.save();

  if (run.status === "completed") {
    await auditService.record({ workspaceId, actorUserId: userId, action: "provider.request", targetType: "PublicWebDiscoveryRun", targetId: run._id, after: { status: run.status, created: run.runSummary.created, merged: run.runSummary.merged }, provider: "public_web_discovery_engine", success: true });
  }
  return { done: run.status === "completed", stepsRun, run };
}

function buildRunExplanation(run, stoppedReason) {
  const total = run.runSummary.created + run.runSummary.merged;
  const reasonText = {
    provider_credit_cap_reached: `stopped early because the $${run.providerCreditCapUsd} provider credit cap was reached`,
    daily_candidate_target_reached: `stopped because the daily target of ${run.dailyCandidateTarget} was reached`,
    all_jobs_complete: "completed every queued search-family query",
  }[stoppedReason] || "completed";
  const tierText = `${run.runSummary.byFreshnessTier.recent} recent (0-90d), ${run.runSummary.byFreshnessTier.aging} aging (91-365d), ${run.runSummary.byFreshnessTier.evergreen} evergreen/undated`;
  const rejectedText = [
    run.runSummary.rejectedSelfMatch ? `${run.runSummary.rejectedSelfMatch} self-match` : "",
    run.runSummary.rejectedCrmDuplicate ? `${run.runSummary.rejectedCrmDuplicate} already in CRM` : "",
    run.runSummary.rejectedPreviouslyDismissed ? `${run.runSummary.rejectedPreviouslyDismissed} previously dismissed` : "",
  ].filter(Boolean).join(", ");
  return `This run ${reasonText}: ${total} new/updated review-queue entries (${run.runSummary.created} new, ${run.runSummary.merged} merged) — ${tierText}. Only the recent tier may be treated as recent intent.${rejectedText ? ` Excluded: ${rejectedText}.` : ""}`;
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
          run = await approvePublicWebDiscoveryRun({ workspaceId: claimed.workspaceId, userId: claimed.createdByUserId, runId: run._id, dailyCandidateTarget: claimed.dailyCandidateTarget, pageLimitPerQuery: claimed.pageLimitPerQuery, queryLimitPerRun: claimed.queryLimitPerRun, providerCreditCapUsd: claimed.providerCreditCapUsd, includePdlCrossReference: claimed.includePdlCrossReference, sources: claimed.sources }, dependencies);
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
  approvePublicWebDiscoveryRun,
  processNextBatch,
  mergeDiscoveryCandidate,
  computeFreshnessTier,
  extractIntentSignals,
  runDueDiscoverySchedules,
  startPublicWebDiscoveryRunner,
  requestScheduleRunNow,
  CATEGORY_RESULT_TYPES,
};
