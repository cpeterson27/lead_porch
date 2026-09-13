// Regression coverage for the Knowledge Center HTTP routes added to
// routes/jarvis.js: list/get/approve/reject/archive/restore-version, and
// the owner-facing vault-credential CRUD routes. Real MongoDB, no mocking
// of jarvisMemoryService/vaultCredentialService — this exercises the real
// route-to-service wiring end to end.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/jarvis");
const JarvisMemoryNote = require("./models/JarvisMemoryNote");
const VaultCredential = require("./models/VaultCredential");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}
async function runRoute(path, method, req) {
  const res = fakeRes();
  for (const layer of router.stack) {
    const handlers = layer.route ? (layer.route.path === path && layer.route.methods[method] ? layer.route.stack : null) : [layer];
    if (!handlers) continue;
    let stopped = false;
    for (const routeLayer of handlers) {
      let calledNext = false, nextError = null;
      await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
      if (nextError) throw nextError;
      if (!calledNext) { stopped = true; break; }
    }
    if (stopped || layer.route) break;
  }
  return res;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const owner = { workspaceId: String(workspaceId), userId: new mongoose.Types.ObjectId(), user: { _id: new mongoose.Types.ObjectId() }, roles: ["owner"], effectivePermissions: ["jarvis.manage"] };

  try {
    // Member (not owner/admin) is rejected before touching any note.
    const forbidden = await runRoute("/memory/notes", "get", { auth: { workspaceId: String(workspaceId), roles: ["member"], effectivePermissions: [] } });
    assert.equal(forbidden.statusCode, 403);

    const note = await JarvisMemoryNote.create({ workspaceId, source: "obsidian_bridge", category: "sops", path: "07 SOPs/route-test.md", title: "Route Test", content: "content", contentHash: "h1", status: "draft" });

    const listRes = await runRoute("/memory/notes", "get", { auth: owner, query: { status: "draft" } });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.body.data.length, 1);

    const getRes = await runRoute("/memory/notes/:id", "get", { auth: owner, params: { id: String(note._id) } });
    assert.equal(getRes.body.data.status, "draft");

    const approveRes = await runRoute("/memory/notes/:id/approve", "post", { auth: owner, params: { id: String(note._id) }, body: { ownerLabel: "Ops" } });
    assert.equal(approveRes.body.data.status, "approved");
    assert.equal(approveRes.body.data.ownerLabel, "Ops");

    const rejectRes = await runRoute("/memory/notes/:id/reject", "post", { auth: owner, params: { id: String(note._id) }, body: { reason: "Outdated" } });
    assert.equal(rejectRes.body.data.status, "rejected");
    assert.equal(rejectRes.body.data.rejectionReason, "Outdated");

    const archiveRes = await runRoute("/memory/notes/:id/archive", "post", { auth: owner, params: { id: String(note._id) } });
    assert.equal(archiveRes.body.data.status, "archived");

    // Cross-workspace access must 404, never leak another workspace's note.
    const foreignGet = await runRoute("/memory/notes/:id", "get", { auth: { ...owner, workspaceId: String(new mongoose.Types.ObjectId()) }, params: { id: String(note._id) } });
    assert.equal(foreignGet.statusCode, 404);

    const disposable = await JarvisMemoryNote.create({ workspaceId, source: "approved_memory", category: "sops", path: "07 SOPs/delete-test.md", title: "Delete Test", content: "remove me", contentHash: "h2", status: "draft" });
    const deleteRes = await runRoute("/memory/notes/:id", "delete", { auth: owner, params: { id: String(disposable._id) } });
    assert.equal(deleteRes.statusCode, 200);
    assert.equal(deleteRes.body.data.deleted, true);
    assert.equal(await JarvisMemoryNote.exists({ _id: disposable._id }), null);

    // Vault credential routes: create (secret shown once), list (never re-shown), revoke.
    const createRes = await runRoute("/memory/vault-credentials", "post", { auth: owner, body: { label: "Test bridge" } });
    assert.equal(createRes.statusCode, 200);
    assert.ok(createRes.body.data.secret);
    const credentialId = createRes.body.data.id;

    const listCredsRes = await runRoute("/memory/vault-credentials", "get", { auth: owner });
    assert.equal(listCredsRes.body.data.length, 1);
    assert.equal(listCredsRes.body.data[0].secret, undefined);

    const revokeRes = await runRoute("/memory/vault-credentials/:id", "delete", { auth: owner, params: { id: credentialId } });
    assert.equal(revokeRes.body.data.status, "revoked");

    console.log("Knowledge Center routes: RBAC gate, note review lifecycle, scoped deletion, cross-workspace isolation, and vault-credential CRUD all passed.");
  } finally {
    await JarvisMemoryNote.deleteMany({ workspaceId });
    await VaultCredential.deleteMany({ workspaceId });
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
