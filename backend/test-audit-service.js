// Regression coverage for the app-wide audit system: secret redaction on
// write, filtered/paginated query, CSV export, and the minimum-retention
// guard on permanent deletion. Real MongoDB, no mocking.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const auditService = require("./services/auditService");
const AuditLog = require("./models/AuditLog");
require("./models/User");

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const foreignWorkspaceId = new mongoose.Types.ObjectId();
  const actorUserId = new mongoose.Types.ObjectId();

  try {
    // Redaction: any key that looks like a secret must never be persisted, at any nesting depth.
    const written = await auditService.record({
      workspaceId, actorUserId, actorRole: "owner", origin: "human", action: "obsidian.credential.created", targetType: "VaultCredential", targetId: new mongoose.Types.ObjectId(),
      after: { label: "Test", secretHash: "should-not-be-visible", nested: { apiKey: "also-hidden", safe: "kept" } },
      metadata: { authorization: "Bearer super-secret-token", note: "kept too" },
      success: true,
    });
    assert.ok(written);
    const stored = await AuditLog.findById(written._id).lean();
    assert.equal(stored.after.secretHash, "[redacted]");
    assert.equal(stored.after.nested.apiKey, "[redacted]");
    assert.equal(stored.after.nested.safe, "kept");
    assert.equal(stored.metadata.authorization, "[redacted]");
    assert.equal(stored.metadata.note, "kept too");

    // Missing required fields must be a safe no-op, never throw and break the real action.
    const skipped = await auditService.record({ workspaceId, action: "deletion" });
    assert.equal(skipped, null);

    // Seed a few more rows across actions/workspaces for query/export/isolation checks.
    await auditService.record({ workspaceId, actorUserId, action: "referral.dispute_filed", targetType: "ReferralAttribution", targetId: new mongoose.Types.ObjectId(), success: true });
    await auditService.record({ workspaceId, actorUserId, action: "referral.dispute_filed", targetType: "ReferralAttribution", targetId: new mongoose.Types.ObjectId(), success: false, provider: "internal" });
    await auditService.record({ workspaceId: foreignWorkspaceId, actorUserId, action: "deletion", targetType: "Contact", targetId: new mongoose.Types.ObjectId(), success: true });

    const allForWorkspace = await auditService.query({ workspaceId, limit: 10 });
    assert.equal(allForWorkspace.rows.length, 3, "workspace scoping must never leak another workspace's rows");
    assert.ok(allForWorkspace.rows.every((row) => String(row.workspaceId) === String(workspaceId)));

    const byAction = await auditService.query({ workspaceId, action: "referral.dispute_filed" });
    assert.equal(byAction.rows.length, 2);

    const failuresOnly = await auditService.query({ workspaceId, success: false });
    assert.equal(failuresOnly.rows.length, 1);
    assert.equal(failuresOnly.rows[0].provider, "internal");

    // Pagination: limit=1 must report a usable cursor, and the cursor must actually advance.
    const firstPage = await auditService.query({ workspaceId, limit: 1 });
    assert.equal(firstPage.rows.length, 1);
    assert.ok(firstPage.nextCursor);
    const secondPage = await auditService.query({ workspaceId, limit: 1, cursor: firstPage.nextCursor });
    assert.equal(secondPage.rows.length, 1);
    assert.notEqual(String(secondPage.rows[0]._id), String(firstPage.rows[0]._id));

    // CSV export never includes another workspace's rows and includes a header.
    const csv = await auditService.exportCsv({ workspaceId });
    const lines = csv.split("\n");
    assert.equal(lines.length, 4, "header + 3 rows for this workspace only");
    assert.ok(lines[0].includes("occurredAt"));
    assert.equal(csv.includes(String(foreignWorkspaceId)), false);

    // Retention: refuses an unsafe short window, accepts a real one.
    await assert.rejects(() => auditService.purgeOlderThan({ workspaceId, olderThanDays: 10 }), (error) => error.code === "AUDIT_RETENTION_TOO_SHORT");
    const purge = await auditService.purgeOlderThan({ workspaceId, olderThanDays: 365 });
    assert.equal(purge.deletedCount, 0, "nothing in this test is actually a year old");

    console.log("Audit service: secret redaction at depth, safe no-op on invalid input, workspace-isolated query/filter/pagination, CSV export, and the minimum-retention guard all passed.");
  } finally {
    await AuditLog.deleteMany({ workspaceId: { $in: [workspaceId, foreignWorkspaceId] } });
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
