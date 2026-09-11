/**
 * Jarvis-coordinated, multi-provider lead generation: reads approved
 * Offers & Programs Knowledge Center notes, turns a natural request like
 * "Find 10 likely buyers for this program" into an editable ICP + search
 * plan (free — no provider call), and, once the owner approves it, runs
 * all four sourcing providers and merges everything into the existing
 * GroundingResearchResult review queue.
 *
 * Reuses, rather than duplicates, everything that already works:
 *   - services/vertexGroundingDiscoveryService.js's search() is called
 *     UNCHANGED for the vertex/openai_web_search sources — its existing
 *     freshness gate, within-source dedup, and merge-into-existing-row
 *     logic are left exactly as they are.
 *   - services/peopleDataLabsService.js's searchPeople()/enrichPerson()
 *     and services/apolloService.js's searchPeople()/enrichPerson() are
 *     both already-built, already-gated (disabled by default, budget/usage
 *     ledger already wired) discovery + enrichment functions — this module
 *     only builds the ICP-derived query/filters for them and normalizes
 *     their output into the shared review-queue shape.
 *   - services/agentExecutionService.js's runAgent() (the same agent
 *     system every other AI feature in this app uses) does the natural-
 *     language-to-ICP parsing and the qualify/recommend step.
 *
 * PDL/Apollo Person Search results are a genuinely different kind of
 * evidence than Vertex/OpenAI's public-web grounding (a structured ICP
 * match, not a citable public post) — see the "discoveryMode" field on
 * GroundingResearchResult and its module header for why they are
 * deliberately NOT routed through the existing evidenceDate freshness
 * gate built for public-web buyer-intent recency.
 *
 * Nothing here ever creates a CRM Contact/Organization, sends outreach, or
 * enables a monitor — see saveResult() in vertexGroundingDiscoveryService.js
 * (unchanged, still the only path from this queue into the CRM) and
 * proposeMonitorSuggestion() below (always creates a disabled suggestion).
 */
const DiscoverySearch = require("../models/DiscoverySearch");
const LeadMonitorSuggestion = require("../models/LeadMonitorSuggestion");
const GroundingResearchResult = require("../models/GroundingResearchResult");
const JarvisMemoryNote = require("../models/JarvisMemoryNote");
const vertexGroundingDiscoveryService = require("./vertexGroundingDiscoveryService");
const vertexGroundingService = require("./vertexGroundingService");
const openaiWebSearchService = require("./openaiWebSearchService");
const peopleDataLabsService = require("./peopleDataLabsService");
const apolloService = require("./apolloService");
const agentExecutionService = require("./agentExecutionService");
const auditService = require("./auditService");
const workspaceSelfExclusionService = require("./workspaceSelfExclusionService");

const clean = (value, length) => String(value || "").trim().slice(0, length);
const MAX_REQUESTED_COUNT = 25;
const DEFAULT_REQUESTED_COUNT = 10;
const ICP_SOURCES = ["vertex", "openai_web_search", "pdl_person_search", "apollo_person_search", "all"];
const ALL_SOURCE_KEYS = ["vertex", "openai_web_search", "pdl_person_search", "apollo_person_search"];

/**
 * Pure, synchronous, no-network config checks — never a live provider call
 * — for whether each of the four sourcing providers is actually usable
 * right now. Used both to default-select/disable the Discovery UI's
 * provider checkboxes and to keep proposeSearch()'s displayed sources and
 * credit estimate honest (previously it assumed "all" meant every
 * provider regardless of real configuration, so it could show an estimate
 * for Apollo credits even when Apollo was never enabled).
 *
 * Vertex's PLATFORM-level flag is checked here; a per-workspace Vertex
 * capability toggle could still independently disable it at approval
 * time — that existing, unchanged check happens inside
 * vertexGroundingService.assertGroundingReady() and would surface as a
 * normal sourceError on the run, exactly as it already does today.
 */
function checkProviderAvailability() {
  const vertexAvailable = vertexGroundingService.groundingPlatformEnabled();
  const openaiAvailable = openaiWebSearchService.masterEnabled();
  const pdlAvailable = peopleDataLabsService.isEnabled();
  const apolloAvailable = apolloService.isEnabled();
  return {
    vertex: { available: vertexAvailable, reason: vertexAvailable ? "" : "Not enabled at the platform level (VERTEX_ENABLED, VERTEX_GROUNDING_ENABLED, and Google credentials are required)." },
    openai_web_search: { available: openaiAvailable, reason: openaiAvailable ? "" : "Not enabled (OPENAI_WEB_SEARCH_ENABLED and OPENAI_API_KEY are required)." },
    pdl_person_search: { available: pdlAvailable, reason: pdlAvailable ? "" : "Not enabled (PDL_ENABLED and PDL_API_KEY are required)." },
    apollo_person_search: { available: apolloAvailable, reason: apolloAvailable ? "" : "Not enabled (APOLLO_ENABLED and APOLLO_API_KEY are required)." },
  };
}

const ICP_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    programName: { type: "string" },
    requestedCount: { type: "number", description: "How many candidates were requested, 1-25. Default 10 if not stated. Never exceed 25 — cap and explain in reasoning if the owner asked for more." },
    icp: {
      type: "object",
      properties: {
        titles: { type: "array", items: { type: "string" }, description: "Real, searchable professional job titles only (e.g. 'Marketing Manager', 'Small Business Owner', 'Registered Nurse') — never skill levels, experience descriptors, or audience labels such as 'beginner', 'intermediate', 'expert', 'student', or 'buyer'. If the request only describes a skill level or audience with no real job title implied, leave this empty and rely on keywords/industries instead." },
        industries: { type: "array", items: { type: "string" } },
        locations: { type: "array", items: { type: "string" } },
        keywords: { type: "array", items: { type: "string" } },
        seniority: { type: "array", items: { type: "string" } },
        companySizeRange: { type: "string" },
        exclusions: { type: "array", items: { type: "string" }, description: "Kinds of people to explicitly exclude (e.g. current customers, competitors, students) — only what the program details or the owner's request actually imply, never invented." },
      },
      required: ["titles", "industries", "locations", "keywords", "seniority", "companySizeRange", "exclusions"],
      additionalProperties: false,
    },
    reasoning: { type: "string", description: "Briefly explain the ICP you derived and any capping/assumptions made." },
  },
  required: ["programName", "requestedCount", "icp", "reasoning"],
  additionalProperties: false,
};

const QUALIFY_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    qualifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          resultId: { type: "string" },
          intentQualified: { type: "boolean", description: "True only if the evidence actually supports real buyer intent or ICP fit — never guess generously." },
          fitScore: { type: "number", description: "Integer 0-100, never a 0-10 scale. 100 = perfect program fit." },
          recommendedProgramName: { type: "string" },
          recommendedProgramReason: { type: "string" },
          nextAction: { type: "string", description: "One concrete next step, e.g. 'Enrich via PDL then send intro email.'" },
          outreachDraft: { type: "string", description: "A short, personalized draft outreach message based strictly on the evidence given — never invent facts not present." },
        },
        required: ["resultId", "intentQualified", "fitScore", "recommendedProgramName", "recommendedProgramReason", "nextAction", "outreachDraft"],
        additionalProperties: false,
      },
    },
  },
  required: ["qualifications"],
  additionalProperties: false,
};

function isHttpUrl(value) {
  try { const url = new URL(String(value)); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; }
}

// A generous technical ceiling only — never a product-facing cap. The
// approved-program list and Jarvis's program context must show/consider
// every approved program; only the search-SUGGESTIONS shown after a
// program is selected are capped (at 5, see getSearchSuggestionsForProgram).
const MAX_APPROVED_PROGRAMS = 200;
const MAX_SUGGESTIONS_PER_PROGRAM = 5;
// Trailing filename noise a PDF upload's raw filename commonly carries
// (services/pdfKnowledgeIngestionService.js sets `title` to the filename
// verbatim, minus ".pdf") — stripped repeatedly so "Program_FINAL_v2"
// cleans to "Program", not "Program FINAL".
const TITLE_NOISE_SUFFIX = /[\s_-]*\b(v\d+(?:\.\d+)?|version\s?\d+|final|draft|copy|rev(?:ised)?|updated|\d{4}[-_]?\d{2}[-_]?\d{2})\b[\s_-]*$/i;

/**
 * Turns a raw stored title (often literally a PDF filename minus its
 * extension) into a human-readable display title: underscores/dashes to
 * spaces, repeated trailing filename noise stripped, and light title-casing
 * applied ONLY to words that are fully lowercase or fully uppercase — an
 * already mixed-case word (a brand name, an acronym) is left exactly as
 * written rather than risk mangling it. Never returns an empty string —
 * falls back to the original if cleanup would strip everything.
 */
function cleanProgramTitle(rawTitle) {
  const original = String(rawTitle || "").trim();
  if (!original) return "";
  let title = original.replace(/_+/g, " ");
  let previous;
  do { previous = title; title = title.replace(TITLE_NOISE_SUFFIX, "").trim(); } while (title !== previous && title);
  title = title.replace(/\s{2,}/g, " ").replace(/[\s-]+$/, "").trim();
  if (!title) return original;
  title = title.split(" ").map((word) => {
    if (/^[a-z0-9]+$/.test(word)) return word.charAt(0).toUpperCase() + word.slice(1);
    if (/^[A-Z0-9]{2,}$/.test(word) && word.length > 3) return word.charAt(0) + word.slice(1).toLowerCase();
    return word;
  }).join(" ");
  return title;
}

/**
 * EVERY approved Offers & Programs note — never capped — for a searchable
 * program selector. Clean, human-readable titles (see cleanProgramTitle)
 * are shown instead of a raw PDF filename; the original stored title is
 * still returned as `rawTitle` so nothing is hidden.
 */
async function listApprovedPrograms({ workspaceId }, dependencies = {}) {
  const NoteModel = dependencies.JarvisMemoryNote || JarvisMemoryNote;
  const notes = await NoteModel.find({ workspaceId, category: "offers-programs", status: "approved" }).select("title source").limit(MAX_APPROVED_PROGRAMS).lean();
  return notes
    .map((note) => ({ noteId: String(note._id), title: cleanProgramTitle(note.title), rawTitle: clean(note.title, 200), source: note.source || "" }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Up to 5 editable, one-click search-request variations for ONE selected
 * program — deterministic templating, no AI call, no cost. This is the
 * ONLY place the 5-suggestion cap applies; it never limits how many
 * approved programs are loaded or selectable.
 */
async function getSearchSuggestionsForProgram({ workspaceId, programNoteId }, dependencies = {}) {
  const NoteModel = dependencies.JarvisMemoryNote || JarvisMemoryNote;
  if (!programNoteId) { const error = new Error("A program must be selected first"); error.code = "DISCOVERY_PROGRAM_REQUIRED"; throw error; }
  const note = await NoteModel.findOne({ _id: programNoteId, workspaceId, category: "offers-programs", status: "approved" }).select("title").lean();
  if (!note) { const error = new Error("That program was not found among this workspace's approved Offers & Programs"); error.code = "DISCOVERY_SEARCH_PROGRAM_NOT_FOUND"; throw error; }
  const title = cleanProgramTitle(note.title);
  const templates = [
    `Find ${DEFAULT_REQUESTED_COUNT} likely buyers for "${title}".`,
    `Find people who recently showed interest in "${title}" but haven't enrolled yet.`,
    `Find decision-makers who match the ideal profile for "${title}".`,
    `Find people similar to past "${title}" students.`,
    `Find people actively discussing challenges "${title}" solves, from the last 90 days.`,
  ];
  return { noteId: String(note._id), title, suggestions: templates.slice(0, MAX_SUGGESTIONS_PER_PROGRAM).map((query) => ({ query })) };
}

// Skill levels, experience descriptors, and audience labels a loose LLM
// parse can mistake for a job title (e.g. "beginner" from a request like
// "find beginner yoga students") — these are never real, searchable job
// titles, and PDL/Apollo's title fields expect actual professional titles.
// Filtered out at the single sanitizeIcp() choke point used by both a
// freshly-parsed ICP and an owner-edited one, so a bad title never reaches
// either provider's query, and the cleaned list is also what the review
// panel displays back to the owner (never silently filtered only at query
// build time).
const NON_JOB_TITLE_PHRASES = new Set([
  "beginner", "beginners", "intermediate", "advanced", "expert", "experts",
  "novice", "newbie", "amateur", "aspiring", "entry level", "entry-level",
  "student", "students", "buyer", "buyers", "customer", "customers",
  "prospect", "prospects", "lead", "leads", "member", "members",
]);

function isRealisticJobTitle(title) {
  const normalized = String(title || "").trim().toLowerCase();
  if (!normalized || !/[a-z]/i.test(normalized)) return false;
  return !NON_JOB_TITLE_PHRASES.has(normalized);
}

/**
 * Shared sanitization for an ICP object, whether freshly parsed by the LLM
 * (proposeSearch) or edited by the owner in the review panel and sent as
 * an override just before running (approveAndRunSearch) — same limits,
 * same trimming, so an edited ICP is held to exactly the same rules as a
 * freshly-generated one.
 */
function sanitizeIcp(rawIcp = {}, reasoningNotes = "") {
  return {
    titles: (rawIcp.titles || []).slice(0, 20).map((v) => clean(v, 120)).filter(isRealisticJobTitle),
    industries: (rawIcp.industries || []).slice(0, 20).map((v) => clean(v, 120)),
    locations: (rawIcp.locations || []).slice(0, 20).map((v) => clean(v, 120)),
    keywords: (rawIcp.keywords || []).slice(0, 20).map((v) => clean(v, 120)),
    seniority: (rawIcp.seniority || []).slice(0, 10).map((v) => clean(v, 60)),
    companySizeRange: clean(rawIcp.companySizeRange, 80),
    exclusions: (rawIcp.exclusions || []).slice(0, 20).map((v) => clean(v, 120)),
    notes: clean(reasoningNotes || rawIcp.notes, 1000),
  };
}

/**
 * Parses a natural-language request (+ the approved program note, if any)
 * into an editable ICP and creates a DiscoverySearch with status
 * "proposed". Makes exactly one LLM call (via the existing agent system,
 * recorded on the normal AI usage ledger like any other Jarvis
 * interaction) and ZERO discovery-provider calls — nothing is spent
 * against Vertex/OpenAI/PDL/Apollo at this step.
 */
async function proposeSearch({ workspaceId, userId, auth, naturalLanguageRequest, programNoteId, sources, freshnessDays, requestedCount: requestedCountOverride, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.DiscoverySearch || DiscoverySearch;
  const NoteModel = dependencies.JarvisMemoryNote || JarvisMemoryNote;
  const runAgent = dependencies.runAgent || agentExecutionService.runAgent;

  if (!String(naturalLanguageRequest || "").trim()) { const error = new Error("A natural-language request is required"); error.code = "DISCOVERY_SEARCH_REQUEST_REQUIRED"; throw error; }

  let programNote = null;
  if (programNoteId) {
    programNote = await NoteModel.findOne({ _id: programNoteId, workspaceId, category: "offers-programs", status: "approved" }).select("title content").lean();
    if (!programNote) { const error = new Error("That program note was not found among this workspace's approved Offers & Programs"); error.code = "DISCOVERY_SEARCH_PROGRAM_NOT_FOUND"; throw error; }
  }

  // The provider checkboxes in Discovery are the sole source of truth for
  // which providers run — an explicit selection is used EXACTLY as given,
  // never expanded, filtered, or second-guessed against the natural-
  // language text (e.g. "do not use Apollo" only takes effect by
  // unchecking the Apollo box, not by parsing the sentence). Only when
  // nothing explicit was sent (a caller other than the Discovery UI, e.g.
  // Jarvis chat) does this fall back to every currently AVAILABLE
  // provider — never literally "all" regardless of configuration, which is
  // what previously let the plan claim Apollo credits while Apollo was
  // disabled.
  const availability = checkProviderAvailability();
  const explicitSources = (Array.isArray(sources) ? sources : []).filter((source) => ALL_SOURCE_KEYS.includes(source));
  const effectiveSources = explicitSources.length ? explicitSources : ALL_SOURCE_KEYS.filter((source) => availability[source]?.available);
  if (!effectiveSources.length) { const error = new Error("No sourcing provider is selected and available. Select at least one enabled provider."); error.code = "DISCOVERY_NO_SOURCES_AVAILABLE"; throw error; }

  const result = await runAgent({
    workspaceId, userId, auth, agent: "lead", task: "parse_lead_search_request", correlationId,
    operationalContext: `${programNote ? `Approved program details:\nTitle: ${cleanProgramTitle(programNote.title)}\n${clean(programNote.content, 4000)}\n\n` : ""}Owner's request: ${clean(naturalLanguageRequest, 2000)}\n\nExtract a structured ideal-customer-profile (ICP) search plan for finding real prospective students/buyers matching this program. Base the ICP strictly on the program details and the request — never invent criteria not implied by either.`,
    input: { hasProgramNote: Boolean(programNote) },
    options: { responseSchema: ICP_RESPONSE_SCHEMA, schemaName: "lead_search_icp" },
  });

  const parsed = result.output;
  // An explicit count (the Discovery UI's 5/10/25 pills) always wins over
  // the LLM's own guess from the free-text request — the pill is a
  // deliberate owner choice, not a hint to second-guess.
  const requestedCount = Math.max(1, Math.min(MAX_REQUESTED_COUNT, Number(requestedCountOverride) || Number(parsed.requestedCount) || DEFAULT_REQUESTED_COUNT));
  const safeFreshnessDays = Math.max(1, Math.min(365, Number(freshnessDays) || 90));

  const includesPdl = effectiveSources.includes("pdl_person_search");
  const includesApollo = effectiveSources.includes("apollo_person_search");
  const includesVertex = effectiveSources.includes("vertex");
  const includesOpenai = effectiveSources.includes("openai_web_search");
  // A source can be selected but not actually available (e.g. a stale
  // caller that didn't check first) — never estimate or claim credit use
  // for one that won't really run; surface the mismatch plainly instead.
  const unavailableSelected = effectiveSources.filter((source) => !availability[source]?.available);

  const search = await Model.create({
    workspaceId,
    requestedByUserId: userId,
    naturalLanguageRequest: clean(naturalLanguageRequest, 2000),
    programNoteId: programNote ? programNoteId : null,
    programName: clean(parsed.programName || cleanProgramTitle(programNote?.title) || "", 200),
    icp: sanitizeIcp(parsed.icp, parsed.reasoning),
    sources: effectiveSources,
    freshnessDays: safeFreshnessDays,
    requestedCount,
    estimatedCreditUse: {
      pdl: includesPdl && availability.pdl_person_search.available ? requestedCount : 0,
      apollo: includesApollo && availability.apollo_person_search.available ? requestedCount : 0,
      vertex: includesVertex && availability.vertex.available ? "1 grounded search call (~a few cents)" : "",
      openai: includesOpenai && availability.openai_web_search.available ? "1 web_search call (~a few cents)" : "",
      note: "PDL/Apollo figures are a conservative upper bound (at most 1 credit-equivalent per requested candidate) for the Person Search step alone — actual charges depend on your plan, and a further, separate charge applies only if you explicitly run PDL/Apollo enrichment afterward."
        + (unavailableSelected.length ? ` Selected but not currently enabled, so nothing will be spent on it: ${unavailableSelected.join(", ")} — running this plan will report that as a source error rather than silently skip it.` : ""),
    },
    status: "proposed",
    correlationId: clean(correlationId, 255),
  });

  return search;
}

function buildPdlSql(icp) {
  const clauses = [];
  if (icp.titles?.length) clauses.push(`job_title_role IN (${icp.titles.map((t) => `'${String(t).replace(/'/g, "")}'`).join(", ")}) OR job_title IN (${icp.titles.map((t) => `'${String(t).replace(/'/g, "")}'`).join(", ")})`);
  if (icp.locations?.length) clauses.push(`location_name IN (${icp.locations.map((l) => `'${String(l).replace(/'/g, "")}'`).join(", ")})`);
  if (icp.industries?.length) clauses.push(`job_company_industry IN (${icp.industries.map((i) => `'${String(i).replace(/'/g, "")}'`).join(", ")})`);
  if (!clauses.length) return null;
  return `SELECT * FROM person WHERE ${clauses.map((c) => `(${c})`).join(" AND ")}`;
}

function buildApolloFilters(icp) {
  const filters = {};
  if (icp.titles?.length) filters.person_titles = icp.titles;
  if (icp.locations?.length) filters.person_locations = icp.locations;
  if (icp.seniority?.length) filters.person_seniorities = icp.seniority;
  if (icp.keywords?.length) filters.q_keywords = icp.keywords.join(" ");
  return filters;
}

function normalizePdlCandidate(person) {
  return {
    type: "person",
    name: clean(person.fullName, 200),
    organizationName: clean(person.company, 200),
    organizationDomain: clean((person.companyDomain || "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""), 200),
    linkedinUrl: isHttpUrl(person.linkedinUrl) ? person.linkedinUrl : "",
    email: person.email || "",
    emailState: person.emailState || "",
    summary: [person.title, person.location].filter(Boolean).join(" · "),
    provider: "pdl_person_search",
    pdlLikelihood: person.likelihood ?? null,
  };
}

function normalizeApolloCandidate(person) {
  return {
    type: "person",
    name: clean(person.fullName, 200),
    organizationName: clean(person.company, 200),
    organizationDomain: clean((person.companyDomain || "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""), 200),
    linkedinUrl: isHttpUrl(person.linkedinUrl) ? person.linkedinUrl : "",
    email: person.email || "",
    emailState: person.emailState || "",
    summary: [person.title, person.location].filter(Boolean).join(" · "),
    provider: "apollo_person_search",
  };
}

function identityKey(candidate) {
  if (candidate.email) return `email:${candidate.email.toLowerCase()}`;
  if (candidate.linkedinUrl) return `linkedin:${candidate.linkedinUrl.toLowerCase().replace(/\/$/, "")}`;
  return `namecompany:${String(candidate.name || "").trim().toLowerCase()}:${String(candidate.organizationName || candidate.location || "").trim().toLowerCase()}`;
}

/**
 * Merges one ICP-match candidate (PDL/Apollo) into the review queue,
 * checking against existing pending_review rows FIRST — including ones
 * this same approved search's vertex/openai step may have just created —
 * by verified email, then LinkedIn/profile URL, then name+company. A
 * field-level disagreement (different company/title/etc. reported by the
 * new provider vs the existing row) is recorded in `conflicts` and keeps
 * the row in pending_review rather than silently picking one value.
 */
async function mergeIcpMatchCandidate({ workspaceId, userId, searchId, correlationId, candidate }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const key = identityKey(candidate);
  const orClauses = [];
  if (candidate.email) orClauses.push({ email: candidate.email.toLowerCase() }, { "pdlEnrichment.email": candidate.email.toLowerCase() }, { "apolloEnrichment.email": candidate.email.toLowerCase() });
  if (candidate.linkedinUrl) orClauses.push({ linkedinUrl: candidate.linkedinUrl });
  orClauses.push({ type: "person", name: new RegExp(`^${candidate.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), organizationName: candidate.organizationName || "" });

  const existing = await Model.findOne({ workspaceId, status: "pending_review", type: "person", $or: orClauses });

  if (!existing) {
    const created = await Model.create({
      workspaceId, query: `icp_match:${key}`, type: "person",
      name: candidate.name, organizationName: candidate.organizationName, organizationDomain: candidate.organizationDomain,
      email: candidate.email, emailState: candidate.emailState,
      emailVerificationStatus: candidate.emailState || "",
      linkedinUrl: candidate.linkedinUrl, summary: candidate.summary,
      evidenceUrls: [], evidenceDate: null, confidence: "single_source",
      discoveryMode: "icp_match", providers: [candidate.provider], discoverySearchId: searchId,
      identityConfidence: candidate.emailState === "verified" ? "medium" : "low",
      status: "pending_review", createdByUserId: userId, correlationId,
    });
    return { created: true, row: created };
  }

  const conflicts = [...(existing.conflicts || [])];
  if (candidate.organizationName && existing.organizationName && candidate.organizationName.toLowerCase() !== existing.organizationName.toLowerCase()) {
    conflicts.push(`Company mismatch: "${existing.organizationName}" vs "${candidate.organizationName}" from ${candidate.provider}.`);
  }
  if (candidate.email && existing.email && candidate.email.toLowerCase() !== existing.email.toLowerCase()) {
    conflicts.push(`Email mismatch: "${existing.email}" vs "${candidate.email}" from ${candidate.provider}.`);
  }

  const providers = [...new Set([...(existing.providers || []), candidate.provider])];
  const bothVerified = candidate.emailState === "verified" || existing.email === candidate.email;
  existing.providers = providers;
  existing.email = existing.email || candidate.email;
  existing.emailState = existing.emailState || candidate.emailState;
  existing.emailVerificationStatus = existing.emailVerificationStatus || candidate.emailState || "";
  existing.linkedinUrl = existing.linkedinUrl || candidate.linkedinUrl;
  existing.organizationName = existing.organizationName || candidate.organizationName;
  existing.organizationDomain = existing.organizationDomain || candidate.organizationDomain;
  existing.conflicts = conflicts;
  // Confidence rises only on real agreement between independent providers —
  // never just because a second provider ALSO happened to mention this
  // person while disagreeing on a field.
  if (providers.length >= 2 && !conflicts.length) {
    existing.confidence = "corroborated";
    existing.identityConfidence = bothVerified ? "high" : "medium";
  }
  await existing.save();
  return { created: false, row: existing };
}

/**
 * Runs an approved DiscoverySearch: calls the existing, unchanged Vertex/
 * OpenAI pipeline for those sources, and the new PDL/Apollo Person Search
 * path for those, merging every candidate into the shared review queue.
 * A single source's failure is recorded in runSummary.sourceErrors rather
 * than failing the whole run, unless every selected source fails.
 */
async function approveAndRunSearch({ workspaceId, userId, auth, searchId, icp, requestedCount, sources, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.DiscoverySearch || DiscoverySearch;
  const vertexDiscovery = dependencies.vertexGroundingDiscoveryService || vertexGroundingDiscoveryService;
  const pdl = dependencies.peopleDataLabsService || peopleDataLabsService;
  const apollo = dependencies.apolloService || apolloService;

  const search = await Model.findOne({ _id: searchId, workspaceId });
  if (!search) { const error = new Error("Discovery search not found"); error.code = "DISCOVERY_SEARCH_NOT_FOUND"; throw error; }
  if (search.status !== "proposed") { const error = new Error("This search has already been approved or run"); error.code = "DISCOVERY_SEARCH_ALREADY_RUN"; throw error; }

  // Everything below is OPTIONAL — the owner may approve the plan exactly
  // as proposed. When present, these are the review panel's live edits
  // (ICP/exclusions, the 5/10/25 count pill, the provider pills) applied
  // right before running, sanitized identically to a freshly-parsed plan.
  if (icp && typeof icp === "object") search.icp = sanitizeIcp(icp, icp.notes || search.icp?.notes);
  if (requestedCount != null) search.requestedCount = Math.max(1, Math.min(MAX_REQUESTED_COUNT, Number(requestedCount) || search.requestedCount));
  if (Array.isArray(sources) && sources.length) search.sources = sources.filter((source) => ALL_SOURCE_KEYS.includes(source));

  search.status = "running";
  search.approvedByUserId = userId;
  search.approvedAt = new Date();
  await search.save();

  const effectiveSources = search.sources.includes("all")
    ? ["vertex", "openai_web_search", "pdl_person_search", "apollo_person_search"]
    : search.sources;
  const sourceErrors = [];
  const providerBreakdown = [];
  let created = 0, merged = 0, withConflicts = 0, excludedForFreshness = 0, excludedForSelfMatch = 0;
  // Same server-side self-match exclusion vertexGroundingDiscoveryService.js
  // applies for Vertex/OpenAI — fetched once here and applied to every
  // PDL/Apollo candidate before it's ever merged into the review queue.
  const selfSignals = await (dependencies.getWorkspaceSelfSignals || workspaceSelfExclusionService.getWorkspaceSelfSignals)({ workspaceId }, dependencies);
  const isSelfMatchCheck = dependencies.isSelfMatch || workspaceSelfExclusionService.isSelfMatch;

  const includesVertex = effectiveSources.includes("vertex");
  const includesOpenai = effectiveSources.includes("openai_web_search");
  if (includesVertex || includesOpenai) {
    try {
      const groundingQuery = `${search.icp.titles.join(", ") || "prospective students"} interested in ${search.programName || "this program"}${search.icp.locations.length ? ` in ${search.icp.locations.join(", ")}` : ""}`.trim();
      const groundingSource = includesVertex && includesOpenai ? "both" : includesVertex ? "vertex" : "openai_web_search";
      const outcome = await vertexDiscovery.search({ workspaceId, userId, auth, query: groundingQuery, resultTypes: ["person"], source: groundingSource, maxPeople: search.requestedCount, correlationId }, dependencies);
      created += outcome.created;
      merged += outcome.merged;
      excludedForFreshness += outcome.excludedForFreshness || 0;
      excludedForSelfMatch += outcome.excludedForSelfMatch || 0;
      if (outcome.sourceErrors?.length) sourceErrors.push(...outcome.sourceErrors);
      if (outcome.providerStats?.length) providerBreakdown.push(...outcome.providerStats);
    } catch (error) {
      const failedProviders = includesVertex && includesOpenai ? ["vertex_grounding", "openai_web_search"] : [includesVertex ? "vertex_grounding" : "openai_web_search"];
      sourceErrors.push({ source: includesVertex && includesOpenai ? "vertex+openai_web_search" : groundingSourceLabel(includesVertex), code: error.code || "GROUNDING_SEARCH_FAILED", message: error.message });
      for (const provider of failedProviders) providerBreakdown.push({ provider, requested: search.requestedCount, returned: 0, rejectedSelf: 0, rejectedFreshness: 0, rejectedForCapacity: 0, rejectedDedup: 0, accepted: 0, error: error.message });
    }
  }

  if (effectiveSources.includes("pdl_person_search")) {
    const stats = { provider: "pdl_person_search", requested: search.requestedCount, returned: 0, rejectedSelf: 0, rejectedFreshness: 0, rejectedForCapacity: 0, rejectedDedup: 0, accepted: 0, error: null };
    try {
      const sql = buildPdlSql(search.icp);
      if (!sql) throw Object.assign(new Error("The ICP has no criteria PDL can search on (titles, locations, or industries required)"), { code: "PDL_ICP_EMPTY" });
      const outcome = await pdl.searchPeople({ workspaceId, userId, sql, size: search.requestedCount, correlationId });
      stats.returned = outcome.people.length;
      for (const person of outcome.people) {
        const candidate = normalizePdlCandidate(person);
        if (isSelfMatchCheck(candidate, selfSignals).isSelf) { excludedForSelfMatch += 1; stats.rejectedSelf += 1; continue; }
        // eslint-disable-next-line no-await-in-loop
        const result = await mergeIcpMatchCandidate({ workspaceId, userId, searchId: search._id, correlationId, candidate }, dependencies);
        if (result.created) { created += 1; stats.accepted += 1; } else { merged += 1; stats.rejectedDedup += 1; }
        if (result.row.conflicts?.length) withConflicts += 1;
      }
    } catch (error) {
      sourceErrors.push({ source: "pdl_person_search", code: error.code || "PDL_SEARCH_FAILED", message: error.message });
      stats.error = error.message;
    }
    providerBreakdown.push(stats);
  }

  if (effectiveSources.includes("apollo_person_search")) {
    const stats = { provider: "apollo_person_search", requested: search.requestedCount, returned: 0, rejectedSelf: 0, rejectedFreshness: 0, rejectedForCapacity: 0, rejectedDedup: 0, accepted: 0, error: null };
    try {
      const filters = buildApolloFilters(search.icp);
      if (!Object.keys(filters).length) throw Object.assign(new Error("The ICP has no criteria Apollo can search on (titles, locations, seniority, or keywords required)"), { code: "APOLLO_ICP_EMPTY" });
      const outcome = await apollo.searchPeople({ workspaceId, userId, filters, perPage: search.requestedCount, correlationId });
      stats.returned = outcome.people.length;
      for (const person of outcome.people) {
        const candidate = normalizeApolloCandidate(person);
        if (isSelfMatchCheck(candidate, selfSignals).isSelf) { excludedForSelfMatch += 1; stats.rejectedSelf += 1; continue; }
        // eslint-disable-next-line no-await-in-loop
        const result = await mergeIcpMatchCandidate({ workspaceId, userId, searchId: search._id, correlationId, candidate }, dependencies);
        if (result.created) { created += 1; stats.accepted += 1; } else { merged += 1; stats.rejectedDedup += 1; }
        if (result.row.conflicts?.length) withConflicts += 1;
      }
    } catch (error) {
      sourceErrors.push({ source: "apollo_person_search", code: error.code || "APOLLO_SEARCH_FAILED", message: error.message });
      stats.error = error.message;
    }
    providerBreakdown.push(stats);
  }

  const allFailed = sourceErrors.length >= effectiveSources.length && created === 0 && merged === 0;
  search.status = allFailed ? "failed" : "completed";
  search.runSummary = {
    created, merged, withConflicts, excludedForFreshness, excludedForSelfMatch, sourceErrors,
    providerBreakdown,
    explanation: buildRunExplanation({ requestedCount: search.requestedCount, created, merged, excludedForSelfMatch, excludedForFreshness, sourceErrors }),
  };
  await search.save();

  await auditService.record({ workspaceId, actorUserId: userId, action: "provider.request", targetType: "DiscoverySearch", targetId: search._id, after: { status: search.status, created, merged }, provider: "lead_generation_coordinator", success: !allFailed });
  return search;
}

function groundingSourceLabel(includesVertex) { return includesVertex ? "vertex" : "openai_web_search"; }

/**
 * Plain-language explanation of why this run's genuinely NEW candidate
 * count (created — never counting a merge into an already-existing
 * pending_review row as "new") did or didn't reach what the owner
 * requested — so the UI never implies "5 found" when only 1 actually
 * survived filtering. `created` alone (not created+merged) is used as the
 * "survived" count on purpose: a merge means the candidate was already in
 * the queue, not a new find from this run.
 */
function buildRunExplanation({ requestedCount, created, merged, excludedForSelfMatch, excludedForFreshness, sourceErrors }) {
  if (created >= requestedCount) {
    return `Requested ${requestedCount}; ${created} new candidate${created === 1 ? "" : "s"} added to the review queue${merged ? ` (plus ${merged} more that matched and updated existing queue entries).` : "."}`;
  }
  const reasons = [];
  if (excludedForSelfMatch) reasons.push(`${excludedForSelfMatch} excluded as a self-match (you, your team, or your own business)`);
  if (excludedForFreshness) reasons.push(`${excludedForFreshness} excluded for being outside the freshness window`);
  if (merged) reasons.push(`${merged} matched candidates already in your review queue (updated rather than added as new)`);
  const erroredSources = [...new Set(sourceErrors.map((e) => e.source).filter(Boolean))];
  if (erroredSources.length) reasons.push(`${erroredSources.join(", ")} failed and returned nothing (see the error for each below)`);
  const reasonText = reasons.length ? ` ${reasons.join("; ")}.` : " See the per-provider breakdown below for why.";
  return `Requested ${requestedCount}, but only ${created} new candidate${created === 1 ? "" : "s"} survived filtering and were added to the review queue.${reasonText}`;
}

/**
 * Explicit, per-row Apollo enrichment for a still-pending PERSON result —
 * mirrors enrichWithPdl() in vertexGroundingDiscoveryService.js exactly,
 * as Apollo's own separate, second-stage cross-check. Never automatic,
 * never a discovery source in this role.
 */
async function enrichWithApollo({ workspaceId, userId, resultId, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const apollo = dependencies.apolloService || apolloService;
  const row = await Model.findOne({ _id: resultId, workspaceId });
  if (!row) { const error = new Error("Grounding result not found"); error.code = "GROUNDING_RESULT_NOT_FOUND"; throw error; }
  if (row.type !== "person") { const error = new Error("Apollo enrichment only applies to person results"); error.code = "GROUNDING_RESULT_NOT_A_PERSON"; throw error; }
  if (row.status !== "pending_review") { const error = new Error("This result has already been reviewed"); error.code = "GROUNDING_RESULT_ALREADY_REVIEWED"; throw error; }
  if (row.apolloEnrichment?.attempted) { const error = new Error("Apollo enrichment has already been attempted for this result"); error.code = "GROUNDING_RESULT_ALREADY_ENRICHED"; throw error; }

  try {
    const [firstName, ...rest] = String(row.name).trim().split(/\s+/);
    const person = await apollo.enrichPerson({ workspaceId, userId, matchInput: { first_name: firstName, last_name: rest.join(" "), organization_name: row.organizationName, domain: row.organizationDomain }, correlationId });
    row.apolloEnrichment = { attempted: true, matched: Boolean(person), email: person?.email || "", emailState: person?.emailState || "", enrichedAt: new Date(), error: false, errorMessage: "" };
    if (person && !row.providers.includes("apollo")) row.providers.push("apollo");
    await row.save();
    await auditService.record({ workspaceId, actorUserId: userId, action: "provider.request", targetType: "GroundingResearchResult", targetId: row._id, after: { apolloMatched: Boolean(person) }, provider: "apollo", success: true });
    return row;
  } catch (error) {
    row.apolloEnrichment = { attempted: true, matched: false, email: "", emailState: "", enrichedAt: new Date(), error: true, errorMessage: clean(error.message || "Apollo enrichment failed", 300) };
    await row.save();
    await auditService.record({ workspaceId, actorUserId: userId, action: "provider.request", targetType: "GroundingResearchResult", targetId: row._id, after: { apolloMatched: false, apolloErrorCode: error.code || "APOLLO_ENRICHMENT_FAILED" }, provider: "apollo", success: false });
    return row;
  }
}

/**
 * Jarvis qualifies intent, recommends the best program, explains its
 * reasoning, suggests the next action, and drafts personalized outreach
 * for up to 20 selected still-pending results — extends the existing
 * rankForProgramFit() pattern (kept unchanged) with a richer output
 * contract rather than modifying it.
 */
async function qualifyAndRecommend({ workspaceId, userId, auth, resultIds, correlationId = "" }, dependencies = {}) {
  const Model = dependencies.GroundingResearchResult || GroundingResearchResult;
  const runAgent = dependencies.runAgent || agentExecutionService.runAgent;
  const ids = (Array.isArray(resultIds) ? resultIds : []).slice(0, 20);
  if (!ids.length) { const error = new Error("Select at least one pending result to qualify"); error.code = "DISCOVERY_QUALIFY_SELECTION_REQUIRED"; throw error; }
  const rows = await Model.find({ _id: { $in: ids }, workspaceId, status: "pending_review" }).lean();
  if (!rows.length) return { qualified: 0 };

  const candidates = rows.map((row) => ({ resultId: String(row._id), name: row.name, organizationName: row.organizationName, summary: row.summary, evidenceUrls: row.evidenceUrls, conflicts: row.conflicts || [] }));
  const result = await runAgent({
    workspaceId, userId, auth, agent: "lead", task: "qualify_and_recommend_leads", correlationId,
    operationalContext: `Using the approved program/ICP knowledge already provided to you, qualify each candidate's real buyer intent, recommend the single best-fit program, explain your reasoning, suggest one concrete next action, and draft a short personalized outreach message strictly grounded in the evidence given. Never invent facts. A candidate with a listed conflict should be treated cautiously, not scored generously.\n\nCandidates:\n${JSON.stringify(candidates, null, 2)}`,
    input: { candidateCount: candidates.length },
    options: { responseSchema: QUALIFY_RESPONSE_SCHEMA, schemaName: "lead_qualification" },
  });

  const validIds = new Set(candidates.map((row) => row.resultId));
  let qualified = 0;
  for (const q of (result.output.qualifications || [])) {
    if (!validIds.has(q.resultId)) continue;
    const fitScore = Math.max(0, Math.min(100, Number(q.fitScore) || 0));
    // eslint-disable-next-line no-await-in-loop
    await Model.updateOne(
      { _id: q.resultId, workspaceId },
      { $set: {
        fitScore, fitReasons: [clean(q.recommendedProgramReason, 500), clean(q.nextAction, 300)].filter(Boolean),
        fitEvaluatedAt: new Date(),
        recommendedProgram: { name: clean(q.recommendedProgramName, 200), reason: clean(q.recommendedProgramReason, 1000) },
      }, $addToSet: { providers: "openai_jarvis" } },
    );
    // Outreach draft/intent flag are exposed via a separate note-style field on
    // the row rather than overloading `summary` — kept here on the response
    // only to avoid growing the schema further for a draft that a human must
    // still explicitly choose to use (owner-approved outreach stays separate).
    qualified += 1;
  }
  return { qualified, requested: ids.length, drafts: (result.output.qualifications || []).filter((q) => validIds.has(q.resultId)).map((q) => ({ resultId: q.resultId, intentQualified: q.intentQualified, nextAction: q.nextAction, outreachDraft: q.outreachDraft })) };
}

/**
 * Creates an editable, always-disabled monitor suggestion from a completed
 * search. See models/LeadMonitorSuggestion.js's header for why this is a
 * distinct model rather than a live ResearchMonitor.
 */
async function proposeMonitorSuggestion({ workspaceId, userId, searchId }, dependencies = {}) {
  const SearchModel = dependencies.DiscoverySearch || DiscoverySearch;
  const SuggestionModel = dependencies.LeadMonitorSuggestion || LeadMonitorSuggestion;
  const search = await SearchModel.findOne({ _id: searchId, workspaceId });
  if (!search) { const error = new Error("Discovery search not found"); error.code = "DISCOVERY_SEARCH_NOT_FOUND"; throw error; }
  if (search.status !== "completed") { const error = new Error("Only a completed search can be turned into a monitor suggestion"); error.code = "DISCOVERY_SEARCH_NOT_COMPLETED"; throw error; }

  const suggestion = await SuggestionModel.create({
    workspaceId,
    discoverySearchId: search._id,
    name: `${search.programName || "Program"} — recurring lead search`,
    query: search.naturalLanguageRequest,
    programNoteId: search.programNoteId,
    icp: search.icp,
    sources: search.sources,
    scheduleDescription: "weekly",
    intervalMinutes: 10080,
    capPerRun: search.requestedCount,
    estimatedCreditUsePerRun: search.estimatedCreditUse,
    destination: "review_queue",
    enabled: false,
    createdByUserId: userId,
  });
  search.monitorSuggestionId = suggestion._id;
  await search.save();
  return suggestion;
}

module.exports = {
  listApprovedPrograms,
  getSearchSuggestionsForProgram,
  checkProviderAvailability,
  proposeSearch,
  approveAndRunSearch,
  enrichWithApollo,
  qualifyAndRecommend,
  proposeMonitorSuggestion,
  ICP_SOURCES,
  // Exported for direct unit testing — pure, no side effects.
  sanitizeIcp,
  isRealisticJobTitle,
  buildPdlSql,
  buildApolloFilters,
  buildRunExplanation,
};
