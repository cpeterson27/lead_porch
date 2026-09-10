// Regression coverage for the search-quality feedback loop: monitor performance must be measured
// by real downstream outcomes (opportunities, enrollments, won revenue), not raw result volume,
// and recommendations must be evidence-based and deterministic (no OpenAI required).
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const searchQualityService = require("./services/searchQualityService");
const router = require("./routes/audience");
const agentExecutionService = require("./services/agentExecutionService");
const ResearchMonitor = require("./models/ResearchMonitor");
const IntentSignal = require("./models/IntentSignal");
const SalesOpportunity = require("./models/SalesOpportunity");
const Enrollment = require("./models/Enrollment");
const CoachingProgram = require("./models/CoachingProgram");
const Contact = require("./models/Contact");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const originalRunAgent = agentExecutionService.runAgent;

  const productiveMonitor = await ResearchMonitor.create({ workspaceId, name: "Productive Monitor", monitorType: "buyer_intent", query: "test", keywords: ["test"], enabled: true, lastRunStatus: "completed" });
  const noisyMonitor = await ResearchMonitor.create({ workspaceId, name: "Noisy Monitor", monitorType: "buyer_intent", query: "test", keywords: ["test"], enabled: true, lastRunStatus: "completed" });
  const failedMonitor = await ResearchMonitor.create({ workspaceId, name: "Failed Monitor", monitorType: "buyer_intent", query: "test", keywords: ["test"], enabled: true, lastRunStatus: "failed" });

  // Productive monitor: real signals -> real opportunity -> real enrollment -> real revenue.
  await IntentSignal.create({ workspaceId, monitorId: productiveMonitor._id, source: "reddit_rss", sourceId: "p1", sourceUrl: "https://reddit.com/p1", title: "Need help", excerpt: "I need help underwriting my first multifamily deal, I'm overwhelmed and ready to invest in coaching.", status: "qualified", score: 80 });
  const contact = await Contact.create({ workspaceId, name: "Won Student", status: "active" });
  const opportunity = await SalesOpportunity.create({ workspaceId, name: "Won deal", stageKey: "won", value: 15000, primaryContactId: contact._id, leadAttribution: { monitorId: productiveMonitor._id } });
  await Enrollment.create({ workspaceId, contactId: contact._id, coachingProgramId: new mongoose.Types.ObjectId(), sourceOpportunityId: opportunity._id, startsAt: new Date(), programVersion: 1, programSnapshot: { name: "Test" } });

  // Noisy monitor: mostly rejected, no conversions.
  for (let i = 0; i < 18; i += 1) {
    await IntentSignal.create({ workspaceId, monitorId: noisyMonitor._id, source: "reddit_rss", sourceId: `noisy${i}`, sourceUrl: `https://reddit.com/noisy${i}`, bucket: i < 16 ? "rejected" : "live_lead", status: "new", score: i < 16 ? 0 : 70 });
  }

  await CoachingProgram.create({ workspaceId, status: "active", name: "6-Week Coaching - Acquisitions", internalSummary: "Buy box, underwriting." });

  try {
    // 1. Monitor performance must reflect real outcomes.
    const performance = await searchQualityService.getMonitorPerformance(workspaceId);
    const productive = performance.find((m) => String(m.monitorId) === String(productiveMonitor._id));
    assert.equal(productive.enrolled, 1);
    assert.equal(productive.wonRevenue, 15000);
    assert.equal(productive.buckets.live_lead, 1);

    const noisy = performance.find((m) => String(m.monitorId) === String(noisyMonitor._id));
    assert.equal(noisy.totalCandidates, 18);
    assert.ok(noisy.rejectionRate >= 85, `expected high rejection rate, got ${noisy.rejectionRate}`);
    assert.equal(noisy.enrolled, 0);

    // The most valuable monitor (real revenue) must rank first, not the one with the most raw candidates.
    assert.equal(String(performance[0].monitorId), String(productiveMonitor._id), "monitors must be ranked by real revenue/enrollment, not raw candidate volume");

    // 2. Recommendations must be evidence-based and catch the real issues seeded above.
    const recommendations = searchQualityService.recommendationsFor(performance);
    assert.ok(recommendations.some((r) => String(r.monitorId) === String(noisyMonitor._id) && r.issue === "high_rejection_rate"));
    assert.ok(recommendations.some((r) => String(r.monitorId) === String(productiveMonitor._id) && r.issue === "no_conversions") === false, "a monitor with a real enrollment must not be flagged as having no conversions");
    assert.ok(recommendations.some((r) => String(r.monitorId) === String(failedMonitor._id) && r.issue === "monitor_failing"));

    // 3. The route must expose the same data.
    const perfLayer = router.stack.find((l) => l.route && l.route.path === "/research/monitor-performance" && l.route.methods.get);
    const perfReq = { auth: { workspaceId: String(workspaceId) } };
    const perfRes = fakeRes();
    await perfLayer.route.stack[0].handle(perfReq, perfRes, (error) => { if (error) throw error; });
    assert.equal(perfRes.statusCode, 200);
    assert.equal(perfRes.body.performance.length, 3);
    assert.ok(perfRes.body.recommendations.length >= 2);

    // 4. Strategy recommendations must ground the Research Agent in the real performance + program data.
    let capturedRequest = null;
    agentExecutionService.runAgent = async (request) => { capturedRequest = request; return { output: { summary: "ok", coverageGaps: [], monitorsToReview: [], suggestedSearches: [] } }; };
    const strategyLayer = router.stack.find((l) => l.route && l.route.path === "/research/strategy-recommendations" && l.route.methods.post);
    const strategyReq = { auth: { workspaceId: String(workspaceId), user: { _id: "u1" } } };
    const strategyRes = fakeRes();
    await strategyLayer.route.stack[0].handle(strategyReq, strategyRes, (error) => { if (error) throw error; });
    assert.equal(strategyRes.statusCode, 200);
    assert.equal(capturedRequest.agent, "research");
    assert.deepEqual(capturedRequest.options.tools.map((t) => t.toolId), ["research.get_monitor_performance", "research.list_recent_signals"]);
    assert.equal(capturedRequest.input.programs[0].name, "6-Week Coaching - Acquisitions");
  } finally {
    agentExecutionService.runAgent = originalRunAgent;
    await Promise.all([
      ResearchMonitor.deleteMany({ workspaceId }),
      IntentSignal.deleteMany({ workspaceId }),
      SalesOpportunity.deleteMany({ workspaceId }),
      Enrollment.deleteMany({ workspaceId }),
      CoachingProgram.deleteMany({ workspaceId }),
      Contact.deleteMany({ workspaceId }),
    ]);
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Search-quality feedback loop: outcome-based ranking, evidence-based recommendations, and Research Agent strategy grounding all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
