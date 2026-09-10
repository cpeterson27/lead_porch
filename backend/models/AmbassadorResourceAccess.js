/**
 * Append-only log of who did what with which resource version — required
 * for "exact document version, effective date, view/download/acceptance
 * timestamps and actor." One row per event; never updated in place.
 */
const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const schema = new mongoose.Schema({
  resourceFileId: { type: mongoose.Schema.Types.ObjectId, ref: "AmbassadorResourceFile", required: true, index: true },
  version: { type: Number, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  action: { type: String, enum: ["view", "download", "acknowledged"], required: true, index: true },
  occurredAt: { type: Date, default: Date.now },
}, { collection: "ambassador_resource_access" });

schema.index({ workspaceId: 1, resourceFileId: 1, userId: 1, action: 1 });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("AmbassadorResourceAccess", schema);
