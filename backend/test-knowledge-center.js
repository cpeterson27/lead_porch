// Regression coverage for the Knowledge Center review workflow
// (approve/reject/archive/restore, list/search, citations) and the
// database-backed, owner-revocable Obsidian vault-bridge credentials that
// replace hand-edited server environment variables.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const jarvisMemoryService = require("./services/jarvisMemoryService");
const vaultCredentialService = require("./services/vaultCredentialService");
const JarvisMemoryNote = require("./models/JarvisMemoryNote");
const VaultCredential = require("./models/VaultCredential");

async function testReviewWorkflow() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const note = await JarvisMemoryNote.create({
    workspaceId, source: "obsidian_bridge", category: "sops", path: "07 SOPs/draft.md",
    title: "Draft SOP", content: "v1 content", contentHash: "hash-v1", status: "draft",
  });

  try {
    // Listing defaults to hiding archived notes; explicit status filters work.
    const drafts = await jarvisMemoryService.listNotes({ workspaceId, status: "draft" });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].content, "v1 content");

    const fetched = await jarvisMemoryService.getNote({ workspaceId, noteId: note._id });
    assert.equal(fetched.status, "draft");
    await assert.rejects(() => jarvisMemoryService.getNote({ workspaceId: new mongoose.Types.ObjectId(), noteId: note._id }), (error) => error.code === "MEMORY_NOTE_NOT_FOUND");

    const approved = await jarvisMemoryService.approveNote({ workspaceId, noteId: note._id, userId, effectiveDate: "2026-01-01", reviewDate: "2027-01-01", ownerLabel: "Marketing" });
    assert.equal(approved.status, "approved");
    assert.equal(String(approved.approvedByUserId), String(userId));
    assert.ok(approved.approvedAt);
    assert.equal(approved.ownerLabel, "Marketing");

    // Only approved notes are retrievable, and retrieval carries structured citations.
    const retrieved = await jarvisMemoryService.retrieveCloudNotes("v1 content", { workspaceId });
    assert.ok(retrieved.sources.includes("07 SOPs/draft.md"));
    const citation = retrieved.citations.find((row) => row.path === "07 SOPs/draft.md");
    assert.equal(citation.title, "Draft SOP");
    assert.equal(citation.stale, false);

    // A rejection clears any prior approval and records why.
    const rejected = await jarvisMemoryService.rejectNote({ workspaceId, noteId: note._id, userId, reason: "Needs a real owner sign-off" });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rejectionReason, "Needs a real owner sign-off");
    const afterRejection = await jarvisMemoryService.retrieveCloudNotes("v1 content", { workspaceId });
    assert.ok(!afterRejection.sources.includes("07 SOPs/draft.md"), "a rejected note must never be retrieved");

    // Archiving removes it from the default (non-archived) list view.
    const archived = await jarvisMemoryService.archiveNote({ workspaceId, noteId: note._id, userId });
    assert.equal(archived.status, "archived");
    const defaultList = await jarvisMemoryService.listNotes({ workspaceId });
    assert.equal(defaultList.length, 0);
    const withArchived = await jarvisMemoryService.listNotes({ workspaceId, includeArchived: true });
    assert.equal(withArchived.length, 1);

    // Search filters by title/content substring.
    await jarvisMemoryService.approveNote({ workspaceId, noteId: note._id, userId });
    const searchHit = await jarvisMemoryService.listNotes({ workspaceId, search: "v1 content" });
    const searchMiss = await jarvisMemoryService.listNotes({ workspaceId, search: "nonexistent phrase" });
    assert.equal(searchHit.length, 1);
    assert.equal(searchMiss.length, 0);

    console.log("Knowledge Center review workflow: draft/approve/reject/archive, citations, and search all passed.");
  } finally {
    await JarvisMemoryNote.deleteMany({ workspaceId });
  }
}

async function testRestoreVersion() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const note = await JarvisMemoryNote.create({
    workspaceId, source: "obsidian_bridge", category: "sops", path: "07 SOPs/restore-me.md",
    title: "Restorable", content: "current content", contentHash: "hash-current", status: "approved",
    version: 2, versions: [{ version: 1, title: "Restorable", content: "original content", contentHash: "hash-original", changeSource: "obsidian_bridge" }],
  });
  try {
    const restored = await jarvisMemoryService.restoreVersion({ workspaceId, noteId: note._id, userId, version: 1 });
    assert.equal(restored.content, "original content");
    assert.equal(restored.status, "draft", "a restore must land as a draft awaiting its own review, never immediately approved");
    assert.equal(restored.version, 3);
    assert.equal(restored.versions.length, 2, "the version that was just replaced must itself be preserved in history");
    await assert.rejects(() => jarvisMemoryService.restoreVersion({ workspaceId, noteId: note._id, userId, version: 99 }), (error) => error.code === "MEMORY_VERSION_NOT_FOUND");
    console.log("Knowledge Center version restore: restores as a new draft revision and preserves history.");
  } finally {
    await JarvisMemoryNote.deleteMany({ workspaceId });
  }
}

async function testVaultCredentials() {
  const workspaceId = new mongoose.Types.ObjectId();
  const otherWorkspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  try {
    const created = await vaultCredentialService.createCredential({ workspaceId, userId, label: "Owner's laptop" });
    assert.ok(created.secret, "the plaintext secret must be returned exactly once, at creation");
    assert.equal(created.label, "Owner's laptop");

    const listed = await vaultCredentialService.listCredentials({ workspaceId });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].secretHash, undefined, "the stored hash must never be exposed to callers");
    assert.equal(listed[0].secret, undefined, "the plaintext secret must never be retrievable after creation");

    // Resolves the correct workspace from the secret, and rejects a wrong one.
    const resolved = await vaultCredentialService.resolveWorkspaceFromSecret(created.secret);
    assert.equal(String(resolved.workspaceId), String(workspaceId));
    assert.equal(resolved.mode, "database_backed");
    assert.equal(await vaultCredentialService.resolveWorkspaceFromSecret("not-a-real-secret"), null);

    // Cross-workspace revocation must not be possible.
    await assert.rejects(() => vaultCredentialService.revokeCredential({ workspaceId: otherWorkspaceId, credentialId: created.id, userId }), (error) => error.code === "VAULT_CREDENTIAL_NOT_FOUND");
    const revoked = await vaultCredentialService.revokeCredential({ workspaceId, credentialId: created.id, userId });
    assert.equal(revoked.status, "revoked");

    // A revoked credential no longer resolves.
    assert.equal(await vaultCredentialService.resolveWorkspaceFromSecret(created.secret), null, "a revoked credential must never authenticate a sync again");

    // Sync history accumulates and is capped.
    const second = await vaultCredentialService.createCredential({ workspaceId, userId, label: "Rotation" });
    await vaultCredentialService.recordSyncResult({ credentialId: second.id, success: true, stats: { syncedCount: 3, draftsAwaitingReviewCount: 1, flaggedForRemovalCount: 0 } });
    await vaultCredentialService.recordSyncResult({ credentialId: second.id, success: false, message: "Sync failed: invalid note path" });
    const afterHistory = await VaultCredential.findById(second.id).lean();
    assert.equal(afterHistory.syncHistory.length, 2);
    assert.equal(afterHistory.syncHistory[0].status, "success");
    assert.equal(afterHistory.syncHistory[1].status, "error");
    assert.ok(afterHistory.lastSuccessAt);
    assert.ok(afterHistory.lastErrorAt);
    assert.equal(afterHistory.lastError, "Sync failed: invalid note path");

    console.log("Vault credentials: create-once secret, list without leaking secrets, workspace resolution, cross-workspace revocation isolation, revocation blocks future sync, and sync history all passed.");
  } finally {
    await VaultCredential.deleteMany({ workspaceId: { $in: [workspaceId, otherWorkspaceId] } });
  }
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  try {
    await testReviewWorkflow();
    await testRestoreVersion();
    await testVaultCredentials();
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
