// Regression coverage for platform-wide provider availability: only a
// platform owner may read/write it, and turning Gemini off here must
// actually block services/geminiService.js even for a workspace that has
// fully opted in and is within budget.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/platform");
const platformConfigService = require("./services/platformConfigService");
const geminiConfigService = require("./services/geminiConfigService");
const vertexConfigService = require("./services/vertexConfigService");
const PlatformConfig = require("./models/PlatformConfig");
const WorkspaceConfig = require("./models/WorkspaceConfig");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}
async function runRoute(path, method, req) {
  const res = fakeRes();
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  for (const routeLayer of layer.route.stack) {
    let calledNext = false, nextError = null;
    await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
    if (nextError) throw nextError;
    if (!calledNext) break;
  }
  return res;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  try {
    // Only a platform owner may read or write global provider availability.
    const forbidden = await runRoute("/providers", "get", { auth: { isPlatformOwner: false } });
    assert.equal(forbidden.statusCode, 403);

    const defaultRes = await runRoute("/providers", "get", { auth: { isPlatformOwner: true } });
    assert.equal(defaultRes.body.data.providerAvailability.gemini, true, "Gemini defaults to platform-available (the actual gate is still the env flags + workspace opt-in)");
    assert.equal(defaultRes.body.data.providerAvailability.vertex, true, "Vertex defaults to platform-available (the actual gate is still the env flags + workspace opt-in)");

    const adminUserId = new mongoose.Types.ObjectId();
    const savedRes = await runRoute("/providers", "patch", { auth: { isPlatformOwner: true, user: { _id: adminUserId } }, body: { providerAvailability: { gemini: false, vertex: false } } });
    assert.equal(savedRes.body.data.providerAvailability.gemini, false);
    assert.equal(savedRes.body.data.providerAvailability.vertex, false);

    // The saved value must actually be what services/geminiService.js and
    // services/vertexGroundingService.js / discoveryEngineService.js consult.
    assert.equal(await platformConfigService.geminiPlatformAvailable(), false);
    assert.equal(await platformConfigService.vertexPlatformAvailable(), false);

    // And it must block a real Gemini call end-to-end, even for a fully
    // opted-in, in-budget workspace — restart geminiService fresh so it
    // re-reads env flags cleanly for this check.
    const originalEnabled = process.env.GEMINI_ENABLED, originalKey = process.env.GEMINI_API_KEY, originalWorkspaceContext = process.env.GEMINI_WORKSPACE_CONTEXT_ENABLED;
    process.env.GEMINI_ENABLED = "true";
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_WORKSPACE_CONTEXT_ENABLED = "true";
    delete require.cache[require.resolve("./services/geminiService")];
    const geminiService = require("./services/geminiService");
    const workspaceId = new mongoose.Types.ObjectId();
    await geminiConfigService.save(workspaceId, { workspaceContextEnabled: true }, WorkspaceConfig);
    let called = false;
    await assert.rejects(
      () => geminiService.workspaceContext({ workspaceId, query: "q" }, { httpClient: { post: async () => { called = true; } } }),
      (error) => error.code === "GEMINI_PLATFORM_UNAVAILABLE",
    );
    assert.equal(called, false);

    if (originalEnabled === undefined) delete process.env.GEMINI_ENABLED; else process.env.GEMINI_ENABLED = originalEnabled;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
    if (originalWorkspaceContext === undefined) delete process.env.GEMINI_WORKSPACE_CONTEXT_ENABLED; else process.env.GEMINI_WORKSPACE_CONTEXT_ENABLED = originalWorkspaceContext;

    // Same end-to-end enforcement for Vertex Agent Search, via
    // discoveryEngineSyncService.search() (the real gating path).
    const originalVertexEnabled = process.env.VERTEX_ENABLED, originalVertexAgentSearch = process.env.VERTEX_AGENT_SEARCH_ENABLED, originalCredsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, originalProjectId = process.env.VERTEX_PROJECT_ID;
    process.env.VERTEX_ENABLED = "true";
    process.env.VERTEX_AGENT_SEARCH_ENABLED = "true";
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: "service_account", client_email: "test@example.com", private_key: "test" });
    process.env.VERTEX_PROJECT_ID = "test-project";
    delete require.cache[require.resolve("./services/discoveryEngineService")];
    delete require.cache[require.resolve("./services/discoveryEngineSyncService")];
    const discoveryEngineSyncService = require("./services/discoveryEngineSyncService");
    await vertexConfigService.save(workspaceId, { agentSearchEnabled: true }, WorkspaceConfig);
    await assert.rejects(
      () => discoveryEngineSyncService.search({ workspaceId, query: "q" }, { discoveryEngineSearch: async () => { called = true; return { results: [] }; } }),
      (error) => error.code === "VERTEX_PLATFORM_UNAVAILABLE",
    );
    assert.equal(called, false);

    if (originalVertexEnabled === undefined) delete process.env.VERTEX_ENABLED; else process.env.VERTEX_ENABLED = originalVertexEnabled;
    if (originalVertexAgentSearch === undefined) delete process.env.VERTEX_AGENT_SEARCH_ENABLED; else process.env.VERTEX_AGENT_SEARCH_ENABLED = originalVertexAgentSearch;
    if (originalCredsJson === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON; else process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = originalCredsJson;
    if (originalProjectId === undefined) delete process.env.VERTEX_PROJECT_ID; else process.env.VERTEX_PROJECT_ID = originalProjectId;
    await WorkspaceConfig.deleteMany({ workspaceId });

    console.log("Platform provider availability: owner-only access, persisted global toggles, and end-to-end enforcement in services/geminiService.js and services/discoveryEngineSyncService.js all passed.");
  } finally {
    await PlatformConfig.deleteMany({ key: "singleton" });
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
