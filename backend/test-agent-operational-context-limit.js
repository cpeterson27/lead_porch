// Regression coverage for a real, reported incident: qualifying a batch of
// up to 20 candidates (each carrying full evidence — organization, summary,
// evidence URLs, conflicts, etc.) serializes into a prompt that can exceed
// the default 20000-character operational-context limit. That limit was a
// blind string slice with no JSON awareness, so candidates whose data
// landed past the cutoff got truncated mid-object — the model genuinely
// never received their data and correctly omitted them from its output,
// which then silently showed up to the owner as "failed" with no real
// error (the "select 50, only ~23 qualified, 27 failed" incident).
//
// Fully mocked — NO real database connection or OpenAI call is made
// anywhere in this file, per this session's standing "no live providers,
// no production writes" constraint. Isolated from test-agent-framework.js,
// which has an unrelated, pre-existing failing assertion (a tool
// classification check) that would prevent this test from ever running if
// it were added there.
require("dotenv").config();
const assert = require("node:assert/strict");
const executionService = require("./services/agentExecutionService");

const workspaceId = "workspace-1";
const auth = { workspaceId, effectivePermissions: ["jarvis.manage", "discovery.manage", "crm.view", "campaigns.manage"] };

function dependencies() {
  let capturedMessages = null;
  return {
    deps: {
      aiConfigService: { async assertEnabled() {} },
      knowledgeService: { async retrieveKnowledge() { return { available: false, sources: [], context: "" }; } },
      llmService: {
        async generateText(value) { capturedMessages = value.messages; return "ok"; },
        async generateStructured(value) { capturedMessages = value.messages; return { qualifications: [] }; },
        getStatus() { return { model: "mock-model" }; },
      },
    },
    getMessages: () => capturedMessages,
  };
}

async function testALongOperationalContextIsTruncatedByDefault() {
  const { deps, getMessages } = dependencies();
  const marker = "END-OF-CANDIDATE-DATA-MARKER";
  const longContext = `${"x".repeat(20500)}${marker}`;
  await executionService.runAgent({ workspaceId, userId: "u1", agent: "lead", task: "qualify_and_recommend_leads", operationalContext: longContext, auth }, deps);
  const combined = getMessages().map((m) => m.content).join("\n");
  assert.ok(!combined.includes(marker), "the default 20000-char limit must still truncate a normal-sized prompt, preserving existing behavior for every other caller");
  console.log("PASS testALongOperationalContextIsTruncatedByDefault");
}

async function testOperationalContextLimitOverridePreservesTheFullPayload() {
  const { deps, getMessages } = dependencies();
  const marker = "END-OF-CANDIDATE-DATA-MARKER";
  const longContext = `${"x".repeat(20500)}${marker}`;
  await executionService.runAgent({ workspaceId, userId: "u1", agent: "lead", task: "qualify_and_recommend_leads", operationalContext: longContext, auth, options: { operationalContextLimit: 80000 } }, deps);
  const combined = getMessages().map((m) => m.content).join("\n");
  assert.ok(combined.includes(marker), "a caller that explicitly raises operationalContextLimit must actually receive the full payload, not a silently truncated one");
  console.log("PASS testOperationalContextLimitOverridePreservesTheFullPayload");
}

async function testOperationalContextLimitIsClampedToASaneMaximum() {
  const { deps, getMessages } = dependencies();
  const marker = "END-OF-CANDIDATE-DATA-MARKER";
  const longContext = `${"x".repeat(200000)}${marker}`;
  await executionService.runAgent({ workspaceId, userId: "u1", agent: "lead", task: "qualify_and_recommend_leads", operationalContext: longContext, auth, options: { operationalContextLimit: 999999 } }, deps);
  const combined = getMessages().map((m) => m.content).join("\n");
  assert.ok(!combined.includes(marker), "an unreasonably large override must still be clamped, never allowed to pass through unbounded");
  console.log("PASS testOperationalContextLimitIsClampedToASaneMaximum");
}

(async () => {
  await testALongOperationalContextIsTruncatedByDefault();
  await testOperationalContextLimitOverridePreservesTheFullPayload();
  await testOperationalContextLimitIsClampedToASaneMaximum();
  console.log("\nAll operational-context-limit tests passed.");
})().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
