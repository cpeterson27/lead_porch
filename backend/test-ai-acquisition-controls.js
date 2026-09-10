// Regression coverage for the new AI & Acquisition Controls backend surface
// added to routes/ai.js: Gemini per-workspace config, aggregated read-only
// provider health, and the emergency Pause All action. All external
// providers are mocked — no real network call is made in this file.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { createAiRouter } = require("./routes/ai");
const { runWithWorkspace } = require("./tenancy/workspaceContext");
const ResearchMonitor = require("./models/ResearchMonitor");
const WorkspaceConfig = require("./models/WorkspaceConfig");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}
async function runRoute(router, path, method, req) {
  const res = fakeRes();
  for (const layer of router.stack) {
    const handlers = layer.route ? (layer.route.path === path && layer.route.methods[method] ? layer.route.stack : null) : [layer];
    if (!handlers) continue;
    let stopped = false;
    for (const routeLayer of handlers) {
      let calledNext = false, nextError = null;
      await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
      if (nextError) throw nextError;
      if (!calledNext) { stopped = true; break; }
    }
    if (stopped || layer.route) break;
  }
  return res;
}

const owner = { workspaceId: null, user: { _id: "u1" }, roles: ["owner"] };

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const foreignWorkspaceId = new mongoose.Types.ObjectId();
  owner.workspaceId = String(workspaceId);

  const geminiConfigService = {
    get: async () => ({ workspaceContextEnabled: false, groundingEnabled: false, monthlyLimitUsd: null }),
    save: async (id, input) => ({ workspaceContextEnabled: false, groundingEnabled: false, monthlyLimitUsd: null, ...input }),
  };
  const geminiService = {
    healthCheck: async () => ({ enabled: false, configured: false, healthy: false, reason: "disabled" }),
    masterEnabled: () => false,
  };
  const router = createAiRouter({ geminiConfigService, geminiService });

  try {
    // Non-admin is rejected before touching any service.
    const forbidden = await runRoute(router, "/gemini/config", "get", { auth: { workspaceId: owner.workspaceId, roles: ["member"] } });
    assert.equal(forbidden.statusCode, 403);

    // Gemini config read/write round-trip.
    const configRes = await runRoute(router, "/gemini/config", "get", { auth: owner });
    assert.equal(configRes.body.data.workspaceContextEnabled, false);
    const savedRes = await runRoute(router, "/gemini/config", "patch", { auth: owner, body: { workspaceContextEnabled: true } });
    assert.equal(savedRes.body.data.workspaceContextEnabled, true);

    // Vertex config read/write round-trip (real, disabled-by-default module — no mock needed).
    const vertexConfigRes = await runRoute(router, "/vertex/config", "get", { auth: owner });
    assert.equal(vertexConfigRes.body.data.agentSearchEnabled, false);
    const vertexSavedRes = await runRoute(router, "/vertex/config", "patch", { auth: owner, body: { agentSearchEnabled: true } });
    assert.equal(vertexSavedRes.body.data.agentSearchEnabled, true);

    // Aggregated provider health never exposes credential values, only status.
    const healthRes = await runRoute(router, "/providers/health", "get", { auth: owner });
    assert.equal(healthRes.statusCode, 200);
    assert.ok(healthRes.body.data.openai);
    assert.ok(healthRes.body.data.gemini);
    assert.ok(healthRes.body.data.vertexGrounding);
    assert.ok(healthRes.body.data.discoveryEngineAgentSearch);
    assert.ok(healthRes.body.data.apollo);
    assert.ok(healthRes.body.data.peopleDataLabs);
    assert.ok(healthRes.body.data.emailable);
    assert.equal(JSON.stringify(healthRes.body).toLowerCase().includes("api_key"), false, "provider health must never leak credential-shaped data");

    // Pause All disables OpenAI, both Gemini capabilities, both Vertex capabilities, and every enabled monitor for this workspace only.
    await runWithWorkspace(workspaceId, () => ResearchMonitor.create([
      { workspaceId, name: "In this workspace", monitorType: "buyer_intent", query: "q", enabled: true, intervalMinutes: 60 },
    ]));
    await runWithWorkspace(foreignWorkspaceId, () => ResearchMonitor.create([
      { workspaceId: foreignWorkspaceId, name: "Foreign workspace", monitorType: "buyer_intent", query: "q", enabled: true, intervalMinutes: 60 },
    ]));

    const pauseRes = await runRoute(router, "/pause-all", "post", { auth: owner });
    assert.equal(pauseRes.statusCode, 200);
    assert.equal(pauseRes.body.data.vertex.agentSearchEnabled, false, "Pause All must turn Vertex Agent Search back off");
    assert.equal(pauseRes.body.data.monitorsDisabled, 1, "Pause All must only affect this workspace's monitors");
    const stillEnabled = await ResearchMonitor.findOne({ workspaceId: foreignWorkspaceId }).lean();
    assert.equal(stillEnabled.enabled, true, "a foreign workspace's monitor must never be touched by another workspace's Pause All");
    const nowDisabled = await ResearchMonitor.findOne({ workspaceId }).lean();
    assert.equal(nowDisabled.enabled, false);

    console.log("AI & Acquisition Controls routes: RBAC gate, Gemini config round-trip, aggregated provider health with no credential leakage, and workspace-scoped Pause All all passed.");
  } finally {
    await ResearchMonitor.deleteMany({ workspaceId: { $in: [workspaceId, foreignWorkspaceId] } });
    await WorkspaceConfig.deleteMany({ workspaceId });
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
