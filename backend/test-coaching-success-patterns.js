// Regression coverage for the Coaching Agent aggregated, anonymized success-patterns feature:
// completion rates, common cancellation stages, and per-program breakdown must all be computed
// from real enrollment data, and must never expose any individual student's name or identity.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { createCoachingRouter } = require("./routes/coaching");
const coachingSuccessPatternsService = require("./services/coachingSuccessPatternsService");
const Contact = require("./models/Contact");
const CoachingProgram = require("./models/CoachingProgram");
const Enrollment = require("./models/Enrollment");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

// Routes here are registered as `router.method(path, middleware, handler)`, so `route.stack` has
// more than one layer. Walk it in order the way Express would, stopping once a response is sent.
async function runRoute(layer, req, res) {
  for (const routeLayer of layer.route.stack) {
    let calledNext = false;
    let nextError = null;
    await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
    if (nextError) throw nextError;
    if (!calledNext) return;
  }
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();

  const program = await CoachingProgram.create({ workspaceId, status: "active", name: "6-Week Coaching - Acquisitions" });
  const studentA = await Contact.create({ workspaceId, name: "Completed Student", status: "active" });
  const studentB = await Contact.create({ workspaceId, name: "Cancelled Student", status: "active" });
  await Enrollment.create({ workspaceId, contactId: studentA._id, coachingProgramId: program._id, status: "completed", startsAt: new Date("2026-01-01"), completedAt: new Date("2026-02-12"), programVersion: 1, programSnapshot: { name: program.name } });
  await Enrollment.create({ workspaceId, contactId: studentB._id, coachingProgramId: program._id, status: "cancelled", currentStageKey: "underwriting", startsAt: new Date("2026-01-01"), programVersion: 1, programSnapshot: { name: program.name } });

  try {
    // 1. Aggregates must be correct and must never contain a student's name.
    const patterns = await coachingSuccessPatternsService.getSuccessPatterns(workspaceId);
    assert.equal(patterns.totalEnrollments, 2);
    assert.equal(patterns.completed, 1);
    assert.equal(patterns.cancelled, 1);
    assert.equal(patterns.completionRate, 50);
    assert.equal(patterns.avgCompletionDays, 42, "Jan 1 to Feb 12 is 42 days");
    assert.equal(patterns.commonCancelStages[0].key, "underwriting");
    assert.equal(patterns.byProgram[0].program, "6-Week Coaching - Acquisitions");
    assert.equal(patterns.byProgram[0].totalEnrollments, 2);
    const serialized = JSON.stringify(patterns);
    assert.ok(!serialized.includes("Completed Student"), "no student name may appear in aggregated patterns");
    assert.ok(!serialized.includes("Cancelled Student"), "no student name may appear in aggregated patterns");

    // 2. Route-level: admin-only, and returns the same aggregate data.
    const router = createCoachingRouter();
    const layer = router.stack.find((l) => l.route && l.route.path === "/success-patterns" && l.route.methods.get);
    const forbiddenReq = { auth: { workspaceId: String(workspaceId), role: "coach", effectivePermissions: ["coaching.view_assigned"] } };
    const forbiddenRes = fakeRes();
    await runRoute(layer, forbiddenReq, forbiddenRes);
    assert.equal(forbiddenRes.statusCode, 403);

    const adminReq = { auth: { workspaceId: String(workspaceId), role: "admin", effectivePermissions: ["coaching.view"] } };
    const adminRes = fakeRes();
    await runRoute(layer, adminReq, adminRes);
    assert.equal(adminRes.statusCode, 200);
    assert.equal(adminRes.body.data.totalEnrollments, 2);

    // 3. The AI summary route must ground itself in the same aggregated tool, never raw student records.
    let capturedRequest = null;
    const aiRouter = createCoachingRouter({ agentExecutionService: { async runAgent(request) { capturedRequest = request; return { output: { summary: "Half of students complete the program.", strengths: [], riskAreas: ["Underwriting stage sees dropout"] } }; } } });
    const aiLayer = aiRouter.stack.find((l) => l.route && l.route.path === "/success-patterns/summarize" && l.route.methods.post);
    const aiReq = { auth: { workspaceId: String(workspaceId), role: "admin", user: { _id: "u1" }, effectivePermissions: ["coaching.view"] } };
    const aiRes = fakeRes();
    await runRoute(aiLayer, aiReq, aiRes);
    assert.equal(aiRes.statusCode, 200);
    assert.equal(capturedRequest.agent, "coaching");
    assert.deepEqual(capturedRequest.options.tools.map((t) => t.toolId), ["coaching.get_success_patterns"]);
  } finally {
    await Promise.all([
      Contact.deleteMany({ workspaceId }),
      CoachingProgram.deleteMany({ workspaceId }),
      Enrollment.deleteMany({ workspaceId }),
    ]);
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Coaching success-patterns: aggregation accuracy, anonymization, admin gating, and AI grounding all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
