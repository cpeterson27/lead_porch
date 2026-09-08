const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const socialConnectionSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  provider: { type: String, enum: require("../services/socialProviderConfig").SOCIAL_PROVIDERS, required: true },
  status: { type: String, enum: ["connected", "expired", "failed", "disconnected"], default: "connected", index: true },
  credentialsEncrypted: { type: mongoose.Schema.Types.Mixed, required: false, select: false },
  scopes: { type: [String], default: [] },
  declinedScopes: { type: [String], default: [] },
  authorization: {
    valid: { type: Boolean, default: false },
    userId: { type: String, default: "" },
    dataAccessExpiresAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
  },
  expiresAt: { type: Date, default: null },
  providerAccount: {
    id: { type: String, default: "" },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
  },
  assets: [{
    id: { type: String, required: true },
    name: { type: String, default: "" },
    type: { type: String, enum: ["linkedin_organization", "facebook_page", "instagram_business", "x_account"], required: true },
    parentId: { type: String, default: "" },
    username: { type: String, default: "" },
    avatarUrl: { type: String, default: "" },
    permissions: { type: [String], default: [] },
  }],
  selectedAssetIds: { type: [String], default: [] },
  webhookSubscriptions: [{
    assetId: { type: String, required: true },
    parentPageId: { type: String, default: "" },
    fields: { type: [String], default: [] },
    status: { type: String, enum: ["subscribed", "failed", "not_subscribed"], default: "not_subscribed" },
    verifiedAt: { type: Date, default: null },
    error: { type: String, default: "" },
  }],
  connectedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  connectedAt: { type: Date, default: Date.now },
  lastVerifiedAt: { type: Date, default: null },
  lastError: { type: String, default: "" },
}, { timestamps: true, optimisticConcurrency: true });

socialConnectionSchema.index({ workspaceId: 1, provider: 1 }, { unique: true });
// An Instagram business account may intentionally be selected through both
// Facebook Login and Instagram Login. Provider-specific routing decides which
// authorization handles each action.
socialConnectionSchema.index({ workspaceId: 1, selectedAssetIds: 1 }, { name: "workspace_selected_social_asset_routes", partialFilterExpression: { "selectedAssetIds.0": { $exists: true } } });

socialConnectionSchema.plugin(workspacePlugin);
module.exports = mongoose.model("SocialConnection", socialConnectionSchema);
