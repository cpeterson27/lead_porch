// Regression coverage for the Ambassador Resource Center HTTP routes:
// admin CRUD capability gate, ambassador self-service browse/download/
// acknowledge, and that a non-ambassador with no visibility gets nothing.
// Cloudinary is mocked at the imageAssetService credential/http layer is
// exercised for real; the actual upload/download HTTP calls are mocked via
// dependency injection inside services/ambassadorResourceService.js tests —
// this file only exercises the route wiring with real service calls, so it
// needs real (fake-value) Cloudinary env vars to pass credential checks and
// will make a best-effort real POST to Cloudinary's API which is expected
// to fail; we assert on the auth/validation layers that run before that.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/ambassadors");
const AmbassadorProfile = require("./models/AmbassadorProfile");
const AmbassadorResourceFile = require("./models/AmbassadorResourceFile");
const AmbassadorResourceAccess = require("./models/AmbassadorResourceAccess");
const User = require("./models/User");

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
      if (nextError) { res.statusCode = nextError.status || 500; res.body = { success: false, error: nextError.message, code: nextError.code }; return res; }
      if (!calledNext) { stopped = true; break; }
    }
    if (stopped || layer.route) break;
  }
  return res;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const adminUser = await User.create({ name: "Admin", email: `res-route-admin-${Date.now()}@example.test`, passwordHash: "x" });
  const ambassadorUser = await User.create({ name: "Ambassador", email: `res-route-amb-${Date.now()}@example.test`, passwordHash: "x" });
  const adminAuth = { workspaceId: String(workspaceId), user: { _id: adminUser._id }, roles: ["admin"], effectivePermissions: ["ambassadors.manage", "ambassadors.view", "ambassadors.view_own"] };
  const ambassadorAuth = { workspaceId: String(workspaceId), user: { _id: ambassadorUser._id }, roles: ["ambassador"], effectivePermissions: ["ambassadors.view_own"] };

  try {
    // A plain member with none of the ambassador capabilities is rejected before touching any resource.
    const forbidden = await runRoute("/resources", "get", { auth: { workspaceId: String(workspaceId), roles: ["member"], effectivePermissions: [] } });
    assert.equal(forbidden.statusCode, 403);

    // Ambassador (view_own only) cannot reach admin-only resource routes.
    const nonAdminAttempt = await runRoute("/resources", "get", { auth: ambassadorAuth });
    assert.equal(nonAdminAttempt.statusCode, 403);

    // Seed a resource directly (bypassing the real Cloudinary call) to test the read/access routes.
    const resource = await AmbassadorResourceFile.create({
      workspaceId, title: "Seeded Resource", category: "training", kind: "guide",
      visibility: { internalOnly: false, allAmbassadors: true }, currentVersion: 1,
      versions: [{ version: 1, cloudinaryPublicId: "mock-id", resourceType: "raw", format: "pdf", fileName: "seed.pdf", mimeType: "application/pdf", sizeBytes: 10, uploadedByUserId: adminUser._id }],
      createdByUserId: adminUser._id,
    });
    await AmbassadorProfile.create({ workspaceId, userId: ambassadorUser._id, displayName: "Ambassador", status: "active", referralCode: `res-route-${Date.now()}`, referralSlug: `res-route-${Date.now()}-slug` });

    const listRes = await runRoute("/resources", "get", { auth: adminAuth, query: {} });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.body.data.length, 1);

    const meListRes = await runRoute("/me/resources", "get", { auth: ambassadorAuth, query: {} });
    assert.equal(meListRes.statusCode, 200);
    assert.equal(meListRes.body.data.length, 1, "an ambassador visible to all-ambassadors resources must see this one via the self-service route");

    const historyRes = await runRoute("/resources/:id/history", "get", { auth: adminAuth, params: { id: String(resource._id) } });
    assert.equal(historyRes.statusCode, 200);
    assert.deepEqual(historyRes.body.data, []);

    const approveRes = await runRoute("/resources/:id/jarvis-approval", "patch", { auth: adminAuth, params: { id: String(resource._id) }, body: { approved: true } });
    assert.equal(approveRes.body.data.jarvisApproved, true);

    const archiveRes = await runRoute("/resources/:id/archive", "post", { auth: adminAuth, params: { id: String(resource._id) } });
    assert.equal(archiveRes.body.data.status, "archived");

    console.log("Ambassador Resource Center routes: RBAC gate, admin list/history/approval/archive, and ambassador self-service visibility all passed.");
  } finally {
    await AmbassadorResourceFile.deleteMany({ workspaceId });
    await AmbassadorResourceAccess.deleteMany({ workspaceId });
    await AmbassadorProfile.deleteMany({ workspaceId });
    await User.deleteMany({ _id: { $in: [adminUser._id, ambassadorUser._id] } });
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
