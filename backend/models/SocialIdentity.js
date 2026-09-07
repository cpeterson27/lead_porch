const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true, index: true },
  provider: { type: String, enum: ["instagram", "facebook", "tiktok", "linkedin", "x"], required: true, index: true },
  providerUserId: { type: String, required: true, trim: true },
  providerAssetId: { type: String, default: "", trim: true, index: true },
  username: { type: String, default: "", trim: true },
  displayName: { type: String, default: "", trim: true },
  avatarUrl: { type: String, default: "", trim: true },
  providerThreadId: { type: String, default: "", trim: true },
  sourceMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  firstActivityAt: { type: Date, default: Date.now },
  lastActivityAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true, collection: "social_identities" });

schema.index({ workspaceId: 1, provider: 1, providerAssetId: 1, providerUserId: 1 }, { unique: true });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("SocialIdentity", schema);
