const CoachingProgram = require("../models/CoachingProgram");
const ContentBrief = require("../models/ContentBrief");
const JarvisCampaignPackage = require("../models/JarvisCampaignPackage");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const llmService = require("./llmService");
const imageGenerationService = require("./imageGenerationService");
const mediaVariantService = require("./mediaVariantService");

const PROVIDERS = ["instagram", "facebook", "linkedin", "x"];
const schema = {
  type: "object",
  properties: {
    name: { type: "string" }, objective: { type: "string" },
    programDraft: { type: "object", properties: {
      name: { type: "string" }, summary: { type: "string" }, durationValue: { type: "number" }, durationUnit: { type: "string", enum: ["days", "weeks", "months"] }, priceAmount: { type: "number" }, audience: { type: "string" }, outcomes: { type: "array", items: { type: "string" } }, curriculum: { type: "array", items: { type: "string" } },
    }, required: ["name", "summary", "durationValue", "durationUnit", "priceAmount", "audience", "outcomes", "curriculum"], additionalProperties: false },
    flyerPrompt: { type: "string" },
    socialVariants: { type: "array", items: { type: "object", properties: { provider: { type: "string", enum: PROVIDERS }, body: { type: "string" }, hashtags: { type: "array", items: { type: "string" } }, cta: { type: "string" } }, required: ["provider", "body", "hashtags", "cta"], additionalProperties: false } },
    callToAction: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["label", "url"], additionalProperties: false },
  }, required: ["name", "objective", "programDraft", "flyerPrompt", "socialVariants", "callToAction"], additionalProperties: false,
};

const cleanList = (values, max, length = 500) => (Array.isArray(values) ? values : []).map((value) => String(value || "").trim().slice(0, length)).filter(Boolean).slice(0, max);
function normalizeProposal(output, request, existingProgram) {
  const draft = output.programDraft || {};
  const program = existingProgram ? {
    name: existingProgram.name, summary: existingProgram.internalSummary || existingProgram.publicPresentation?.summary || "",
    durationValue: existingProgram.duration?.value || 0, durationUnit: existingProgram.duration?.unit || "weeks",
    priceAmount: existingProgram.defaultPrice?.amount || 0, audience: existingProgram.publicPresentation?.audience || "",
    outcomes: existingProgram.publicPresentation?.outcomes || [], curriculum: existingProgram.publicPresentation?.curriculum || [],
  } : draft;
  const byProvider = new Map((output.socialVariants || []).map((row) => [row.provider, row]));
  const variants = PROVIDERS.map((provider) => {
    const row = byProvider.get(provider) || {};
    return { provider, body: String(row.body || `${program.name}: ${program.summary}`).slice(0, 10000), hashtags: cleanList(row.hashtags, 12, 80), cta: String(row.cta || output.callToAction?.label || "Learn more").slice(0, 1000) };
  });
  return {
    request: String(request).trim().slice(0, 5000), name: String(output.name || `${program.name} campaign`).trim().slice(0, 240), objective: String(output.objective || "Promote this program to qualified prospective students.").trim().slice(0, 2000),
    programDraft: { name: String(program.name || "New program").slice(0, 180), summary: String(program.summary || "").slice(0, 3000), durationValue: Math.max(0, Number(program.durationValue) || 0), durationUnit: ["days", "weeks", "months"].includes(program.durationUnit) ? program.durationUnit : "weeks", priceAmount: Math.max(0, Number(program.priceAmount) || 0), audience: String(program.audience || "").slice(0, 3000), outcomes: cleanList(program.outcomes, 20), curriculum: cleanList(program.curriculum, 40) },
    flyerPrompt: String(output.flyerPrompt || `Professional promotional flyer for ${program.name}.`).trim().slice(0, 4000), socialVariants: variants,
    callToAction: { label: String(output.callToAction?.label || "Apply now").slice(0, 120), url: String(output.callToAction?.url || "/apply").slice(0, 2000) },
  };
}

async function prepare({ workspaceId, userId, request, existingProgramId = null, correlationId = "" }, dependencies = {}) {
  if (!String(request || "").trim()) throw Object.assign(new Error("Tell Jarvis what you want to create."), { code: "STUDIO_REQUEST_REQUIRED" });
  const Program = dependencies.CoachingProgram || CoachingProgram;
  const Package = dependencies.JarvisCampaignPackage || JarvisCampaignPackage;
  const Config = dependencies.WorkspaceConfig || WorkspaceConfig;
  let existingProgram = existingProgramId ? await Program.findOne({ _id: existingProgramId, workspaceId }).lean() : null;
  if (existingProgramId && !existingProgram) throw Object.assign(new Error("The selected program was not found."), { code: "STUDIO_PROGRAM_NOT_FOUND" });
  if (!existingProgramId) {
    const programs = await Program.find({ workspaceId, status: { $in: ["active", "draft"] } }).limit(100).lean();
    const requestLower = String(request).toLowerCase();
    const namedMatches = programs.filter((program) => program.name?.length >= 4 && requestLower.includes(program.name.toLowerCase()));
    if (namedMatches.length === 1) existingProgram = namedMatches[0];
  }
  const config = await Config.findOne({ workspaceId, key: "primary" }).lean();
  const brand = { name: config?.branding?.publicSiteName || config?.workspaceName || "", primaryColor: config?.branding?.primaryColor || "", accentColor: config?.branding?.accentColor || "", websiteUrl: config?.websiteUrl || "", logoUrl: config?.organizationLogoUrl || config?.branding?.logoUrl || "" };
  const output = await (dependencies.llmService || llmService).generateStructured({ workspaceId, userId, agent: "content", feature: "jarvis.campaign_studio.prepare", correlationId, schema, schemaName: "jarvis_campaign_package", messages: [
    { role: "system", content: "You are a senior marketing strategist and instructional product designer. Create a polished, truthful, review-ready campaign package. Use only supplied program facts; when designing a new program, clearly make it a draft. Produce distinct copy for Instagram, Facebook, LinkedIn, and X. The flyer prompt must describe visual hierarchy, brand colors, legible text-safe areas, and no unsupported claims. Never imply publishing or outreach occurred." },
    { role: "user", content: `Owner request:\n${String(request).slice(0, 5000)}\n\nBrand:\n${JSON.stringify(brand)}\n\nExisting program (authoritative when present):\n${JSON.stringify(existingProgram || null)}` },
  ] });
  const normalized = normalizeProposal(output, request, existingProgram);
  return Package.create({ workspaceId, ...normalized, existingProgramId: existingProgram?._id || null, createdByUserId: userId });
}

async function build({ workspaceId, userId, packageId }, dependencies = {}) {
  const Package = dependencies.JarvisCampaignPackage || JarvisCampaignPackage;
  const Program = dependencies.CoachingProgram || CoachingProgram;
  const Brief = dependencies.ContentBrief || ContentBrief;
  const imageService = dependencies.imageGenerationService || imageGenerationService;
  const variantService = dependencies.mediaVariantService || mediaVariantService;
  const item = await Package.findOne({ _id: packageId, workspaceId });
  if (!item) throw Object.assign(new Error("Campaign package not found."), { code: "STUDIO_PACKAGE_NOT_FOUND" });
  if (item.status === "ready") return item;
  imageService.assertEnabled(); // fail before creating partial records
  item.status = "building"; item.lastError = ""; await item.save();
  try {
    let programId = item.existingProgramId || item.generatedProgramId;
    if (!programId) {
      const p = item.programDraft;
      const program = await Program.create({ workspaceId, name: p.name, internalSummary: p.summary, status: "draft", duration: { value: p.durationValue, unit: p.durationUnit }, defaultPrice: { amount: p.priceAmount, currency: "USD" }, publicPresentation: { title: p.name, summary: p.summary, audience: p.audience, outcomes: p.outcomes, curriculum: p.curriculum, status: "hidden", ctaLabel: item.callToAction.label, ctaUrl: item.callToAction.url } });
      programId = program._id; item.generatedProgramId = program._id; await item.save();
    }
    const image = item.image?.url ? item.image : await imageService.generateImage({ workspaceId, userId, agent: "content", feature: "jarvis.campaign_studio.flyer", prompt: item.flyerPrompt, size: "1024x1536", quality: "standard", folder: `growth-operator/jarvis-campaigns/${workspaceId}` });
    if (!item.image?.url) { item.image = { url: image.url, publicId: image.publicId, width: image.width, height: image.height, model: image.model, prompt: image.prompt }; await item.save(); }
    const media = { type: "image", url: image.url, publicId: image.publicId, width: image.width, height: image.height, orientation: variantService.detectOrientation(image.width, image.height), alt: `${item.name} campaign graphic` };
    media.platformVariants = variantService.generatePlatformVariants({ media, platforms: PROVIDERS, mode: "contain" });
    const existingBrief = item.contentBriefId ? await Brief.findOne({ _id: item.contentBriefId, workspaceId }) : null;
    const brief = existingBrief || await Brief.create({ workspaceId, type: "social", title: item.name, body: item.socialVariants.find((v) => v.provider === "instagram")?.body || item.objective, coachingProgramId: programId, origin: "ai", source: "jarvis", status: "draft", social: { media: [media], variants: item.socialVariants, destinations: [], cta: item.callToAction, generationHistory: [{ generatedBy: userId, kind: "full", templateVersion: 1 }] }, createdBy: userId, updatedBy: userId });
    item.contentBriefId = brief._id; item.status = "ready"; item.confirmedByUserId = userId; item.confirmedAt = new Date(); await item.save();
    return item;
  } catch (error) {
    item.status = "failed"; item.lastError = String(error.message || "Campaign package could not be built").slice(0, 2000); await item.save(); throw error;
  }
}

async function list({ workspaceId, limit = 20 }, dependencies = {}) { return (dependencies.JarvisCampaignPackage || JarvisCampaignPackage).find({ workspaceId, status: { $ne: "archived" } }).sort({ createdAt: -1 }).limit(Math.min(50, Math.max(1, Number(limit) || 20))).lean(); }
module.exports = { PROVIDERS, schema, normalizeProposal, prepare, build, list };
