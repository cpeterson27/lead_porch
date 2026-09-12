const assert = require("node:assert/strict");
const studio = require("./services/jarvisCampaignStudioService");

function testProposalNormalization() {
  const result = studio.normalizeProposal({
    name: "Spring acquisition launch", objective: "Enroll qualified students.",
    programDraft: { name: "Acquisition Lab", summary: "Six weeks of guided practice.", durationValue: 6, durationUnit: "weeks", priceAmount: 1700, audience: "Beginning acquisition entrepreneurs", outcomes: ["Evaluate opportunities"], curriculum: ["Deal criteria"] },
    flyerPrompt: "A polished green and gold flyer with clear text-safe space.",
    socialVariants: [{ provider: "instagram", body: "Instagram copy", hashtags: ["AcquisitionLab"], cta: "Apply" }],
    callToAction: { label: "Apply now", url: "/apply" },
  }, "Create the campaign", null);
  assert.equal(result.socialVariants.length, 4, "every package must have one variant for every supported platform");
  assert.deepEqual(new Set(result.socialVariants.map((row) => row.provider)), new Set(studio.PROVIDERS));
  assert.equal(result.programDraft.durationValue, 6);
  assert.equal(result.callToAction.url, "/apply");
}

async function testBuildIsDraftOnlyAndIdempotent() {
  const createdPrograms = [], createdBriefs = [], generatedImages = [];
  const item = {
    _id: "package-1", status: "proposal", existingProgramId: null, generatedProgramId: null, contentBriefId: null,
    name: "Campaign", objective: "Enroll students", flyerPrompt: "Professional flyer", callToAction: { label: "Apply", url: "/apply" },
    programDraft: { name: "Program", summary: "Summary", durationValue: 6, durationUnit: "weeks", priceAmount: 1700, audience: "Audience", outcomes: ["Outcome"], curriculum: ["Week one"] },
    socialVariants: studio.PROVIDERS.map((provider) => ({ provider, body: `${provider} copy`, hashtags: [], cta: "Apply" })), image: {},
    async save() { return this; },
  };
  const dependencies = {
    JarvisCampaignPackage: { async findOne() { return item; } },
    CoachingProgram: { async create(values) { createdPrograms.push(values); return { _id: "program-1" }; } },
    ContentBrief: { async findOne() { return createdBriefs.length ? { _id: "brief-1" } : null; }, async create(values) { createdBriefs.push(values); return { _id: "brief-1" }; } },
    imageGenerationService: { assertEnabled() {}, async generateImage(values) { generatedImages.push(values); return { url: "https://res.cloudinary.com/demo-cloud/image/upload/v1/flyer.png", publicId: "flyer", width: 1024, height: 1024, model: "test-image", prompt: values.prompt }; } },
    mediaVariantService: require("./services/mediaVariantService"),
  };
  const first = await studio.build({ workspaceId: "workspace-1", userId: "user-1", packageId: "package-1" }, dependencies);
  assert.equal(first.status, "ready");
  assert.equal(createdPrograms.length, 1);
  assert.equal(createdPrograms[0].status, "draft", "Jarvis must never activate a generated program");
  assert.equal(createdPrograms[0].publicPresentation.status, "hidden", "Jarvis must never publish a generated program");
  assert.equal(createdBriefs.length, 1);
  assert.equal(createdBriefs[0].status, "draft", "Jarvis must never publish generated social content");
  assert.equal(createdBriefs[0].social.media[0].platformVariants.length, 4);
  assert.equal(generatedImages.length, 1);
  assert.equal(generatedImages[0].size, "1024x1536", "the permanent flyer master must use the portrait output before platform variants are derived");
  await studio.build({ workspaceId: "workspace-1", userId: "user-1", packageId: "package-1" }, dependencies);
  assert.equal(createdPrograms.length, 1, "repeating confirmation must not duplicate a program");
  assert.equal(createdBriefs.length, 1, "repeating confirmation must not duplicate content");
  assert.equal(generatedImages.length, 1, "repeating confirmation must not buy another image");
}

async function run() { testProposalNormalization(); await testBuildIsDraftOnlyAndIdempotent(); console.log("Jarvis Campaign Studio: four-platform normalization, draft-only safety, generated variants, and idempotent confirmation passed."); }
run().catch((error) => { console.error(error); process.exitCode = 1; });
