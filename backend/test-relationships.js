/**
 * Test script for Organization Relationship Management Layer
 * Tests all 3 endpoints (GET relationship, PATCH relationship, GET by-status)
 * via in-process, authenticated, workspace-scoped route invocation.
 */

require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/organizationRelationships");
const { runWithWorkspace } = require("./tenancy/workspaceContext");
const Audience = require("./models/Audience");
const Organization = require("./models/Organization");
const OrganizationRelationship = require("./models/OrganizationRelationship");
const CrmActivity = require("./models/CrmActivity");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

// This router relies entirely on the automatic tenancy plugin (workspace
// scoping via AsyncLocalStorage), never reading req.auth.workspaceId
// directly in its queries — so route invocation must run inside
// runWithWorkspace for scoping to apply at all, matching what requireAuth
// does for every real request.
async function runRoute(path, method, req) {
  return runWithWorkspace(req.auth.workspaceId, async () => {
    const res = fakeRes();
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    for (const routeLayer of layer.route.stack) {
      let calledNext = false, nextError = null;
      await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
      if (nextError) throw nextError;
      if (!calledNext) break;
    }
    return res;
  });
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const auth = { workspaceId: String(workspaceId), user: { _id: String(new mongoose.Types.ObjectId()) }, effectivePermissions: [] };

  const audience = await runWithWorkspace(workspaceId, () => Audience.create({ name: "Test Relationship Audience" }));
  const organization = await runWithWorkspace(workspaceId, () => Organization.create({ name: "Test Relationship Org" }));
  const relationship = await runWithWorkspace(workspaceId, () => OrganizationRelationship.create({
    organizationId: organization._id,
    audienceId: audience._id,
    status: "new",
  }));

  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { await fn(); console.log(`✓ ${name}`); passed++; }
    catch (error) { console.error(`✗ ${name}`); console.error(`  ${error.message}`); failed++; }
  }

  try {
    await test("GET /organizations/:id/relationship?audienceId=... returns the relationship", async () => {
      const res = await runRoute("/:organizationId/relationship", "get", {
        auth, params: { organizationId: String(organization._id) }, query: { audienceId: String(audience._id) },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.organization.name, "Test Relationship Org");
      assert.equal(res.body.audience.name, "Test Relationship Audience");
      assert.equal(res.body.relationship.status, "new");
    });

    await test("GET /organizations/:id/relationship (no audience filter) returns all relationships", async () => {
      const res = await runRoute("/:organizationId/relationship", "get", {
        auth, params: { organizationId: String(organization._id) }, query: {},
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert(Array.isArray(res.body.relationships));
      assert.equal(res.body.relationships.length, 1);
      assert.equal(res.body.relationships[0].audienceName, "Test Relationship Audience");
    });

    await test("PATCH /organizations/:id/relationship updates status to reviewing", async () => {
      const res = await runRoute("/:organizationId/relationship", "patch", {
        auth, params: { organizationId: String(organization._id) },
        body: { audienceId: String(audience._id), status: "reviewing", notes: "Initial review started" },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.relationship.status, "reviewing");
      assert.equal(res.body.relationship.notes, "Initial review started");
      const activity = await runWithWorkspace(workspaceId, () => CrmActivity.findOne({ organizationId: organization._id, type: "status_change" }).lean());
      assert(activity, "a CrmActivity record must be created for the status change");
      assert.match(activity.body, /new → reviewing/);
    });

    await test("PATCH /organizations/:id/relationship updates status to qualified", async () => {
      const res = await runRoute("/:organizationId/relationship", "patch", {
        auth, params: { organizationId: String(organization._id) },
        body: { audienceId: String(audience._id), status: "qualified", notes: "Excellent fit" },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.relationship.status, "qualified");
      assert.equal(res.body.relationship.notes, "Excellent fit");
    });

    await test("PATCH with invalid status returns 400", async () => {
      const res = await runRoute("/:organizationId/relationship", "patch", {
        auth, params: { organizationId: String(organization._id) },
        body: { audienceId: String(audience._id), status: "invalid_status", notes: "This should fail" },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
    });

    await test("GET with invalid organization ID returns 404", async () => {
      const res = await runRoute("/:organizationId/relationship", "get", {
        auth, params: { organizationId: "invalid123" }, query: { audienceId: String(audience._id) },
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.success, false);
    });

    await test("GET /organizations/by-status/:audienceId?status=qualified returns matching organizations", async () => {
      const res = await runRoute("/by-status/:audienceId", "get", {
        auth, params: { audienceId: String(audience._id) }, query: { status: "qualified", limit: "10" },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert(Array.isArray(res.body.organizations));
      assert.equal(res.body.organizations.length, 1);
      assert.equal(res.body.organizations[0].organization.name, "Test Relationship Org");
      assert.equal(res.body.pagination.totalResults, 1);
      assert.equal(res.body.summary.byStatus.qualified, 1);
    });

    await test("GET /organizations/by-status/:audienceId (no filter) returns all statuses", async () => {
      const res = await runRoute("/by-status/:audienceId", "get", {
        auth, params: { audienceId: String(audience._id) }, query: { limit: "5", page: "1" },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.pagination.totalResults, 1);
      assert.equal(res.body.summary.byStatus.qualified, 1);
    });

    await test("GET /organizations/by-status with invalid status filter returns 400", async () => {
      const res = await runRoute("/by-status/:audienceId", "get", {
        auth, params: { audienceId: String(audience._id) }, query: { status: "bad_status" },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
    });

    await test("GET /organizations/by-status with invalid audience ID returns 404", async () => {
      const res = await runRoute("/by-status/:audienceId", "get", {
        auth, params: { audienceId: "invalid123" }, query: {},
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.success, false);
    });

    await test("Workspace isolation: a relationship in a foreign workspace is invisible", async () => {
      const foreignWorkspaceId = new mongoose.Types.ObjectId();
      const res = await runRoute("/:organizationId/relationship", "get", {
        auth: { ...auth, workspaceId: String(foreignWorkspaceId) },
        params: { organizationId: String(organization._id) },
        query: { audienceId: String(audience._id) },
      });
      assert.equal(res.statusCode, 404, "a foreign workspace must not see another workspace's organization");
    });
  } finally {
    await runWithWorkspace(workspaceId, async () => {
      await OrganizationRelationship.deleteMany({ workspaceId });
      await Organization.deleteMany({ workspaceId });
      await Audience.deleteMany({ workspaceId });
      await CrmActivity.deleteMany({ workspaceId });
    });
    await mongoose.disconnect();
  }

  console.log("\n========================================");
  console.log("Test Summary");
  console.log("========================================");
  console.log(`✓ Passed: ${passed}`);
  console.log(`✗ Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);
  if (failed > 0) { console.log("\n⚠️  Some tests failed"); process.exitCode = 1; }
  else console.log("\n🎉 ALL TESTS PASSED!");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
