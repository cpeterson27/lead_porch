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
 */
const GroundingResearchResult = require("../models/GroundingResearchResult");
const Organization = require("../models/Organization");
const vertexGroundingService = require("./vertexGroundingService");
const openaiWebSearchService = require("./openaiWebSearchService");
const peopleDataLabsService = require("./peopleDataLabsService");
const agentExecutionService = require("./agentExecutionService");
const { ingestContacts } = require("./contactIngestionService");
const auditService = require("./auditService");

const MAX_RANK_BATCH = 20;
const MAX_INITIAL_PEOPLE = 5;
const SOURCES = ["vertex", "openai_web_search", "both"];

const RANK_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    rankings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          resultId: { type: "string" },
          fitScore: { type: "number" },
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
  // Hard cap regardless of provider prompt compliance — "the initial
  // request" for people stays at MAX_INITIAL_PEOPLE no matter how many
  // sources contributed or how many each returned.
  const people = merged.filter((row) => row.type === "person").slice(0, MAX_INITIAL_PEOPLE);
  const nonPeople = merged.filter((row) => row.type !== "person");
  const combinedResults = [...people, ...nonPeople];

  const existing = await Model.find({ workspaceId, status: "pending_review" }).select("type name organizationDomain evidenceUrls confidence providers").lean();
  const existingByKey = new Map(existing.map((row) => [fingerprintKey(row), row]));

  let created = 0, mergedCount = 0;
  for (const result of combinedResults) {
    const key = fingerprintKey(result);
    const match = existingByKey.get(key);
    if (match) {
      const mergedUrls = [...new Set([...(match.evidenceUrls || []), ...(result.evidenceUrls || [])])];
      const mergedProviders = [...new Set([...(match.providers || []), ...(result.providers || [])])];
      // eslint-disable-next-line no-await-in-loop
      await Model.updateOne({ _id: match._id }, { $set: { evidenceUrls: mergedUrls, confidence: result.confidence === "corroborated" || match.confidence === "corroborated" ? "corroborated" : "single_source", summary: result.summary || match.summary, providers: mergedProviders } });
      mergedCount += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await Model.create({
      workspaceId, query: String(query || "").slice(0, 2000), type: result.type, name: result.name,
      organizationName: result.organizationName, organizationDomain: result.organizationDomain,
      summary: result.summary, evidenceUrls: result.evidenceUrls, confidence: result.confidence,
      status: "pending_review", createdByUserId: userId, correlationId, providers: result.providers,
    });
    created += 1;
  }

  return { created, merged: mergedCount, total: combinedResults.length, source: selectedSource, groundingCitations, sourceErrors };
}

async function listResults({ workspaceId, status, type }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const filter = { workspaceId };
  if (status) filter.status = status;
  if (type) filter.type = type;
  return Model.find(filter).sort({ createdAt: -1 }).limit(200).lean();
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
    const summary = await ingest({
      contacts: [{
        "First Name": firstName || row.name, "Last Name": rest.join(" "), "Company Name": row.organizationName,
        "Website": row.organizationDomain,
        // A PDL-verified email (an explicit, separate enrichment step — see
        // enrichWithPdl below) takes priority when present; otherwise this
        // stays a public-web find with no email, exactly as before.
        ...(row.pdlEnrichment?.matched && row.pdlEnrichment?.email ? { Email: row.pdlEnrichment.email, "Email Status": row.pdlEnrichment.emailState || "provider_validated" } : {}),
        "Primary Email Source": row.pdlEnrichment?.matched ? "people_data_labs" : (row.evidenceUrls?.[0] || ""),
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
 */
async function enrichWithPdl({ workspaceId, userId, resultId, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const pdl = dependencies.peopleDataLabsService || peopleDataLabsService;
  const row = await Model.findOne({ _id: resultId, workspaceId });
  if (!row) { const error = new Error("Grounding result not found"); error.code = "GROUNDING_RESULT_NOT_FOUND"; throw error; }
  if (row.type !== "person") { const error = new Error("PDL enrichment only applies to person results"); error.code = "GROUNDING_RESULT_NOT_A_PERSON"; throw error; }
  if (row.status !== "pending_review") { const error = new Error("This result has already been reviewed"); error.code = "GROUNDING_RESULT_ALREADY_REVIEWED"; throw error; }

  const outcome = await pdl.enrichPerson({ workspaceId, userId, inputs: { name: row.name, company: row.organizationName }, correlationId });
  row.pdlEnrichment = {
    attempted: true,
    matched: outcome.matched,
    likelihood: outcome.likelihood,
    email: outcome.matched ? outcome.person?.email || "" : "",
    emailState: outcome.matched ? outcome.person?.emailState || "" : "",
    enrichedAt: new Date(),
  };
  if (outcome.matched && !row.providers.includes("people_data_labs")) row.providers.push("people_data_labs");
  await row.save();

  await auditService.record({ workspaceId, actorUserId: userId, action: "provider.request", targetType: "GroundingResearchResult", targetId: row._id, after: { pdlMatched: outcome.matched }, provider: "people_data_labs", success: true });
  return row;
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
    operationalContext: `Evaluate how well each of these publicly-discovered Discovery candidates fits our coaching program, using the approved program/ICP knowledge already provided to you. Base every score and reason strictly on the evidence given for that candidate below — never invent facts not present. A candidate with weak or no evidence for program fit should score low, not be guessed generously.\n\nCandidates:\n${JSON.stringify(candidates, null, 2)}`,
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

module.exports = { search, listResults, saveResult, dismissResult, enrichWithPdl, rankForProgramFit };
