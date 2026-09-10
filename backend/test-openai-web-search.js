// Targeted regression coverage for services/openaiWebSearchService.js — the
// OpenAI Responses API web_search discovery provider added as Discovery's
// second optional public-web source alongside Vertex Grounding: disabled by
// default with zero HTTP calls; the existing workspace AI budget gate
// (aiConfigService.assertEnabled — the SAME one every other OpenAI/Jarvis
// call in this app goes through) is checked BEFORE any call is made; a real
// result extraction (text + url_citation annotations from the Responses API
// output) is capped at 5 and deduplicated; and a model/tool-incompatibility
// error from OpenAI is surfaced as a clear OPENAI_WEB_SEARCH_UNSUPPORTED_MODEL
// configuration error rather than silently retried or downgraded. The
// OpenAI client is fully mocked via dependencies.clientFactory — no real
// network/OpenAI call is made.
require("dotenv").config();
const assert = require("node:assert/strict");

const originalEnabled = process.env.OPENAI_WEB_SEARCH_ENABLED;
const originalKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.JARVIS_RESEARCH_OPENAI_MODEL;

function freshService() {
  delete require.cache[require.resolve("./services/openaiWebSearchService")];
  return require("./services/openaiWebSearchService");
}

async function testDisabledMakesZeroCalls() {
  delete process.env.OPENAI_WEB_SEARCH_ENABLED;
  delete process.env.OPENAI_API_KEY;
  const service = freshService();
  assert.equal(service.masterEnabled(), false);
  let called = false;
  await assert.rejects(
    () => service.groundedSearch({ workspaceId: "w1", query: "q" }, { clientFactory: () => { called = true; throw new Error("must not construct a client while disabled"); } }),
    (error) => error.code === "OPENAI_WEB_SEARCH_DISABLED",
  );
  assert.equal(called, false, "no OpenAI client may be constructed while OpenAI Web Search is disabled");
}

async function testWorkspaceBudgetEnforcementBlocksBeforeAnyCall() {
  process.env.OPENAI_WEB_SEARCH_ENABLED = "true";
  process.env.OPENAI_API_KEY = "test-key";
  const service = freshService();
  let called = false;
  const assertEnabled = async () => { const error = new Error("The configured workspace AI monthly limit has been reached"); error.code = "AI_MONTHLY_LIMIT_REACHED"; throw error; };
  await assert.rejects(
    () => service.groundedSearch({ workspaceId: "w1", query: "q" }, { assertEnabled, clientFactory: () => { called = true; return {}; } }),
    (error) => error.code === "AI_MONTHLY_LIMIT_REACHED",
    "the same workspace AI budget gate every other OpenAI/Jarvis call uses must be preserved for web search",
  );
  assert.equal(called, false, "a workspace over its AI budget must never reach a real OpenAI call");
}

async function testMissingQueryRejectsWithoutCallingOpenAi() {
  process.env.OPENAI_WEB_SEARCH_ENABLED = "true";
  process.env.OPENAI_API_KEY = "test-key";
  const service = freshService();
  let called = false;
  await assert.rejects(
    () => service.groundedSearch({ workspaceId: "w1", query: "  " }, { assertEnabled: async () => {}, clientFactory: () => { called = true; return {}; } }),
    (error) => error.code === "OPENAI_WEB_SEARCH_QUERY_REQUIRED",
  );
  assert.equal(called, false);
}

async function testSuccessfulSearchExtractsCitationsAndCapsAtFive() {
  process.env.OPENAI_WEB_SEARCH_ENABLED = "true";
  process.env.OPENAI_API_KEY = "test-key";
  const service = freshService();
  const candidates = Array.from({ length: 7 }, (_, index) => ({
    type: "person", name: `Person ${index}`, organizationName: "Metro REIA", organizationDomain: "metroreia.org",
    summary: "Found via OpenAI web_search.", evidenceUrls: [`https://metroreia.org/person-${index}`, "javascript:alert(1)"],
  }));
  const text = `Here is what I found.\n\`\`\`json\n${JSON.stringify(candidates)}\n\`\`\``;
  const mockResponse = {
    model: "gpt-5.6-terra",
    usage: { input_tokens: 500, output_tokens: 300, total_tokens: 800 },
    output: [{ type: "message", content: [{ type: "output_text", text, annotations: [{ type: "url_citation", url: "https://metroreia.org/person-0", title: "Person 0" }] }] }],
  };
  let capturedRequest = null;
  const client = { responses: { create: async (request) => { capturedRequest = request; return mockResponse; } } };
  const result = await service.groundedSearch({ workspaceId: "w1", query: "multifamily investors near Austin" }, { assertEnabled: async () => {}, clientFactory: () => client });

  assert.equal(capturedRequest.model, service.model(), "the configured research model must be the one actually requested, never silently substituted");
  assert.deepEqual(capturedRequest.tools, [{ type: "web_search" }]);
  assert.equal(result.results.length, 5, "results must be capped at the documented default max (5)");
  assert.ok(result.results.every((row) => row.evidenceUrls.every((url) => url.startsWith("http"))), "a non-http(s) evidence URL must never survive extraction");
  assert.equal(result.groundingCitations.length, 1);
  assert.equal(result.groundingCitations[0].url, "https://metroreia.org/person-0");
}

async function testUnsupportedToolErrorBecomesAClearConfigErrorNotASilentFallback() {
  process.env.OPENAI_WEB_SEARCH_ENABLED = "true";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.JARVIS_RESEARCH_OPENAI_MODEL = "gpt-5.6-terra";
  const service = freshService();
  let callCount = 0;
  const client = { responses: { create: async () => { callCount += 1; const error = new Error("This model does not support the 'web_search' tool."); error.status = 400; error.param = "tools"; throw error; } } };
  await assert.rejects(
    () => service.groundedSearch({ workspaceId: "w1", query: "q" }, { assertEnabled: async () => {}, clientFactory: () => client }),
    (error) => error.code === "OPENAI_WEB_SEARCH_UNSUPPORTED_MODEL" && error.message.includes("gpt-5.6-terra"),
  );
  assert.equal(callCount, 1, "an unsupported-tool error must surface directly — never retried with a different model, which would be a silent fallback");
}

async function run() {
  try {
    await testDisabledMakesZeroCalls();
    await testWorkspaceBudgetEnforcementBlocksBeforeAnyCall();
    await testMissingQueryRejectsWithoutCallingOpenAi();
    await testSuccessfulSearchExtractsCitationsAndCapsAtFive();
    await testUnsupportedToolErrorBecomesAClearConfigErrorNotASilentFallback();
  } finally {
    if (originalEnabled === undefined) delete process.env.OPENAI_WEB_SEARCH_ENABLED; else process.env.OPENAI_WEB_SEARCH_ENABLED = originalEnabled;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.JARVIS_RESEARCH_OPENAI_MODEL; else process.env.JARVIS_RESEARCH_OPENAI_MODEL = originalModel;
    delete require.cache[require.resolve("./services/openaiWebSearchService")];
  }
}

run()
  .then(() => console.log("OpenAI Web Search integration: disabled-by-default zero-calls, workspace AI budget enforcement runs before any call, missing-query validation, successful extraction (citations + 5-result cap + non-http URL rejection), and an unsupported-tool error surfaces as a clear config error with no silent retry — all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
