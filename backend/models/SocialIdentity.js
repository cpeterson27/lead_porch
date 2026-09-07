const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  // Null after the linked contact is deleted (e.g. for a "start fresh" reset).
  // The row itself is kept rather than deleted so linkedIdentityKeys survives
  // and a future message from this same provider identity is not treated as
  // brand new.
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", default: null, index: true },
  // Other identities (by "provider:providerAssetId:providerUserId" key) that
  // a human has manually confirmed belong to the same real person via the
  // CRM's merge action. This is the only reliable signal available — Meta
  // gives an Instagram account and a Facebook Messenger account completely
  // unrelated ids with no shared identifier, even for the same person.
  linkedIdentityKeys: { type: [String], default: [] },
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
