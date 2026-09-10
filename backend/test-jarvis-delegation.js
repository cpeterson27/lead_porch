// Regression coverage for wiring Jarvis's real chat flow into the specialized-agent
// coordinator (services/jarvisAgentCoordinator.js), which previously existed but was
// never called from jarvisService.processQuery(). This must be purely additive:
// Jarvis's own deterministic keyword handlers must keep answering exactly as before,
// and delegation must only ever add a `delegatedAgent` field, never replace or break
// the existing `answer`.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { runWithWorkspace } = require("./tenancy/workspaceContext");
const jarvisService = require("./services/jarvisService");
const llmService = require("./services/llmService");
const jarvisAgentCoordinator = require("./services/jarvisAgentCoordinator");

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const auth = { workspaceId: String(workspaceId), effectivePermissions: ["discovery.manage", "crm.view", "social.manage", "campaigns.manage"] };

  const originalIsEnabled = llmService.isEnabled;
  const originalChat = llmService.chat;
  const originalRunSpecialized = jarvisAgentCoordinator.runSpecialized;

  try {
    llmService.isEnabled = () => true;
    llmService.chat = async () => "Polished Jarvis answer.";

    // 1. A message matching the Lead Agent's domain must delegate, with real tool grounding.
    let capturedRequest = null;
    jarvisAgentCoordinator.runSpecialized = async (request) => { capturedRequest = request; return { output: "Grounded lead research from the Lead Agent." }; };
    const leadResult = await runWithWorkspace(String(workspaceId), () =>
      jarvisService.processQuery("please research this prospect and their qualification", { workspaceId, userId: "u1", auth }));
    assert.ok(capturedRequest, "runSpecialized must be invoked for a lead-domain message");
    assert.equal(capturedRequest.agent, "lead");
    assert.deepEqual(capturedRequest.options.tools.map((t) => t.toolId), ["crm.search_contacts", "crm.list_opportunities"]);
    assert.deepEqual(leadResult.delegatedAgent, { agent: "lead", answer: "Grounded lead research from the Lead Agent." });
    assert.ok(leadResult.activity.some((step) => step.label === "Consulted the Lead Agent" && step.status === "complete"));
    assert.equal(leadResult.answer, "Polished Jarvis answer.", "Jarvis's own deterministic+OpenAI answer must still be produced");

    // 2. A message matching the Content Agent's domain must delegate there instead.
    capturedRequest = null;
    jarvisAgentCoordinator.runSpecialized = async (request) => { capturedRequest = request; return { output: "Grounded content plan from the Content Agent." }; };
    const contentResult = await runWithWorkspace(String(workspaceId), () =>
      jarvisService.processQuery("help me draft content and a caption for next week's post", { workspaceId, userId: "u1", auth }));
    assert.equal(capturedRequest.agent, "content");
    assert.deepEqual(capturedRequest.options.tools.map((t) => t.toolId), ["content.list_briefs", "growth.analytics"]);
    assert.deepEqual(contentResult.delegatedAgent, { agent: "content", answer: "Grounded content plan from the Content Agent." });

    // 3. A message matching no specialized-agent domain must not delegate at all.
    let specializedCalled = false;
    jarvisAgentCoordinator.runSpecialized = async () => { specializedCalled = true; return { output: "should not run" }; };
    const generalResult = await runWithWorkspace(String(workspaceId), () =>
      jarvisService.processQuery("what are my priorities today", { workspaceId, userId: "u1", auth }));
    assert.equal(specializedCalled, false, "a message outside any specialized-agent domain must not trigger delegation");
    assert.equal(generalResult.delegatedAgent, undefined);

    // 4. If OpenAI is unavailable, delegation must be skipped rather than attempted and failed.
    llmService.isEnabled = () => false;
    specializedCalled = false;
    const noAiResult = await runWithWorkspace(String(workspaceId), () =>
      jarvisService.processQuery("please research this prospect and their qualification", { workspaceId, userId: "u1", auth }));
    assert.equal(specializedCalled, false, "delegation must not be attempted when OpenAI is disabled");
    assert.ok(noAiResult.answer, "the deterministic answer must still be returned with OpenAI disabled");
    llmService.isEnabled = () => true;

    // 5. If the specialized agent fails (e.g. no OpenAI credits), Jarvis must fall back gracefully.
    jarvisAgentCoordinator.runSpecialized = async () => { const error = new Error("no credits"); error.status = 429; throw error; };
    const failedResult = await runWithWorkspace(String(workspaceId), () =>
      jarvisService.processQuery("please research this prospect and their qualification", { workspaceId, userId: "u1", auth }));
    assert.equal(failedResult.delegatedAgent, undefined, "a failed delegation must not appear as a result");
    assert.ok(failedResult.activity.some((step) => step.label === "Lead Agent unavailable" && step.status === "warning"));
    assert.equal(failedResult.answer, "Polished Jarvis answer.", "Jarvis's own answer must still succeed even when delegation fails");
  } finally {
    llmService.isEnabled = originalIsEnabled;
    llmService.chat = originalChat;
    jarvisAgentCoordinator.runSpecialized = originalRunSpecialized;
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Jarvis delegation: lead/content routing, tool grounding, non-interference with deterministic answers, and graceful fallback all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
