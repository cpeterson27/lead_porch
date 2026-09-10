// Regression coverage for the Content Agent campaign-automation recommender: Content Agent
// proposes a complete, safe automation plan (never auto-activated), and Social Agent's own real
// capability matrix validates whether it's actually executable today — this route only ever
// recommends, it never creates or activates an automation.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/socialAutomation");
const agentExecutionService = require("./services/agentExecutionService");
const SocialConnection = require("./models/SocialConnection");
const SocialAutomation = require("./models/SocialAutomation");
const ContentBrief = require("./models/ContentBrief");

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

const fixtureRecommendation = {
  triggerType: "comment_keyword", keywords: ["DEAL"],
  publicAcknowledgement: "Thanks! Check your DMs.", privateMessage: "Here's the link to apply: https://leadporch.co/apply",
  crmActions: { createOrUpdateContact: true, tags: ["social-deal-lead"], qualificationSignals: ["commented DEAL"] },
  followUp: "Follow up in 24h if no response", exclusions: ["existing students"],
  cooldownMinutes: 60, dailyLimit: 50,
  stopConditions: ["response_received", "opt_out", "frequency_limit"],
  optOutHandling: "Stop immediately on any negative or unsubscribe reply", humanHandoff: "Escalate to a human if the lead asks a pricing question we can't template",
  rationale: "This is a well-established DEAL keyword pattern grounded in your recent post.",
};

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const originalRunAgent = agentExecutionService.runAgent;

  const connectedConnection = await SocialConnection.create({ workspaceId, provider: "meta", status: "connected", authorization: { valid: true }, scopes: ["pages_manage_posts"], assets: [{ id: "page1", name: "Test Page", type: "facebook_page" }], selectedAssetIds: ["page1"], connectedByUserId: new mongoose.Types.ObjectId() });
  const brief = await ContentBrief.create({ workspaceId, title: "DEAL promo", type: "social", body: "Comment DEAL for the link", createdBy: new mongoose.Types.ObjectId(), updatedBy: new mongoose.Types.ObjectId() });

  try {
    let capturedRequest = null;
    agentExecutionService.runAgent = async (request) => { capturedRequest = request; return { output: fixtureRecommendation, metadata: { agent: "content" } }; };

    // 1. A connected, capable provider must be validated as executable.
    const req = { auth: { workspaceId: String(workspaceId), user: { _id: "u1" }, effectivePermissions: ["social.manage"] }, body: { contentBriefId: String(brief._id), provider: "facebook" } };
    const res = await runRoute("/recommend", "post", req);
    assert.equal(res.statusCode, 200);
    assert.equal(capturedRequest.agent, "content", "recommendations must come from the Content Agent");
    assert.deepEqual(res.body.data.recommendation, fixtureRecommendation);
    assert.equal(res.body.data.validation.status, "executable");
    assert.equal(res.body.data.validation.asset.id, "page1");

    // 2. Nothing was created or activated — this route is recommend-only.
    assert.equal(await SocialAutomation.countDocuments({ workspaceId }), 0, "recommending an automation must never create or activate one");

    // 3. An unconfigured provider must be validated as not executable, even though the
    //    recommendation itself still comes back for review.
    const igReq = { auth: { workspaceId: String(workspaceId), user: { _id: "u1" }, effectivePermissions: ["social.manage"] }, body: { provider: "instagram" } };
    const igRes = await runRoute("/recommend", "post", igReq);
    assert.equal(igRes.body.data.validation.status, "not_executable");

    // 4. Capability gate: no social.manage -> 403.
    const forbiddenRes = await runRoute("/recommend", "post", { auth: { workspaceId: String(workspaceId), effectivePermissions: [] }, body: { provider: "facebook" } });
    assert.equal(forbiddenRes.statusCode, 403);

    // 5. Invalid provider -> 400, agent never called.
    let secondCallHappened = false;
    agentExecutionService.runAgent = async () => { secondCallHappened = true; };
    const badRes = await runRoute("/recommend", "post", { auth: { workspaceId: String(workspaceId), user: { _id: "u1" }, effectivePermissions: ["social.manage"] }, body: { provider: "tiktok" } });
    assert.equal(badRes.statusCode, 400);
    assert.equal(secondCallHappened, false);
  } finally {
    agentExecutionService.runAgent = originalRunAgent;
    await SocialConnection.deleteMany({ workspaceId });
    await SocialAutomation.deleteMany({ workspaceId });
    await ContentBrief.deleteMany({ workspaceId });
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Campaign automation recommender: Content Agent proposal, real Social Agent capability validation, recommend-only (never auto-activates), and capability gating all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
