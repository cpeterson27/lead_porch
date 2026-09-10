// Regression coverage for the optional Gemini Developer API provider:
// disabled-by-default makes zero real requests, the two-tier (platform +
// per-workspace) capability gates, the separate monthly budget, workspace-only
// Workspace Context never touching the open web, grounded-search
// citation/JSON parsing, and dedup/corroboration — all against mocked HTTP.
// No real network call is ever made in this file, and none of this has been
// run against a real Gemini endpoint (see the module header in
// services/geminiService.js).
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const originalEnabled = process.env.GEMINI_ENABLED;
const originalKey = process.env.GEMINI_API_KEY;
const originalWorkspaceContextFlag = process.env.GEMINI_WORKSPACE_CONTEXT_ENABLED;
const originalGroundingFlag = process.env.GEMINI_GROUNDING_ENABLED;

function freshService() {
  delete require.cache[require.resolve("./services/geminiService")];
  delete require.cache[require.resolve("./services/providerResilience")];
  return require("./services/geminiService");
}

async function testDisabledMakesZeroRequests() {
  delete process.env.GEMINI_ENABLED;
  delete process.env.GEMINI_API_KEY;
  const gemini = freshService();
  let called = false;
  const httpClient = { post: async () => { called = true; throw new Error("must not call Gemini while disabled"); } };
  await assert.rejects(() => gemini.workspaceContext({ workspaceId: "w1", query: "q" }, { httpClient }), /GEMINI_DISABLED|not enabled/);
  await assert.rejects(() => gemini.groundedSearch({ workspaceId: "w1", query: "q" }, { httpClient }), /GEMINI_DISABLED|not enabled/);
  assert.equal(called, false, "no HTTP call may be made while Gemini is disabled");
  const health = await gemini.healthCheck({ workspaceId: "w1" }, { httpClient });
  assert.deepEqual(health, { enabled: false, configured: false, healthy: false, reason: "disabled" });
  assert.equal(gemini.masterEnabled(), false);
}

async function testPlatformFlagsGateIndependently() {
  process.env.GEMINI_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_WORKSPACE_CONTEXT_ENABLED;
  delete process.env.GEMINI_GROUNDING_ENABLED;
  const gemini = freshService();
  let called = false;
  const httpClient = { post: async () => { called = true; throw new Error("must not call Gemini while a capability is platform-disabled"); } };
  await assert.rejects(() => gemini.workspaceContext({ workspaceId: "w1", query: "q" }, { httpClient }), (error) => error.code === "GEMINI_WORKSPACE_CONTEXT_DISABLED");
  await assert.rejects(() => gemini.groundedSearch({ workspaceId: "w1", query: "q" }, { httpClient }), (error) => error.code === "GEMINI_GROUNDING_DISABLED");
  assert.equal(called, false);

  process.env.GEMINI_WORKSPACE_CONTEXT_ENABLED = "true";
  process.env.GEMINI_GROUNDING_ENABLED = "true";
  assert.equal(gemini.workspaceContextPlatformEnabled(), true);
  assert.equal(gemini.groundingPlatformEnabled(), true);
}

async function testPlatformAdministratorOverrideBlocksEvenWhenWorkspaceOptedIn(models) {
  const gemini = freshService();
  const workspaceId = new mongoose.Types.ObjectId();
  await models.geminiConfigService.save(workspaceId, { workspaceContextEnabled: true, groundingEnabled: true }, models.WorkspaceConfig);
  let called = false;
  const httpClient = { post: async () => { called = true; throw new Error("must not call Gemini while a platform administrator has disabled it"); } };
  const geminiPlatformAvailable = async () => false;
  await assert.rejects(() => gemini.workspaceContext({ workspaceId, query: "q" }, { httpClient, geminiPlatformAvailable }), (error) => error.code === "GEMINI_PLATFORM_UNAVAILABLE");
  await assert.rejects(() => gemini.groundedSearch({ workspaceId, query: "q" }, { httpClient, geminiPlatformAvailable }), (error) => error.code === "GEMINI_PLATFORM_UNAVAILABLE");
  assert.equal(called, false, "a platform-level disable must block the call even though this workspace opted in and its budget is fine");
  await models.WorkspaceConfig.deleteMany({ workspaceId });
}

async function testWorkspaceOptInAndBudget(models) {
  const gemini = freshService();
  const workspaceId = new mongoose.Types.ObjectId();

  // Platform-enabled but this workspace has not opted in (defaults OFF).
  let called = false;
  const httpClient = { post: async () => { called = true; throw new Error("must not call Gemini before the workspace opts in"); } };
  await assert.rejects(() => gemini.workspaceContext({ workspaceId, query: "q" }, { httpClient }), (error) => error.code === "GEMINI_CAPABILITY_DISABLED");
  assert.equal(called, false);

  await models.geminiConfigService.save(workspaceId, { workspaceContextEnabled: true, groundingEnabled: true, monthlyLimitUsd: 0.000001 }, models.WorkspaceConfig);

  // Monthly budget of effectively $0 with prior recorded spend must block further calls.
  await models.AiUsageRecord.create({ workspaceId, agent: "research", feature: "workspace_context", provider: "gemini", model: "gemini-2.5-flash", endpoint: "generateContent", estimatedTotalCostUsd: 1, latencyMs: 10, success: true });
  await assert.rejects(() => gemini.workspaceContext({ workspaceId, query: "q" }, { httpClient }), (error) => error.code === "GEMINI_MONTHLY_LIMIT_REACHED");
  assert.equal(called, false, "a reached budget must block the call before any HTTP request");

  await models.AiUsageRecord.deleteMany({ workspaceId });
  await models.WorkspaceConfig.deleteMany({ workspaceId });
}

async function testWorkspaceContextNeverTouchesWebAndSkipsCallWithNoContext(models) {
  const gemini = freshService();
  const workspaceId = new mongoose.Types.ObjectId();
  await models.geminiConfigService.save(workspaceId, { workspaceContextEnabled: true }, models.WorkspaceConfig);

  let called = false;
  const httpClient = { post: async () => { called = true; throw new Error("must not call Gemini with no approved context to search"); } };
  const result = await gemini.workspaceContext({ workspaceId, query: "nothing approved matches this" }, { httpClient, gatherWorkspaceContext: async () => ({ knowledge: { available: false, sources: [], context: "" }, organizations: [], unavailableSources: [{ source: "uploaded_documents", reason: "not yet implemented" }] }) });
  assert.equal(result.matched, false);
  assert.equal(called, false, "workspaceContext must not spend a Gemini call when nothing approved matched");
  assert.deepEqual(result.unavailableSources, [{ source: "uploaded_documents", reason: "not yet implemented" }]);

  await models.WorkspaceConfig.deleteMany({ workspaceId });
}

async function testWorkspaceContextWithRealContext(models) {
  const gemini = freshService();
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  await models.geminiConfigService.save(workspaceId, { workspaceContextEnabled: true }, models.WorkspaceConfig);

  let capturedModel, capturedBody;
  const httpClient = { post: async (model, body) => { capturedModel = model; capturedBody = body; return { data: { candidates: [{ content: { parts: [{ text: "Answer grounded only in approved notes." }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 } } }; } };
  const result = await gemini.workspaceContext(
    { workspaceId, userId, agent: "research", query: "What is our onboarding SOP?" },
    { httpClient, gatherWorkspaceContext: async () => ({ knowledge: { available: true, sources: ["sop-onboarding.md"], context: "Onboarding SOP: ..." }, organizations: [{ name: "Acme Corp", domain: "acme.com" }], unavailableSources: [] }) },
  );
  assert.equal(result.matched, true);
  assert.equal(result.answer, "Answer grounded only in approved notes.");
  assert.deepEqual(result.citations, ["sop-onboarding.md"]);
  assert.deepEqual(result.sourcesUsed, ["approved_knowledge", "structured_data"]);
  assert.equal(capturedBody.contents[0].parts[0].text.includes("APPROVED"), true, "the prompt must instruct Gemini to answer only from supplied approved content");
  assert.ok(!capturedBody.tools, "workspaceContext must never enable the google_search grounding tool");

  const usage = await models.AiUsageRecord.find({ workspaceId, provider: "gemini" }).lean();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].success, true);
  assert.equal(usage[0].inputTokens, 120);
  assert.equal(usage[0].outputTokens, 30);
  assert.equal(String(usage[0].userId), String(userId));

  await models.WorkspaceConfig.deleteMany({ workspaceId });
  await models.AiUsageRecord.deleteMany({ workspaceId });
}

async function testGroundedSearchParsingAndCitations(models) {
  const gemini = freshService();
  const workspaceId = new mongoose.Types.ObjectId();
  await models.geminiConfigService.save(workspaceId, { groundingEnabled: true }, models.WorkspaceConfig);

  const rawJson = JSON.stringify([
    { type: "organization", name: "Metro REIA", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "A local real estate investors association.", evidenceUrls: ["https://metroreia.org/about"] },
    { type: "person", name: "No Evidence Person", organizationName: "", organizationDomain: "", summary: "Should be dropped — no evidence URL at all.", evidenceUrls: [] },
    { type: "not_a_real_type", name: "Should be dropped", evidenceUrls: ["https://example.com"] },
  ]);
  const text = `Here is what I found.\n\`\`\`json\n${rawJson}\n\`\`\``;
  let capturedBody;
  const httpClient = { post: async (model, body) => {
    capturedBody = body;
    return {
      data: {
        candidates: [{
          content: { parts: [{ text }] },
          groundingMetadata: { groundingChunks: [{ web: { uri: "https://metroreia.org/events", title: "Metro REIA Events" } }] },
        }],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 80, totalTokenCount: 280 },
      },
    };
  } };
  const result = await gemini.groundedSearch({ workspaceId, query: "real estate investor associations near Austin", resultTypes: ["organization", "person"] }, { httpClient });

  assert.equal(capturedBody.tools[0].google_search !== undefined, true, "groundedSearch must enable the google_search grounding tool");
  assert.equal(result.results.length, 1, "an entry with no evidence URL and an entry with an invalid type must both be dropped");
  const org = result.results[0];
  assert.equal(org.type, "organization");
  assert.equal(org.name, "Metro REIA");
  assert.deepEqual(org.evidenceUrls, ["https://metroreia.org/about"], "a result's evidence must come only from what the model cited for that entity, not every page-level grounding citation");
  assert.deepEqual(result.groundingCitations, [{ url: "https://metroreia.org/events", title: "Metro REIA Events" }]);

  await models.WorkspaceConfig.deleteMany({ workspaceId });
  await models.AiUsageRecord.deleteMany({ workspaceId });
}

function testDeduplicationAndCorroboration() {
  const gemini = freshService();
  const results = [
    { type: "organization", name: "Metro REIA", organizationDomain: "metroreia.org", evidenceUrls: ["https://metroreia.org/about"] },
    { type: "organization", name: "Metro REIA", organizationDomain: "metroreia.org", evidenceUrls: ["https://eventbrite.com/o/metro-reia"] },
    { type: "person", name: "Jane Solo", organizationDomain: "solo.com", evidenceUrls: ["https://solo.com/team"] },
  ];
  const merged = gemini.deduplicateAndCorroborate(results);
  assert.equal(merged.length, 2, "the two Metro REIA rows must merge into one");
  const org = merged.find((row) => row.name === "Metro REIA");
  assert.equal(org.confidence, "corroborated", "two independent domains for the same entity must raise confidence");
  assert.equal(org.evidenceDomains.length, 2);
  const person = merged.find((row) => row.name === "Jane Solo");
  assert.equal(person.confidence, "single_source", "a single citation domain must not be treated as corroborated");
}

function testNeverReusesLegacyGoogleSearchCredentials() {
  const source = require("fs").readFileSync(require.resolve("./services/geminiService"), "utf8");
  // The module header legitimately documents the legacy names to explain
  // what NOT to do — what matters is that the code never actually READS
  // them from the environment.
  assert.equal(source.includes("process.env.GOOGLE_SEARCH_API_KEY"), false, "must never read the legacy Custom Search key");
  assert.equal(source.includes("process.env.GOOGLE_SEARCH_ENGINE_ID"), false, "must never read the legacy Custom Search engine ID");
  assert.ok(source.includes("process.env.GEMINI_API_KEY"));
}

async function testErrorPathIsLoggedAndCategorized(models) {
  const gemini = freshService();
  const workspaceId = new mongoose.Types.ObjectId();
  await models.geminiConfigService.save(workspaceId, { workspaceContextEnabled: true }, models.WorkspaceConfig);
  const httpClient = { post: async () => { const error = new Error("Unauthorized"); error.response = { status: 401 }; throw error; } };
  await assert.rejects(
    () => gemini.workspaceContext({ workspaceId, query: "q" }, { httpClient, gatherWorkspaceContext: async () => ({ knowledge: { available: true, sources: [], context: "x" }, organizations: [], unavailableSources: [] }) }),
    /Unauthorized/,
  );
  const usage = await models.AiUsageRecord.find({ workspaceId, provider: "gemini" }).lean();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].success, false);
  assert.equal(usage[0].errorCategory, "authentication");

  await models.WorkspaceConfig.deleteMany({ workspaceId });
  await models.AiUsageRecord.deleteMany({ workspaceId });
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const WorkspaceConfig = require("./models/WorkspaceConfig");
  const AiUsageRecord = require("./models/AiUsageRecord");
  const geminiConfigService = require("./services/geminiConfigService");
  const models = { WorkspaceConfig, AiUsageRecord, geminiConfigService };
  try {
    await testDisabledMakesZeroRequests();
    await testPlatformFlagsGateIndependently();
    await testWorkspaceOptInAndBudget(models);
    await testPlatformAdministratorOverrideBlocksEvenWhenWorkspaceOptedIn(models);
    require("./services/providerResilience").resetCircuits();
    await testWorkspaceContextNeverTouchesWebAndSkipsCallWithNoContext(models);
    await testWorkspaceContextWithRealContext(models);
    await testGroundedSearchParsingAndCitations(models);
    testDeduplicationAndCorroboration();
    testNeverReusesLegacyGoogleSearchCredentials();
    require("./services/providerResilience").resetCircuits();
    await testErrorPathIsLoggedAndCategorized(models);
  } finally {
    if (originalEnabled === undefined) delete process.env.GEMINI_ENABLED; else process.env.GEMINI_ENABLED = originalEnabled;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
    if (originalWorkspaceContextFlag === undefined) delete process.env.GEMINI_WORKSPACE_CONTEXT_ENABLED; else process.env.GEMINI_WORKSPACE_CONTEXT_ENABLED = originalWorkspaceContextFlag;
    if (originalGroundingFlag === undefined) delete process.env.GEMINI_GROUNDING_ENABLED; else process.env.GEMINI_GROUNDING_ENABLED = originalGroundingFlag;
    require("./services/providerResilience").resetCircuits();
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Gemini provider: disabled-by-default zero-requests, two-tier capability gating, workspace budget, Workspace Context (no-context skip, real-context grounding-free retrieval), Grounded Search (citation parsing, evidence-required filtering), dedup/corroboration, legacy-credential isolation, and error categorization all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
