#!/usr/bin/env node

/**
 * Bootcamp Marketing Workflow Tests
 * Tests: Templates, campaign creation, scheduling, and performance tracking
 *
 * Calls routes/bootcampCampaigns.js handlers directly in-process (no real
 * HTTP, no live server) — this router has no inline auth/capability checks
 * of its own (auth is enforced once, globally, in server.js before the
 * router is ever mounted), but its models are workspace-scoped via
 * tenancy/workspacePlugin, so every DB-touching call must run inside
 * runWithWorkspace() the same way requireAuth() would set it up for a real
 * request.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const MarketingCampaign = require("./models/MarketingCampaign");
const Audience = require("./models/Audience");
const router = require("./routes/bootcampCampaigns");
const { runWithWorkspace } = require("./tenancy/workspaceContext");

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
  return res;
}

function req({ params = {}, body = {} } = {}) {
  return { params, body };
}

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✓ Connected to MongoDB\n");
  } catch (error) {
    console.error("Failed to connect:", error.message);
    process.exit(1);
  }
}

async function cleanup(workspaceId) {
  try {
    await runWithWorkspace(workspaceId, () =>
      Promise.all([
        MarketingCampaign.deleteMany({}),
        Audience.deleteMany({}),
      ]),
    );
  } catch (error) {
    console.error("Cleanup error:", error.message);
  }
}

async function setupTestData(workspaceId) {
  return runWithWorkspace(workspaceId, async () => {
    const audience = new Audience({
      name: "Bootcamp Workflow Test",
      description: "Test audience for bootcamp marketing",
    });
    await audience.save();
    return { audience };
  });
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
  console.log("Bootcamp Marketing Workflow Tests");
  console.log("════════════════════════════════════════════════\n");

  await connectDB();
  const workspaceId = new mongoose.Types.ObjectId().toString();
  await cleanup(workspaceId);

  let testData;
  try {
    testData = await setupTestData(workspaceId);
    console.log("✓ Setup: Test audience created\n");
  } catch (error) {
    console.error("Setup failed:", error.message);
    await mongoose.connection.close();
    process.exit(1);
  }

  const { audience } = testData;
  const withWorkspace = (fn) => runWithWorkspace(workspaceId, fn);

  console.log("═══ PHASE 1: GET /api/bootcamp-campaigns/templates ═══\n");

  await test("GET /templates - Get all templates", async () => {
    const res = await withWorkspace(() => callRoute("/templates", "get", req()));
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!res.body.data.templates) throw new Error("Missing templates");
    if (res.body.data.count === 0) throw new Error("No templates found");
    console.log(`    Found ${res.body.data.count} templates: ${res.body.data.available.join(", ")}`);
  });

  await test("GET /templates/:name - Get specific template", async () => {
    const res = await withWorkspace(() => callRoute("/templates/:templateName", "get", req({ params: { templateName: "announcement" } })));
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!res.body.data.template) throw new Error("Missing template");
    if (!res.body.data.template.htmlBody) throw new Error("Missing template body");
  });

  await test("GET /templates/:name - Template not found (404)", async () => {
    const res = await withWorkspace(() => callRoute("/templates/:templateName", "get", req({ params: { templateName: "invalid" } })));
    if (res.statusCode !== 404) throw new Error(`Expected 404, got ${res.statusCode}`);
  });

  console.log("\n═══ PHASE 2: POST /api/bootcamp-campaigns/create ═══\n");

  let campaignId1, campaignId2;

  await test("POST /create - Create campaign from announcement template", async () => {
    const res = await withWorkspace(() => callRoute("/create", "post", req({
      body: { audienceId: audience._id.toString(), templateName: "announcement", name: "Q3 Bootcamp Announcement", callToActionUrl: "https://example.com/bootcamp" },
    })));
    if (res.statusCode !== 201) throw new Error(`Expected 201, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!res.body.data.campaignId) throw new Error("Missing campaignId");
    campaignId1 = String(res.body.data.campaignId);
    console.log(`    Created campaign: ${res.body.data.name}`);
  });

  await test("POST /create - Create campaign with variables", async () => {
    const res = await withWorkspace(() => callRoute("/create", "post", req({
      body: { audienceId: audience._id.toString(), templateName: "earlyBird", name: "Early Bird Campaign", callToActionUrl: "https://example.com/earlybird", variables: { expiryDate: "2026-08-21" } },
    })));
    if (res.statusCode !== 201) throw new Error(`Expected 201, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    campaignId2 = String(res.body.data.campaignId);
  });

  await test("POST /create - Missing audienceId (400)", async () => {
    const res = await withWorkspace(() => callRoute("/create", "post", req({ body: { templateName: "announcement" } })));
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  });

  await test("POST /create - Invalid template (404)", async () => {
    const res = await withWorkspace(() => callRoute("/create", "post", req({ body: { audienceId: audience._id.toString(), templateName: "nonexistent" } })));
    if (res.statusCode !== 404) throw new Error(`Expected 404, got ${res.statusCode}`);
  });

  console.log("\n═══ PHASE 3: PATCH /api/bootcamp-campaigns/:id/schedule ═══\n");

  await test("PATCH /:id/schedule - Schedule campaign", async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);
    const res = await withWorkspace(() => callRoute("/:campaignId/schedule", "patch", req({ params: { campaignId: campaignId1 }, body: { scheduledFor: futureDate.toISOString() } })));
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (res.body.data.status !== "scheduled") throw new Error("Status should be scheduled");
  });

  await test("PATCH /:id/schedule - Past date (400)", async () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 1);
    const res = await withWorkspace(() => callRoute("/:campaignId/schedule", "patch", req({ params: { campaignId: campaignId2 }, body: { scheduledFor: pastDate.toISOString() } })));
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  });

  console.log("\n═══ PHASE 4: POST /api/bootcamp-campaigns/workflow ═══\n");

  let workflowCampaigns = 0;
  await test("POST /workflow - Create complete bootcamp workflow", async () => {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() + 1);
    const reminderDate = new Date();
    reminderDate.setDate(reminderDate.getDate() + 14);

    const res = await withWorkspace(() => callRoute("/workflow", "post", req({
      body: {
        audienceId: audience._id.toString(),
        name: "Summer Bootcamp 2026",
        campaigns: [
          { template: "announcement", name: "Announcement", callToActionUrl: "https://example.com/bootcamp", scheduledFor: startDate.toISOString() },
          { template: "earlyBird", name: "Early Bird Offer", callToActionUrl: "https://example.com/earlybird", scheduledFor: new Date(startDate.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(), variables: { expiryDate: "2026-09-01" } },
          { template: "reminder", name: "Pre-Bootcamp Reminder", callToActionUrl: "https://example.com/bootcamp", scheduledFor: reminderDate.toISOString(), variables: { startDate: "2026-09-15", duration: "8 weeks", format: "Virtual" } },
        ],
      },
    })));
    if (res.statusCode !== 201) throw new Error(`Expected 201, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (res.body.data.campaignsCreated !== 3) throw new Error(`Expected 3 campaigns, got ${res.body.data.campaignsCreated}`);
    workflowCampaigns = res.body.data.campaignsCreated;
    console.log(`    Created ${workflowCampaigns} campaigns in workflow`);
  });

  console.log("\n═══ PHASE 5: GET /api/bootcamp-campaigns/:id/performance ═══\n");

  await test("GET /:id/performance - Get campaign performance", async () => {
    const res = await withWorkspace(() => callRoute("/:campaignId/performance", "get", req({ params: { campaignId: campaignId1 } })));
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!res.body.data.metrics) throw new Error("Missing metrics");
    if (!res.body.data.performance) throw new Error("Missing performance");
    if (!res.body.data.performance.openRate) throw new Error("Missing openRate");
  });

  await test("GET /:id/performance - Non-existent campaign (404)", async () => {
    const fakeId = "507f1f77bcf86cd799439011";
    const res = await withWorkspace(() => callRoute("/:campaignId/performance", "get", req({ params: { campaignId: fakeId } })));
    if (res.statusCode !== 404) throw new Error(`Expected 404, got ${res.statusCode}`);
  });

  console.log("\n═══ PHASE 6: GET /api/bootcamp-campaigns/audience/:id/summary ═══\n");

  await test("GET /audience/:id/summary - Get campaigns summary", async () => {
    const res = await withWorkspace(() => callRoute("/audience/:audienceId/summary", "get", req({ params: { audienceId: audience._id.toString() } })));
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!res.body.data.summary) throw new Error("Missing summary");
    if (res.body.data.summary.totalCampaigns === 0) throw new Error("Should have campaigns");
    if (!res.body.data.overallMetrics) throw new Error("Missing overallMetrics");
    console.log(`    Total campaigns: ${res.body.data.summary.totalCampaigns}`);
    console.log(`    By status: ${JSON.stringify(res.body.data.summary.byStatus)}`);
  });

  console.log("\n═══ PHASE 7: POST /api/bootcamp-campaigns/execute-scheduled ═══\n");

  await test("POST /execute-scheduled - Execute scheduled campaigns", async () => {
    const res = await withWorkspace(() => callRoute("/execute-scheduled", "post", req()));
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (res.body.data.executedCount === undefined) throw new Error("Missing executedCount");
    console.log(`    Executed: ${res.body.data.executedCount}, Failed: ${res.body.data.failedCount}`);
  });

  console.log("\n════════════════════════════════════════════════");
  console.log("Test Summary");
  console.log("════════════════════════════════════════════════");
  console.log(`✓ Passed: ${passed}`);
  console.log(`✗ Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  if (failed === 0) {
    console.log("\n🎉 ALL TESTS PASSED!");
  } else {
    console.log("\n⚠️  Some tests failed");
  }

  await cleanup(workspaceId);
  await mongoose.connection.close();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
