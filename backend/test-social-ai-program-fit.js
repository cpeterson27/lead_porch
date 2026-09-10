// Regression coverage for the Social Agent upgrade: full-conversation analysis must also surface
// objections, urgency, and program fit — grounded in the workspace's real active coaching programs
// — not just intent/sentiment/lead potential.
const assert = require("node:assert/strict");
const service = require("./services/socialAiService");

const query = (value) => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => value });
const auth = (workspaceId) => ({ workspaceId, effectivePermissions: ["social.manage"] });

async function testProgramsInContext() {
  const deps = {
    ConversationThread: { findOne: () => query({ _id: "thread", channel: "instagram", status: "open", priority: "normal", contactIds: ["contact"], metadata: { interactionType: "message", contentId: "post" } }) },
    ConversationMessage: { find: () => query([{ _id: "m1", direction: "inbound", body: "I need help underwriting my first multifamily deal", createdAt: new Date() }]) },
    Contact: { findOne: () => query({ name: "Prospect" }) },
    SalesOpportunity: { findOne: () => query(null) },
    CoachingProgram: { find: () => query([{ name: "6-Week Coaching - Acquisitions", internalSummary: "Buy box, underwriting, LOIs." }]) },
  };
  const result = await service.sanitizedContext({ workspaceId: "ws", threadId: "thread" }, deps);
  assert.deepEqual(result.dto.programs, [{ name: "6-Week Coaching - Acquisitions", summary: "Buy box, underwriting, LOIs." }]);
}

async function testAnalysisFieldsPropagate() {
  let stored = null;
  const deps = {
    WorkspaceConfig: { findOne: () => query({ socialAi: { analysisEnabled: true, confidenceThreshold: .75 } }) },
    ConversationThread: { findOne: () => query({ _id: "thread", channel: "facebook", status: "open", priority: "normal", contactIds: ["contact"], metadata: { interactionType: "comment", contentId: "post-1" } }) },
    ConversationMessage: { find: () => query([{ _id: "message", direction: "inbound", body: "I love the program but $20k feels like too much for me right now, though I need help soon", createdAt: new Date() }]) },
    Contact: { findOne: () => query({ name: "Prospect" }) },
    SalesOpportunity: { findOne: () => query(null) },
    CoachingProgram: { find: () => query([{ name: "6-Week Coaching - Acquisitions", internalSummary: "Buy box, underwriting, LOIs." }]) },
    SocialAiAnalysis: {
      findOne: () => query(stored),
      create: async (values) => { stored = { _id: "analysis", ...values, save: async () => stored }; return stored; },
    },
    agentExecutionService: {
      runAgent: async (request) => {
        assert.match(request.operationalContext, /6-Week Coaching - Acquisitions/, "the AI must be grounded in the real active program list");
        return { output: { intent: "objection", confidence: .88, sentiment: "mixed", leadPotential: "medium", objections: ["Price feels too high"], urgency: "high", programFit: "6-Week Coaching - Acquisitions", qualificationSignals: ["wants help soon"], observedEvidence: ["I need help soon"], inference: [], recommendedAction: "Address the price objection and confirm urgency", suggestedReply: "Totally understand — want to talk through payment options?", requiresHuman: true, reason: "Explicit price objection with urgency" } };
      },
    },
    CrmActivity: {},
  };
  const result = await service.analyze({ workspaceId: "ws", userId: "user", auth: auth("ws"), threadId: "thread", action: "handle_objection", forceAi: true }, deps);
  assert.deepEqual(result.analysis.objections, ["Price feels too high"]);
  assert.equal(result.analysis.urgency, "high");
  assert.equal(result.analysis.programFit, "6-Week Coaching - Acquisitions");
}

Promise.resolve().then(testProgramsInContext).then(testAnalysisFieldsPropagate)
  .then(() => console.log("Social Agent program-fit upgrade: real program grounding, objections, and urgency all propagate correctly."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
