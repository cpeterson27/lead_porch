const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

// Version history is capped at the most recent 20 snapshots per note — enough
// to review and restore recent changes without unbounded document growth.
const MAX_VERSIONS = 20;

const versionSchema = new mongoose.Schema({
  version: { type: Number, required: true },
  title: { type: String, required: true },
  content: { type: String, required: true },
  contentHash: { type: String, required: true },
  changeSource: { type: String, enum: ["obsidian_bridge", "approved_memory", "restore"], required: true },
  savedAt: { type: Date, default: Date.now },
  savedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { _id: false });

const jarvisMemoryNoteSchema = new mongoose.Schema({
  source: { type: String, enum: ["obsidian_bridge", "approved_memory", "pdf_upload"], required: true, default: "obsidian_bridge", index: true },
  // Only set when source is "pdf_upload" — the original file name as
  // uploaded, preserved for provenance even though the stored path is
  // sanitized/generated (see pdfKnowledgeIngestionService.js).
  originalFilename: { type: String, default: "", trim: true, maxlength: 300 },
  category: { type: String, enum: ["dashboard/context", "campaigns", "contacts-icp", "partners-affiliates", "offers-programs", "marketing-channels", "sops", "decisions"], required: true, index: true },
  path: { type: String, required: true, trim: true },
  title: { type: String, required: true, trim: true },
  content: { type: String, required: true },
  contentHash: { type: String, required: true },
  sourceUpdatedAt: { type: Date, default: null },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  approvedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

  // Knowledge Center review workflow — retrieveCloudNotes only ever serves
  // status: "approved" notes to agents. An Obsidian-synced note always lands
  // (or returns) as "draft" when its content actually changes; it never
  // silently becomes live/approved knowledge on its own.
  status: { type: String, enum: ["draft", "approved", "rejected", "archived"], default: "draft", index: true },
  ownerLabel: { type: String, default: "", trim: true, maxlength: 120 },
  effectiveDate: { type: Date, default: null },
  reviewDate: { type: Date, default: null },
  approvedAt: { type: Date, default: null },
  rejectedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  rejectedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: "", trim: true, maxlength: 2000 },
  archivedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  archivedAt: { type: Date, default: null },
  // Set when an Obsidian sync no longer includes this path. The note stays
  // exactly as it was (still approved and retrievable if it was approved)
  // until a human explicitly archives it or it reappears in a later sync.
  pendingRemoval: { type: Boolean, default: false, index: true },

  version: { type: Number, default: 1 },
  versions: { type: [versionSchema], default: [] },
}, { timestamps: true, collection: "jarvis_memory_notes" });

jarvisMemoryNoteSchema.pre("validate", function capVersionHistory() {
  if (this.versions.length > MAX_VERSIONS) this.versions = this.versions.slice(-MAX_VERSIONS);
});

jarvisMemoryNoteSchema.index({ workspaceId: 1, source: 1, path: 1 }, { unique: true });
jarvisMemoryNoteSchema.plugin(workspacePlugin);

module.exports = mongoose.model("JarvisMemoryNote", jarvisMemoryNoteSchema);
