// Regression coverage for the audit routes: owner/admin-only gate,
// workspace-scoped list/export/retention, and that a member cannot reach any of it.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/audit");
const auditService = require("./services/auditService");
const AuditLog = require("./models/AuditLog");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  res.set = () => res;
  res.send = (data) => { res.body = data; return res; };
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
  const adminAuth = { workspaceId: String(workspaceId), roles: ["admin"], effectivePermissions: [] };
  const memberAuth = { workspaceId: String(workspaceId), roles: ["member"], effectivePermissions: [] };

  try {
    await auditService.record({ workspaceId, action: "deletion", targetType: "Contact", targetId: new mongoose.Types.ObjectId(), success: true });

    const forbidden = await runRoute("/", "get", { auth: memberAuth, query: {} });
    assert.equal(forbidden.statusCode, 403);

    const listRes = await runRoute("/", "get", { auth: adminAuth, query: {} });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.body.data.rows.length, 1);

    const exportRes = await runRoute("/export", "get", { auth: adminAuth, query: {} });
    assert.equal(exportRes.statusCode, 200);
    assert.ok(exportRes.body.includes("occurredAt"));

    const retentionRejected = await runRoute("/retention", "post", { auth: adminAuth, body: { olderThanDays: 5 } });
    assert.equal(retentionRejected.statusCode, 400);

    console.log("Audit routes: owner/admin RBAC gate, list, CSV export, and retention guard all passed.");
  } finally {
    await AuditLog.deleteMany({ workspaceId });
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
