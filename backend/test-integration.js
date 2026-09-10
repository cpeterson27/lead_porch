/**
 * Comprehensive Integration Test — Organization/Audience relationship CRUD
 *
 * Rewritten from real, unauthenticated HTTP calls (a legacy pattern from
 * before this app had an auth/tenancy system — it would now correctly get
 * 401/404 against a live server) to the established in-process route-handler
 * invocation convention used throughout this test suite. This specific
 * router (routes/organizationRelationships.js) applies no inline
 * requireAuth/requireCapability of its own — the global /api gate lives in
 * server.js, upstream of every router — so these tests build req.params/
 * req.query/req.body directly and exercise the route handlers' own logic,
 * matching the same convention as every other passing in-process test here.
 *
 * Self-contained: creates and cleans up its own Organization/Audience/
 * OrganizationRelationship fixtures rather than depending on whatever
 * happens to already exist in the shared dev database.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Organization = require("./models/Organization");
const Audience = require("./models/Audience");
const OrganizationRelationship = require("./models/OrganizationRelationship");
const CrmActivity = require("./models/CrmActivity");
const router = require("./routes/organizationRelationships");
const { runWithWorkspace } = require("./tenancy/workspaceContext");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

async function runRoute(path, method, req) {
  const res = fakeRes();
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No route registered for ${method.toUpperCase()} ${path}`);
  for (const routeLayer of layer.route.stack) {
    let calledNext = false, nextError = null;
    await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
    if (nextError) throw nextError;
    if (!calledNext) break;
  }
  return res;
}

async function runTests() {
  console.log("========================================");
  console.log("Integration Test Suite");
  console.log("========================================\n");

  let passCount = 0;
  let failCount = 0;

  console.log("Connecting to MongoDB...");
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✓ Connected to MongoDB\n");

  console.log("Creating self-contained test data...\n");
  const testOrg = await Organization.create({ name: "Integration Test Org", domain: "integration-test-org.example" });
  const testAud = await Audience.create({ name: "Integration Test Audience", discoverySource: "manual" });
  const extraOrgs = await Organization.create([
    { name: "Integration Test Org 2", domain: "integration-test-org-2.example" },
    { name: "Integration Test Org 3", domain: "integration-test-org-3.example" },
  ]);
  const testOrgId = String(testOrg._id);
  const testAudId = String(testAud._id);
  console.log(`✓ Org: ${testOrgId}`);
  console.log(`✓ Audience: ${testAudId}\n`);

  try {
    // TEST PHASE 1: Create relationships manually
    console.log("═══ PHASE 1: Relationship Creation ═══\n");

    console.log("TEST 1: Create relationship via database");
    try {
      const rel = await OrganizationRelationship.create({
        organizationId: testOrg._id,
        audienceId: testAud._id,
        status: "new",
        notes: "",
      });
      console.log("✓ PASS: Relationship created");
      console.log(`  - Status: ${rel.status}`);
      console.log(`  - Created: ${rel.createdAt}`);
      passCount++;
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failCount++;
    }
    console.log("");

    // TEST PHASE 2: GET operations
    console.log("═══ PHASE 2: GET Operations ═══\n");

    console.log("TEST 2: GET relationship by org + audience");
    try {
      const res = await runRoute("/:organizationId/relationship", "get", {
        params: { organizationId: testOrgId },
        query: { audienceId: testAudId },
      });
      if (res.statusCode === 200 && res.body.success && res.body.relationship) {
        console.log("✓ PASS: Relationship retrieved");
        console.log(`  - Org: ${res.body.organization.name}`);
        console.log(`  - Status: ${res.body.relationship.status}`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.statusCode}, error: ${res.body.error}`);
        failCount++;
      }
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failCount++;
    }
    console.log("");

    console.log("TEST 3: GET all relationships for org");
    try {
      const res = await runRoute("/:organizationId/relationship", "get", {
        params: { organizationId: testOrgId },
        query: {},
      });
      if (res.statusCode === 200 && res.body.success && Array.isArray(res.body.relationships)) {
        console.log("✓ PASS: All relationships retrieved");
        console.log(`  - Count: ${res.body.relationships.length}`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.statusCode}`);
        failCount++;
      }
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failCount++;
    }
    console.log("");

    // TEST PHASE 3: UPDATE operations
    console.log("═══ PHASE 3: UPDATE Operations ═══\n");

    console.log("TEST 4: Update status to 'reviewing'");
    try {
      const res = await runRoute("/:organizationId/relationship", "patch", {
        params: { organizationId: testOrgId },
        body: { audienceId: testAudId, status: "reviewing", notes: "Good fit for audience" },
      });
      if (res.statusCode === 200 && res.body.success && res.body.relationship.status === "reviewing") {
        console.log("✓ PASS: Status updated to reviewing");
        console.log(`  - Notes: ${res.body.relationship.notes}`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.statusCode}`);
        failCount++;
      }
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failCount++;
    }
    console.log("");

    console.log("TEST 5: Update status to 'qualified'");
    try {
      const res = await runRoute("/:organizationId/relationship", "patch", {
        params: { organizationId: testOrgId },
        body: { audienceId: testAudId, status: "qualified", notes: "Ready for outreach" },
      });
      if (res.statusCode === 200 && res.body.success && res.body.relationship.status === "qualified") {
        console.log("✓ PASS: Status updated to qualified");
        console.log(`  - Changed: ${res.body.relationship.lastChangedAt}`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.statusCode}`);
        failCount++;
      }
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failCount++;
    }
    console.log("");

    // TEST PHASE 4: Filtering and pagination
    console.log("═══ PHASE 4: Query & Filtering ═══\n");

    console.log("TEST 6: Create additional relationships for filtering");
    try {
      const statuses = ["new", "reviewing", "qualified"];
      let i = 0;
      for (const org of extraOrgs) {
        await OrganizationRelationship.updateOne(
          { organizationId: org._id, audienceId: testAud._id },
          { organizationId: org._id, audienceId: testAud._id, status: statuses[i++ % statuses.length] },
          { upsert: true },
        );
      }
      console.log("✓ PASS: Additional relationships created");
      passCount++;
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failCount++;
    }
    console.log("");

    console.log("TEST 7: Get organizations by status (all)");
    try {
      const res = await runRoute("/by-status/:audienceId", "get", {
        params: { audienceId: testAudId },
        query: { limit: "10" },
      });
      if (res.statusCode === 200 && res.body.success) {
        console.log("✓ PASS: Organizations retrieved");
        console.log(`  - Total: ${res.body.pagination.totalResults}`);
        console.log("  - Status summary:", res.body.summary.byStatus);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.statusCode}`);
        failCount++;
      }
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failCount++;
    }
    console.log("");

    console.log("TEST 8: Get organizations filtered by status");
    try {
      const res = await runRoute("/by-status/:audienceId", "get", {
        params: { audienceId: testAudId },
        query: { status: "qualified", limit: "10" },
      });
      if (res.statusCode === 200 && res.body.success) {
        console.log("✓ PASS: Filtered organizations retrieved");
        console.log(`  - Status filter: ${res.body.filter.status}`);
        console.log(`  - Results: ${res.body.organizations.length}`);
        if (res.body.organizations.length > 0) {
          console.log(`  - First org: ${res.body.organizations[0].organization.name}`);
        }
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.statusCode}`);
        failCount++;
      }
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failCount++;
    }
    console.log("");

    console.log("TEST 9: Pagination (page 1)");
    try {
      const res = await runRoute("/by-status/:audienceId", "get", {
        params: { audienceId: testAudId },
        query: { page: "1", limit: "2" },
      });
      if (res.statusCode === 200 && res.body.success && res.body.pagination) {
        console.log("✓ PASS: Pagination works");
        console.log(`  - Page: ${res.body.pagination.page}`);
        console.log(`  - Limit: ${res.body.pagination.limit}`);
        console.log(`  - Total results: ${res.body.pagination.totalResults}`);
        console.log(`  - Total pages: ${res.body.pagination.totalPages}`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.statusCode}`);
        failCount++;
      }
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failCount++;
    }
    console.log("");

    // TEST PHASE 5: Error handling
    console.log("═══ PHASE 5: Error Handling ═══\n");

    console.log("TEST 10: Invalid status update (should 400)");
    try {
      const res = await runRoute("/:organizationId/relationship", "patch", {
        params: { organizationId: testOrgId },
        body: { audienceId: testAudId, status: "invalid" },
      });
      if (res.statusCode === 400 && !res.body.success) {
        console.log("✓ PASS: Invalid status rejected");
        console.log(`  - Error: ${res.body.error.substring(0, 50)}...`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Expected 400, got ${res.statusCode}`);
        failCount++;
      }
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failCount++;
    }
    console.log("");

    console.log("TEST 11: Notes length validation");
    try {
      const longNotes = "x".repeat(1001);
      const res = await runRoute("/:organizationId/relationship", "patch", {
        params: { organizationId: testOrgId },
        body: { audienceId: testAudId, status: "qualified", notes: longNotes },
      });
      if (res.statusCode === 400 && !res.body.success) {
        console.log("✓ PASS: Notes length limit enforced");
        console.log(`  - Error: ${res.body.error}`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Expected 400, got ${res.statusCode}`);
        failCount++;
      }
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failCount++;
    }
    console.log("");

    console.log("TEST 12: Invalid org ID");
    try {
      const res = await runRoute("/:organizationId/relationship", "get", {
        params: { organizationId: "invalid123" },
        query: {},
      });
      if (res.statusCode === 404 && !res.body.success) {
        console.log("✓ PASS: Invalid org ID rejected");
        passCount++;
      } else {
        console.log(`❌ FAIL: Expected 404, got ${res.statusCode}`);
        failCount++;
      }
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failCount++;
    }
    console.log("");

    // Summary
    console.log("════════════════════════════════════════");
    console.log("Test Summary");
    console.log("════════════════════════════════════════");
    console.log(`✓ Passed: ${passCount}`);
    console.log(`❌ Failed: ${failCount}`);
    console.log(`Total: ${passCount + failCount}`);
    console.log("");

    if (failCount === 0) {
      console.log("🎉 ALL TESTS PASSED!");
    } else {
      console.log("⚠️  Some tests failed");
      process.exitCode = 1;
    }
  } finally {
    await OrganizationRelationship.deleteMany({ audienceId: testAud._id });
    await CrmActivity.deleteMany({ organizationId: { $in: [testOrg._id, ...extraOrgs.map((o) => o._id)] } });
    await Organization.deleteMany({ _id: { $in: [testOrg._id, ...extraOrgs.map((o) => o._id)] } });
    await Audience.deleteMany({ _id: testAud._id });
    await mongoose.disconnect();
  }
}

const testWorkspaceId = new mongoose.Types.ObjectId();
runWithWorkspace(testWorkspaceId, runTests).catch((err) => {
  console.error("Test error:", err);
  process.exitCode = 1;
});
