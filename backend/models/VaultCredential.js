/**
 * A workspace-owned, revocable credential for the Obsidian vault-bridge
 * sync (tools/jarvis-vault-bridge). The plaintext secret is generated once,
 * shown to the owner exactly once, and never stored — only its SHA-256
 * hash is kept, so a database read alone can never leak a usable secret.
 * Each workspace can hold multiple credentials (e.g. while rotating one
 * out), but only "active" ones are ever accepted for sync.
 */
const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const syncEventSchema = new mongoose.Schema({
  occurredAt: { type: Date, default: Date.now },
  status: { type: String, enum: ["success", "error"], required: true },
  message: { type: String, default: "", maxlength: 500 },
  syncedCount: { type: Number, default: 0 },
  draftsAwaitingReviewCount: { type: Number, default: 0 },
  flaggedForRemovalCount: { type: Number, default: 0 },
}, { _id: false });

const vaultCredentialSchema = new mongoose.Schema({
  label: { type: String, default: "", trim: true, maxlength: 120 },
  secretHash: { type: String, required: true, unique: true, index: true, select: false },
  status: { type: String, enum: ["active", "revoked"], default: "active", index: true },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  revokedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  revokedAt: { type: Date, default: null },
  lastUsedAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  lastErrorAt: { type: Date, default: null },
  lastError: { type: String, default: "", maxlength: 500 },
  // Most-recent-last, capped — enough for an owner to see recent sync health
  // without unbounded document growth.
  syncHistory: { type: [syncEventSchema], default: [] },
}, { timestamps: true, collection: "vault_credentials" });

vaultCredentialSchema.pre("validate", function capSyncHistory() {
  if (this.syncHistory.length > 20) this.syncHistory = this.syncHistory.slice(-20);
});

vaultCredentialSchema.plugin(workspacePlugin);
vaultCredentialSchema.index({ workspaceId: 1, status: 1 });

module.exports = mongoose.model("VaultCredential", vaultCredentialSchema);
