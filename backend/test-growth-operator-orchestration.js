#!/usr/bin/env node

/**
 * Growth Operator Orchestration Tests
 *
 * Rewritten from real unauthenticated HTTP calls (pre-auth-system legacy) to
 * in-process authenticated route invocation, matching this codebase's
 * established convention (see test-automation-recommendation.js). This
 * router (routes/growthOperators.js) applies no capability/role gate of its
 * own — auth is enforced entirely upstream in server.js — so any populated
 * req.auth is sufficient here, matching the router's real behavior.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const GrowthOperator = require("./models/GrowthOperator");
const GrowthOpportunity = require("./models/GrowthOpportunity");
const Audience = require("./models/Audience");
const Organization = require("./models/Organization");
const OrganizationRelationship = require("./models/OrganizationRelationship");
const router = require("./routes/growthOperators");

let passed = 0;
let failed = 0;

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

async function callRoute(path, method, req) {
  const res = fakeRes();
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No route registered for ${method.toUpperCase()} ${path}`);
  for (const routeLayer of layer.route.stack) {
    let calledNext = false, nextError = null;
    await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
    if (nextError) throw nextError;
    if (!calledNext) break;
  }
  return { status: res.statusCode, body: res.body };
}

const workspaceId = new mongoose.Types.ObjectId().toString();
const authorizedReq = (overrides = {}) => ({ auth: { workspaceId, user: { _id: "test-user" }, effectivePermissions: [] }, params: {}, query: {}, body: {}, ...overrides });

async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✓ Connected to MongoDB\n");
}

async function cleanup(audienceId) {
  await Promise.all([
    GrowthOperator.deleteMany({}),
    GrowthOpportunity.deleteMany({}),
    OrganizationRelationship.deleteMany({}),
    audienceId ? Audience.deleteOne({ _id: audienceId }) : Promise.resolve(),
  ]);
}

async function setupTestData() {
  const audience = await Audience.create({
    name: "Growth Operator Orchestration Test",
    workspaceId,
  });

  // Create real fixture organizations with priority scores rather than
  // depending on whatever happens to already exist in the shared dev DB.
  const orgs = await Organization.insertMany(
    Array.from({ length: 3 }, (_, i) => ({
      name: `Orchestration Test Org ${i + 1}`,
      priorityScore: 70 - i * 10,
      workspaceId,
    })),
  );

  audience.organizationIds = orgs.map((o) => o._id);
  await audience.save();

  await OrganizationRelationship.create({
    organizationId: orgs[0]._id,
    audienceId: audience._id,
    status: "reviewing",
    notes: "Initial contact made",
    workspaceId,
  });

  return { audience, orgs };
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    failed++;
  }
}

async function runTests() {
  console.log("════════════════════════════════════════════════");
  console.log("Growth Operator Orchestration Tests");
  console.log("════════════════════════════════════════════════\n");

  await connectDB();
  await cleanup();

  let testData;
  try {
    testData = await setupTestData();
    console.log(`✓ Setup: Audience and ${testData.orgs.length} organizations\n`);
  } catch (error) {
    console.error("Setup failed:", error.message);
    await mongoose.disconnect();
    process.exit(1);
  }

  const { audience, orgs } = testData;

  console.log("═══ PHASE 1: POST /api/growth-operators/analyze/:audienceId ═══\n");

  let operatorId;

  await test("POST /analyze/:audienceId - Start analysis", async () => {
    const res = await callRoute("/analyze/:audienceId", "post", authorizedReq({
      params: { audienceId: String(audience._id) },
      body: { config: { minPriorityScore: 0, maxOrganizationsToProcess: 10, campaignTypes: ["email", "social"] } },
    }));
    if (res.status !== 201) throw new Error(`Expected 201, got ${res.status}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!res.body.data.operatorId) throw new Error("Missing operatorId");
    if (res.body.data.status !== "active") throw new Error("Status should be active");
    operatorId = String(res.body.data.operatorId);
  });

  await test("POST /analyze/:audienceId - Invalid audience ID (404)", async () => {
    const fakeId = "507f1f77bcf86cd799439011";
    const res = await callRoute("/analyze/:audienceId", "post", authorizedReq({ params: { audienceId: fakeId } }));
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
  });

  await test("POST /analyze/:audienceId - Invalid format (400)", async () => {
    const res = await callRoute("/analyze/:audienceId", "post", authorizedReq({ params: { audienceId: "invalid" } }));
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
  });

  console.log("\nWaiting for analysis to complete (3 seconds)...\n");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log("═══ PHASE 2: GET /api/growth-operators/:operatorId ═══\n");

  await test("GET /:operatorId - Get operator status", async () => {
    const res = await callRoute("/:operatorId", "get", authorizedReq({ params: { operatorId } }));
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!res.body.data.metrics) throw new Error("Missing metrics");
    if (res.body.data.status !== "completed") console.log(`    (Status: ${res.body.data.status}, still processing)`);
  });

  await test("GET /:operatorId - Invalid ID (400)", async () => {
    const res = await callRoute("/:operatorId", "get", authorizedReq({ params: { operatorId: "invalid" } }));
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
  });

  await test("GET /:operatorId - Non-existent (404)", async () => {
    const res = await callRoute("/:operatorId", "get", authorizedReq({ params: { operatorId: "507f1f77bcf86cd799439011" } }));
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
  });

  console.log("\n═══ PHASE 3: GET /api/growth-operators/:operatorId/opportunities ═══\n");

  await test("GET /:operatorId/opportunities - List all opportunities", async () => {
    const res = await callRoute("/:operatorId/opportunities", "get", authorizedReq({ params: { operatorId } }));
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!Array.isArray(res.body.data.opportunities)) throw new Error("Missing opportunities array");
    console.log(`    Found ${res.body.data.opportunities.length} opportunities`);
  });

  await test("GET /:operatorId/opportunities - Filter by status", async () => {
    const res = await callRoute("/:operatorId/opportunities", "get", authorizedReq({ params: { operatorId }, query: { status: "identified" } }));
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.success) throw new Error("Response not successful");
  });

  await test("GET /:operatorId/opportunities - Filter by minPriority", async () => {
    const res = await callRoute("/:operatorId/opportunities", "get", authorizedReq({ params: { operatorId }, query: { minPriority: "60" } }));
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.success) throw new Error("Response not successful");
  });

  await test("GET /:operatorId/opportunities - Invalid minPriority (400)", async () => {
    const res = await callRoute("/:operatorId/opportunities", "get", authorizedReq({ params: { operatorId }, query: { minPriority: "999" } }));
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
  });

  await test("GET /:operatorId/opportunities - Pagination works", async () => {
    const res = await callRoute("/:operatorId/opportunities", "get", authorizedReq({ params: { operatorId }, query: { page: "1", limit: "10" } }));
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.data.pagination) throw new Error("Missing pagination");
    if (res.body.data.pagination.page !== 1) throw new Error("Page should be 1");
  });

  console.log("\n═══ PHASE 4: GET /api/growth-operators/organizations/:organizationId/opportunities ═══\n");

  await test("GET /organizations/:organizationId/opportunities - Get org opportunities", async () => {
    const res = await callRoute("/organizations/:organizationId/opportunities", "get", authorizedReq({ params: { organizationId: String(orgs[0]._id) } }));
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.success) throw new Error("Response not successful");
    console.log(`    Found ${res.body.data.opportunities.length} opportunities for org`);
  });

  await test("GET /organizations/:organizationId/opportunities - With audienceId filter", async () => {
    const res = await callRoute("/organizations/:organizationId/opportunities", "get", authorizedReq({ params: { organizationId: String(orgs[0]._id) }, query: { audienceId: String(audience._id) } }));
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.success) throw new Error("Response not successful");
  });

  console.log("\n═══ PHASE 5: PATCH /api/growth-operators/opportunities/:opportunityId/action ═══\n");

  const oppRes = await callRoute("/:operatorId/opportunities", "get", authorizedReq({ params: { operatorId }, query: { limit: "1" } }));
  if (oppRes.body.data.opportunities.length > 0) {
    const opportunityId = String(oppRes.body.data.opportunities[0]._id);

    await test("PATCH /opportunities/:opportunityId/action - Mark as actioned", async () => {
      const res = await callRoute("/opportunities/:opportunityId/action", "patch", authorizedReq({
        params: { opportunityId },
        body: { action: "actioned", actionDetails: { campaignId: "507f1f77bcf86cd799439011", note: "Campaign created" } },
      }));
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      if (res.body.data.status !== "actioned") throw new Error("Status should be actioned");
    });

    await test("PATCH /opportunities/:opportunityId/action - Mark as skipped", async () => {
      // Fetch a second, distinct opportunity — the first is already actioned.
      const listRes = await callRoute("/:operatorId/opportunities", "get", authorizedReq({ params: { operatorId }, query: { status: "identified", limit: "1" } }));
      if (!listRes.body.data.opportunities.length) { console.log("    (no remaining identified opportunities to skip)"); return; }
      const secondId = String(listRes.body.data.opportunities[0]._id);
      const res = await callRoute("/opportunities/:opportunityId/action", "patch", authorizedReq({
        params: { opportunityId: secondId },
        body: { action: "skipped", actionDetails: { reason: "Not relevant for this quarter" } },
      }));
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      if (res.body.data.status !== "skipped") throw new Error("Status should be skipped");
    });

    await test("PATCH /opportunities/:opportunityId/action - Invalid action (400)", async () => {
      const res = await callRoute("/opportunities/:opportunityId/action", "patch", authorizedReq({ params: { opportunityId }, body: { action: "invalid_action" } }));
      if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
    });

    await test("PATCH /opportunities/:opportunityId/action - Invalid ID (400)", async () => {
      const res = await callRoute("/opportunities/:opportunityId/action", "patch", authorizedReq({ params: { opportunityId: "invalid" }, body: { action: "actioned" } }));
      if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
    });

    await test("PATCH /opportunities/:opportunityId/action - Non-existent (404)", async () => {
      const res = await callRoute("/opportunities/:opportunityId/action", "patch", authorizedReq({ params: { opportunityId: "507f1f77bcf86cd799439011" }, body: { action: "actioned" } }));
      if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
    });
  } else {
    console.log("⊘ Skipping opportunity action tests (no opportunities found)");
  }

  console.log("\n════════════════════════════════════════════════");
  console.log("Test Summary");
  console.log("════════════════════════════════════════════════");
  console.log(`✓ Passed: ${passed}`);
  console.log(`✗ Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  if (failed === 0) console.log("\n🎉 ALL TESTS PASSED!");
  else console.log("\n⚠️  Some tests failed");

  await Organization.deleteMany({ _id: { $in: orgs.map((o) => o._id) } });
  await cleanup(audience._id);
  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
