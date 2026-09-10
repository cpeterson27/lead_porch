// Regression coverage for moving POST /social-workspace/generate ("Generate post" and friends)
// off a raw, ungrounded llmService.chat() call and onto the real Content Agent, so drafting is
// grounded in real workspace analytics/campaigns and usage is attributed to the content agent
// instead of silently defaulting to agent "jarvis".
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/socialWorkspace");
const agentExecutionService = require("./services/agentExecutionService");
const llmService = require("./services/llmService");
const WorkspaceConfig = require("./models/WorkspaceConfig");
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
  const originalIsEnabled = llmService.isEnabled;
  const originalRunAgent = agentExecutionService.runAgent;

  try {
    await WorkspaceConfig.create({ workspaceId, key: "primary", workspaceName: "Ellie's Coaching Test" });
    await CoachingProgram.create({ workspaceId, name: "Test Bootcamp" });

    const layer = router.stack.find((l) => l.route && l.route.path === "/generate" && l.route.methods.post);
    const auth = { workspaceId: String(workspaceId), user: { _id: "u1" }, effectivePermissions: ["social.manage"] };

    // 1. The route must call the real Content Agent, grounded with real analytics/campaign tools.
    let capturedRequest = null;
    agentExecutionService.runAgent = async (request) => { capturedRequest = request; return { output: "Grounded, analytics-aware caption." }; };
    llmService.isEnabled = () => true;
    const req = { auth, body: { action: "Generate post", instructions: "Promote the new cohort" }, get: () => "" };
    const res = fakeRes();
    let nextError = null;
    await layer.route.stack[0].handle(req, res, (error) => { nextError = error; });
    assert.equal(nextError, null, nextError?.message);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.body, "Grounded, analytics-aware caption.");
    assert.equal(capturedRequest.agent, "content", "generation must be attributed to the content agent, not jarvis");
    assert.equal(String(capturedRequest.workspaceId), String(workspaceId));
    assert.deepEqual(capturedRequest.options.tools.map((t) => t.toolId), ["growth.analytics", "growth.list_campaigns"], "drafting must be grounded in real analytics and campaigns");
    assert.equal(capturedRequest.input.instructions, "Promote the new cohort");

    // 1b. When the caller also has coaching visibility, drafting must additionally be grounded in
    // the aggregated, anonymized success-patterns tool (never for a caller without that permission).
    const coachingAuth = { ...auth, effectivePermissions: ["social.manage", "coaching.view"] };
    const coachingReq = { auth: coachingAuth, body: { action: "Generate post", instructions: "Promote the new cohort" }, get: () => "" };
    const coachingRes = fakeRes();
    await layer.route.stack[0].handle(coachingReq, coachingRes, (error) => { if (error) throw error; });
    assert.deepEqual(capturedRequest.options.tools.map((t) => t.toolId), ["growth.analytics", "growth.list_campaigns", "coaching.get_success_patterns"], "a caller with coaching visibility must also get success-pattern grounding");

    // 2. Unsupported actions must still be rejected before any agent call.
    let secondCallHappened = false;
    agentExecutionService.runAgent = async () => { secondCallHappened = true; return { output: "" }; };
    const badReq = { auth, body: { action: "Not a real action" }, get: () => "" };
    const badRes = fakeRes();
    await layer.route.stack[0].handle(badReq, badRes, () => {});
    assert.equal(badRes.statusCode, 400);
    assert.equal(secondCallHappened, false);

    // 3. When OpenAI is not enabled at all, the route must return its friendly 409 without ever calling the agent.
    llmService.isEnabled = () => false;
    const disabledReq = { auth, body: { action: "Generate post" }, get: () => "" };
    const disabledRes = fakeRes();
    await layer.route.stack[0].handle(disabledReq, disabledRes, () => {});
    assert.equal(disabledRes.statusCode, 409);
    assert.equal(secondCallHappened, false);
  } finally {
    llmService.isEnabled = originalIsEnabled;
    agentExecutionService.runAgent = originalRunAgent;
    await WorkspaceConfig.deleteMany({ workspaceId });
    await CoachingProgram.deleteMany({ workspaceId });
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Content Agent generate route: real agent grounding, attribution, and existing guardrails all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
