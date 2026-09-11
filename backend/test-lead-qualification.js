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

const { detectExclusionFlags, buildQualifyResponseSchema, computeQualificationOutcome, qualifyAndRecommend, approveAndRunSearch } = leadGenerationCoordinatorService;
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

function testComputeQualificationOutcomeRejectsNoProgramOrPoorFit() {
  const noProgram = computeQualificationOutcome({ identityConfidence: "high", programFitScore: 80, recommendedProgramId: "none", buyerIntentLevel: "strong", exclusionFlags: [] });
  assert.equal(noProgram.qualificationLabel, "not_a_fit", "no genuinely-approved program match must be 'not a fit', never silently dropped or left ambiguous");
  const poorFit = computeQualificationOutcome({ identityConfidence: "high", programFitScore: 20, recommendedProgramId: "note-1", buyerIntentLevel: "strong", exclusionFlags: [] });
  assert.equal(poorFit.qualificationLabel, "not_a_fit");
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

// ==================== approveAndRunSearch: overall merged cap, not per-provider ====================

async function testApproveAndRunSearchHonorsTheOverallCapAcrossProviders() {
  const DiscoverySearchModel = {
    doc: {
      _id: "search-cap", status: "proposed", sources: ["pdl_person_search", "apollo_person_search"], requestedCount: 5,
      icp: { titles: ["Real Estate Agent"], locations: [], industries: [], keywords: [], seniority: [] },
      programName: "Test", save: async function save() { return this; },
    },
    findOne: async () => DiscoverySearchModel.doc,
  };
  // Each provider independently offers 5 fresh, non-duplicate, non-self
  // candidates — if the cap were (bugged) per-provider, this would create
  // 10 total; the fix must cap the COMBINED total at 5.
  const peopleDataLabsService = { searchPeople: async ({ size }) => ({ people: Array.from({ length: size }, (_, i) => ({ fullName: `PDL Person ${i}`, company: "", companyDomain: "", linkedinUrl: `pdl-${i}`, email: "", emailState: "" })) }) };
  const apolloService = { searchPeople: async ({ perPage }) => ({ people: Array.from({ length: perPage }, (_, i) => ({ fullName: `Apollo Person ${i}`, company: "", companyDomain: "", linkedinUrl: `apollo-${i}`, email: "", emailState: "" })) }) };
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

  assert.equal(result.runSummary.created, 5, "the OVERALL created count must respect the requested cap of 5, regardless of how many providers were selected");
  assert.equal(rows.length, 5);
  const apolloStats = result.runSummary.providerBreakdown.find((p) => p.provider === "apollo_person_search");
  assert.ok(apolloStats.requested <= 5, "a later provider must be asked for only what's left of the overall cap, never the full requested count again");
}

async function run() {
  testComputeIdentityConfidenceFollowsTheFourRules();
  testDetectExclusionFlagsCatchesProfessionalsNotStudents();
  testBuildQualifyResponseSchemaOnlyEverAllowsRealProgramIds();
  testBuildQualifyResponseSchemaWithNoApprovedProgramsOnlyAllowsNone();
  testComputeQualificationOutcomeRequiresAllThreePillarsForQualified();
  testComputeQualificationOutcomeExcludesRegardlessOfOtherScores();
  testComputeQualificationOutcomeTreatsConflictAsNeedsReviewNotAutoRejected();
  testComputeQualificationOutcomeRejectsNoProgramOrPoorFit();
  await testQualifyAndRecommendPersistsOnlyARealApprovedProgramId();
  await testQualifyAndRecommendDiscardsAFabricatedProgramIdIfOneEverSlipsThrough();
  await testQualifyAndRecommendReportsAnAccurateCompletionSummary();
  await testApproveAndRunSearchHonorsTheOverallCapAcrossProviders();
  console.log("Lead qualification: identityConfidence is computed deterministically from real provider/corroboration/conflict signals (never left at a stale 'low' for a strongly-corroborated identity — the Ellie Baxter fix), the qualify schema structurally cannot return a program outside the workspace's real approved list (the fabrication fix, plus a defensive discard if one ever slips through), qualification requires ALL THREE separate signals — identity, program fit, and buyer-intent evidence — before 'qualified'/outreach is ever recommended (never a title alone), ICP exclusions and identity conflicts are handled as distinct, sensible outcomes, the completion summary accurately counts processed/qualified/needsReview/notAFit/failed including a candidate the model silently omitted, and the overall requested-count cap in approveAndRunSearch is honored across ALL selected providers combined rather than treated as a separate allowance per provider — all passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
