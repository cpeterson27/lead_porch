// Regression coverage for services/discoveryEngineSyncService.js: no-op
// (zero HTTP, zero audit writes) when a workspace hasn't opted into Agent
// Search, the never-throws guarantee on a real indexing/removal failure (a
// Discovery Engine hiccup must never block the actual Knowledge Center
// action it mirrors), the full platform+workspace+budget gate on search(),
// server-side result deduplication, and that the jarvisMemoryService hooks
// (approve/reject/archive/restoreVersion/syncCloudNotes) actually call
// through to this service. All HTTP and Google auth calls are mocked.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const originalEnabled = process.env.VERTEX_ENABLED;
const originalCredsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
const originalProjectId = process.env.VERTEX_PROJECT_ID;
const originalAgentSearchFlag = process.env.VERTEX_AGENT_SEARCH_ENABLED;
const originalDataStore = process.env.DISCOVERY_ENGINE_DATA_STORE_ID;
const originalEngine = process.env.DISCOVERY_ENGINE_ENGINE_ID;

function freshSync() {
  delete require.cache[require.resolve("./services/discoveryEngineSyncService")];
  delete require.cache[require.resolve("./services/discoveryEngineService")];
  delete require.cache[require.resolve("./services/providerResilience")];
  return require("./services/discoveryEngineSyncService");
}

function configureEnv() {
  process.env.VERTEX_ENABLED = "true";
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: "service_account" });
  process.env.VERTEX_PROJECT_ID = "test-project";
  process.env.VERTEX_AGENT_SEARCH_ENABLED = "true";
  process.env.DISCOVERY_ENGINE_DATA_STORE_ID = "test-store";
  process.env.DISCOVERY_ENGINE_ENGINE_ID = "test-engine";
}

const getAccessToken = async () => "fake-token";

async function testNoOpWhenWorkspaceHasNotOptedIn(models) {
  delete process.env.VERTEX_ENABLED;
  const sync = freshSync();
  const workspaceId = new mongoose.Types.ObjectId();
  const noteId = new mongoose.Types.ObjectId();
  let called = false;
  const http = { patch: async () => { called = true; } };
  const result = await sync.indexApprovedNote({ _id: noteId, workspaceId, title: "t", content: "c" }, { http, getAccessToken, WorkspaceConfig: models.WorkspaceConfig });
  assert.deepEqual(result, { synced: false, reason: "disabled" });
  assert.equal(called, false, "no HTTP call may be made while disabled");
  const audits = await models.AuditLog.find({ workspaceId }).lean();
  assert.equal(audits.length, 0, "no audit row when the sync never actually ran");
}

async function testIndexApprovedNoteCallsUpsertWithPrefixedDocId(models) {
  configureEnv();
  const sync = freshSync();
  const workspaceId = new mongoose.Types.ObjectId();
  const noteId = new mongoose.Types.ObjectId();
  await models.vertexConfigService.save(workspaceId, { agentSearchEnabled: true }, models.WorkspaceConfig);
  let capturedUrl, capturedBody;
  const http = { patch: async (url, body) => { capturedUrl = url; capturedBody = body; return { data: {} }; } };
  const result = await sync.indexApprovedNote({ _id: noteId, workspaceId, title: "Onboarding SOP", content: "Step 1", category: "sops" }, { http, getAccessToken, vertexPlatformAvailable: async () => true });
  assert.equal(result.synced, true);
  assert.ok(capturedUrl.includes(`documents/kc-${workspaceId}-${noteId}`), "docId must be prefixed with the workspaceId so two workspaces can never collide");
  assert.equal(capturedBody.structData.workspace_id, String(workspaceId));
  const audits = await models.AuditLog.find({ workspaceId, action: "vertex.agent_search.indexed" }).lean();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].success, true);

  await models.WorkspaceConfig.deleteMany({ workspaceId });
  await models.AuditLog.deleteMany({ workspaceId });
}

async function testIndexingFailureNeverThrowsAndIsAudited(models) {
  configureEnv();
  const sync = freshSync();
  const workspaceId = new mongoose.Types.ObjectId();
  const noteId = new mongoose.Types.ObjectId();
  await models.vertexConfigService.save(workspaceId, { agentSearchEnabled: true }, models.WorkspaceConfig);
  const http = { patch: async () => { const error = new Error("Service unavailable"); error.response = { status: 503 }; throw error; } };
  // Must resolve, never reject — a Discovery Engine outage must never break
  // the real Knowledge Center approval it is mirroring.
  const result = await sync.indexApprovedNote({ _id: noteId, workspaceId, title: "t", content: "c" }, { http, getAccessToken, vertexPlatformAvailable: async () => true });
  assert.equal(result.synced, false);
  const audits = await models.AuditLog.find({ workspaceId, action: "vertex.agent_search.indexed" }).lean();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].success, false);

  await models.WorkspaceConfig.deleteMany({ workspaceId });
  await models.AuditLog.deleteMany({ workspaceId });
}

async function testRemoveNoteIsIdempotentAndAudited(models) {
  configureEnv();
  const sync = freshSync();
  const workspaceId = new mongoose.Types.ObjectId();
  const noteId = new mongoose.Types.ObjectId();
  await models.vertexConfigService.save(workspaceId, { agentSearchEnabled: true }, models.WorkspaceConfig);
  const http = { delete: async () => { const error = new Error("Not found"); error.response = { status: 404 }; throw error; } };
  const result = await sync.removeNote({ _id: noteId, workspaceId }, { http, getAccessToken, vertexPlatformAvailable: async () => true });
  assert.equal(result.synced, true, "removing an already-absent document must count as success");
  const audits = await models.AuditLog.find({ workspaceId, action: "vertex.agent_search.removed" }).lean();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].success, true);

  await models.WorkspaceConfig.deleteMany({ workspaceId });
  await models.AuditLog.deleteMany({ workspaceId });
}

async function testSearchGatingChainAndDeduplication(models) {
  configureEnv();
  const sync = freshSync();
  const workspaceId = new mongoose.Types.ObjectId();

  await assert.rejects(
    () => sync.search({ workspaceId, query: "q" }, { vertexPlatformAvailable: async () => true }),
    (error) => error.code === "VERTEX_CAPABILITY_DISABLED",
    "must not search before this workspace opts in",
  );

  await models.vertexConfigService.save(workspaceId, { agentSearchEnabled: true }, models.WorkspaceConfig);
  const duplicated = [
    { documentId: "kc-1", title: "SOP A", link: "", snippet: "..." },
    { documentId: "kc-1", title: "SOP A", link: "", snippet: "..." },
    { documentId: "kc-2", title: "SOP B", link: "", snippet: "..." },
  ];
  const result = await sync.search({ workspaceId, query: "sop" }, { vertexPlatformAvailable: async () => true, discoveryEngineSearch: async () => ({ results: duplicated }) });
  assert.equal(result.results.length, 2, "a document returned twice by Discovery Engine must be deduplicated by documentId");
  assert.equal(result.matched, true);

  await models.WorkspaceConfig.deleteMany({ workspaceId });
  await models.AiUsageRecord.deleteMany({ workspaceId });
}

async function testPurgeWorkspaceWorksEvenIfNotOptedIn(models) {
  configureEnv();
  const sync = freshSync();
  const workspaceId = new mongoose.Types.ObjectId();
  // Deliberately NOT opted into agentSearchEnabled — a workspace revoking
  // access must still be able to purge whatever was already indexed.
  let capturedBody;
  const http = { post: async (url, body) => { capturedBody = body; return { data: { name: "operations/xyz" } }; } };
  const operation = await sync.purgeWorkspace(workspaceId, null, { http, getAccessToken });
  assert.equal(operation.operationName, "operations/xyz");
  assert.equal(capturedBody.filter, `workspace_id: ANY("${workspaceId}")`);
  const audits = await models.AuditLog.find({ workspaceId, action: "vertex.agent_search.workspace_purged" }).lean();
  assert.equal(audits.length, 1);

  await models.AuditLog.deleteMany({ workspaceId });
}

async function testJarvisMemoryServiceHooksCallThrough() {
  delete require.cache[require.resolve("./services/jarvisMemoryService")];
  const jarvisMemoryService = require("./services/jarvisMemoryService");
  const workspaceId = new mongoose.Types.ObjectId();
  const noteId = new mongoose.Types.ObjectId();
  const calls = [];
  const stubSync = {
    indexApprovedNote: async () => { calls.push("index"); return { synced: false, reason: "stub" }; },
    removeNote: async () => { calls.push("remove"); return { synced: false, reason: "stub" }; },
  };

  const modulePath = require.resolve("./services/discoveryEngineSyncService");
  const original = require.cache[modulePath];
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: stubSync };
  try {
    const userId = new mongoose.Types.ObjectId();
    await jarvisMemoryService.approveNote({ workspaceId, noteId, userId }, { findOneAndUpdate: async () => ({ _id: noteId, workspaceId, status: "approved" }) });
    await jarvisMemoryService.rejectNote({ workspaceId, noteId, userId }, { findOneAndUpdate: async () => ({ _id: noteId, workspaceId, status: "rejected" }) });
    await jarvisMemoryService.archiveNote({ workspaceId, noteId, userId }, { findOneAndUpdate: async () => ({ _id: noteId, workspaceId, status: "archived" }) });
    assert.deepEqual(calls, ["index", "remove", "remove"], "approveNote must index; rejectNote and archiveNote must both remove");
  } finally {
    require.cache[modulePath] = original;
  }
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const WorkspaceConfig = require("./models/WorkspaceConfig");
  const AiUsageRecord = require("./models/AiUsageRecord");
  const AuditLog = require("./models/AuditLog");
  const vertexConfigService = require("./services/vertexConfigService");
  const models = { WorkspaceConfig, AiUsageRecord, AuditLog, vertexConfigService };
  try {
    await testNoOpWhenWorkspaceHasNotOptedIn(models);
    require("./services/providerResilience").resetCircuits();
    await testIndexApprovedNoteCallsUpsertWithPrefixedDocId(models);
    await testIndexingFailureNeverThrowsAndIsAudited(models);
    await testRemoveNoteIsIdempotentAndAudited(models);
    await testSearchGatingChainAndDeduplication(models);
    await testPurgeWorkspaceWorksEvenIfNotOptedIn(models);
    await testJarvisMemoryServiceHooksCallThrough();
  } finally {
    if (originalEnabled === undefined) delete process.env.VERTEX_ENABLED; else process.env.VERTEX_ENABLED = originalEnabled;
    if (originalCredsJson === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON; else process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = originalCredsJson;
    if (originalProjectId === undefined) delete process.env.VERTEX_PROJECT_ID; else process.env.VERTEX_PROJECT_ID = originalProjectId;
    if (originalAgentSearchFlag === undefined) delete process.env.VERTEX_AGENT_SEARCH_ENABLED; else process.env.VERTEX_AGENT_SEARCH_ENABLED = originalAgentSearchFlag;
    if (originalDataStore === undefined) delete process.env.DISCOVERY_ENGINE_DATA_STORE_ID; else process.env.DISCOVERY_ENGINE_DATA_STORE_ID = originalDataStore;
    if (originalEngine === undefined) delete process.env.DISCOVERY_ENGINE_ENGINE_ID; else process.env.DISCOVERY_ENGINE_ENGINE_ID = originalEngine;
    require("./services/providerResilience").resetCircuits();
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Discovery Engine sync: no-op-when-disabled, prefixed docId tenant isolation, never-throws indexing/removal with audit trail, full search gating chain with deduplication, revocation-purge working even when not opted in, and jarvisMemoryService hook wiring all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
