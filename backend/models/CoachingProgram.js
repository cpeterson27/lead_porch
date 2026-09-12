const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const stageSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
  label: { type: String, required: true, trim: true, maxlength: 120 },
  order: { type: Number, required: true, min: 0 },
  defaultDuration: {
    value: { type: Number, default: null, min: 0 },
    unit: { type: String, enum: ["", "days", "weeks", "months"], default: "" },
  },
}, { _id: false });

const coachingProgramSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 180 },
  internalSummary: { type: String, default: "", trim: true, maxlength: 3000 },
  status: { type: String, enum: ["draft", "active", "archived"], default: "draft", index: true },
  duration: {
    value: { type: Number, default: null, min: 0 },
    unit: { type: String, enum: ["", "days", "weeks", "months"], default: "" },
  },
  defaultPrice: {
    amount: { type: Number, default: null, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true, minlength: 3, maxlength: 3 },
  },
  stages: { type: [stageSchema], default: [] },
  skoolMapping: {
    enabled: { type: Boolean, default: false },
    groupId: { type: String, default: "", trim: true, maxlength: 255 },
    groupSlug: { type: String, default: "", trim: true, maxlength: 255 },
    groupUrl: { type: String, default: "", trim: true, maxlength: 2048 },
    courseIds: { type: [String], default: [] },
    courseLabels: { type: [String], default: [] },
    retainAccessOnCompletion: { type: Boolean, default: true },
    retainAccessOnCancellation: { type: Boolean, default: true },
  },
  publicPresentation: {
    slug: { type: String, default: "", trim: true, lowercase: true, maxlength: 120 },
    title: { type: String, default: "", trim: true, maxlength: 180 }, summary: { type: String, default: "", trim: true, maxlength: 1200 }, description: { type: String, default: "", maxlength: 12000 },
    priceVisible: { type: Boolean, default: false }, highlights: { type: [String], default: [] }, audience: { type: String, default: "", maxlength: 3000 },
    outcomes: { type: [String], default: [] }, curriculum: { type: [String], default: [] }, imageUrl: { type: String, default: "", maxlength: 1000 },
    introVideoUrl: { type: String, default: "", maxlength: 1000 }, introVideoPublicId: { type: String, default: "", maxlength: 500 },
    ctaLabel: { type: String, default: "Apply Now", maxlength: 80 }, ctaUrl: { type: String, default: "/apply", maxlength: 1000 }, ctaSupportingText: { type: String, default: "", maxlength: 500 },
    status: { type: String, enum: ["hidden", "published"], default: "hidden" },
    section: { type: String, enum: ["accelerator", "intensive"], default: "intensive" },
    tierLabel: { type: String, default: "", trim: true, maxlength: 80 },
    comparisonPriceLabel: { type: String, default: "", trim: true, maxlength: 80 },
    comparisonDurationLabel: { type: String, default: "", trim: true, maxlength: 80 },
    coachingFormat: { type: String, default: "", trim: true, maxlength: 80 },
    featured: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
  },
  version: { type: Number, default: 1, min: 1 },
  archivedAt: { type: Date, default: null },
}, { timestamps: true, collection: "coaching_programs" });

coachingProgramSchema.index({ workspaceId: 1, status: 1, name: 1 });
coachingProgramSchema.index({ workspaceId: 1, "publicPresentation.slug": 1 }, { unique: true, partialFilterExpression: { "publicPresentation.slug": { $gt: "" } } });
coachingProgramSchema.plugin(workspacePlugin);

module.exports = mongoose.model("CoachingProgram", coachingProgramSchema);
