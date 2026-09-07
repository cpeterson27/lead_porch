const assert = require("assert");
const service = require("./services/socialAiService");

const query = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => value });
const auth = workspaceId => ({ workspaceId, effectivePermissions: ["social.manage"] });

async function testSanitizedContext() {
  const messages = Array.from({ length: 15 }, (_, index) => ({ _id: `m${index}`, direction: "inbound", body: `${"x".repeat(900)} secret-token-${index}`, createdAt: new Date(index) }));
  const deps = {
    ConversationThread: { findOne: () => query({ _id: "thread", channel: "instagram", status: "open", priority: "normal", contactIds: ["contact"], metadata: { interactionType: "message", contentId: "post" } }) },
    ConversationMessage: { find: () => query(messages) },
    Contact: { findOne: () => query({ name: "Visible Name", email: "must-not-leak@example.com", phone: "555" }) },
    SalesOpportunity: { findOne: () => query(null) },
  };
  const result = await service.sanitizedContext({ workspaceId: "ws", threadId: "thread" }, deps);
  assert(result.dto.recentMessages.length <= 12);
  assert(result.dto.recentMessages.every(item => item.text.length <= 800));
  assert(result.dto.recentMessages.reduce((sum, item) => sum + item.text.length, 0) <= 6000);
  assert.equal(result.dto.contactDisplayName, "Visible Name");
  assert(!JSON.stringify(result.dto).includes("must-not-leak@example.com"));
}

async function testAnalyzeAndIdempotency() {
  let aiCalls = 0, creates = 0, updates = 0, stored = null;
  const deps = {
    WorkspaceConfig: { findOne: () => query({ socialAi: { analysisEnabled: true, confidenceThreshold: .75 } }) },
    ConversationThread: { findOne: () => query({ _id: "thread", channel: "facebook", status: "open", priority: "normal", contactIds: ["contact"], metadata: { interactionType: "comment", contentId: "post-1" } }) },
    ConversationMessage: { find: () => query([{ _id: "message", direction: "inbound", body: "I want help buying my first multifamily property", createdAt: new Date() }]) },
    Contact: { findOne: () => query({ name: "Prospect" }) },
    SalesOpportunity: { findOne: () => query(null) },
    SocialAiAnalysis: {
      findOne: () => query(stored),
      create: async values => { creates += 1; stored = { _id: "analysis", ...values, save: async () => stored }; return stored; },
      findOneAndUpdate: async (_filter, update) => { updates += 1; stored = { ...stored, ...update.$set, save: async () => stored }; return stored; },
    },
    agentExecutionService: { runAgent: async request => { aiCalls += 1; const serialized = JSON.stringify(request); assert(!serialized.includes("accessToken")); assert(serialized.includes("multifamily")); return { output: { intent: "buying_intent", confidence: .91, sentiment: "positive", leadPotential: "high", qualificationSignals: ["first deal"], observedEvidence: ["wants help buying"], inference: ["may need coaching"], recommendedAction: "Review and qualify", suggestedReply: "Thanks — would you like the program details?", requiresHuman: true, reason: "Strong explicit intent" } }; } },
    CrmActivity: {},
  };
  const first = await service.analyze({ workspaceId: "ws", userId: "user", auth: auth("ws"), threadId: "thread", action: "identify_intent", forceAi: true }, deps);
  const second = await service.analyze({ workspaceId: "ws", userId: "user", auth: auth("ws"), threadId: "thread", action: "identify_intent", forceAi: true }, deps);
  const regenerated = await service.analyze({ workspaceId: "ws", userId: "user", auth: auth("ws"), threadId: "thread", action: "identify_intent", forceAi: true, forceRegenerate: true }, deps);
  assert.equal(first.analysis.intent, "buying_intent"); assert.equal(first.analysis.requiresHuman, true);
  assert.equal(second.reused, true); assert.equal(regenerated.reused, false);
  assert.equal(aiCalls, 2); assert.equal(creates, 1); assert.equal(updates, 1);
  await assert.rejects(() => service.analyze({ workspaceId: "other", auth: auth("ws"), threadId: "thread" }, deps), /Social access/);
}

async function testQualifyConvergesWithoutAutomation() {
  let saved = 0, linked = null, activity = 0;
  class Opportunity {
    constructor(values) { Object.assign(this, values); this._id = "opportunity"; }
    async save() { saved += 1; }
  }
  Opportunity.findOne = async () => null;
  const deps = {
    SalesOpportunity: Opportunity,
    ConversationThread: { updateOne: async (_filter, update) => { linked = update.$set.opportunityId; } },
    CrmActivity: { findOneAndUpdate: async () => { activity += 1; } },
  };
  const result = await service.qualify({ workspaceId: "ws", userId: "owner", context: { thread: { _id: "thread", contactIds: ["contact"] }, dto: { platform: "instagram", interactionType: "message", contactDisplayName: "Prospect", contentAttribution: { contentId: "post" }, recentMessages: [{ text: "I want the program" }] } }, analysis: { _id: "analysis", leadPotential: "high", confidence: .9, qualificationSignals: ["program interest"], observedEvidence: ["asked for program"], inference: [], recommendedAction: "Human follow-up", reason: "Explicit interest", aiUsed: true } }, deps);
  assert.equal(result._id, "opportunity"); assert.equal(result.stageKey, "qualified"); assert.equal(result.ownerId, undefined);
  assert.equal(result.leadAttribution.contentId, "post"); assert.equal(linked, "opportunity"); assert.equal(saved, 1); assert.equal(activity, 1);
  assert.notEqual(result.stageKey, "won"); assert.notEqual(result.stageKey, "lost");
}

async function testRulesFirstAndAnalytics() {
  assert.deepEqual(service.deterministicDecision({ text: "DEAL", automation: { qualification: ["program_interest"] } }), { useAi: false, reason: "configured_automation_match", intent: "program_interest" });
  assert.equal(service.deterministicDecision({ text: "Can I speak to a real person?" }).intent, "human_requested");
  const analytics = await service.analytics("ws", { SocialAiAnalysis: { find: () => query([{ platform: "instagram", leadPotential: "high", handoffState: "closer_attention_required" }, { platform: "facebook", leadPotential: "low", handoffState: "human_review_required" }]) } });
  assert.deepEqual({ total: analytics.total, qualified: analytics.qualified, needsHuman: analytics.needsHuman }, { total: 2, qualified: 1, needsHuman: 2 });
}

(async () => {
  await testSanitizedContext();
  await testAnalyzeAndIdempotency();
  await testQualifyConvergesWithoutAutomation();
  await testRulesFirstAndAnalytics();
  console.log("Social AI focused tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
