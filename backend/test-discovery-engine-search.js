// Regression coverage for the low-level Discovery Engine (Vertex AI Search)
// REST client: disabled-by-default makes zero real requests, the
// server-enforced workspace_id filter (the actual tenant-isolation
// mechanism — never derived from caller input), document upsert/delete/purge
// request shapes, already-absent-delete idempotency, and search response
// parsing — all against a mocked HTTP client and a mocked Google auth
// token getter. No real network call is ever made in this file, and none of
// this has been run against a live Discovery Engine data store (see the
// module header in services/discoveryEngineService.js).
require("dotenv").config();
const assert = require("node:assert/strict");

const originalEnabled = process.env.VERTEX_ENABLED;
const originalCredsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
const originalProjectId = process.env.VERTEX_PROJECT_ID;
const originalAgentSearchFlag = process.env.VERTEX_AGENT_SEARCH_ENABLED;
const originalDataStore = process.env.DISCOVERY_ENGINE_DATA_STORE_ID;
const originalEngine = process.env.DISCOVERY_ENGINE_ENGINE_ID;
const originalLocation = process.env.DISCOVERY_ENGINE_LOCATION;

function freshService() {
  delete require.cache[require.resolve("./services/discoveryEngineService")];
  delete require.cache[require.resolve("./services/providerResilience")];
  return require("./services/discoveryEngineService");
}

const getAccessToken = async () => "fake-token";

function configureEnv() {
  process.env.VERTEX_ENABLED = "true";
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: "service_account" });
  process.env.VERTEX_PROJECT_ID = "test-project";
  process.env.VERTEX_AGENT_SEARCH_ENABLED = "true";
  process.env.DISCOVERY_ENGINE_DATA_STORE_ID = "test-store";
  process.env.DISCOVERY_ENGINE_ENGINE_ID = "test-engine";
  process.env.DISCOVERY_ENGINE_LOCATION = "global";
}

async function testDisabledMakesZeroRequests() {
  // Explicitly clear every input to masterEnabled() rather than assuming the
  // ambient environment has none of them set — a real deployment's .env
  // legitimately has GOOGLE_APPLICATION_CREDENTIALS_JSON/VERTEX_PROJECT_ID
  // configured even while VERTEX_ENABLED is still "false", and this test
  // must prove the disabled state makes zero requests regardless of that.
  delete process.env.VERTEX_ENABLED;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  delete process.env.VERTEX_PROJECT_ID;
  const service = freshService();
  let called = false;
  const http = { post: async () => { called = true; }, get: async () => { called = true; } };
  const health = await service.healthCheck({ http });
  assert.deepEqual(health, { enabled: false, configured: false, healthy: false, reason: "disabled" });
  assert.equal(called, false, "no HTTP call may be made while Vertex is disabled");
  assert.equal(service.masterEnabled(), false);
}

function testWorkspaceFilterIsServerBuiltAndEscaped() {
  configureEnv();
  const service = freshService();
  assert.equal(service.workspaceFilter("abc123"), 'workspace_id: ANY("abc123")');
  // A workspaceId containing a quote must never be able to break out of the filter's string literal.
  assert.equal(service.workspaceFilter('abc" OR "1"="1'), 'workspace_id: ANY("abc\\" OR \\"1\\"=\\"1")');
}

/**
 * Regression for a real, live-confirmed bug: a filtered search failed with
 * HTTP 400 "Unsupported field \"workspace_id\" on \":\" operator" against a
 * fresh data store, because auto-detected schemas don't mark custom
 * structData fields indexable by default. This asserts the documented fix
 * (requiredSchemaPatchBody()) actually declares the SAME field name
 * workspaceFilter() filters on, as indexable, and string-typed — so the
 * schema patch and the filter code can never silently drift apart, and a
 * schema patch that weakened this (e.g. indexable: false, or a wrong field
 * name) would fail this test.
 */
function testRequiredSchemaPatchMatchesTheFilterFieldAndStaysStrict() {
  configureEnv();
  const service = freshService();
  const patch = service.requiredSchemaPatchBody();
  const fieldNameInFilter = service.workspaceFilter("x").split(":")[0];
  const fieldSchema = patch.structSchema.properties[fieldNameInFilter];
  assert.ok(fieldSchema, `requiredSchemaPatchBody() must define the same field workspaceFilter() uses ("${fieldNameInFilter}")`);
  assert.equal(fieldSchema.type, "string");
  assert.equal(fieldSchema.indexable, true, "indexable:true is the one setting that actually fixes the live 400 — must never be weakened");
  // Deliberately not searchable/retrievable/dynamicFacetable — this is an
  // internal tenant key, never meant to be exposed, full-text searched, or
  // offered as a facet. A patch that turned these on would be a real
  // regression, not a hardening.
  assert.equal(fieldSchema.searchable, false);
  assert.equal(fieldSchema.retrievable, false);
  assert.equal(fieldSchema.dynamicFacetable, false);
}

async function testUpsertDocumentSendsCorrectShape() {
  configureEnv();
  const service = freshService();
  let capturedUrl, capturedBody, capturedHeaders;
  const http = { patch: async (url, body, options) => { capturedUrl = url; capturedBody = body; capturedHeaders = options.headers; return { data: {} }; } };
  await service.upsertDocument({ docId: "kc-w1-n1", workspaceId: "w1", title: "Onboarding SOP", content: "Step 1...", structData: { category: "sops" } }, { http, getAccessToken });

  assert.ok(capturedUrl.includes("dataStores/test-store/branches/0/documents/kc-w1-n1"));
  assert.ok(capturedUrl.includes("allowMissing=true"), "upsert must use allowMissing=true so a first-time index is a create, not an error");
  assert.equal(capturedBody.structData.workspace_id, "w1");
  assert.equal(capturedBody.structData.category, "sops");
  assert.equal(Buffer.from(capturedBody.content.rawBytes, "base64").toString("utf8"), "Step 1...");
  assert.equal(capturedHeaders.Authorization, "Bearer fake-token");
}

async function testDeleteDocumentIsIdempotentOnAlreadyAbsent() {
  configureEnv();
  const service = freshService();
  const http = { delete: async () => { const error = new Error("Not found"); error.response = { status: 404 }; throw error; } };
  const result = await service.deleteDocument({ docId: "kc-w1-n1" }, { http, getAccessToken });
  assert.equal(result.data.alreadyAbsent, true, "deleting an already-gone document must be treated as success, not an error");
}

async function testDeleteDocumentRethrowsRealErrors() {
  configureEnv();
  const service = freshService();
  const http = { delete: async () => { const error = new Error("Forbidden"); error.response = { status: 403 }; throw error; } };
  await assert.rejects(() => service.deleteDocument({ docId: "kc-w1-n1" }, { http, getAccessToken }), /Forbidden/);
}

async function testPurgeUsesWorkspaceFilterAndForce() {
  configureEnv();
  const service = freshService();
  let capturedUrl, capturedBody;
  const http = { post: async (url, body) => { capturedUrl = url; capturedBody = body; return { data: { name: "operations/abc" } }; } };
  const result = await service.purgeWorkspaceDocuments("w1", { http, getAccessToken });
  assert.ok(capturedUrl.endsWith("documents:purge"));
  assert.equal(capturedBody.filter, 'workspace_id: ANY("w1")');
  assert.equal(capturedBody.force, true);
  assert.equal(result.operationName, "operations/abc");
}

async function testSearchAppliesServerSideWorkspaceFilterNotCallerInput() {
  configureEnv();
  const service = freshService();
  let capturedUrl, capturedBody;
  const http = {
    post: async (url, body) => {
      capturedUrl = url;
      capturedBody = body;
      return { data: { results: [{ document: { id: "kc-w1-n1", derivedStructData: { title: "Onboarding SOP", link: "", snippets: [{ snippet: "Step 1..." }] }, structData: { workspace_id: "w1" } } }] } };
    },
  };
  // Even if a caller tried to smuggle a filter/workspaceId override into the
  // query text itself, the actual `filter` param sent to Google is built
  // from the trusted workspaceId argument alone.
  const result = await service.search({ workspaceId: "w1", query: 'onboarding" OR workspace_id: ANY("w2' }, { http, getAccessToken });
  assert.ok(capturedUrl.includes("servingConfigs/default_search:search"));
  assert.equal(capturedBody.filter, 'workspace_id: ANY("w1")', "the filter must come from the trusted workspaceId, never be influenced by query text");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, "Onboarding SOP");
  assert.equal(result.results[0].snippet, "Step 1...");
}

async function testHealthCheckReadOnlyGetNeverSpendsSearchQuota() {
  configureEnv();
  const service = freshService();
  let calledSearch = false;
  const http = { get: async () => ({ data: { name: "test-store" } }), post: async () => { calledSearch = true; } };
  const health = await service.healthCheck({ http, getAccessToken });
  assert.deepEqual(health, { enabled: true, configured: true, healthy: true });
  assert.equal(calledSearch, false, "health check must never call the search/query endpoint");
}

async function run() {
  try {
    await testDisabledMakesZeroRequests();
    testWorkspaceFilterIsServerBuiltAndEscaped();
    testRequiredSchemaPatchMatchesTheFilterFieldAndStaysStrict();
    require("./services/providerResilience").resetCircuits();
    await testUpsertDocumentSendsCorrectShape();
    await testDeleteDocumentIsIdempotentOnAlreadyAbsent();
    await testDeleteDocumentRethrowsRealErrors();
    await testPurgeUsesWorkspaceFilterAndForce();
    await testSearchAppliesServerSideWorkspaceFilterNotCallerInput();
    await testHealthCheckReadOnlyGetNeverSpendsSearchQuota();
  } finally {
    if (originalEnabled === undefined) delete process.env.VERTEX_ENABLED; else process.env.VERTEX_ENABLED = originalEnabled;
    if (originalCredsJson === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON; else process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = originalCredsJson;
    if (originalProjectId === undefined) delete process.env.VERTEX_PROJECT_ID; else process.env.VERTEX_PROJECT_ID = originalProjectId;
    if (originalAgentSearchFlag === undefined) delete process.env.VERTEX_AGENT_SEARCH_ENABLED; else process.env.VERTEX_AGENT_SEARCH_ENABLED = originalAgentSearchFlag;
    if (originalDataStore === undefined) delete process.env.DISCOVERY_ENGINE_DATA_STORE_ID; else process.env.DISCOVERY_ENGINE_DATA_STORE_ID = originalDataStore;
    if (originalEngine === undefined) delete process.env.DISCOVERY_ENGINE_ENGINE_ID; else process.env.DISCOVERY_ENGINE_ENGINE_ID = originalEngine;
    if (originalLocation === undefined) delete process.env.DISCOVERY_ENGINE_LOCATION; else process.env.DISCOVERY_ENGINE_LOCATION = originalLocation;
    require("./services/providerResilience").resetCircuits();
  }
}

run()
  .then(() => console.log("Discovery Engine client: disabled-by-default zero-requests, server-built and escaped workspace filter (never caller-influenced), the required-schema-patch contract staying in sync with the filter field and never weakened, document upsert/delete/purge request shapes, already-absent-delete idempotency, tenant-isolated search parsing, and a quota-free health check all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
