/**
 * Connects TWO independent, optional public-web discovery sources to
 * Discovery People Research, merged and deduplicated into one review queue
 * (GroundingResearchResult) with per-source citations attached — nothing
 * here ever becomes a CRM contact, organization, or lead without an
 * explicit, separate "save" action:
 *   - Vertex AI Gemini + Google Search grounding
 *     (services/vertexGroundingService.js).
 *   - OpenAI's Responses API `web_search` hosted tool
 *     (services/openaiWebSearchService.js). This app's OpenAI/Jarvis chat
 *     (services/llmService.js) calls `client.chat.completions.create(...)`
 *     exclusively — the Chat Completions API, which has no hosted
 *     web-search tool. `web_search` only exists on OpenAI's separate
 *     Responses API (`client.responses.create(...)`), confirmed supported
 *     by the installed `openai` SDK. openaiWebSearchService.js uses that
 *     Responses API path specifically for this second discovery source; it
 *     is a genuinely different code path from llmService.js, not a
 *     reinterpretation of it.
 * The caller picks "vertex", "openai_web_search", or "both" (default
 * "both") via the `source` option on search() below. Either, both, or
 * neither may be enabled server-side; an unavailable/misconfigured source
 * selected under "both" is reported back in `sourceErrors` alongside
 * whatever the other source found, rather than silently hidden — and if a
 * single source is selected explicitly, its error is thrown directly with
 * no silent fallback to the other source or to a different model.
 *
 * OpenAI/Jarvis's OTHER role in this pipeline — evidence-based program-fit
 * evaluation/ranking (rankForProgramFit below) — is unrelated to web search:
 * it runs via the SAME agent system (agentExecutionService.js) every other
 * AI feature in this app uses, never originates a discovery row, and is
 * recorded under the separate "openai_jarvis" provider tag.
 *
 * PDL (people_data_labs) likewise never originates a row here — it is
 * explicit, per-row structured enrichment (services/peopleDataLabsService.js
 * enrichPerson()) of a person a discovery source already found with public
 * evidence, matching its established role as the structured people/company
 * provider.
 *
 * Deduplication happens at three layers: services/geminiService.js's
 * deduplicateAndCorroborate() first merges duplicate entities WITHIN one
 * source's own results (by type+name+domain, raising confidence only when
 * independent citation domains agree); mergeAcrossSources() below then
 * merges the two sources' results together by the same key, unions their
 * `providers` and evidenceUrls, and raises confidence to "corroborated"
 * when two independent providers (not just two citations from the same
 * provider) both found the same entity; finally, this service merges a new
 * finding into an existing, still-open review row from an EARLIER search
 * for the same entity, rather than creating a duplicate row every time the
 * same person/organization/event/community turns up again.
 *
 * The initial request is capped at MAX_INITIAL_PEOPLE person-type results
 * per search() call, regardless of how many sources are active or how many
 * each returns — enforced here after merging, not left to each provider's
 * own prompt compliance.
 *
 * Every "person" result must also carry a verifiable evidenceDate within
 * PERSON_FRESHNESS_DAYS (default 90) — enforced here, independently of
 * whatever each provider's own prompt asked for — after a real report of
 * "buyer-intent" search results surfacing posts over a year old.
 */
const GroundingResearchResult = require("../models/GroundingResearchResult");
const Organization = require("../models/Organization");
const JarvisMemoryNote = require("../models/JarvisMemoryNote");
const vertexGroundingService = require("./vertexGroundingService");
const openaiWebSearchService = require("./openaiWebSearchService");
const peopleDataLabsService = require("./peopleDataLabsService");
const agentExecutionService = require("./agentExecutionService");
const { ingestContacts } = require("./contactIngestionService");
const auditService = require("./auditService");
const clean = (value, length) => String(value || "").trim().slice(0, length);

const MAX_RANK_BATCH = 20;
const MAX_INITIAL_PEOPLE = 5;
const MAX_SUGGESTED_SEARCHES = 5;
const SOURCES = ["vertex", "openai_web_search", "both"];
// The SERVER-SIDE freshness cutoff for "person" results — independent of
// whatever each provider's own prompt asked for (see the module headers in
// vertexGroundingService.js / openaiWebSearchService.js). A stale or
// undated buyer-intent post is excluded here regardless of provider
// compliance. Same env var both providers read, so one flag tunes both
// layers consistently.
const PERSON_FRESHNESS_DAYS = Number(process.env.DISCOVERY_PERSON_FRESHNESS_DAYS) || 90;

const RANK_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    rankings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          resultId: { type: "string" },
          // Explicitly 0-100, not a 1-10 rating — an unscaled prompt let the
          // model default to a 0-10-ish score that this code then displayed
          // as "N/100", making every real fit look terrible.
          fitScore: { type: "number", description: "Integer from 0 to 100 (never a 0-10 scale) — 100 is a perfect program fit, 0 is no fit at all." },
          fitReasons: { type: "array", items: { type: "string" } },
        },
        required: ["resultId", "fitScore", "fitReasons"],
        additionalProperties: false,
      },
    },
  },
  required: ["rankings"],
  additionalProperties: false,
};

function fingerprintKey({ type, name, organizationDomain }) {
  return `${type}:${String(name || "").trim().toLowerCase()}:${String(organizationDomain || "").trim().toLowerCase()}`;
}

/**
 * Merges results from multiple discovery sources by the same
 * type+name+domain key deduplicateAndCorroborate() uses, unioning their
 * evidenceUrls and `providers`. Confidence is raised to "corroborated" when
 * either two independent citation domains agree (already true for a single
 * source) OR two independent PROVIDERS both found the same entity — the
 * latter is stronger corroboration than two links from one search.
 */
function mergeAcrossSources(sourcedResults) {
  const byKey = new Map();
  for (const { result, provider } of sourcedResults) {
    const key = fingerprintKey(result);
    if (!byKey.has(key)) { byKey.set(key, { ...result, providers: new Set([provider]), anyCorroborated: result.confidence === "corroborated" }); continue; }
    const existing = byKey.get(key);
    existing.evidenceUrls = [...new Set([...(existing.evidenceUrls || []), ...(result.evidenceUrls || [])])];
    existing.summary = existing.summary || result.summary;
    existing.providers.add(provider);
    if (result.confidence === "corroborated") existing.anyCorroborated = true;
  }
  return [...byKey.values()].map(({ anyCorroborated, ...row }) => {
    const domains = new Set((row.evidenceUrls || []).map((url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }).filter(Boolean));
    // Preserve a source's own already-corroborated verdict (e.g. that
    // provider's single search already saw 2 independent citation domains)
    // rather than recomputing purely from THIS merge's inputs, which could
    // otherwise wrongly downgrade it back to single_source.
    return { ...row, providers: [...row.providers], confidence: (anyCorroborated || domains.size >= 2 || row.providers.length >= 2) ? "corroborated" : "single_source" };
  });
}

/**
 * Runs real, billed discovery calls against whichever source(s) `source`
 * selects ("vertex" | "openai_web_search" | "both", default "both") and
 * stages every merged result into the review queue. Never creates a
 * Contact/Organization/lead — only pending_review rows. Merges into an
 * existing open (pending_review) row for the same entity instead of
 * duplicating it. Caps the number of NEW person-type results this call can
 * stage at MAX_INITIAL_PEOPLE, regardless of source count.
 */
async function search({ workspaceId, userId, auth, query, resultTypes, source = "both", correlationId = "" }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const vertex = dependencies.vertexGroundingService || vertexGroundingService;
  const openaiWebSearch = dependencies.openaiWebSearchService || openaiWebSearchService;
  const selectedSource = SOURCES.includes(source) ? source : "both";

  const sourcedResults = [];
  const sourceErrors = [];
  let groundingCitations = [];

  if (selectedSource === "vertex" || selectedSource === "both") {
    try {
      const outcome = await vertex.groundedSearch({ workspaceId, userId, query, resultTypes, correlationId }, dependencies);
      for (const result of outcome.results) sourcedResults.push({ result, provider: "vertex_grounding" });
      groundingCitations = groundingCitations.concat(outcome.groundingCitations || []);
    } catch (error) {
      if (selectedSource === "vertex") throw error;
      sourceErrors.push({ source: "vertex_grounding", code: error.code || "VERTEX_GROUNDING_FAILED", message: error.message });
    }
  }
  if (selectedSource === "openai_web_search" || selectedSource === "both") {
    try {
      const outcome = await openaiWebSearch.groundedSearch({ workspaceId, userId, query, resultTypes, maxResults: MAX_INITIAL_PEOPLE, correlationId }, dependencies);
      for (const result of outcome.results) sourcedResults.push({ result, provider: "openai_web_search" });
      groundingCitations = groundingCitations.concat(outcome.groundingCitations || []);
    } catch (error) {
      if (selectedSource === "openai_web_search") throw error;
      sourceErrors.push({ source: "openai_web_search", code: error.code || "OPENAI_WEB_SEARCH_FAILED", message: error.message });
    }
  }
  if (!sourcedResults.length && sourceErrors.length) {
    const error = new Error("Both public-web sources failed for this search.");
    error.code = "GROUNDING_ALL_SOURCES_FAILED";
    error.sourceErrors = sourceErrors;
    throw error;
  }

  const merged = mergeAcrossSources(sourcedResults);
  // SERVER-SIDE freshness validation — independent of provider prompt
  // compliance. A "person" result without a verifiable evidenceDate, or
  // dated older than PERSON_FRESHNESS_DAYS, is excluded before it ever
  // reaches the review queue. Non-person types are unaffected.
  const cutoffDate = new Date(Date.now() - PERSON_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
  const isFreshPerson = (row) => row.type !== "person" || (row.evidenceDate instanceof Date && row.evidenceDate >= cutoffDate);
  const excludedForFreshness = merged.filter((row) => !isFreshPerson(row)).length;
  const freshResults = merged.filter(isFreshPerson);
  // Hard cap regardless of provider prompt compliance — "the initial
  // request" for people stays at MAX_INITIAL_PEOPLE no matter how many
  // sources contributed or how many each returned.
  const people = freshResults.filter((row) => row.type === "person").slice(0, MAX_INITIAL_PEOPLE);
  const nonPeople = freshResults.filter((row) => row.type !== "person");
  const combinedResults = [...people, ...nonPeople];

  const existing = await Model.find({ workspaceId, status: "pending_review" }).select("type name organizationDomain evidenceUrls evidenceDate confidence providers").lean();
  const existingByKey = new Map(existing.map((row) => [fingerprintKey(row), row]));

  let created = 0, mergedCount = 0;
  for (const result of combinedResults) {
    const key = fingerprintKey(result);
    const match = existingByKey.get(key);
    if (match) {
      const mergedUrls = [...new Set([...(match.evidenceUrls || []), ...(result.evidenceUrls || [])])];
      const mergedProviders = [...new Set([...(match.providers || []), ...(result.providers || [])])];
      const matchEvidenceDate = match.evidenceDate ? new Date(match.evidenceDate) : null;
      const mergedEvidenceDate = result.evidenceDate && (!matchEvidenceDate || result.evidenceDate > matchEvidenceDate) ? result.evidenceDate : matchEvidenceDate;
      // eslint-disable-next-line no-await-in-loop
      await Model.updateOne({ _id: match._id }, { $set: { evidenceUrls: mergedUrls, evidenceDate: mergedEvidenceDate, confidence: result.confidence === "corroborated" || match.confidence === "corroborated" ? "corroborated" : "single_source", summary: result.summary || match.summary, providers: mergedProviders } });
      mergedCount += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await Model.create({
      workspaceId, query: String(query || "").slice(0, 2000), type: result.type, name: result.name,
      organizationName: result.organizationName, organizationDomain: result.organizationDomain,
      summary: result.summary, evidenceUrls: result.evidenceUrls, evidenceDate: result.evidenceDate || null, confidence: result.confidence,
      status: "pending_review", createdByUserId: userId, correlationId, providers: result.providers,
    });
    created += 1;
  }

  return { created, merged: mergedCount, total: combinedResults.length, source: selectedSource, groundingCitations, sourceErrors, excludedForFreshness, personFreshnessDays: PERSON_FRESHNESS_DAYS };
}

async function listResults({ workspaceId, status, type }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const filter = { workspaceId };
  if (status) filter.status = status;
  if (type) filter.type = type;
  const rows = await Model.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  const now = Date.now();
  const NEW_WINDOW_MS = 48 * 60 * 60 * 1000;
  // Age/newness are computed at read time, never stored, so they're always
  // accurate relative to "now" rather than whatever moment the row was last
  // written.
  return rows.map((row) => ({
    ...row,
    evidenceAgeDays: row.evidenceDate ? Math.max(0, Math.floor((now - new Date(row.evidenceDate).getTime()) / 86400000)) : null,
    isNew: row.status === "pending_review" && (now - new Date(row.createdAt).getTime()) < NEW_WINDOW_MS,
  }));
}

/**
 * Editable, one-click starting points for a search — derived deterministically
 * (no AI call, no cost) from this workspace's own APPROVED Offers & Programs
 * Knowledge Center notes, so a suggestion always reflects a real, reviewed
 * program rather than a guess. Purely a convenience prefill for the query
 * textarea; running the suggested text still goes through the normal
 * search() pipeline (5-person cap, freshness cutoff, review queue) unchanged.
 */
async function getSuggestedSearches({ workspaceId }, dependencies = {}) {
  const NoteModel = dependencies.JarvisMemoryNote || JarvisMemoryNote;
  const notes = await NoteModel.find({ workspaceId, category: "offers-programs", status: "approved" }).select("title").sort({ updatedAt: -1 }).limit(MAX_SUGGESTED_SEARCHES).lean();
  return notes.map((note) => ({
    noteId: String(note._id),
    title: clean(note.title, 200),
    query: `Find people publicly discussing recent, active interest in "${clean(note.title, 160)}" — for example asking questions about it, evaluating whether to join, or comparing it to alternatives.`,
  }));
}

/**
 * Saves one reviewed result with source attribution and deduplication:
 * person -> a real Contact via the SAME ingestContacts() pipeline the
 * existing (Jarvis/ChatGPT) People Research flow already uses, so
 * email-less public-web finds are handled identically and email-based
 * dedup still applies whenever an email exists. organization -> a real
 * Organization, deduplicated by domain via the model's own existing sparse
 * unique index. community/event have no equivalent CRM entity in this app
 * today — "saved" honestly means kept in this review queue's own record
 * (with all its evidence) rather than inventing a new CRM entity type.
 */
async function saveResult({ workspaceId, userId, resultId }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const OrganizationModel = dependencies.Organization || Organization;
  const ingest = dependencies.ingestContacts || ingestContacts;
  const row = await Model.findOne({ _id: resultId, workspaceId });
  if (!row) { const error = new Error("Grounding result not found"); error.code = "GROUNDING_RESULT_NOT_FOUND"; throw error; }
  if (row.status !== "pending_review") { const error = new Error("This result has already been reviewed"); error.code = "GROUNDING_RESULT_ALREADY_REVIEWED"; throw error; }

  let savedContactId = null, savedOrganizationId = null;
  if (row.type === "person") {
    const [firstName, ...rest] = String(row.name).trim().split(/\s+/);
    // Email priority: a matched enrichment result (PDL, then Apollo — each
    // an explicit, separate cross-check step) beats whatever email the
    // discovery source itself may have already supplied (PDL/Apollo Person
    // Search rows carry one directly; Vertex/OpenAI rows never do). Never
    // upgrades the emailState past whatever the actual source reported —
    // an "unverified"/"provider_validated" email is stored as exactly that,
    // never relabeled "verified".
    const emailSource = row.pdlEnrichment?.matched && row.pdlEnrichment?.email
      ? { email: row.pdlEnrichment.email, state: row.pdlEnrichment.emailState || "provider_validated", provider: "people_data_labs" }
      : row.apolloEnrichment?.matched && row.apolloEnrichment?.email
        ? { email: row.apolloEnrichment.email, state: row.apolloEnrichment.emailState || "unverified", provider: "apollo" }
        : row.email
          ? { email: row.email, state: row.emailState || "unverified", provider: row.providers?.find((p) => p === "pdl_person_search" || p === "apollo_person_search") || "" }
          : null;
    const summary = await ingest({
      contacts: [{
        "First Name": firstName || row.name, "Last Name": rest.join(" "), "Company Name": row.organizationName,
        "Website": row.organizationDomain,
        ...(row.linkedinUrl ? { LinkedIn: row.linkedinUrl } : {}),
        ...(emailSource ? { Email: emailSource.email, "Email Status": emailSource.state } : {}),
        "Primary Email Source": emailSource?.provider || (row.evidenceUrls?.[0] || ""),
      }],
      source: "vertex_grounding",
    });
    savedContactId = summary.createdContacts?.[0]?.id || summary.updatedContacts?.[0]?.id || null;
    if (!savedContactId) { const error = new Error(summary.errors?.[0]?.message || "Unable to save this person to Contacts"); error.code = "GROUNDING_RESULT_SAVE_FAILED"; throw error; }
  } else if (row.type === "organization") {
    const organization = row.organizationDomain
      ? await OrganizationModel.findOneAndUpdate(
          { workspaceId, domain: row.organizationDomain },
          { $set: { name: row.organizationName || row.name, source: "vertex_grounding" }, $setOnInsert: { workspaceId, domain: row.organizationDomain } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
      : await OrganizationModel.create({ workspaceId, name: row.organizationName || row.name, source: "vertex_grounding" });
    savedOrganizationId = organization._id;
  }
  // community / event: no CRM entity to create — the row itself, marked
  // saved below, IS the saved record, with its full evidence intact.

  row.status = "saved";
  row.reviewedByUserId = userId;
  row.reviewedAt = new Date();
  row.savedContactId = savedContactId;
  row.savedOrganizationId = savedOrganizationId;
  await row.save();

  await auditService.record({ workspaceId, actorUserId: userId, action: "provider.request", targetType: "GroundingResearchResult", targetId: row._id, after: { status: "saved", type: row.type, savedContactId, savedOrganizationId }, provider: "vertex", success: true });
  return row;
}

/**
 * Explicit, per-row PDL enrichment for a still-pending PERSON result — never
 * automatic (PDL enrichment spends real credits per call). Requires the row
 * to already carry public evidence (enforced by search() above, which never
 * creates a row without at least one evidenceUrl); PDL only ever adds
 * structured detail (a verified email, when it finds a confident match) on
 * top of a publicly-evidenced find, never originates one.
 *
 * Always leaves a PERSISTED, explicit outcome — matched, no-match, OR error
 * — on the row before returning. A PDL call that throws (disabled,
 * insufficient corroborating identity inputs, rate limited, provider error,
 * etc.) previously left the row completely untouched: nothing was saved,
 * so after a page refresh the attempt looked like it had never happened.
 * Once a real attempt (of any outcome) is persisted, a second call is
 * rejected server-side — belt-and-suspenders against a double-click firing
 * two overlapping PDL calls (billed per call) for the same row.
 */
async function enrichWithPdl({ workspaceId, userId, resultId, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const pdl = dependencies.peopleDataLabsService || peopleDataLabsService;
  const row = await Model.findOne({ _id: resultId, workspaceId });
  if (!row) { const error = new Error("Grounding result not found"); error.code = "GROUNDING_RESULT_NOT_FOUND"; throw error; }
  if (row.type !== "person") { const error = new Error("PDL enrichment only applies to person results"); error.code = "GROUNDING_RESULT_NOT_A_PERSON"; throw error; }
  if (row.status !== "pending_review") { const error = new Error("This result has already been reviewed"); error.code = "GROUNDING_RESULT_ALREADY_REVIEWED"; throw error; }
  if (row.pdlEnrichment?.attempted) { const error = new Error("PDL enrichment has already been attempted for this result"); error.code = "GROUNDING_RESULT_ALREADY_ENRICHED"; throw error; }

  try {
    const outcome = await pdl.enrichPerson({ workspaceId, userId, inputs: { name: row.name, company: row.organizationName }, correlationId });
    row.pdlEnrichment = {
      attempted: true,
      matched: outcome.matched,
      likelihood: outcome.likelihood,
      email: outcome.matched ? outcome.person?.email || "" : "",
      emailState: outcome.matched ? outcome.person?.emailState || "" : "",
      enrichedAt: new Date(),
      error: false,
      errorMessage: "",
    };
    if (outcome.matched && !row.providers.includes("people_data_labs")) row.providers.push("people_data_labs");
    await row.save();
    await auditService.record({ workspaceId, actorUserId: userId, action: "provider.request", targetType: "GroundingResearchResult", targetId: row._id, after: { pdlMatched: outcome.matched }, provider: "people_data_labs", success: true });
    return row;
  } catch (error) {
    row.pdlEnrichment = {
      attempted: true, matched: false, likelihood: null, email: "", emailState: "", enrichedAt: new Date(),
      error: true, errorMessage: clean(error.message || "PDL enrichment failed", 300),
    };
    await row.save();
    await auditService.record({ workspaceId, actorUserId: userId, action: "provider.request", targetType: "GroundingResearchResult", targetId: row._id, after: { pdlMatched: false, pdlErrorCode: error.code || "PDL_ENRICHMENT_FAILED" }, provider: "people_data_labs", success: false });
    return row;
  }
}

/**
 * Explicit, batch program-fit evaluation via the SAME agent system
 * (agentExecutionService.js) every other AI feature in this app already
 * uses — the "lead" agent (evidence-based prospect qualification), which
 * automatically retrieves this workspace's own approved Knowledge Center
 * program/ICP notes as grounding context. Never automatic — scores at most
 * MAX_RANK_BATCH still-pending rows the caller explicitly selects. Rows the
 * model does not return a valid, matching ID for are left unscored rather
 * than guessed at.
 */
async function rankForProgramFit({ workspaceId, userId, auth, resultIds, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const runAgent = dependencies.runAgent || agentExecutionService.runAgent;
  const ids = (Array.isArray(resultIds) ? resultIds : []).slice(0, MAX_RANK_BATCH);
  if (!ids.length) { const error = new Error("Select at least one pending result to rank"); error.code = "GROUNDING_RANK_SELECTION_REQUIRED"; throw error; }
  const rows = await Model.find({ _id: { $in: ids }, workspaceId, status: "pending_review" }).lean();
  if (!rows.length) return { ranked: 0 };

  const candidates = rows.map((row) => ({ resultId: String(row._id), type: row.type, name: row.name, organizationName: row.organizationName, summary: row.summary, evidenceUrls: row.evidenceUrls }));
  const result = await runAgent({
    workspaceId, userId, auth, agent: "lead", task: "rank_discovery_candidates_for_program_fit", correlationId,
    operationalContext: `Evaluate how well each of these publicly-discovered Discovery candidates fits our coaching program, using the approved program/ICP knowledge already provided to you. Base every score and reason strictly on the evidence given for that candidate below — never invent facts not present. A candidate with weak or no evidence for program fit should score low, not be guessed generously.\n\nScore fitScore on a 0 to 100 scale — NOT 0 to 10. 100 means a perfect program fit, 0 means no fit at all. For example, a strong fit should score in the 70-95 range, a weak fit in the 5-30 range; never return a bare single digit like "8" to mean "80".\n\nCandidates:\n${JSON.stringify(candidates, null, 2)}`,
    input: { candidateCount: candidates.length },
    options: { responseSchema: RANK_RESPONSE_SCHEMA, schemaName: "discovery_program_fit_ranking" },
  });

  const validIds = new Set(candidates.map((row) => row.resultId));
  let ranked = 0;
  for (const ranking of (result.output.rankings || [])) {
    if (!validIds.has(ranking.resultId)) continue;
    const fitScore = Math.max(0, Math.min(100, Number(ranking.fitScore) || 0));
    // eslint-disable-next-line no-await-in-loop
    await Model.updateOne(
      { _id: ranking.resultId, workspaceId },
      { $set: { fitScore, fitReasons: (ranking.fitReasons || []).slice(0, 10), fitEvaluatedAt: new Date() }, $addToSet: { providers: "openai_jarvis" } },
    );
    ranked += 1;
  }
  return { ranked, requested: ids.length };
}

async function dismissResult({ workspaceId, userId, resultId }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const row = await Model.findOneAndUpdate(
    { _id: resultId, workspaceId, status: "pending_review" },
    { $set: { status: "dismissed", reviewedByUserId: userId, reviewedAt: new Date() } },
    { new: true },
  );
  if (!row) { const error = new Error("Grounding result not found or already reviewed"); error.code = "GROUNDING_RESULT_NOT_FOUND"; throw error; }
  return row;
}

module.exports = { search, listResults, saveResult, dismissResult, enrichWithPdl, rankForProgramFit, getSuggestedSearches };
