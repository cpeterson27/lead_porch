const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const socialVariantSchema = new mongoose.Schema({
  provider: { type: String, enum: ["facebook", "instagram", "linkedin", "x"], required: true },
  body: { type: String, required: true, maxlength: 10000 },
  hashtags: { type: [String], default: [] },
  cta: { type: String, default: "", maxlength: 1000 },
}, { _id: false });

/**
 * A reviewable Jarvis work order. Preparing one spends only a text-generation
 * call; confirming it is the explicit boundary that creates records and an
 * image. It never publishes, activates a program, or contacts a prospect.
 */
const jarvisCampaignPackageSchema = new mongoose.Schema({
  request: { type: String, required: true, trim: true, maxlength: 5000 },
  name: { type: String, required: true, trim: true, maxlength: 240 },
  objective: { type: String, default: "", trim: true, maxlength: 2000 },
  status: { type: String, enum: ["proposal", "building", "ready", "failed", "archived"], default: "proposal", index: true },
  existingProgramId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachingProgram", default: null },
  programDraft: {
    name: { type: String, default: "", trim: true, maxlength: 180 },
    summary: { type: String, default: "", trim: true, maxlength: 3000 },
    durationValue: { type: Number, default: null, min: 0 },
    durationUnit: { type: String, enum: ["", "days", "weeks", "months"], default: "" },
    priceAmount: { type: Number, default: null, min: 0 },
    audience: { type: String, default: "", maxlength: 3000 },
    outcomes: { type: [String], default: [] },
    curriculum: { type: [String], default: [] },
  },
  flyerPrompt: { type: String, required: true, maxlength: 4000 },
  socialVariants: { type: [socialVariantSchema], default: [] },
  callToAction: { label: { type: String, default: "Learn more", maxlength: 120 }, url: { type: String, default: "/apply", maxlength: 2000 } },
  generatedProgramId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachingProgram", default: null },
  contentBriefId: { type: mongoose.Schema.Types.ObjectId, ref: "ContentBrief", default: null },
  image: { url: String, publicId: String, width: Number, height: Number, model: String, prompt: String },
  lastError: { type: String, default: "", maxlength: 2000 },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  confirmedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  confirmedAt: { type: Date, default: null },
}, { timestamps: true, collection: "jarvis_campaign_packages" });

jarvisCampaignPackageSchema.index({ workspaceId: 1, createdAt: -1 });
jarvisCampaignPackageSchema.plugin(workspacePlugin);
module.exports = mongoose.model("JarvisCampaignPackage", jarvisCampaignPackageSchema);
