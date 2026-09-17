// Targeted regression coverage for tonight's Discovery → People Research
// fix: Jarvis qualification must select only a real approved program (never
// invent one like "Real Estate Investor Growth Program"), identity
// confidence must be computed deterministically from real signals (never
// left stuck at "low" for a strongly-corroborated identity), and program
// fit / identity confidence / buyer intent must stay three separate,
// enforced axes — an outreach recommendation requires all three, never a
// title alone. Also covers the per-provider overall-cap fix.
//
// Fully mocked — NO real or test database connection, and NO real
// OpenAI/Vertex/PDL/Apollo call, is made anywhere in this file.
// TEST_MONGO_URI is still not configured in this environment.
require("dotenv").config();
const assert = require("node:assert/strict");
const leadGenerationCoordinatorService = require("./services/leadGenerationCoordinatorService");
const vertexGroundingDiscoveryService = require("./services/vertexGroundingDiscoveryService");

const { detectExclusionFlags, buildQualifyResponseSchema, computeQualificationOutcome, qualifyAndRecommend, approveAndRunSearch, mapToApolloSeniority, buildApolloFilters, parseCompanySizeToApolloRange, broadenIcp, enrichWithApollo } = leadGenerationCoordinatorService;
const { computeIdentityConfidence } = vertexGroundingDiscoveryService;

function leanQuery(result) {
  const chain = { select: () => chain, sort: () => chain, limit: () => chain, lean: async () => result };
  return chain;
}

// ==================== computeIdentityConfidence ====================

function testComputeIdentityConfidenceFollowsTheFourRules() {
  assert.equal(computeIdentityConfidence({ providers: [], confidence: "single_source" }), "low", "one uncorroborated record must be low");
  assert.equal(computeIdentityConfidence({ providers: ["vertex_grounding"], confidence: "corroborated" }), "medium", "one provider with strong (multi-citation) corroboration must be medium");
  assert.equal(computeIdentityConfidence({ providers: ["vertex_grounding"], confidence: "single_source", linkedinUrl: "https://linkedin.com/in/x", organizationName: "Acme" }), "medium", "sufficiently complete matching identifiers (LinkedIn + org) must be medium");
  assert.equal(computeIdentityConfidence({ providers: ["vertex_grounding", "openai_web_search"], confidence: "corroborated" }), "high", "strong agreement from multiple independent providers must be high — the exact Ellie Baxter scenario");
  assert.equal(computeIdentityConfidence({ providers: ["pdl_person_search"], confidence: "single_source", verifiedIdentifier: true }), "high", "a verified contact/profile identifier must be high even from one provider");
  assert.equal(computeIdentityConfidence({ providers: ["vertex_grounding", "openai_web_search"], confidence: "corroborated", conflicts: ["Company mismatch"] }), "conflict", "providers disagreeing on a material field must be 'conflict', overriding what would otherwise be high");
}

// ==================== detectExclusionFlags ====================

function testDetectExclusionFlagsCatchesProfessionalsNotStudents() {
  assert.deepEqual(detectExclusionFlags({ name: "Jane Coach", organizationName: "Jane's Coaching", summary: "" }), ["coach"]);
  assert.deepEqual(detectExclusionFlags({ name: "Sam Broker", organizationName: "", summary: "Licensed real estate broker." }), ["broker"]);
  assert.deepEqual(detectExclusionFlags({ name: "New Investor", organizationName: "", summary: "Just starting out, asking beginner questions." }), [], "a genuine prospective student must never be flagged");
}

// ==================== buildQualifyResponseSchema: the actual fabrication fix ====================

function testBuildQualifyResponseSchemaOnlyEverAllowsRealProgramIds() {
  const schema = buildQualifyResponseSchema(["note-1", "note-2"]);
  const enumValues = schema.properties.qualifications.items.properties.recommendedProgramId.enum;
  assert.deepEqual(enumValues, ["note-1", "note-2", "none"], "the schema must constrain recommendedProgramId to the exact real program IDs plus 'none' — nothing else is structurally possible to return");
  assert.equal(schema.properties.qualifications.items.additionalProperties, false);
}

function testBuildQualifyResponseSchemaWithNoApprovedProgramsOnlyAllowsNone() {
  const schema = buildQualifyResponseSchema([]);
  assert.deepEqual(schema.properties.qualifications.items.properties.recommendedProgramId.enum, ["none"], "with zero approved programs, 'none' must be the only legal value — never a fabricated fallback name");
}

// ==================== computeQualificationOutcome: the three-axis enforcement ====================

function testComputeQualificationOutcomeRequiresAllThreePillarsForQualified() {
  const titleAlone = computeQualificationOutcome({ identityConfidence: "high", programFitScore: 90, recommendedProgramId: "note-1", buyerIntentLevel: "none", exclusionFlags: [] });
  assert.equal(titleAlone.qualificationLabel, "needs_review", "high identity + high fit but NO buyer-intent evidence must never be 'qualified' — a matching title/role alone is not enough");
  assert.equal(titleAlone.outreachRecommended, false, "outreach must never be recommended on fit/identity alone, without buyer-intent evidence");

  const everyPillar = computeQualificationOutcome({ identityConfidence: "high", programFitScore: 80, recommendedProgramId: "note-1", buyerIntentLevel: "strong", exclusionFlags: [] });
  assert.equal(everyPillar.qualificationLabel, "qualified");
  assert.equal(everyPillar.outreachRecommended, true);

  const weakIdentity = computeQualificationOutcome({ identityConfidence: "low", programFitScore: 80, recommendedProgramId: "note-1", buyerIntentLevel: "strong", exclusionFlags: [] });
  assert.equal(weakIdentity.qualificationLabel, "needs_review", "strong intent and fit but unreliable identity must not be auto-qualified");
  assert.equal(weakIdentity.outreachRecommended, false);
}

function testComputeQualificationOutcomeExcludesRegardlessOfOtherScores() {
  const excluded = computeQualificationOutcome({ identityConfidence: "high", programFitScore: 95, recommendedProgramId: "note-1", buyerIntentLevel: "strong", exclusionFlags: ["broker"] });
  assert.equal(excluded.qualificationLabel, "not_a_fit", "an ICP exclusion must win even over otherwise-perfect scores");
  assert.equal(excluded.outreachRecommended, false);
}

function testComputeQualificationOutcomeTreatsConflictAsNeedsReviewNotAutoRejected() {
  const conflicted = computeQualificationOutcome({ identityConfidence: "conflict", programFitScore: 80, recommendedProgramId: "note-1", buyerIntentLevel: "strong", exclusionFlags: [] });
  assert.equal(conflicted.qualificationLabel, "needs_review", "a real identity conflict needs a human decision — it isn't automatically 'not a fit' the way an ICP exclusion is");
}

function testComputeQualificationOutcomeKeepsMissingEvidenceReviewable() {
  const noProgram = computeQualificationOutcome({ identityConfidence: "high", programFitScore: 80, recommendedProgramId: "none", buyerIntentLevel: "strong", exclusionFlags: [] });
  assert.equal(noProgram.qualificationLabel, "needs_review", "missing a program recommendation is incomplete evidence, not proof that the lead is bad");
  const missingIntent = computeQualificationOutcome({ identityConfidence: "high", programFitScore: 80, recommendedProgramId: "note-1", buyerIntentLevel: "none", exclusionFlags: ["no_personal_investing_evidence"] });
  assert.equal(missingIntent.qualificationLabel, "needs_review", "missing public intent must stay reviewable rather than becoming an automatic rejection");
  const poorFit = computeQualificationOutcome({ identityConfidence: "high", programFitScore: 20, recommendedProgramId: "note-1", buyerIntentLevel: "strong", exclusionFlags: [] });
  assert.equal(poorFit.qualificationLabel, "not_a_fit");
}

function testStructuredAudienceMatchCanQualifyWithoutPublicIntent() {
  const structured = computeQualificationOutcome({ identityConfidence: "high", programFitScore: 82, recommendedProgramId: "note-1", buyerIntentLevel: "none", exclusionFlags: ["no_personal_investing_evidence"], discoveryMode: "icp_match" });
  assert.equal(structured.qualificationLabel, "qualified", "a verified Apollo/PDL audience match should qualify on identity + genuine program fit without pretending it came from a current public-intent post");
  const uncertainIdentity = computeQualificationOutcome({ identityConfidence: "low", programFitScore: 82, recommendedProgramId: "note-1", buyerIntentLevel: "none", exclusionFlags: [], discoveryMode: "icp_match" });
  assert.equal(uncertainIdentity.qualificationLabel, "needs_review", "structured matches with weak identity should be researched, not rejected");
  const trulyExcluded = computeQualificationOutcome({ identityConfidence: "high", programFitScore: 82, recommendedProgramId: "note-1", buyerIntentLevel: "none", exclusionFlags: ["wrong_country"], discoveryMode: "icp_match" });
  assert.equal(trulyExcluded.qualificationLabel, "not_a_fit", "real disqualifiers must still be enforced");
}

// ==================== qualifyAndRecommend: end-to-end, mocked ====================

function fakeGroundingResultModel(rows) {
  return {
    rows,
    find: () => leanQuery(rows),
    updateOne: async (filter, update) => {
      const row = rows.find((r) => String(r._id) === String(filter._id));
      if (row && update.$set) Object.assign(row, update.$set);
      if (row && update.$addToSet?.providers) row.providers = [...new Set([...(row.providers || []), update.$addToSet.providers])];
      return { acknowledged: true };
    },
  };
}

async function testQualifyAndRecommendPersistsOnlyARealApprovedProgramId() {
  const rows = [{ _id: "gr-1", name: "Jane Prospect", organizationName: "Acme Rentals", organizationDomain: "acme.com", summary: "Asked for recommendations on getting started in multifamily investing.", evidenceUrls: [], conflicts: [], providers: ["vertex_grounding", "openai_web_search"], confidence: "corroborated", discoveryMode: "public_web_evidence", linkedinUrl: "", pdlEnrichment: {}, apolloEnrichment: {} }];
  const GroundingResearchResult = fakeGroundingResultModel(rows);
  const listApprovedPrograms = async () => [{ noteId: "note-real-1", title: "4-Month Multifamily Mentorship" }];
  const runAgent = async ({ options }) => {
    // Simulate the exact prior bug: the model tries to invent a program.
    assert.ok(options.responseSchema.properties.qualifications.items.properties.recommendedProgramId.enum.includes("note-real-1"), "the real program ID must actually be offered to the model");
    assert.ok(!options.responseSchema.properties.qualifications.items.properties.recommendedProgramId.enum.includes("Real Estate Investor Growth Program"), "a fabricated program name must not even be a structurally legal output");
    return { output: { qualifications: [{ resultId: "gr-1", identityNotes: "consistent", programFitScore: 82, programFitReasons: ["Multifamily-relevant evidence"], recommendedProgramId: "note-real-1", buyerIntentLevel: "strong", buyerIntentEvidence: "Explicitly asked for recommendations on getting started.", exclusionFlags: [], qualificationLabel: "qualified", recommendedNextAction: "Reach out with an intro.", outreachRecommended: true, outreachDraft: "Hi Jane, saw your post..." }] } };
  };

  const result = await qualifyAndRecommend({ workspaceId: "workspace-1", userId: "u1", resultIds: ["gr-1"] }, { GroundingResearchResult, listApprovedPrograms, runAgent });

  assert.equal(result.summary.qualified, 1);
  assert.equal(rows[0].recommendedProgram.programNoteId, "note-real-1");
  assert.equal(rows[0].recommendedProgram.name, "4-Month Multifamily Mentorship", "the persisted name must come from the REAL program record, not whatever string the model returned");
  assert.equal(rows[0].identityConfidence, "high", "identity confidence must be recomputed from real signals (2 independent providers, corroborated) — the Ellie Baxter fix — not left at the stale 'low' default");
  assert.equal(rows[0].qualificationLabel, "qualified");
  assert.equal(rows[0].outreachRecommended, true);
}

async function testQualifyAndRecommendDiscardsAFabricatedProgramIdIfOneEverSlipsThrough() {
  const rows = [{ _id: "gr-2", name: "Pat Prospect", organizationName: "", organizationDomain: "", summary: "Looking for help analyzing my first multifamily deal.", evidenceUrls: [], conflicts: [], providers: ["vertex_grounding"], confidence: "single_source", discoveryMode: "public_web_evidence", linkedinUrl: "", pdlEnrichment: {}, apolloEnrichment: {} }];
  const GroundingResearchResult = fakeGroundingResultModel(rows);
  const listApprovedPrograms = async () => [{ noteId: "note-real-1", title: "4-Month Multifamily Mentorship" }];
  // Simulates a response that names a program not in the real list —
  // schema constraints should prevent this in practice, but the service
  // must still defend itself rather than trust the raw value blindly.
  const runAgent = async () => ({ output: { qualifications: [{ resultId: "gr-2", identityNotes: "", programFitScore: 70, programFitReasons: [], recommendedProgramId: "Real Estate Investor Growth Program", buyerIntentLevel: "weak", buyerIntentEvidence: "", exclusionFlags: [], qualificationLabel: "needs_review", recommendedNextAction: "Review manually.", outreachRecommended: false, outreachDraft: "" }] } });

  await qualifyAndRecommend({ workspaceId: "workspace-1", userId: "u1", resultIds: ["gr-2"] }, { GroundingResearchResult, listApprovedPrograms, runAgent });

  assert.equal(rows[0].recommendedProgram.programNoteId, null, "a program ID that doesn't match a real approved program must never be persisted");
  assert.equal(rows[0].recommendedProgram.name, "", "a fabricated program name must never reach the row, even if it somehow slipped past the schema");
}

async function testStructuredSearchKeepsItsRealTargetProgramAndQualifiesAfterIdentityMatch() {
  const rows = [{ _id: "gr-structured", name: "Alex Buyer", organizationName: "Alex Investments", organizationDomain: "", summary: "Real Estate Investor", evidenceUrls: [], conflicts: [], providers: ["apollo_person_search"], confidence: "single_source", discoveryMode: "icp_match", discoverySearchId: "search-1", linkedinUrl: "", pdlEnrichment: {}, apolloEnrichment: { matched: true, email: "alex@example.com" } }];
  const GroundingResearchResult = fakeGroundingResultModel(rows);
  const DiscoverySearch = { find: () => leanQuery([{ _id: "search-1", programNoteId: "note-real-1", programName: "Multifamily Foundations" }]) };
  const listApprovedPrograms = async () => [{ noteId: "note-real-1", title: "Multifamily Foundations" }];
  const runAgent = async () => ({ output: { qualifications: [{ resultId: "gr-structured", identityNotes: "Apollo identity matched", programFitScore: 82, programFitReasons: ["Matches the selected audience profile"], recommendedProgramId: "none", buyerIntentLevel: "none", buyerIntentEvidence: "No public intent post was supplied", exclusionFlags: ["no_personal_investing_evidence"], qualificationLabel: "needs_review", recommendedNextAction: "Use profile-based cold outreach", outreachRecommended: false, outreachDraft: "" }] } });

  const result = await qualifyAndRecommend({ workspaceId: "workspace-1", userId: "u1", resultIds: ["gr-structured"] }, { GroundingResearchResult, DiscoverySearch, listApprovedPrograms, runAgent });

  assert.equal(result.summary.qualified, 1, "a verified structured audience match with strong fit should be usable as a cold-outreach lead");
  assert.equal(rows[0].recommendedProgram.programNoteId, "note-real-1", "the selected approved search program should survive when missing public intent is the only reason the model omitted it");
  assert.equal(rows[0].qualificationLabel, "qualified");
}

async function testPublicDiscoveryRunKeepsItsSelectedProgramDuringQualification() {
  const rows = [{ _id: "gr-public-run", name: "Morgan Buyer", organizationName: "Morgan Investments", organizationDomain: "", summary: "Real Estate Investor", evidenceUrls: [], conflicts: [], providers: ["apollo_person_search"], confidence: "single_source", discoveryMode: "icp_match", discoveryRunId: "run-1", linkedinUrl: "https://linkedin.example/morgan", pdlEnrichment: {}, apolloEnrichment: {} }];
  const GroundingResearchResult = fakeGroundingResultModel(rows);
  const PublicWebDiscoveryRun = { find: () => leanQuery([{ _id: "run-1", programNoteId: "note-real-1", programName: "6-Week Coaching - Acquisitions" }]) };
  const listApprovedPrograms = async () => [{ noteId: "note-real-1", title: "6-Week Coaching - Acquisitions" }];
  const runAgent = async ({ operationalContext }) => {
    assert.ok(operationalContext.includes('"targetProgramId": "note-real-1"'), "the high-volume run's selected program must be supplied to Jarvis instead of an empty target");
    return { output: { qualifications: [{ resultId: "gr-public-run", identityNotes: "Apollo profile is consistent", programFitScore: 80, programFitReasons: ["Matches the acquisitions audience"], recommendedProgramId: "none", buyerIntentLevel: "none", buyerIntentEvidence: "No public intent post", exclusionFlags: [], qualificationLabel: "needs_review", recommendedNextAction: "Review for outreach", outreachRecommended: false, outreachDraft: "" }] } };
  };

  const result = await qualifyAndRecommend({ workspaceId: "workspace-1", userId: "u1", resultIds: ["gr-public-run"] }, { GroundingResearchResult, PublicWebDiscoveryRun, listApprovedPrograms, runAgent });

  assert.equal(result.summary.qualified, 1, "a strong structured Apollo match must qualify against the program selected by its public discovery run");
  assert.equal(rows[0].recommendedProgram.programNoteId, "note-real-1");
  assert.equal(rows[0].recommendedProgram.name, "6-Week Coaching - Acquisitions");
  assert.equal(rows[0].qualificationLabel, "qualified");
}

async function testQualifyAndRecommendReportsAnAccurateCompletionSummary() {
  const rows = [
    { _id: "gr-a", name: "A", providers: ["vertex_grounding", "openai_web_search"], confidence: "corroborated", conflicts: [], discoveryMode: "public_web_evidence" },
    { _id: "gr-b", name: "B", providers: ["vertex_grounding"], confidence: "single_source", conflicts: [], discoveryMode: "public_web_evidence" },
    { _id: "gr-c", name: "C", providers: ["vertex_grounding"], confidence: "single_source", conflicts: [], discoveryMode: "public_web_evidence" },
  ];
  const GroundingResearchResult = fakeGroundingResultModel(rows);
  const listApprovedPrograms = async () => [{ noteId: "note-real-1", title: "4-Month Multifamily Mentorship" }];
  const runAgent = async () => ({ output: { qualifications: [
    { resultId: "gr-a", identityNotes: "", programFitScore: 85, programFitReasons: [], recommendedProgramId: "note-real-1", buyerIntentLevel: "strong", buyerIntentEvidence: "asked for help", exclusionFlags: [], qualificationLabel: "qualified", recommendedNextAction: "", outreachRecommended: true, outreachDraft: "hi" },
    { resultId: "gr-b", identityNotes: "", programFitScore: 70, programFitReasons: [], recommendedProgramId: "note-real-1", buyerIntentLevel: "none", buyerIntentEvidence: "", exclusionFlags: [], qualificationLabel: "needs_review", recommendedNextAction: "", outreachRecommended: false, outreachDraft: "" },
    { resultId: "gr-c", identityNotes: "", programFitScore: 10, programFitReasons: [], recommendedProgramId: "none", buyerIntentLevel: "none", buyerIntentEvidence: "", exclusionFlags: ["broker"], qualificationLabel: "not_a_fit", recommendedNextAction: "", outreachRecommended: false, outreachDraft: "" },
    // gr-d intentionally omitted from the model's own response — must count as failed, never silently dropped.
  ] } });

  const result = await qualifyAndRecommend({ workspaceId: "workspace-1", userId: "u1", resultIds: ["gr-a", "gr-b", "gr-c", "gr-d"] }, { GroundingResearchResult, listApprovedPrograms, runAgent });

  assert.equal(result.summary.processed, 3);
  assert.equal(result.summary.qualified, 1);
  assert.equal(result.summary.needsReview, 1);
  assert.equal(result.summary.notAFit, 1);
  assert.equal(result.summary.failed, 1, "a requested candidate never found in pending_review or never returned by the model must be counted as failed, not silently ignored");
}

// ==================== approveAndRunSearch: every selected provider runs, queue stays capped ====================

async function testApproveAndRunSearchGathersARankedPoolAndKeepsOnlyTheBestByFit() {
  const DiscoverySearchModel = {
    doc: {
      _id: "search-cap", status: "proposed", sources: ["pdl_person_search", "apollo_person_search"], requestedCount: 5,
      icp: { titles: ["Real Estate Agent"], locations: [], industries: [], keywords: [], seniority: [] },
      programName: "Test", save: async function save() { return this; },
    },
    findOne: async () => DiscoverySearchModel.doc,
  };
  // Both providers over-fetch a pool larger than requestedCount (the whole
  // point of gatherRankAndMergeIcpMatches) — PDL's candidates don't match
  // the ICP title (low fit score), Apollo's do (high fit score), so this
  // also proves ranking actually picks the best candidates rather than
  // just whichever provider ran first.
  const peopleDataLabsService = { searchPeople: async ({ size }) => ({ people: Array.from({ length: size }, (_, i) => ({ fullName: `PDL Person ${i}`, title: "Barista", company: "", companyDomain: "", linkedinUrl: `pdl-${i}`, email: "", emailState: "" })) }) };
  const apolloService = { searchPeople: async ({ perPage }) => ({ people: Array.from({ length: perPage }, (_, i) => ({ fullName: `Apollo Person ${i}`, title: "Real Estate Agent", company: "", companyDomain: "", linkedinUrl: `apollo-${i}`, email: "", emailState: "" })), pagination: { totalPages: 1 } }) };
  const rows = [];
  const GroundingResearchResult = {
    rows,
    findOne: async () => null,
    create: async (doc) => { const row = { _id: `gr-${rows.length}`, conflicts: [], providers: [], ...doc }; rows.push(row); return row; },
  };

  const result = await approveAndRunSearch(
    { workspaceId: "workspace-1", userId: "u1", auth: { workspaceId: "workspace-1" }, searchId: "search-cap" },
    { DiscoverySearch: DiscoverySearchModel, peopleDataLabsService, apolloService, GroundingResearchResult, getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }), isSelfMatch: () => ({ isSelf: false, reasons: [] }) },
  );

  assert.equal(result.runSummary.created, 5, "the OVERALL created count must respect the requested cap of 5, regardless of how many providers were selected or how large a pool was gathered");
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.name.startsWith("Apollo")), "the 5 persisted rows must be the higher-fit Apollo candidates, not whichever provider happened to run first");
  assert.ok(rows.every((row) => row.fitScore > 20), "persisted rows must carry the computed ICP fit score, not a null/default");
  const apolloStats = result.runSummary.providerBreakdown.find((p) => p.provider === "apollo_person_search");
  const pdlStats = result.runSummary.providerBreakdown.find((p) => p.provider === "pdl_person_search");
  assert.ok(pdlStats.returned > 0 && apolloStats.returned > 5, "both providers must genuinely over-fetch a pool larger than the requested count");
  assert.equal(apolloStats.accepted, 5, "all 5 accepted slots went to the higher-fit provider");
  assert.equal(pdlStats.accepted, 0, "the lower-fit provider's candidates were correctly ranked below the cap, not accepted just for running first");
  assert.ok(pdlStats.rejectedForRanking + apolloStats.rejectedForRanking > 0, "candidates beyond the cap are reported as ranked-lower, not silently dropped");
}

// A 100-person request needs a 300-person Apollo pool (100 * APOLLO_POOL_
// MULTIPLIER, capped at APOLLO_MAX_POOL_SIZE) — 3 full pages at 100/page.
// Only the LAST expected page's candidates are given a real ICP title
// match (higher fit score); every earlier page's are given a non-matching
// title (lower score). If fetchApolloPool only ever requested page 1 — or
// requested later pages but discarded them instead of merging them into
// the scored pool — the last page's higher-fit candidates could never end
// up in the final accepted set. Their presence there is only possible if
// every page up to it was genuinely requested (proving real multi-page
// pagination, not just a bigger page 1) AND merged into the ranked pool
// (not fetched and dropped). Page count is derived from the real formula
// (poolSize = min(APOLLO_MAX_POOL_SIZE, requestedCount * APOLLO_POOL_
// MULTIPLIER), pages = poolSize / 100) rather than hardcoded, so this
// keeps testing real behavior if those constants are ever retuned.
async function testApproveAndRunSearchRequestsAndMergesRealApolloPagesBeyondPage1() {
  const requestedCount = 100;
  const poolSize = Math.min(2000, requestedCount * 4);
  const expectedPages = Math.ceil(poolSize / 100);
  const lastPage = expectedPages;

  const DiscoverySearchModel = {
    doc: {
      _id: "search-pages", status: "proposed", sources: ["apollo_person_search"], requestedCount,
      icp: { titles: ["Real Estate Agent"], locations: [], industries: [], keywords: [], seniority: [] },
      programName: "Test", save: async function save() { return this; },
    },
    findOne: async () => DiscoverySearchModel.doc,
  };
  const pagesRequested = [];
  const apolloService = {
    searchPeople: async ({ page, perPage }) => {
      pagesRequested.push(page);
      const isMatchingPage = page === lastPage;
      const people = Array.from({ length: perPage }, (_, i) => ({
        fullName: `Apollo P${page}-${i}`,
        title: isMatchingPage ? "Real Estate Agent" : "Notary Public",
        company: "", companyDomain: "", linkedinUrl: `apollo-page${page}-${i}`, email: "", emailState: "",
      }));
      // A real, larger-than-needed upstream result set (10 total pages
      // available) — the loop must keep paging until it has enough people
      // or hits its own page cap, not stop after an arbitrary first call.
      return { people, pagination: { page, totalPages: 10 } };
    },
  };
  const rows = [];
  const GroundingResearchResult = {
    rows,
    findOne: async () => null,
    create: async (doc) => { const row = { _id: `gr-${rows.length}`, conflicts: [], providers: [], ...doc }; rows.push(row); return row; },
  };

  const result = await approveAndRunSearch(
    { workspaceId: "workspace-1", userId: "u1", auth: { workspaceId: "workspace-1" }, searchId: "search-pages" },
    { DiscoverySearch: DiscoverySearchModel, apolloService, GroundingResearchResult, getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }), isSelfMatch: () => ({ isSelf: false, reasons: [] }) },
  );

  assert.deepEqual(pagesRequested, Array.from({ length: expectedPages }, (_, i) => i + 1), `a ${requestedCount}-person request needing a ${poolSize}-person pool must fetch exactly ${expectedPages} real Apollo pages — not stop after page 1, and not fetch more than needed`);
  const apolloStats = result.runSummary.providerBreakdown.find((p) => p.provider === "apollo_person_search");
  assert.equal(apolloStats.returned, poolSize, "every page's results must be merged into the pool total, not just the first page's");
  assert.equal(result.runSummary.created, requestedCount, "the requested count is filled");
  assert.equal(rows.length, requestedCount);
  assert.ok(rows.every((row) => row.name.startsWith(`Apollo P${lastPage}-`)), `the persisted rows must be the last page's (${lastPage}) higher-fit candidates specifically — only possible if every page up to it was both requested AND merged into the ranked pool, not fetched and discarded`);
}

// Confirmed live against the real API: Apollo's person_seniorities 422s/
// zeros the WHOLE search on a value outside its fixed vocabulary
// (owner/founder/c_suite/partner/vp/head/director/manager/senior/entry/
// intern). mapToApolloSeniority must map confident synonyms and drop
// anything ambiguous — never pass an unmapped raw value through.
function testMapToApolloSeniorityMapsConfidentlyAndDropsAmbiguousTerms() {
  assert.equal(mapToApolloSeniority("Owner"), "owner");
  assert.equal(mapToApolloSeniority("Founder"), "founder");
  assert.equal(mapToApolloSeniority("Co-Founder"), "founder");
  assert.equal(mapToApolloSeniority("Chief Executive Officer"), "c_suite");
  assert.equal(mapToApolloSeniority("VP of Sales"), "vp");
  assert.equal(mapToApolloSeniority("Director"), "director");
  assert.equal(mapToApolloSeniority("Senior Manager"), "senior");
  assert.equal(mapToApolloSeniority("Manager"), "manager");
  assert.equal(mapToApolloSeniority("Individual Contributor"), null, "an ambiguous term (could be junior or senior) must never be guessed into a bucket");
  assert.equal(mapToApolloSeniority("Some Random Title"), null);
  assert.equal(mapToApolloSeniority(""), null);

  const filters = buildApolloFilters({ titles: ["Real Estate Investor"], seniority: ["Individual Contributor", "Manager", "Owner", "Founder", "Partner"] });
  assert.deepEqual(filters.contact_email_status, ["verified"], "every Apollo discovery search must only return profiles for which Apollo says a verified email is available");
  assert.deepEqual(filters.person_seniorities, ["manager", "owner", "founder", "partner"], "only the confidently-mapped values reach Apollo — the ambiguous one is silently dropped, never passed through raw");
  assert.equal(filters.q_keywords, undefined, "q_keywords must never be sent — confirmed live it requires near-impossible co-occurrence and has an undocumented length limit that 422s the whole search");

  const allAmbiguous = buildApolloFilters({ titles: ["Owner"], seniority: ["Individual Contributor"] });
  assert.equal(allAmbiguous.person_seniorities, undefined, "when nothing maps, the filter must be omitted entirely rather than sent as an empty/invalid value");
}

function testParseCompanySizeToApolloRange() {
  assert.equal(parseCompanySizeToApolloRange("10-50"), "10,50");
  assert.equal(parseCompanySizeToApolloRange("10-50 employees"), "10,50");
  assert.equal(parseCompanySizeToApolloRange("500+"), "500,1000000");
  assert.equal(parseCompanySizeToApolloRange("10 to 50"), "10,50");
  assert.equal(parseCompanySizeToApolloRange(""), null);
  assert.equal(parseCompanySizeToApolloRange("small business"), null, "unparseable text must never be guessed into a fabricated range");
  assert.equal(parseCompanySizeToApolloRange("50-10"), null, "a backwards range (min > max) must never be sent as-is");

  const filters = buildApolloFilters({ titles: ["Owner"], companySizeRange: "10-50" });
  assert.deepEqual(filters.organization_num_employees_ranges, ["10,50"]);
}

function testBroadenIcpDropsCompanySizeInTheCascade() {
  const icp = { industries: [], companySizeRange: "10-50", seniority: ["Owner"], locations: ["Austin"], keywords: ["foo"] };
  const step1 = broadenIcp(icp);
  assert.equal(step1.relaxed, "company size", "with no industries, company size is the next field to relax");
  assert.equal(step1.icp.companySizeRange, "");
  const step2 = broadenIcp(step1.icp);
  assert.equal(step2.relaxed, "seniority");
  const step3 = broadenIcp(step2.icp);
  assert.equal(step3.relaxed, "locations");
  const step4 = broadenIcp(step3.icp);
  assert.equal(step4.relaxed, "keywords");
  assert.equal(broadenIcp(step4.icp), null, "nothing left to relax once every optional field is emptied");
}

// The automatic enrichment waterfall: a persisted candidate with no email
// must get an automatic Apollo enrichment attempt (the account's own
// primary paid source) before anything is reported back — a lead nobody
// can email is not a usable lead. Uses a real in-memory row store so
// enrichWithApollo's own Model.findOne(resultId)/row.save() calls behave
// like the real GroundingResearchResult model would.
// Regression coverage for a real bug found via live testing: Apollo's
// /people/match ALWAYS returns a `person` object, even with no real match —
// it echoes back a placeholder built from our own input, with every real
// field empty/null and a match_confidence that's sometimes the literal
// string "none", sometimes just blank (no single documented enum value).
// enrichWithApollo() used to treat any returned object as a genuine match,
// which marked leads "Enriched with Apollo" with an empty profile and
// stored the placeholder's throwaway id as a real, reusable Apollo person
// id. It must now require real, substantive data before calling it matched.
function mockRow(overrides = {}) {
  return { name: "Test Person", organizationName: "", organizationDomain: "", linkedinUrl: "", apolloPersonId: "", providers: [], type: "person", status: "pending_review", apolloEnrichment: {}, save: async function save() { return this; }, ...overrides };
}

async function testEnrichWithApolloRejectsANoMatchPlaceholderEvenWithoutTheLiteralNoneLabel() {
  const row = mockRow();
  const GroundingResearchResult = { findOne: async () => row };
  const apolloService = { enrichPerson: async () => ({ externalId: "placeholder-id", fullName: "Test Person", title: "", headline: "", linkedinUrl: "", email: "", organization: {}, matchConfidence: "" }) };
  const result = await enrichWithApollo({ workspaceId: "workspace-1", userId: "u1", resultId: "r1" }, { GroundingResearchResult, apolloService });
  assert.equal(result.apolloEnrichment.matched, false, "a placeholder with no substantive data must never be recorded as matched, even when match_confidence is blank rather than the literal string 'none'");
  assert.deepEqual(result.apolloEnrichment.profile, {}, "no placeholder data should be persisted as if it were a real profile");
}

async function testEnrichWithApolloAcceptsARealMatchWithBlankConfidenceIfItHasRealData() {
  const row = mockRow();
  const GroundingResearchResult = { findOne: async () => row };
  const apolloService = { enrichPerson: async () => ({ externalId: "real-id", fullName: "Test Person", title: "VP of Sales", linkedinUrl: "https://linkedin.com/in/test", email: "test@example.com", organization: {}, matchConfidence: "" }) };
  const result = await enrichWithApollo({ workspaceId: "workspace-1", userId: "u1", resultId: "r1" }, { GroundingResearchResult, apolloService });
  assert.equal(result.apolloEnrichment.matched, true, "a real match with genuine substantive data must be accepted even when Apollo's own confidence label is blank");
  assert.equal(result.apolloEnrichment.email, "test@example.com");
}

async function testEnrichWithApolloNeverSendsFalseEmptyDomainOrLinkedinToApollo() {
  const row = mockRow();
  const GroundingResearchResult = { findOne: async () => row };
  let capturedMatchInput = null;
  const apolloService = { enrichPerson: async ({ matchInput }) => { capturedMatchInput = matchInput; return { externalId: "x", title: "", email: "", organization: {}, matchConfidence: "none" }; } };
  await enrichWithApollo({ workspaceId: "workspace-1", userId: "u1", resultId: "r1" }, { GroundingResearchResult, apolloService });
  assert.ok(!("domain" in capturedMatchInput), "an unknown domain must never be sent as an empty string — Apollo treats that as conflicting identity evidence and degrades its own match confidence, confirmed live");
  assert.ok(!("linkedin_url" in capturedMatchInput), "an unknown LinkedIn URL must never be sent as an empty string, for the same reason");
}

async function testApproveAndRunSearchAutomaticallyEnrichesCandidatesMissingAnEmail() {
  const DiscoverySearchModel = {
    doc: {
      _id: "search-enrich", status: "proposed", sources: ["apollo_person_search"], requestedCount: 1,
      icp: { titles: ["Real Estate Investor"], locations: [], industries: [], keywords: [], seniority: [] },
      programName: "Test", save: async function save() { return this; },
    },
    findOne: async () => DiscoverySearchModel.doc,
  };
  const rowsById = new Map();
  const GroundingResearchResult = {
    findOne: async (filter) => {
      if (filter._id) return rowsById.get(String(filter._id)) || null;
      return null;
    },
    create: async (doc) => {
      const id = `gr-${rowsById.size}`;
      const row = {
        _id: id, conflicts: [], providers: [], ...doc,
        save: async function save() { rowsById.set(id, this); return this; },
      };
      rowsById.set(id, row);
      return row;
    },
  };
  let enrichmentMatchInput = null;
  const apolloService = {
    searchPeople: async () => ({ people: [{ externalId: "apollo-person-123", fullName: "No Email Person", title: "Real Estate Investor", company: "Acme", companyDomain: "acme.example", linkedinUrl: "https://www.linkedin.com/in/no-email-person", email: "", emailState: "" }] }),
    enrichPerson: async ({ matchInput }) => {
      enrichmentMatchInput = matchInput;
      return { externalId: "apollo-person-123", email: "found@example.com", emailState: "verified", title: "Regional Asset Manager", linkedinUrl: "https://www.linkedin.com/in/no-email-person", facebookUrl: "https://facebook.com/noemailperson", phoneNumbers: ["+15125550100"], organization: { name: "Acme", domain: "acme.example", industry: "Real Estate", employeeCount: 42 } };
    },
  };

  const result = await approveAndRunSearch(
    { workspaceId: "workspace-1", userId: "u1", auth: { workspaceId: "workspace-1" }, searchId: "search-enrich" },
    { DiscoverySearch: DiscoverySearchModel, apolloService, GroundingResearchResult, getWorkspaceSelfSignals: async () => ({ names: new Set(), emails: new Set(), domains: new Set(), businessNames: new Set() }), isSelfMatch: () => ({ isSelf: false, reasons: [] }) },
  );

  const savedRow = [...rowsById.values()][0];
  assert.equal(savedRow.apolloEnrichment?.matched, true, "the automatic waterfall must have run Apollo enrichment without any manual click");
  assert.equal(savedRow.apolloEnrichment?.email, "found@example.com", "the enrichment's found email must be recorded — saveResult() already prioritizes this over row.email when saving to a real Contact");
  assert.equal(savedRow.apolloPersonId, "apollo-person-123", "the exact Apollo person ID from free search must survive persistence");
  assert.equal(enrichmentMatchInput?.id, "apollo-person-123", "paid enrichment must use Apollo's exact person ID instead of fuzzy name/company rematching");
  assert.equal(enrichmentMatchInput?.linkedin_url, "https://www.linkedin.com/in/no-email-person", "LinkedIn remains a secondary matching signal and a usable public contact route");
  assert.equal(savedRow.apolloEnrichment.profile.title, "Regional Asset Manager", "useful Apollo enrichment fields must be retained instead of collapsing the paid response to email only");
  assert.equal(savedRow.phone, undefined, "phone numbers are deliberately not pursued — only email is needed, and Apollo's phone reveal is a separate paid/webhook-based feature");
  assert.ok(savedRow.socialProfileUrls.includes("https://facebook.com/noemailperson"), "Apollo social URLs must remain available to the review UI");
  assert.ok(result.runSummary.explanation.includes("Automatically found a verified email"), "the run explanation must surface that auto-enrichment happened");
}

async function run() {
  testComputeIdentityConfidenceFollowsTheFourRules();
  testDetectExclusionFlagsCatchesProfessionalsNotStudents();
  testBuildQualifyResponseSchemaOnlyEverAllowsRealProgramIds();
  testBuildQualifyResponseSchemaWithNoApprovedProgramsOnlyAllowsNone();
  testComputeQualificationOutcomeRequiresAllThreePillarsForQualified();
  testComputeQualificationOutcomeExcludesRegardlessOfOtherScores();
  testComputeQualificationOutcomeTreatsConflictAsNeedsReviewNotAutoRejected();
  testComputeQualificationOutcomeKeepsMissingEvidenceReviewable();
  testStructuredAudienceMatchCanQualifyWithoutPublicIntent();
  await testQualifyAndRecommendPersistsOnlyARealApprovedProgramId();
  await testQualifyAndRecommendDiscardsAFabricatedProgramIdIfOneEverSlipsThrough();
  await testStructuredSearchKeepsItsRealTargetProgramAndQualifiesAfterIdentityMatch();
  await testPublicDiscoveryRunKeepsItsSelectedProgramDuringQualification();
  await testQualifyAndRecommendReportsAnAccurateCompletionSummary();
  await testApproveAndRunSearchGathersARankedPoolAndKeepsOnlyTheBestByFit();
  await testApproveAndRunSearchRequestsAndMergesRealApolloPagesBeyondPage1();
  testMapToApolloSeniorityMapsConfidentlyAndDropsAmbiguousTerms();
  testParseCompanySizeToApolloRange();
  testBroadenIcpDropsCompanySizeInTheCascade();
  await testApproveAndRunSearchAutomaticallyEnrichesCandidatesMissingAnEmail();
  await testEnrichWithApolloRejectsANoMatchPlaceholderEvenWithoutTheLiteralNoneLabel();
  await testEnrichWithApolloAcceptsARealMatchWithBlankConfidenceIfItHasRealData();
  await testEnrichWithApolloNeverSendsFalseEmptyDomainOrLinkedinToApollo();
  console.log("Lead qualification: identity confidence is deterministic, program IDs are constrained to real approved programs, public-web leads require current intent, structured Apollo/PDL matches can qualify from verified identity plus genuine selected-program fit, missing evidence remains reviewable, real exclusions and poor fits are rejected, completion counts are accurate, provider pagination runs, and candidate caps remain enforced — all passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
