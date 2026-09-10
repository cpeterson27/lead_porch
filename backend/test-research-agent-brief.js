// Regression coverage for the new Research Agent "summarize this week's Discovery findings" feature:
// 1. services/agentToolRegistry.js: research.list_recent_signals must scope by workspace and window.
// 2. routes/audience.js POST /research/weekly-brief: deterministic short-circuit on an empty week
//    (never spends an OpenAI call for nothing to summarize), correct grounding tool call otherwise,
//    and clean billing-error mapping.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/audience");
const toolRegistry = require("./services/agentToolRegistry");
const agentExecutionService = require("./services/agentExecutionService");
const IntentSignal = require("./models/IntentSignal");
const ResearchMonitor = require("./models/ResearchMonitor");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const otherWorkspaceId = new mongoose.Types.ObjectId();
  const originalRunAgent = agentExecutionService.runAgent;

  const monitor = await ResearchMonitor.create({ workspaceId, name: "Test Monitor", query: "test query" });
  const recentSignal = await IntentSignal.create({ workspaceId, monitorId: monitor._id, source: "reddit_rss", sourceId: "s1", sourceUrl: "https://reddit.com/r/test/1", title: "Looking for a coach", classification: "buyer_intent", score: 80, discoveredAt: new Date() });
  await IntentSignal.create({ workspaceId, monitorId: monitor._id, source: "reddit_rss", sourceId: "s2", sourceUrl: "https://reddit.com/r/test/2", title: "Old signal", classification: "buyer_intent", score: 40, discoveredAt: new Date(Date.now() - 40 * 86400000) });
  await IntentSignal.create({ workspaceId: otherWorkspaceId, monitorId: monitor._id, source: "reddit_rss", sourceId: "s3", sourceUrl: "https://reddit.com/r/test/3", title: "Other workspace signal", classification: "buyer_intent", score: 90, discoveredAt: new Date() });

  try {
    // 1. Tool-level: workspace scoping and window filtering.
    const listRecentSignals = toolRegistry.getTool("research.list_recent_signals");
    const results = await listRecentSignals.handler({ workspaceId, input: { days: 7 }, models: { IntentSignal } });
    assert.equal(results.length, 1, "must only return this workspace's signals within the window");
    assert.equal(results[0].title, "Looking for a coach");

    // 2. Route-level: an empty week must short-circuit deterministically, without calling the agent.
    let agentCalled = false;
    agentExecutionService.runAgent = async () => { agentCalled = true; return { output: {} }; };
    const emptyWorkspaceId = new mongoose.Types.ObjectId();
    const emptyLayer = router.stack.find((l) => l.route && l.route.path === "/research/weekly-brief" && l.route.methods.post);
    const emptyReq = { auth: { workspaceId: String(emptyWorkspaceId), user: { _id: "u1" }, effectivePermissions: ["discovery.manage"] }, body: {} };
    const emptyRes = fakeRes();
    await emptyLayer.route.stack[0].handle(emptyReq, emptyRes, (error) => { if (error) throw error; });
    assert.equal(emptyRes.statusCode, 200);
    assert.equal(emptyRes.body.signalCount, 0);
    assert.match(emptyRes.body.data.summary, /No Discovery signals/);
    assert.equal(agentCalled, false, "an empty week must never call the agent");

    // 3. Route-level: a real week grounds the Research Agent in the real signals via the tool.
    let capturedRequest = null;
    agentExecutionService.runAgent = async (request) => { capturedRequest = request; return { output: { summary: "One strong buyer-intent signal this week.", topFindings: [{ title: "Looking for a coach", why: "High score, direct buyer language" }], recommendedFollowUps: ["Review and qualify this signal"] } }; };
    const req = { auth: { workspaceId: String(workspaceId), user: { _id: "u1" }, effectivePermissions: ["discovery.manage"] }, body: {} };
    const res = fakeRes();
    await emptyLayer.route.stack[0].handle(req, res, (error) => { if (error) throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.signalCount, 1);
    assert.equal(res.body.data.summary, "One strong buyer-intent signal this week.");
    assert.equal(capturedRequest.agent, "research");
    assert.deepEqual(capturedRequest.options.tools.map((t) => t.toolId), ["research.list_recent_signals"]);

    // 4. Billing failure surfaces as a clean 429.
    agentExecutionService.runAgent = async () => { throw Object.assign(new Error("no credits"), { status: 429 }); };
    const billingRes = fakeRes();
    await emptyLayer.route.stack[0].handle(req, billingRes, (error) => { if (error) throw error; });
    assert.equal(billingRes.statusCode, 429);
  } finally {
    agentExecutionService.runAgent = originalRunAgent;
    await IntentSignal.deleteMany({ workspaceId: { $in: [workspaceId, otherWorkspaceId] } });
    await ResearchMonitor.deleteMany({ workspaceId });
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Research Agent weekly brief: workspace scoping, deterministic empty-week short-circuit, real grounding, and billing-error mapping all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
