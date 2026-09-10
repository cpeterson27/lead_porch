const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const emailVerificationResultSchema = new mongoose.Schema(
  {
    email: { type: String, required: true },
    state: { type: String, default: "unknown" },
    // Provider-neutral canonical status. This is what the rest of the app
    // (approved automated outreach gating, UI) should read — never the raw
    // provider-specific `state` above.
    canonicalState: { type: String, enum: ["independently_verified", "provider_validated", "catch_all_risky", "unverified", "invalid", "unknown"], default: "unknown" },
    reason: { type: String, default: "" },
    score: { type: Number, default: null },
    didYouMean: { type: String, default: "" },
    acceptAll: { type: Boolean, default: false },
    disposable: { type: Boolean, default: false },
    role: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
  },
  { _id: false },
);

const emailVerificationBatchSchema = new mongoose.Schema(
  {
    provider: { type: String, default: "emailable" },
    providerBatchId: { type: String, required: true, index: true },
    emailFingerprint: { type: String, required: true, index: true },
    emails: { type: [String], default: [] },
    processed: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    complete: { type: Boolean, default: false },
    counts: { type: mongoose.Schema.Types.Mixed, default: {} },
    results: { type: [emailVerificationResultSchema], default: [] },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      expires: 0,
    },
  },
  { timestamps: true },
);

emailVerificationBatchSchema.plugin(workspacePlugin);
emailVerificationBatchSchema.index({ workspaceId: 1, providerBatchId: 1 }, { unique: true });
module.exports = mongoose.model("EmailVerificationBatch", emailVerificationBatchSchema);
