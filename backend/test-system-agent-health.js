// Regression coverage for the System Agent "Lead Operations Guardian":
// 1. services/systemAgentHealthService.js: each deterministic check fires on the right fixture data,
//    stays silent on a clean workspace, and findings are ranked by score (urgency/revenue/count/age/blocking).
// 2. routes/systemAgent.js: GET /pipeline-health requires the system.monitor capability and returns the
//    same report the service produces.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/systemAgent");
const systemAgentHealthService = require("./services/systemAgentHealthService");
const Contact = require("./models/Contact");
const SalesOpportunity = require("./models/SalesOpportunity");
const PipelineStage = require("./models/PipelineStage");
const CoachingApplication = require("./models/CoachingApplication");
const Enrollment = require("./models/Enrollment");
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

  try {
    // 1. A clean workspace produces no findings.
    const clean = await systemAgentHealthService.getLeadPipelineHealth(workspaceId);
    assert.equal(clean.summary.total, 0, "a workspace with no data should have zero findings");
    assert.deepEqual(clean.findings, []);

    // 2. Build fixtures that should each trigger exactly one known finding.
    const wonStage = await PipelineStage.create({ workspaceId, key: "won", label: "Won", order: 9, terminal: "won" });

    const incompleteContact = await Contact.create({ workspaceId, name: "No Contact Info", status: "active" });
    const qualifiedContact = await Contact.create({ workspaceId, name: "Qualified No Opp", status: "active", researchStatus: "qualified", email: "qualified@example.com" });
    const wonContact = await Contact.create({ workspaceId, name: "Won No Coaching", status: "active", email: "won@example.com" });

    const unassignedOpp = await SalesOpportunity.create({ workspaceId, name: "Unassigned Deal", stageKey: "new", value: 5000 });
    const wonOpp = await SalesOpportunity.create({ workspaceId, name: "Won Deal", stageKey: "won", value: 8000, primaryContactId: wonContact._id, wonAt: new Date() });

    await CoachingApplication.create({
      workspaceId, contactId: incompleteContact._id, status: "submitted",
      submittedAt: new Date(Date.now() - 5 * 86400000),
      consent: { privacyTerms: true, capturedAt: new Date() },
      idempotencyKey: `test-${incompleteContact._id}`,
    });

    const report = await systemAgentHealthService.getLeadPipelineHealth(workspaceId);
    const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));

    assert.ok(byId.incomplete_contacts, "should flag the contact with no email or phone");
    assert.equal(byId.incomplete_contacts.count, 1);
    assert.equal(String(byId.incomplete_contacts.affectedRecords[0].id), String(incompleteContact._id));

    assert.ok(byId.qualified_without_opportunity, "should flag a qualified contact with no opportunity");
    assert.equal(String(byId.qualified_without_opportunity.affectedRecords[0].id), String(qualifiedContact._id));

    assert.ok(byId.unassigned_opportunities, "should flag the ownerless open opportunity");
    assert.equal(byId.unassigned_opportunities.revenueImpact, 5000);
    assert.equal(String(byId.unassigned_opportunities.affectedRecords[0].id), String(unassignedOpp._id));

    assert.ok(byId.unreviewed_applications, "should flag the application sitting unreviewed for 3+ days");

    assert.ok(byId.won_without_coaching, "should flag the won deal with no coaching enrollment");
    assert.equal(String(byId.won_without_coaching.affectedRecords[0].id), String(wonOpp._id));

    // Every finding must carry the required safety/reporting shape.
    for (const f of report.findings) {
      assert.equal(f.approvalRequired, true, `${f.id} must always require human approval`);
      assert.ok(["critical", "high", "medium", "low"].includes(f.severity));
      assert.ok(Array.isArray(f.links) && f.links.length >= 1, `${f.id} must include at least one direct link`);
      assert.ok(typeof f.recommendedAction === "string" && f.recommendedAction.length > 0);
    }

    // Findings must be ranked highest-score first.
    const scores = report.findings.map((f) => f.score);
    const sorted = [...scores].sort((a, b) => b - a);
    assert.deepEqual(scores, sorted, "findings must be sorted by descending score");

    // 3. Once the won deal gets a real enrollment, that specific finding must clear.
    const program = await CoachingProgram.create({ workspaceId, name: "Test Program", version: 1 });
    await Enrollment.create({ workspaceId, contactId: wonContact._id, coachingProgramId: program._id, sourceOpportunityId: wonOpp._id, startsAt: new Date(), programVersion: 1, programSnapshot: { name: "Test Program" } });
    const afterHandoff = await systemAgentHealthService.getLeadPipelineHealth(workspaceId);
    assert.ok(!afterHandoff.findings.some((f) => f.id === "won_without_coaching"), "won_without_coaching must clear once an enrollment exists");

    // 4. Route-level: capability enforcement.
    const layer = router.stack.find((l) => l.route && l.route.path === "/pipeline-health" && l.route.methods.get);
    const capabilityMiddleware = router.stack.find((l) => !l.route && typeof l.handle === "function");
    const forbiddenReq = { auth: { workspaceId: String(workspaceId), user: { _id: "u1" }, effectivePermissions: [] } };
    const forbiddenRes = fakeRes();
    let forbiddenNextCalled = false;
    capabilityMiddleware.handle(forbiddenReq, forbiddenRes, () => { forbiddenNextCalled = true; });
    assert.equal(forbiddenRes.statusCode, 403, "system.monitor must be required");
    assert.equal(forbiddenNextCalled, false);

    const allowedReq = { auth: { workspaceId: String(workspaceId), user: { _id: "u1" }, effectivePermissions: ["system.monitor"] } };
    const allowedRes = fakeRes();
    let allowedNextCalled = false;
    capabilityMiddleware.handle(allowedReq, allowedRes, () => { allowedNextCalled = true; });
    assert.equal(allowedNextCalled, true, "a caller with system.monitor must pass the gate");

    const routeRes = fakeRes();
    await layer.route.stack[0].handle(allowedReq, routeRes, (error) => { if (error) throw error; });
    assert.equal(routeRes.statusCode, 200);
    assert.equal(routeRes.body.data.summary.total, afterHandoff.summary.total);
  } finally {
    await Promise.all([
      Contact.deleteMany({ workspaceId }),
      SalesOpportunity.deleteMany({ workspaceId }),
      PipelineStage.deleteMany({ workspaceId }),
      CoachingApplication.deleteMany({ workspaceId }),
      Enrollment.deleteMany({ workspaceId }),
      CoachingProgram.deleteMany({ workspaceId }),
    ]);
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("System Agent pipeline health: deterministic checks, ranking, safety shape, and capability enforcement all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
