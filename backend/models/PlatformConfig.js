/**
 * A single global (not workspace-scoped) document platform owners use to
 * flip provider availability at runtime, without a redeploy. This is
 * layered ON TOP of the server environment variables that actually hold
 * credentials and the master enable flags (GEMINI_ENABLED, PDL_ENABLED,
 * etc.) — an env flag OFF always wins; this can only turn a
 * properly-configured provider OFF platform-wide, never turn on a provider
 * that has no real credentials configured.
 */
const mongoose = require("mongoose");

const platformConfigSchema = new mongoose.Schema({
  key: { type: String, default: "singleton", unique: true, index: true },
  providerAvailability: {
    gemini: { type: Boolean, default: true },
    vertex: { type: Boolean, default: true },
  },
  updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true, collection: "platform_config" });

module.exports = mongoose.model("PlatformConfig", platformConfigSchema);
