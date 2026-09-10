/**
 * A file/document in the Ambassador Resource Center. The file BODY is never
 * stored here — only Cloudinary metadata (public ID, resource type) per
 * version. Downloads are always proxied through a workspace-authorized
 * backend route that fetches a short-lived signed URL from Cloudinary at
 * request time (see services/ambassadorResourceService.js) — the client
 * never receives a permanent or direct provider URL.
 *
 * Jarvis approval (jarvisApproved) and ambassador visibility (visibility.*)
 * are deliberately separate: a file can be ambassador-visible without being
 * approved as Jarvis knowledge, or approved for Jarvis while staying
 * internal-only.
 */
const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const versionSchema = new mongoose.Schema({
  version: { type: Number, required: true },
  cloudinaryPublicId: { type: String, required: true },
  resourceType: { type: String, enum: ["image", "video", "raw"], required: true },
  format: { type: String, default: "", maxlength: 20 },
  fileName: { type: String, required: true, maxlength: 260 },
  mimeType: { type: String, default: "", maxlength: 120 },
  sizeBytes: { type: Number, required: true, min: 0 },
  effectiveDate: { type: Date, default: Date.now },
  changeNotes: { type: String, default: "", trim: true, maxlength: 2000 },
  uploadedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });

const schema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, default: "", trim: true, maxlength: 2000 },
  category: {
    type: String,
    enum: ["start_here", "ambassador_program", "program_outlines", "brand_assets", "approved_talking_points", "campaigns", "training", "policies_and_agreements"],
    required: true,
    index: true,
  },
  // Program guides stay categorically distinct from binding agreements —
  // an e-signature/acceptance flow only ever applies to the latter.
  kind: { type: String, enum: ["guide", "binding_agreement"], default: "guide" },
  coachingProgramIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "CoachingProgram" }],
  visibility: {
    internalOnly: { type: Boolean, default: true },
    allAmbassadors: { type: Boolean, default: false },
    namedAmbassadorIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "AmbassadorProfile" }],
    studentsOrProgramMembers: { type: Boolean, default: false },
    public: { type: Boolean, default: false },
  },
  jarvisApproved: { type: Boolean, default: false, index: true },
  requiresAcknowledgment: { type: Boolean, default: false },
  status: { type: String, enum: ["active", "archived"], default: "active", index: true },
  currentVersion: { type: Number, default: 1 },
  versions: { type: [versionSchema], default: [] },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  archivedAt: { type: Date, default: null },
  archivedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true, collection: "ambassador_resource_files" });

schema.index({ workspaceId: 1, category: 1, status: 1 });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("AmbassadorResourceFile", schema);
