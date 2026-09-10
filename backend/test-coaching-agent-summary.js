// Regression coverage for the new Coaching Agent "summarize this student" feature:
// POST /coaching/students/:contactId/ai-summary reads the student's real enrollments, coach
// assignments, and recent notes, and grounds the Coaching Agent's session-prep brief in them.
// Read-only — proposes nothing, changes nothing.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { createCoachingRouter } = require("./routes/coaching");
const Contact = require("./models/Contact");
const CoachingProgram = require("./models/CoachingProgram");
const Enrollment = require("./models/Enrollment");
const CoachProfile = require("./models/CoachProfile");
const CoachAssignment = require("./models/CoachAssignment");
const CoachingNote = require("./models/CoachingNote");
const User = require("./models/User");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();

  const student = await Contact.create({ workspaceId, name: "Session Prep Student", status: "active" });
  const program = await CoachingProgram.create({ workspaceId, name: "Signature Bootcamp" });
  const enrollment = await Enrollment.create({ workspaceId, contactId: student._id, coachingProgramId: program._id, status: "active", startsAt: new Date(), programVersion: 1, programSnapshot: { name: "Signature Bootcamp" }, currentStageKey: "onboarding" });
  const coachUser = await User.create({ email: `coach-${Date.now()}@example.com`, passwordHash: "x".repeat(20), name: "Coach Test" });
  const coachProfile = await CoachProfile.create({ workspaceId, userId: coachUser._id, displayName: "Coach Test" });
  await CoachAssignment.create({ workspaceId, contactId: student._id, enrollmentId: enrollment._id, coachProfileId: coachProfile._id, coachUserId: coachUser._id, status: "active", stageKey: "onboarding", startsAt: new Date(), sequence: 0 });
  await CoachingNote.create({ workspaceId, contactId: student._id, enrollmentId: enrollment._id, coachAssignmentId: null, authorUserId: coachUser._id, body: "Student is engaged and ahead of schedule on module 1." });

  try {
    let capturedRequest = null;
    const router = createCoachingRouter({
      agentExecutionService: {
        async runAgent(request) {
          capturedRequest = request;
          return { output: { summary: "Doing well.", currentStanding: "On track", suggestedFocusAreas: ["Module 2"], riskFlags: [] }, metadata: { agent: "coaching" } };
        },
      },
    });
    const layer = router.stack.find((l) => l.route && l.route.path === "/students/:contactId/ai-summary" && l.route.methods.post);

    // 1. Invalid contact ID -> 400.
    const badReq = { params: { contactId: "not-an-id" }, auth: { workspaceId: String(workspaceId), role: "admin", effectivePermissions: ["coaching.view"] } };
    const badRes = fakeRes();
    await layer.route.stack[0].handle(badReq, badRes, (error) => { if (error) throw error; });
    assert.equal(badRes.statusCode, 400);

    // 2. Contact from another workspace -> 404, never leaks cross-tenant data.
    const otherWorkspaceReq = { params: { contactId: String(student._id) }, auth: { workspaceId: String(new mongoose.Types.ObjectId()), role: "admin", effectivePermissions: ["coaching.view"] } };
    const otherWorkspaceRes = fakeRes();
    await layer.route.stack[0].handle(otherWorkspaceReq, otherWorkspaceRes, (error) => { if (error) throw error; });
    assert.equal(otherWorkspaceRes.statusCode, 404);
    assert.equal(capturedRequest, null, "the agent must never be called for a contact outside the caller's workspace");

    // 3. A valid request grounds the Coaching Agent in the real enrollment, assignment, and note data.
    const req = { params: { contactId: String(student._id) }, auth: { workspaceId: String(workspaceId), role: "admin", user: { _id: coachUser._id }, effectivePermissions: ["coaching.view"] } };
    const res = fakeRes();
    await layer.route.stack[0].handle(req, res, (error) => { if (error) throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.summary, "Doing well.");
    assert.equal(capturedRequest.agent, "coaching");
    const context = JSON.parse(capturedRequest.operationalContext.match(/Student context: (.+)$/)[1]);
    assert.equal(context.student.displayName, "Session Prep Student");
    assert.equal(context.enrollments[0].program, "Signature Bootcamp");
    assert.equal(context.enrollments[0].currentStageKey, "onboarding");
    assert.equal(context.coachAssignments[0].coach, "Coach Test");
    assert.equal(context.recentNotes[0].note, "Student is engaged and ahead of schedule on module 1.");

    // 4. A billing failure from the agent must surface as a clean 429, not a generic 500.
    const billingRouter = createCoachingRouter({ agentExecutionService: { async runAgent() { throw Object.assign(new Error("no credits"), { status: 429 }); } } });
    const billingLayer = billingRouter.stack.find((l) => l.route && l.route.path === "/students/:contactId/ai-summary" && l.route.methods.post);
    const billingRes = fakeRes();
    await billingLayer.route.stack[0].handle(req, billingRes, (error) => { if (error) throw error; });
    assert.equal(billingRes.statusCode, 429);
  } finally {
    await Promise.all([
      Contact.deleteMany({ workspaceId }),
      CoachingProgram.deleteMany({ workspaceId }),
      Enrollment.deleteMany({ workspaceId }),
      CoachProfile.deleteMany({ workspaceId }),
      CoachAssignment.deleteMany({ workspaceId }),
      CoachingNote.deleteMany({ workspaceId }),
      User.deleteOne({ _id: coachUser._id }),
    ]);
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Coaching Agent student summary: grounding, workspace isolation, and billing-error mapping all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
