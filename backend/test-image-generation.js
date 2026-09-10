// Regression coverage for real OpenAI image generation: disabled by default (separate flag from
// chat), never returns a bare/expiring OpenAI URL (always uploads through Cloudinary first),
// records usage/cost/prompt/model/generation-id, and never makes a real OpenAI call in this file.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const service = require("./services/imageGenerationService");
const AiUsageRecord = require("./models/AiUsageRecord");

const ENV_KEYS = ["OPENAI_IMAGE_GENERATION_ENABLED", "JARVIS_OPENAI_ENABLED", "OPENAI_API_KEY", "OPENAI_IMAGE_MODEL"];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
function restoreEnv() { for (const key of ENV_KEYS) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; } }

async function testDisabledMakesZeroCalls() {
  delete process.env.OPENAI_IMAGE_GENERATION_ENABLED;
  process.env.JARVIS_OPENAI_ENABLED = "true";
  process.env.OPENAI_API_KEY = "sk-test";
  assert.equal(service.isEnabled(), false, "must stay disabled even with chat enabled and a key present until its own flag is set");
  let clientConstructed = false;
  await assert.rejects(
    () => service.generateImage({ workspaceId: "w1", prompt: "a friendly logo" }, { clientFactory: () => { clientConstructed = true; return {}; } }),
    /IMAGE_GENERATION_DISABLED|not enabled/,
  );
  assert.equal(clientConstructed, false, "no OpenAI client may be constructed while image generation is disabled");
}

function testChatEnabledAloneIsNotEnough() {
  process.env.JARVIS_OPENAI_ENABLED = "true";
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.OPENAI_IMAGE_GENERATION_ENABLED;
  assert.equal(service.isEnabled(), false);
  process.env.OPENAI_IMAGE_GENERATION_ENABLED = "true";
  assert.equal(service.isEnabled(), true);
}

async function testGenerateRequiresPrompt() {
  process.env.OPENAI_IMAGE_GENERATION_ENABLED = "true";
  process.env.JARVIS_OPENAI_ENABLED = "true";
  process.env.OPENAI_API_KEY = "sk-test";
  await assert.rejects(() => service.generateImage({ workspaceId: "w1", prompt: "   " }), /IMAGE_PROMPT_REQUIRED|prompt is required/);
}

async function testGenerateUploadsAndRecordsUsage(workspaceId) {
  process.env.OPENAI_IMAGE_GENERATION_ENABLED = "true";
  process.env.JARVIS_OPENAI_ENABLED = "true";
  process.env.OPENAI_API_KEY = "sk-test";
  let generateCalled = false, uploadCalled = false;
  const result = await service.generateImage(
    { workspaceId, campaignId: "campaign-1", prompt: "A bright, modern coaching program banner" },
    {
      clientFactory: () => ({ images: { generate: async (params) => { generateCalled = true; assert.equal(params.model, "gpt-image-1"); assert.equal(params.prompt, "A bright, modern coaching program banner"); return { id: "gen_123", data: [{ b64_json: "ZmFrZS1pbWFnZS1kYXRh" }] }; } } }),
      uploadImage: async ({ file, folder }) => { uploadCalled = true; assert.match(file, /^data:image\/png;base64,/); assert.equal(folder, `growth-operator/generated/${workspaceId}`); return { url: "https://res.cloudinary.com/demo/image/upload/v1/generated/abc.png", publicId: "generated/abc", width: 1024, height: 1024 }; },
    },
  );
  assert.equal(generateCalled, true);
  assert.equal(uploadCalled, true);
  assert.equal(result.url, "https://res.cloudinary.com/demo/image/upload/v1/generated/abc.png", "must return the real, permanent Cloudinary URL, never a bare/expiring OpenAI URL");
  assert.equal(result.prompt, "A bright, modern coaching program banner");
  assert.equal(result.model, "gpt-image-1");
  assert.equal(result.generationId, "gen_123");
  assert.equal(result.campaignId, "campaign-1");
  assert.ok(result.usage.pricingAvailable);
  assert.ok(result.usage.estimatedCostUsd > 0);

  const usage = await AiUsageRecord.findOne({ workspaceId, feature: "image.generate" }).lean();
  assert.ok(usage, "usage must be recorded with prompt-adjacent provenance fields");
  assert.equal(usage.success, true);
  assert.equal(usage.agent, "content");
  assert.equal(usage.provider, "openai");
  assert.ok(usage.estimatedTotalCostUsd > 0);
}

async function testFailedGenerationStillRecordsUsage(workspaceId) {
  await assert.rejects(() => service.generateImage(
    { workspaceId, prompt: "test" },
    { clientFactory: () => ({ images: { generate: async () => { const error = new Error("insufficient_quota"); error.status = 429; throw error; } } }) },
  ));
  const usage = await AiUsageRecord.findOne({ workspaceId, feature: "image.generate", success: false }).lean();
  assert.ok(usage);
  assert.equal(usage.errorCategory, "rate_limit");
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  try {
    await testDisabledMakesZeroCalls();
    testChatEnabledAloneIsNotEnough();
    await testGenerateRequiresPrompt();
    await testGenerateUploadsAndRecordsUsage(workspaceId);
    await testFailedGenerationStillRecordsUsage(workspaceId);
  } finally {
    await AiUsageRecord.deleteMany({ workspaceId });
    restoreEnv();
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Image generation: disabled-by-default (separate flag from chat), Cloudinary-backed permanent URLs, usage/cost logging, and failure categorization all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
