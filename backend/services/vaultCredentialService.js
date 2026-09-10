/**
 * Owner-facing, database-backed credentials for the Obsidian vault-bridge
 * sync — the self-service replacement for editing
 * JARVIS_MEMORY_SYNC_CREDENTIALS/JARVIS_MEMORY_SYNC_SECRET by hand. Legacy
 * env-based credentials (see jarvisVaultSyncAuthService.js) keep working
 * for backward compatibility, but a client never needs to touch them.
 */
const crypto = require("crypto");
const VaultCredential = require("../models/VaultCredential");
const auditService = require("./auditService");

function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest("hex");
}

function generateSecret() {
  return crypto.randomBytes(24).toString("base64url");
}

/** Returns the plaintext secret exactly once — it is never retrievable again. */
async function createCredential({ workspaceId, userId, label = "" }, Model = VaultCredential) {
  if (!workspaceId) { const error = new Error("Workspace context is required"); error.code = "WORKSPACE_REQUIRED"; throw error; }
  const secret = generateSecret();
  const credential = await Model.create({ workspaceId, label: String(label || "").trim().slice(0, 120), secretHash: hashSecret(secret), createdByUserId: userId, status: "active" });
  await auditService.record({ workspaceId, actorUserId: userId, action: "obsidian.credential.created", targetType: "VaultCredential", targetId: credential._id, after: { label: credential.label }, success: true });
  return { id: credential._id, secret, label: credential.label, createdAt: credential.createdAt };
}

async function listCredentials({ workspaceId }, Model = VaultCredential) {
  if (!workspaceId) { const error = new Error("Workspace context is required"); error.code = "WORKSPACE_REQUIRED"; throw error; }
  return Model.find({ workspaceId }).select("-secretHash").sort({ createdAt: -1 }).lean();
}

async function revokeCredential({ workspaceId, credentialId, userId }, Model = VaultCredential) {
  const credential = await Model.findOneAndUpdate(
    { _id: credentialId, workspaceId, status: "active" },
    { $set: { status: "revoked", revokedByUserId: userId, revokedAt: new Date() } },
    { new: true },
  ).select("-secretHash");
  if (!credential) { const error = new Error("Active credential not found"); error.code = "VAULT_CREDENTIAL_NOT_FOUND"; throw error; }
  await auditService.record({ workspaceId, actorUserId: userId, action: "obsidian.credential.revoked", targetType: "VaultCredential", targetId: credential._id, success: true });
  return credential;
}

/** Looks up which workspace a bearer secret belongs to, via a hash lookup — never by iterating plaintext candidates. */
async function resolveWorkspaceFromSecret(secret, Model = VaultCredential) {
  if (!secret) return null;
  const credential = await Model.findOne({ secretHash: hashSecret(secret), status: "active" }).select("workspaceId");
  if (!credential) return null;
  await Model.updateOne({ _id: credential._id }, { $set: { lastUsedAt: new Date() } });
  return { workspaceId: credential.workspaceId, credentialId: credential._id, mode: "database_backed" };
}

async function recordSyncResult({ workspaceId, credentialId, success, message = "", stats = {} }, Model = VaultCredential) {
  if (!credentialId) return;
  const event = { status: success ? "success" : "error", message: String(message || "").slice(0, 500), syncedCount: stats.syncedCount || 0, draftsAwaitingReviewCount: stats.draftsAwaitingReviewCount || 0, flaggedForRemovalCount: stats.flaggedForRemovalCount || 0 };
  await Model.findByIdAndUpdate(credentialId, {
    $push: { syncHistory: { $each: [event], $slice: -20 } },
    $set: success ? { lastSuccessAt: new Date() } : { lastErrorAt: new Date(), lastError: event.message },
  }).catch((error) => console.warn("[VaultCredential] sync history write skipped", { code: error.code || "VAULT_SYNC_HISTORY_WRITE_FAILED" }));
  if (workspaceId) await auditService.record({ workspaceId, origin: "system", action: success ? "obsidian.sync.completed" : "obsidian.sync.failed", targetType: "VaultCredential", targetId: credentialId, metadata: stats, success });
}

module.exports = { createCredential, listCredentials, revokeCredential, resolveWorkspaceFromSecret, recordSyncResult, hashSecret };
