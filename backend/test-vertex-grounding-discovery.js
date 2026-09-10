// Targeted regression coverage for connecting Vertex AI Grounding AND
// OpenAI's Responses API web_search tool to Discovery as two independent,
// optional public-web research sources: results land in a review queue with
// citations and are never auto-created as leads; deduplication merges
// repeat finds instead of duplicating, both WITHIN a source and ACROSS the
// two sources (a person both sources find merges into one row carrying both
// providers and corroborated confidence, and an already-corroborated
// single-source result is never wrongly downgraded by the cross-source
// merge); the initial request is capped at 5 people regardless of how many
// sources contribute; selecting a single source surfaces that source's real
// error directly with no silent fallback, while "both" reports a partial
// source failure plainly instead of hiding it; saving a reviewed result
// creates the correct CRM entity (person -> Contact, organization ->
// Organization, deduplicated by domain) with source attribution, while
// community/event honestly stay in the review queue (no invented CRM entity
// type); PDL enrichment and OpenAI/Jarvis ranking only ever ACT ON an
// already-evidenced row (never originate one), record real provenance, and
// never auto-run. Also asserts, as a live regression guard, that
// services/llmService.js still calls only the Chat Completions API —
// confirming the documented claim that this app's OpenAI/Jarvis CHAT
// integration does not use the Responses API (the separate
// services/openaiWebSearchService.js module does, deliberately, for web
// search only). vertexGroundingService/openaiWebSearchService/
// peopleDataLabsService/runAgent are all mocked — no real
// network/Google/OpenAI/PDL call is made.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const vertexGroundingDiscoveryService = require("./services/vertexGroundingDiscoveryService");
const GroundingResearchResult = require("./models/GroundingResearchResult");
const Organization = require("./models/Organization");
const Contact = require("./models/Contact");
async function testSearchStagesResultsWithoutCreatingAnyLead() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const vertexGroundingService = {
    groundedSearch: async () => ({
      results: [
        { type: "person", name: "Jane Owner", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "A local association organizer.", evidenceUrls: ["https://metroreia.org/about"], confidence: "single_source" },
        { type: "organization", name: "Metro REIA", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "A real estate investors association.", evidenceUrls: ["https://metroreia.org"], confidence: "single_source" },
      ],
      groundingCitations: [{ url: "https://metroreia.org/events", title: "Metro REIA Events" }],
    }),
  };
  const result = await vertexGroundingDiscoveryService.search({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, query: "real estate investor associations", resultTypes: ["person", "organization"] }, { vertexGroundingService });
  assert.equal(result.created, 2);
  assert.equal(result.merged, 0);

  const rows = await GroundingResearchResult.find({ workspaceId }).lean();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === "pending_review"), "every result must start pending_review, never an auto-created lead");
  assert.ok(rows.every((row) => row.evidenceUrls.length > 0), "every staged result must carry its citation");

  const contactCount = await Contact.countDocuments({ workspaceId });
  const orgCount = await Organization.countDocuments({ workspaceId });
  assert.equal(contactCount, 0, "search() alone must never create a Contact");
  assert.equal(orgCount, 0, "search() alone must never create an Organization");

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testRepeatSearchMergesInsteadOfDuplicating() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const firstFind = { type: "person", name: "Jane Owner", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "Organizer.", evidenceUrls: ["https://metroreia.org/about"], confidence: "single_source" };
  const secondFind = { ...firstFind, evidenceUrls: ["https://news.example.com/jane-owner-profile"], confidence: "corroborated" };

  await vertexGroundingDiscoveryService.search({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, query: "q1", resultTypes: ["person"] }, { vertexGroundingService: { groundedSearch: async () => ({ results: [firstFind], groundingCitations: [] }) } });
  const secondRun = await vertexGroundingDiscoveryService.search({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, query: "q2", resultTypes: ["person"] }, { vertexGroundingService: { groundedSearch: async () => ({ results: [secondFind], groundingCitations: [] }) } });

  assert.equal(secondRun.created, 0);
  assert.equal(secondRun.merged, 1, "finding the same person again must merge into the existing pending row, not create a duplicate");

  const rows = await GroundingResearchResult.find({ workspaceId }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].evidenceUrls.length, 2, "evidence from both finds must be combined");
  assert.equal(rows[0].confidence, "corroborated", "a later corroborated find must upgrade confidence on the merged row");

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testSavingAPersonCreatesAnAttributedContact() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const row = await GroundingResearchResult.create({ workspaceId, query: "q", type: "person", name: "Jane Owner", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "Organizer.", evidenceUrls: ["https://metroreia.org/about"], confidence: "single_source", status: "pending_review" });

  const saved = await vertexGroundingDiscoveryService.saveResult({ workspaceId, userId, resultId: row._id });
  assert.equal(saved.status, "saved");
  assert.ok(saved.savedContactId, "saving a person must produce a real Contact");

  const contact = await Contact.findById(saved.savedContactId).lean();
  assert.ok(contact, "the referenced Contact must actually exist");
  assert.ok(contact.sources.includes("vertex_grounding"), "the Contact must carry real source attribution back to Vertex Grounding");

  // A second save attempt on the same, now-reviewed row must be refused.
  await assert.rejects(() => vertexGroundingDiscoveryService.saveResult({ workspaceId, userId, resultId: row._id }), (error) => error.code === "GROUNDING_RESULT_ALREADY_REVIEWED");

  await GroundingResearchResult.deleteMany({ workspaceId });
  await Contact.deleteMany({ workspaceId });
}

async function testSavingAnOrganizationDedupesByDomain() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  await Organization.create({ workspaceId, name: "Metro REIA (existing)", domain: "metroreia.org", source: "manual" });

  const row = await GroundingResearchResult.create({ workspaceId, query: "q", type: "organization", name: "Metro REIA", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "A REIA.", evidenceUrls: ["https://metroreia.org"], confidence: "single_source", status: "pending_review" });
  const saved = await vertexGroundingDiscoveryService.saveResult({ workspaceId, userId, resultId: row._id });

  const orgCount = await Organization.countDocuments({ workspaceId, domain: "metroreia.org" });
  assert.equal(orgCount, 1, "saving an organization that already exists by domain must update it, never duplicate it");
  const organization = await Organization.findById(saved.savedOrganizationId).lean();
  assert.equal(organization.source, "vertex_grounding");

  await GroundingResearchResult.deleteMany({ workspaceId });
  await Organization.deleteMany({ workspaceId });
}

async function testSavingCommunityOrEventNeverInventsACrmEntity() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const row = await GroundingResearchResult.create({ workspaceId, query: "q", type: "community", name: "Austin Multifamily Meetup", summary: "A recurring public meetup.", evidenceUrls: ["https://meetup.example.com/austin-multifamily"], confidence: "single_source", status: "pending_review" });
  const saved = await vertexGroundingDiscoveryService.saveResult({ workspaceId, userId, resultId: row._id });

  assert.equal(saved.status, "saved");
  assert.equal(saved.savedContactId, null);
  assert.equal(saved.savedOrganizationId, null);
  assert.equal((await Contact.countDocuments({ workspaceId })), 0);
  assert.equal((await Organization.countDocuments({ workspaceId })), 0);
  // The evidence itself IS the saved record for a type with no CRM equivalent.
  const reloaded = await GroundingResearchResult.findById(row._id).lean();
  assert.deepEqual(reloaded.evidenceUrls, ["https://meetup.example.com/austin-multifamily"]);

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testDismissNeverCreatesAnything() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const row = await GroundingResearchResult.create({ workspaceId, query: "q", type: "person", name: "No Thanks", evidenceUrls: ["https://example.com"], status: "pending_review" });
  const dismissed = await vertexGroundingDiscoveryService.dismissResult({ workspaceId, userId, resultId: row._id });
  assert.equal(dismissed.status, "dismissed");
  assert.equal((await Contact.countDocuments({ workspaceId })), 0);

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testBothSourcesMergeAndPreserveEachProvidersProvenance() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const vertexGroundingService = { groundedSearch: async () => ({
    results: [{ type: "person", name: "Jane Owner", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "Organizer.", evidenceUrls: ["https://metroreia.org/about"], confidence: "single_source" }],
    groundingCitations: [{ url: "https://metroreia.org/about", title: "About" }],
  }) };
  const openaiWebSearchService = { groundedSearch: async () => ({
    results: [
      { type: "person", name: "Jane Owner", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "Also found via OpenAI.", evidenceUrls: ["https://news.example.com/jane-owner"], confidence: "single_source" },
      { type: "person", name: "Sam Second", organizationName: "", organizationDomain: "", summary: "Only OpenAI found this one.", evidenceUrls: ["https://example.com/sam-second"], confidence: "single_source" },
    ],
    groundingCitations: [],
  }) };

  const result = await vertexGroundingDiscoveryService.search({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, query: "q", resultTypes: ["person"], source: "both" }, { vertexGroundingService, openaiWebSearchService });
  assert.equal(result.source, "both");
  assert.equal(result.created, 2, "the same person found by both sources must merge into ONE row, not two");

  const jane = await GroundingResearchResult.findOne({ workspaceId, name: "Jane Owner" }).lean();
  assert.deepEqual([...jane.providers].sort(), ["openai_web_search", "vertex_grounding"], "a row found by both sources must carry both providers");
  assert.equal(jane.evidenceUrls.length, 2, "evidence from both sources must be combined on the merged row");
  assert.equal(jane.confidence, "corroborated", "two independent providers finding the same person is real corroboration");

  const sam = await GroundingResearchResult.findOne({ workspaceId, name: "Sam Second" }).lean();
  assert.deepEqual(sam.providers, ["openai_web_search"], "a row only OpenAI found must not falsely claim Vertex provenance");

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testSearchCapsInitialPeopleAtFiveRegardlessOfSourceCount() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const makePerson = (n) => ({ type: "person", name: `Person ${n}`, organizationName: "", organizationDomain: "", summary: "", evidenceUrls: [`https://example.com/person-${n}`], confidence: "single_source" });
  const vertexGroundingService = { groundedSearch: async () => ({ results: [1, 2, 3].map(makePerson), groundingCitations: [] }) };
  const openaiWebSearchService = { groundedSearch: async () => ({ results: [4, 5, 6, 7].map(makePerson), groundingCitations: [] }) };

  const result = await vertexGroundingDiscoveryService.search({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, query: "q", resultTypes: ["person"], source: "both" }, { vertexGroundingService, openaiWebSearchService });
  assert.equal(result.created, 5, "search() must cap the number of NEW people staged at 5, no matter how many sources contributed or how many each returned");

  const rows = await GroundingResearchResult.find({ workspaceId }).lean();
  assert.equal(rows.length, 5);

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testSingleSourceFailureSurfacesAsAClearErrorWithNoSilentFallback() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const failingOpenai = { groundedSearch: async () => { throw Object.assign(new Error("does not support the web_search tool"), { code: "OPENAI_WEB_SEARCH_UNSUPPORTED_MODEL" }); } };

  await assert.rejects(
    () => vertexGroundingDiscoveryService.search({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, query: "q", resultTypes: ["person"], source: "openai_web_search" }, { openaiWebSearchService: failingOpenai }),
    (error) => error.code === "OPENAI_WEB_SEARCH_UNSUPPORTED_MODEL",
    "selecting OpenAI Web Search alone must surface its real config error directly, never silently fall back to Vertex or a different model",
  );
  assert.equal((await GroundingResearchResult.countDocuments({ workspaceId })), 0, "a failed single-source search must stage nothing");
}

async function testBothModeReportsAPartialSourceFailureInsteadOfHidingIt() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const vertexGroundingService = { groundedSearch: async () => ({ results: [{ type: "person", name: "Jane Owner", organizationName: "", organizationDomain: "", summary: "", evidenceUrls: ["https://example.com/jane"], confidence: "single_source" }], groundingCitations: [] }) };
  const openaiWebSearchService = { groundedSearch: async () => { throw Object.assign(new Error("OpenAI Web Search is not enabled."), { code: "OPENAI_WEB_SEARCH_DISABLED" }); } };

  const result = await vertexGroundingDiscoveryService.search({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, query: "q", resultTypes: ["person"], source: "both" }, { vertexGroundingService, openaiWebSearchService });
  assert.equal(result.created, 1, "the working source's results must still be staged");
  assert.equal(result.sourceErrors.length, 1);
  assert.equal(result.sourceErrors[0].source, "openai_web_search");
  assert.equal(result.sourceErrors[0].code, "OPENAI_WEB_SEARCH_DISABLED", "a partial failure under 'both' must be reported plainly, not hidden behind a successful-looking response");

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testPdlEnrichmentRecordsRealProvenanceOnAMatch() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const row = await GroundingResearchResult.create({ workspaceId, query: "q", type: "person", name: "Jane Owner", organizationName: "Metro REIA", evidenceUrls: ["https://metroreia.org/about"], status: "pending_review", providers: ["vertex_grounding"] });
  const peopleDataLabsService = { enrichPerson: async () => ({ matched: true, likelihood: 9, person: { email: "jane@metroreia.org", emailState: "provider_validated" } }) };

  const updated = await vertexGroundingDiscoveryService.enrichWithPdl({ workspaceId, userId, resultId: row._id }, { peopleDataLabsService });
  assert.equal(updated.pdlEnrichment.attempted, true);
  assert.equal(updated.pdlEnrichment.matched, true);
  assert.equal(updated.pdlEnrichment.email, "jane@metroreia.org");
  assert.ok(updated.providers.includes("people_data_labs"), "a real PDL match must be recorded as real provenance");
  assert.ok(updated.providers.includes("vertex_grounding"), "enrichment must not erase the original discovery provider");
  assert.equal(updated.status, "pending_review", "enrichment alone must never save/review the result");

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testPdlNoMatchRecordsAttemptWithoutFabricatingAnEmail() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const row = await GroundingResearchResult.create({ workspaceId, query: "q", type: "person", name: "Unknown Person", evidenceUrls: ["https://example.com"], status: "pending_review", providers: ["vertex_grounding"] });
  const peopleDataLabsService = { enrichPerson: async () => ({ matched: false, likelihood: 3, person: null }) };

  const updated = await vertexGroundingDiscoveryService.enrichWithPdl({ workspaceId, userId, resultId: row._id }, { peopleDataLabsService });
  assert.equal(updated.pdlEnrichment.attempted, true);
  assert.equal(updated.pdlEnrichment.matched, false);
  assert.equal(updated.pdlEnrichment.email, "");
  assert.ok(!updated.providers.includes("people_data_labs"), "a non-match must never be recorded as if PDL contributed real data");

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testPdlEnrichmentRejectsNonPersonAndReviewedRows() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const orgRow = await GroundingResearchResult.create({ workspaceId, query: "q", type: "organization", name: "Metro REIA", evidenceUrls: ["https://metroreia.org"], status: "pending_review" });
  await assert.rejects(() => vertexGroundingDiscoveryService.enrichWithPdl({ workspaceId, userId, resultId: orgRow._id }, { peopleDataLabsService: { enrichPerson: async () => ({ matched: false }) } }), (error) => error.code === "GROUNDING_RESULT_NOT_A_PERSON");

  const savedRow = await GroundingResearchResult.create({ workspaceId, query: "q", type: "person", name: "Already Saved", evidenceUrls: ["https://example.com"], status: "saved" });
  await assert.rejects(() => vertexGroundingDiscoveryService.enrichWithPdl({ workspaceId, userId, resultId: savedRow._id }, { peopleDataLabsService: { enrichPerson: async () => ({ matched: false }) } }), (error) => error.code === "GROUNDING_RESULT_ALREADY_REVIEWED");

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testSavingAPersonUsesThePdlVerifiedEmailWhenPresent() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const row = await GroundingResearchResult.create({
    workspaceId, query: "q", type: "person", name: "Jane Owner", organizationName: "Metro REIA", evidenceUrls: ["https://metroreia.org/about"], status: "pending_review",
    pdlEnrichment: { attempted: true, matched: true, likelihood: 9, email: "jane@metroreia.org", emailState: "provider_validated", enrichedAt: new Date() },
  });
  const saved = await vertexGroundingDiscoveryService.saveResult({ workspaceId, userId, resultId: row._id });
  const contact = await Contact.findById(saved.savedContactId).lean();
  assert.equal(contact.email, "jane@metroreia.org", "a PDL-verified email must actually reach the saved Contact");

  await GroundingResearchResult.deleteMany({ workspaceId });
  await Contact.deleteMany({ workspaceId });
}

async function testRankForProgramFitScoresOnlyValidPendingRowsAndRecordsProvenance() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const pendingRow = await GroundingResearchResult.create({ workspaceId, query: "q", type: "person", name: "Jane Owner", evidenceUrls: ["https://metroreia.org/about"], status: "pending_review", providers: ["vertex_grounding"] });
  const savedRow = await GroundingResearchResult.create({ workspaceId, query: "q", type: "person", name: "Already Saved", evidenceUrls: ["https://example.com"], status: "saved" });

  let capturedContext = "";
  const runAgent = async ({ operationalContext }) => {
    capturedContext = operationalContext;
    return { output: { rankings: [
      { resultId: String(pendingRow._id), fitScore: 87, fitReasons: ["Strong evidence of active multifamily ownership"] },
      { resultId: "000000000000000000000000", fitScore: 99, fitReasons: ["A fabricated ID the model made up"] },
    ] } };
  };

  const result = await vertexGroundingDiscoveryService.rankForProgramFit({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, resultIds: [String(pendingRow._id), String(savedRow._id)] }, { runAgent });
  assert.equal(result.ranked, 1, "only the real, still-pending row may be scored — the already-saved row and the fabricated ID must both be ignored");
  assert.ok(capturedContext.includes("Jane Owner"), "the agent must actually receive the real candidate evidence, not a generic prompt");
  assert.ok(!capturedContext.includes("Already Saved"), "an already-reviewed row must never be sent for ranking");

  const rankedRow = await GroundingResearchResult.findById(pendingRow._id).lean();
  assert.equal(rankedRow.fitScore, 87);
  assert.deepEqual(rankedRow.fitReasons, ["Strong evidence of active multifamily ownership"]);
  assert.ok(rankedRow.providers.includes("openai_jarvis"), "a real ranking must be recorded as real provenance");

  const untouchedSavedRow = await GroundingResearchResult.findById(savedRow._id).lean();
  assert.equal(untouchedSavedRow.fitScore, null, "ranking must never touch a row outside the requested, still-pending set");

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testRankForProgramFitRequiresAtLeastOneSelection() {
  const workspaceId = new mongoose.Types.ObjectId();
  await assert.rejects(
    () => vertexGroundingDiscoveryService.rankForProgramFit({ workspaceId, userId: new mongoose.Types.ObjectId(), auth: { workspaceId: String(workspaceId) }, resultIds: [] }, { runAgent: async () => { throw new Error("must not be called"); } }),
    (error) => error.code === "GROUNDING_RANK_SELECTION_REQUIRED",
  );
}

/**
 * Live regression guard for the honesty claim in this file's header and in
 * services/vertexGroundingDiscoveryService.js's module comment: this app's
 * OpenAI integration must keep using only the Chat Completions API. If this
 * ever starts failing, it means someone added Responses API usage
 * elsewhere without updating that documented claim — not a false alarm to
 * silence, a prompt to re-verify and correct the claim everywhere it's made.
 */
function testOpenAiIntegrationStillHasNoResponsesApiWebSearch() {
  const source = require("fs").readFileSync(require.resolve("./services/llmService"), "utf8");
  assert.ok(source.includes("chat.completions.create"), "llmService.js must still be calling the Chat Completions API");
  assert.ok(!source.includes("responses.create") && !source.includes("web_search"), "llmService.js must not silently gain Responses API / web_search usage without this claim being re-verified");
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  try {
    await testSearchStagesResultsWithoutCreatingAnyLead();
    await testRepeatSearchMergesInsteadOfDuplicating();
    await testSavingAPersonCreatesAnAttributedContact();
    await testSavingAnOrganizationDedupesByDomain();
    await testSavingCommunityOrEventNeverInventsACrmEntity();
    await testDismissNeverCreatesAnything();
    await testBothSourcesMergeAndPreserveEachProvidersProvenance();
    await testSearchCapsInitialPeopleAtFiveRegardlessOfSourceCount();
    await testSingleSourceFailureSurfacesAsAClearErrorWithNoSilentFallback();
    await testBothModeReportsAPartialSourceFailureInsteadOfHidingIt();
    await testPdlEnrichmentRecordsRealProvenanceOnAMatch();
    await testPdlNoMatchRecordsAttemptWithoutFabricatingAnEmail();
    await testPdlEnrichmentRejectsNonPersonAndReviewedRows();
    await testSavingAPersonUsesThePdlVerifiedEmailWhenPresent();
    await testRankForProgramFitScoresOnlyValidPendingRowsAndRecordsProvenance();
    await testRankForProgramFitRequiresAtLeastOneSelection();
    testOpenAiIntegrationStillHasNoResponsesApiWebSearch();
    console.log("Vertex Grounding + OpenAI Web Search Discovery integration: results stage to a review queue with citations and never auto-create a lead, repeat finds merge and corroborate instead of duplicating (within AND across the two sources, without wrongly downgrading an already-corroborated result), the initial request caps at 5 people regardless of source count, a single selected source's failure surfaces directly with no silent fallback while 'both' reports a partial failure plainly, saving a person/organization creates the correct attributed+deduplicated CRM entity, community/event save honestly without inventing a CRM type, dismiss creates nothing, PDL enrichment records real provenance only on a real match and never fabricates data on a miss, a PDL-verified email actually reaches the saved Contact, OpenAI/Jarvis ranking scores only real still-pending rows with real evidence and ignores fabricated IDs, and the OpenAI/Jarvis-chat-still-Chat-Completions-only honesty claim still holds — all passed.");
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
