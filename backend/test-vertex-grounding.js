// Regression coverage for the optional Vertex AI grounding provider:
// disabled-by-default makes zero real requests, the two-tier (platform +
// per-workspace) capability gate, the separate monthly budget, the
// Vertex-specific camelCase "googleSearch" tool key (vs. the Gemini
// Developer API's snake_case "google_search"), citation/JSON parsing, and
// dedup/corroboration reuse from services/geminiService.js — all against
// mocked HTTP and a mocked Google auth client. No real network call is ever
// made in this file, and none of this has been run against a live Google
// Cloud project (see the module header in services/vertexGroundingService.js).
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const originalEnabled = process.env.VERTEX_ENABLED;
const originalCredsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
const originalProjectId = process.env.VERTEX_PROJECT_ID;
const originalGroundingFlag = process.env.VERTEX_GROUNDING_ENABLED;

function freshService() {
  delete require.cache[require.resolve("./services/vertexGroundingService")];
  delete require.cache[require.resolve("./services/providerResilience")];
  return require("./services/vertexGroundingService");
}

const fakeAuth = { getAccessToken: async () => "fake-token" };

async function testDisabledMakesZeroRequests() {
  delete process.env.VERTEX_ENABLED;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const vertex = freshService();
  let called = false;
  const httpClient = { post: async () => { called = true; throw new Error("must not call Vertex while disabled"); } };
  await assert.rejects(() => vertex.groundedSearch({ workspaceId: "w1", query: "q" }, { httpClient }), /VERTEX_DISABLED|not enabled/);
  assert.equal(called, false, "no HTTP call may be made while Vertex is disabled");
  const health = await vertex.healthCheck({ workspaceId: "w1" }, { httpClient });
  assert.deepEqual(health, { enabled: false, configured: false, healthy: false, reason: "disabled" });
  assert.equal(vertex.masterEnabled(), false);
}

async function testPlatformFlagGatesIndependently() {
  process.env.VERTEX_ENABLED = "true";
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: "service_account" });
  process.env.VERTEX_PROJECT_ID = "test-project";
  delete process.env.VERTEX_GROUNDING_ENABLED;
  const vertex = freshService();
  let called = false;
  const httpClient = { post: async () => { called = true; throw new Error("must not call Vertex while grounding is platform-disabled"); } };
  await assert.rejects(() => vertex.groundedSearch({ workspaceId: "w1", query: "q" }, { httpClient, getAccessToken: fakeAuth.getAccessToken }), (error) => error.code === "VERTEX_GROUNDING_DISABLED");
  assert.equal(called, false);

  process.env.VERTEX_GROUNDING_ENABLED = "true";
  assert.equal(vertex.groundingPlatformEnabled(), true);
}

async function testWorkspaceOptInAndBudget(models) {
  const vertex = freshService();
  const workspaceId = new mongoose.Types.ObjectId();

  let called = false;
  const httpClient = { post: async () => { called = true; throw new Error("must not call Vertex before the workspace opts in"); } };
  await assert.rejects(() => vertex.groundedSearch({ workspaceId, query: "q" }, { httpClient, getAccessToken: fakeAuth.getAccessToken }), (error) => error.code === "VERTEX_CAPABILITY_DISABLED");
  assert.equal(called, false);

  await models.vertexConfigService.save(workspaceId, { groundingEnabled: true, monthlyLimitUsd: 0.000001 }, models.WorkspaceConfig);
  await models.AiUsageRecord.create({ workspaceId, agent: "research", feature: "vertex_grounded_search", provider: "vertex", model: "gemini-2.5-flash-002", endpoint: "generateContent", estimatedTotalCostUsd: 1, latencyMs: 10, success: true });
  await assert.rejects(() => vertex.groundedSearch({ workspaceId, query: "q" }, { httpClient, getAccessToken: fakeAuth.getAccessToken }), (error) => error.code === "VERTEX_MONTHLY_LIMIT_REACHED");
  assert.equal(called, false, "a reached budget must block the call before any HTTP request");

  await models.AiUsageRecord.deleteMany({ workspaceId });
  await models.WorkspaceConfig.deleteMany({ workspaceId });
}

async function testGroundedSearchUsesCamelCaseToolAndParsesCitations(models) {
  const vertex = freshService();
  const workspaceId = new mongoose.Types.ObjectId();
  await models.vertexConfigService.save(workspaceId, { groundingEnabled: true }, models.WorkspaceConfig);

  const rawJson = JSON.stringify([
    { type: "organization", name: "Metro REIA", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "A local real estate investors association.", evidenceUrls: ["https://metroreia.org/about"] },
    { type: "person", name: "No Evidence Person", evidenceUrls: [] },
  ]);
  const text = `Here is what I found.\n\`\`\`json\n${rawJson}\n\`\`\``;
  let capturedBody, capturedUrl, capturedHeaders;
  const httpClient = {
    post: async (body) => {
      capturedBody = body;
      return { data: { candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://metroreia.org/events", title: "Metro REIA Events" } }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, totalTokenCount: 140 } } };
    },
  };
  const result = await vertex.groundedSearch({ workspaceId, query: "real estate investor associations near Austin", resultTypes: ["organization", "person"] }, { httpClient, getAccessToken: fakeAuth.getAccessToken });

  assert.equal(capturedBody.tools[0].googleSearch !== undefined, true, "Vertex must use the camelCase googleSearch tool key, not the Developer API's google_search");
  assert.equal(capturedBody.tools[0].google_search, undefined, "must never send the Developer API's snake_case tool key to Vertex");
  assert.equal(result.results.length, 1, "the no-evidence entry must be dropped");
  assert.deepEqual(result.groundingCitations, [{ url: "https://metroreia.org/events", title: "Metro REIA Events" }]);

  const usage = await models.AiUsageRecord.find({ workspaceId, provider: "vertex" }).lean();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].success, true);
  assert.equal(usage[0].inputTokens, 100);

  await models.WorkspaceConfig.deleteMany({ workspaceId });
  await models.AiUsageRecord.deleteMany({ workspaceId });
  void capturedUrl; void capturedHeaders;
}

async function testErrorPathIsLoggedAndCategorized(models) {
  const vertex = freshService();
  const workspaceId = new mongoose.Types.ObjectId();
  await models.vertexConfigService.save(workspaceId, { groundingEnabled: true }, models.WorkspaceConfig);
  const httpClient = { post: async () => { const error = new Error("Forbidden"); error.response = { status: 403 }; throw error; } };
  await assert.rejects(() => vertex.groundedSearch({ workspaceId, query: "q" }, { httpClient, getAccessToken: fakeAuth.getAccessToken }), /Forbidden/);
  const usage = await models.AiUsageRecord.find({ workspaceId, provider: "vertex" }).lean();
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
  const vertexConfigService = require("./services/vertexConfigService");
  const models = { WorkspaceConfig, AiUsageRecord, vertexConfigService };
  try {
    await testDisabledMakesZeroRequests();
    await testPlatformFlagGatesIndependently();
    require("./services/providerResilience").resetCircuits();
    await testWorkspaceOptInAndBudget(models);
    await testGroundedSearchUsesCamelCaseToolAndParsesCitations(models);
    require("./services/providerResilience").resetCircuits();
    await testErrorPathIsLoggedAndCategorized(models);
  } finally {
    if (originalEnabled === undefined) delete process.env.VERTEX_ENABLED; else process.env.VERTEX_ENABLED = originalEnabled;
    if (originalCredsJson === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON; else process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = originalCredsJson;
    if (originalProjectId === undefined) delete process.env.VERTEX_PROJECT_ID; else process.env.VERTEX_PROJECT_ID = originalProjectId;
    if (originalGroundingFlag === undefined) delete process.env.VERTEX_GROUNDING_ENABLED; else process.env.VERTEX_GROUNDING_ENABLED = originalGroundingFlag;
    require("./services/providerResilience").resetCircuits();
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Vertex grounding: disabled-by-default zero-requests, two-tier capability gating, workspace budget, camelCase googleSearch tool key (vs. Developer API's snake_case), citation parsing/evidence filtering, and error categorization all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
