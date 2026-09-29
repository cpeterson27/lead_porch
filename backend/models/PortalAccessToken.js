const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

// Mirrors the same hashed-token pattern as publicSiteService's student
// profile EditToken — only the SHA-256 hash is ever stored, so a database
// read alone can never produce a usable portal link. A year-long expiry
// (not EditToken's 30 days) since this is meant to last the length of a
// program, not a one-time edit; a coach/admin can revoke and reissue any
// time from the Enrollment.
const portalAccessTokenSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Enrollment", required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  lastUsedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true, collection: "portal_access_tokens" });

portalAccessTokenSchema.plugin(workspacePlugin);

module.exports = mongoose.model("PortalAccessToken", portalAccessTokenSchema);
