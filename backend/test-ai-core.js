const assert = require("assert");
const { createLlmService, normalizeUsage, safeError } = require("./services/llmService");
const { estimateCost } = require("./services/aiPricingService");
const aiConfigService = require("./services/aiConfigService");
const aiUsageService = require("./services/aiUsageService");
const AiUsageRecord = require("./models/AiUsageRecord");
const { requireAiAdministrator } = require("./routes/ai");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function run() {
  const records = [];
  let tick = 1000;
  const response = {
    model: "gpt-4.1-mini-2025-04-14",
    _request_id: "req_safe_123",
    choices: [{ message: { content: "A safe answer" } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 5 },
    },
  };
  const service = createLlmService({
    allowWhenEnvironmentDisabled: true,
    clientFactory: () => ({ chat: { completions: { create: async () => response } } }),
    AiUsageRecord: { create: async (record) => records.push(record) },
    assertEnabled: async ({ workspaceId, agent }) => {
      assert.equal(workspaceId, "workspace-a");
      assert.equal(agent, "jarvis");
    },
    now: () => (tick += 25),
  });

  const text = await service.chat({
    message: "PRIVATE PROMPT",
    context: "PRIVATE CONTEXT",
    workspaceId: "workspace-a",
    userId: "user-a",
    correlationId: "corr-1",
  });
  assert.equal(text, "A safe answer");
  assert.equal(records.length, 1);
  assert.deepEqual(
    { input: records[0].inputTokens, output: records[0].outputTokens, cached: records[0].cachedTokens, reasoning: records[0].reasoningTokens, total: records[0].totalTokens },
    { input: 100, output: 20, cached: 40, reasoning: 5, total: 120 },
  );
  assert.equal(records[0].agent, "jarvis");
  assert.equal(records[0].feature, "jarvis.chat");
  assert.equal(records[0].success, true);
  assert.equal(records[0].providerRequestId, "req_safe_123");
  assert.equal(records[0].pricingVersion, "2026-09-16");
  assert(Math.abs(records[0].estimatedTotalCostUsd - 0.00006) < 1e-12);
  const serialized = JSON.stringify(records[0]);
  assert(!serialized.includes("PRIVATE PROMPT"));
  assert(!serialized.includes("PRIVATE CONTEXT"));
  assert(!/messages|prompt|response|apiKey|token[^s]/i.test(serialized));

  const structured = createLlmService({
    allowWhenEnvironmentDisabled: true,
    clientFactory: () => ({ chat: { completions: { create: async (request) => {
      assert.equal(request.response_format.type, "json_schema");
      return { model: "unknown-model", choices: [{ message: { content: '{"qualified":true}' } }], usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } };
    } } } }),
    AiUsageRecord: { create: async (record) => records.push(record) },
    assertEnabled: async () => {},
  });
  assert.deepEqual(await structured.generateStructured({ workspaceId: "workspace-a", agent: "lead", feature: "lead.qualify", messages: [], schema: { type: "object", properties: { qualified: { type: "boolean" } }, required: ["qualified"], additionalProperties: false } }), { qualified: true });
  assert.equal(records.at(-1).pricingAvailable, false);
  assert.equal(records.at(-1).estimatedTotalCostUsd, null);

  const failures = [];
  const providerError = Object.assign(new Error("sensitive provider message"), { status: 429, code: "rate_limit_exceeded", request_id: "req_fail" });
  const failing = createLlmService({
    allowWhenEnvironmentDisabled: true,
    clientFactory: () => ({ chat: { completions: { create: async () => { throw providerError; } } } }),
    AiUsageRecord: { create: async (record) => failures.push(record) },
    assertEnabled: async () => {},
  });
  await assert.rejects(() => failing.generateText({ workspaceId: "workspace-a", agent: "social", feature: "social.caption", messages: [] }), (error) => error === providerError);
  assert.equal(failures[0].success, false);
  assert.equal(failures[0].errorCategory, "rate_limit");
  assert.equal(failures[0].errorCode, "rate_limit_exceeded");
  assert(!JSON.stringify(failures[0]).includes("sensitive provider message"));

  const ledgerFailure = createLlmService({
    allowWhenEnvironmentDisabled: true,
    clientFactory: () => ({ chat: { completions: { create: async () => response } } }),
    AiUsageRecord: { create: async () => { throw Object.assign(new Error("database unavailable"), { code: "DB_DOWN" }); } },
    assertEnabled: async () => {},
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try { assert.equal(await ledgerFailure.generateText({ workspaceId: "workspace-a", messages: [] }), "A safe answer"); }
  finally { console.warn = originalWarn; }

  const knownCost = estimateCost("gpt-4.1-mini", { inputTokens: 100, cachedTokens: 40, outputTokens: 20 });
  assert(Math.abs(knownCost.totalCostUsd - 0.00006) < 1e-12);
  // gpt-5.6-terra: real rate confirmed 2026-09-16 from OpenAI's own pricing
  // page — $2.00/1M input, $0.20/1M cached input, $12.00/1M output,
  // standard short-context tier. This is JARVIS_RESEARCH_OPENAI_MODEL in
  // production, so an inaccurate rate here directly means an inaccurate
  // number on the AI spend dashboard.
  const terraCost = estimateCost("gpt-5.6-terra", { inputTokens: 1_000_000, cachedTokens: 400_000, outputTokens: 1_000_000 });
  assert.equal(terraCost.pricingAvailable, true);
  assert(Math.abs(terraCost.inputCostUsd - (600_000 * 2.00 / 1_000_000 + 400_000 * 0.20 / 1_000_000)) < 1e-9);
  assert(Math.abs(terraCost.outputCostUsd - 12.00) < 1e-9);
  assert.deepEqual(estimateCost("future-model", { inputTokens: 100 }), { pricingAvailable: false, pricingVersion: "2026-09-16", inputCostUsd: null, outputCostUsd: null, totalCostUsd: null, costIsEstimate: true });
  assert.deepEqual(normalizeUsage({ usage: { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 1 } } }), { inputTokens: 8, outputTokens: 2, cachedTokens: 3, reasoningTokens: 1, totalTokens: 10 });
  assert.deepEqual(safeError({ status: 401, message: "secret", code: "bad key!" }), { errorCategory: "authentication", errorCode: "bad_key_", providerRequestId: "" });

  let usageFilter;
  let selectedFields;
  const rows = [
    { agent: "jarvis", model: "gpt-4.1-mini", provider: "openai", endpoint: "chat.completions", inputTokens: 10, outputTokens: 5, cachedTokens: 2, reasoningTokens: 1, totalTokens: 15, estimatedTotalCostUsd: 0.25, success: true },
    { agent: "research", model: "gemini-2.5-flash", provider: "vertex", endpoint: "generateContent", inputTokens: 100, outputTokens: 40, cachedTokens: 0, reasoningTokens: 0, totalTokens: 140, estimatedTotalCostUsd: 0.03, success: true },
  ];
  const Model = { find(filter) { usageFilter = filter; return { select(fields) { selectedFields = fields; return this; }, lean: async () => rows }; } };
  const summary = await aiUsageService.summary("workspace-a", { now: new Date("2026-08-27T12:00:00Z"), Model });
  assert.equal(usageFilter.workspaceId, "workspace-a");
  assert.equal(summary.requestCount, 2);
  assert.equal(summary.estimatedTotalCostUsd, 0.28);
  assert.equal(summary.byAgent[0].key, "jarvis");
  // The Mongo projection must actually include provider/endpoint, or every
  // row silently falls into "unknown" in production even though a mocked
  // Model.find() (which ignores the field list) would never catch that.
  assert.ok(/\bprovider\b/.test(selectedFields) && /\bendpoint\b/.test(selectedFields), "the usage query must select provider and endpoint, or every grouping below is silently empty in production");
  // The usage page groups by provider (OpenAI/Gemini/Vertex), by endpoint
  // (chat.completions/generateContent/...), and by the real (provider,
  // endpoint) combination for an OpenAI-dashboard-style card grid that
  // reflects every provider this workspace actually uses.
  assert.equal(summary.byProvider.find((row) => row.key === "openai").estimatedTotalCostUsd, 0.25);
  assert.equal(summary.byProvider.find((row) => row.key === "vertex").estimatedTotalCostUsd, 0.03);
  assert.equal(summary.byEndpoint.find((row) => row.key === "chat.completions").requestCount, 1);
  const openaiChat = summary.byProviderEndpoint.find((row) => row.provider === "openai" && row.endpoint === "chat.completions");
  assert.equal(openaiChat.requestCount, 1);
  assert.equal(openaiChat.estimatedTotalCostUsd, 0.25);
  const vertexGenerate = summary.byProviderEndpoint.find((row) => row.provider === "vertex" && row.endpoint === "generateContent");
  assert.equal(vertexGenerate.totalTokens, 140);

  const configDefaults = aiConfigService.defaults();
  assert.equal(configDefaults.enabled, true);
  assert.equal(configDefaults.monthlyLimitUsd, null);
  assert.equal(configDefaults.agentEnabled.social, true);
  const saved = [];
  const configModel = {
    findOne() { return { select() { return this; }, lean: async () => ({ ai: { ...configDefaults, monthlyLimitUsd: 5 } }) }; },
    async findOneAndUpdate(filter, update) { saved.push({ filter, update }); return { ai: update.$set.ai }; },
  };
  const updated = await aiConfigService.save("workspace-a", { enabled: false }, configModel);
  assert.equal(updated.monthlyLimitUsd, 5);
  assert.equal(updated.enabled, false);
  assert.equal(saved[0].filter.workspaceId, "workspace-a");

  await assert.rejects(
    () => aiConfigService.assertEnabled(
      { workspaceId: "workspace-a", agent: "jarvis" },
      { WorkspaceConfig: configModel, summary: async () => ({ estimatedTotalCostUsd: 5 }) },
    ),
    (error) => error.code === "AI_MONTHLY_LIMIT_REACHED",
  );

  const schemaPaths = Object.keys(AiUsageRecord.schema.paths);
  for (const forbidden of ["prompt", "messages", "response", "apiKey", "accessToken", "credentials"]) assert(!schemaPaths.includes(forbidden));
  assert(AiUsageRecord.schema.paths.workspaceId);

  for (const auth of [{ roles: ["owner"] }, { role: "admin" }, { isPlatformOwner: true }]) {
    let allowed = false;
    requireAiAdministrator({ auth }, responseRecorder(), () => { allowed = true; });
    assert.equal(allowed, true);
  }
  const denied = responseRecorder();
  requireAiAdministrator({ auth: { roles: ["coach"] } }, denied, () => assert.fail("coach should not pass"));
  assert.equal(denied.statusCode, 403);

  console.log("AI core and usage ledger tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
