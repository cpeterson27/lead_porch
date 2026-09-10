// Regression coverage for GET /audience/research/signals bucket support: rejected and
// watchlisted signals must actually be returned (with their reason) when requested by bucket,
// instead of being silently filtered out by the legacy "accepted live lead" pipeline.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/audience");
const IntentSignal = require("./models/IntentSignal");
const ResearchMonitor = require("./models/ResearchMonitor");
const CoachingProgram = require("./models/CoachingProgram");

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

  const monitor = await ResearchMonitor.create({ workspaceId, name: "Test monitor", monitorType: "buyer_intent", query: "multifamily", keywords: ["multifamily", "underwriting"], enabled: true, intervalMinutes: 60 });

  const liveLead = await IntentSignal.create({ workspaceId, monitorId: monitor._id, source: "reddit_rss", sourceId: "live1", sourceUrl: "https://reddit.com/r/re/live1", title: "Need help", excerpt: "I need help underwriting my first multifamily deal, I'm overwhelmed and ready to invest in coaching.", classification: "buyer_intent", score: 80, bucket: "live_lead" });
  const watchlisted = await IntentSignal.create({ workspaceId, monitorId: monitor._id, source: "reddit_rss", sourceId: "watch1", sourceUrl: "https://reddit.com/r/re/watch1", title: "Exploring", excerpt: "I'm exploring multifamily investing and thinking about my next move into apartments.", classification: "uncertain", score: 55, bucket: "watchlist" });
  const rejectedSignal = await IntentSignal.create({ workspaceId, monitorId: monitor._id, source: "reddit_rss", sourceId: "reject1", sourceUrl: "https://reddit.com/r/re/reject1", title: "Financing help", excerpt: "I'm a mortgage broker helping multifamily investors get financing for their first deal.", classification: "irrelevant", score: 0, bucket: "rejected", rejectionReason: "vendor_lender_agent_recruiter" });
  await IntentSignal.create({ workspaceId: otherWorkspaceId, monitorId: monitor._id, source: "reddit_rss", sourceId: "otherws1", sourceUrl: "https://reddit.com/r/re/otherws1", title: "Other workspace", excerpt: "I'm a mortgage broker.", classification: "irrelevant", score: 0, bucket: "rejected", rejectionReason: "vendor_lender_agent_recruiter" });

  try {
    const layer = router.stack.find((l) => l.route && l.route.path === "/research/signals" && l.route.methods.get);
    const auth = { workspaceId: String(workspaceId), user: { _id: "u1" } };

    // 1. bucket=rejected must actually return the rejected signal with its reason, not filter it away.
    const rejectedReq = { auth, query: { bucket: "rejected" } };
    const rejectedRes = fakeRes();
    await layer.route.stack[0].handle(rejectedReq, rejectedRes, (error) => { if (error) throw error; });
    assert.equal(rejectedRes.statusCode, 200);
    assert.equal(rejectedRes.body.signals.length, 1, "only this workspace's rejected signal must be returned");
    assert.equal(rejectedRes.body.signals[0].rejectionReason, "vendor_lender_agent_recruiter");
    assert.equal(String(rejectedRes.body.signals[0]._id), String(rejectedSignal._id));
    assert.equal(rejectedRes.body.bucketSummary.rejected >= 1, true);

    // 2. bucket=watchlist must return the watchlisted signal.
    const watchlistReq = { auth, query: { bucket: "watchlist" } };
    const watchlistRes = fakeRes();
    await layer.route.stack[0].handle(watchlistReq, watchlistRes, (error) => { if (error) throw error; });
    assert.equal(watchlistRes.body.signals.length, 1);
    assert.equal(String(watchlistRes.body.signals[0]._id), String(watchlisted._id));

    // 3. Cross-workspace isolation: the other workspace's rejected signal must never appear.
    assert.ok(!rejectedRes.body.signals.some((s) => String(s._id) === "otherws1"));

    // 4. Default (no bucket param) request must still succeed for backward compatibility and
    //    surface the live lead through the existing accepted-signal pipeline.
    const defaultReq = { auth, query: {} };
    const defaultRes = fakeRes();
    await layer.route.stack[0].handle(defaultReq, defaultRes, (error) => { if (error) throw error; });
    assert.equal(defaultRes.statusCode, 200);
    assert.ok(defaultRes.body.signals.some((s) => String(s._id) === String(liveLead._id)), "the live lead must still surface through the default pipeline");
    assert.ok(defaultRes.body.bucketSummary, "bucketSummary must be present on the default response too");
  } finally {
    await IntentSignal.deleteMany({ workspaceId: { $in: [workspaceId, otherWorkspaceId] } });
    await ResearchMonitor.deleteMany({ workspaceId });
    await CoachingProgram.deleteMany({ workspaceId });
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Research signals bucket route: rejected/watchlist visibility, workspace isolation, and backward-compatible default pipeline all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
