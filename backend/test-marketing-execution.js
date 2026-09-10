#!/usr/bin/env node

/**
 * Email Marketing Execution Layer Tests
 * Tests: Campaign execution, email delivery, status tracking
 *
 * Converted from real unauthenticated HTTP calls (pre-tenancy legacy pattern)
 * to in-process, workspace-scoped route invocation. marketingCampaigns.js
 * routes carry no per-route capability gate of their own — auth is enforced
 * globally in server.js before routing ever reaches this router — so what
 * these routes actually depend on is workspace context (via the tenancy
 * AsyncLocalStorage), not a req.auth object; runWithWorkspace() supplies
 * that directly. Real Resend sends still go out to Resend's own sandbox
 * addresses (delivered@resend.dev, bounced@resend.dev), matching the
 * established convention elsewhere in this suite (e.g.
 * test-resend-credential-poc.js) — no mocking of Resend itself.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { runWithWorkspace } = require("./tenancy/workspaceContext");

const router = require("./routes/marketingCampaigns");
const MarketingCampaign = require("./models/MarketingCampaign");
const Audience = require("./models/Audience");
const Contact = require("./models/Contact");
const IntegrationConnection = require("./models/IntegrationConnection");

let passed = 0;
let failed = 0;

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

async function runRoute(path, method, req) {
  const res = fakeRes();
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  for (const routeLayer of layer.route.stack) {
    let calledNext = false, nextError = null;
    await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
    if (nextError) throw nextError;
    if (!calledNext) break;
  }
  return res;
}

function call(workspaceId, path, method, req) {
  return runWithWorkspace(workspaceId, () => runRoute(path, method, req));
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
    await Promise.all([
      MarketingCampaign.deleteMany({ workspaceId }),
      IntegrationConnection.deleteMany({ workspaceId, provider: "resend" }),
      Audience.deleteMany({ workspaceId }),
      Contact.deleteMany({ email: { $in: ["delivered@resend.dev", "bounced@resend.dev"] } }),
    ]);
  } catch (error) {
    console.error("Cleanup error:", error.message);
  }
}

async function setupTestData(workspaceId) {
  return runWithWorkspace(workspaceId, async () => {
    const audience = await Audience.create({
      name: "Campaign Execution Test",
      description: "Test audience for campaign execution",
    });

    // Bulk campaign sends are gated by checkSendEligibility (suppression,
    // verified email, marketing opt-in) — these two need compliant CRM
    // contacts to be eligible recipients in execute-batch.
    const compliantPrefs = {
      marketingStatus: "subscribed",
      consentAt: new Date(),
    };
    await Contact.deleteMany({ email: { $in: ["delivered@resend.dev", "bounced@resend.dev"] } });
    await Contact.create([
      { name: "Delivered Test", email: "delivered@resend.dev", sources: ["manual"], status: "active", emailStatus: "verified", emailPreferences: compliantPrefs },
      { name: "Bounced Test", email: "bounced@resend.dev", sources: ["manual"], status: "active", emailStatus: "verified", emailPreferences: compliantPrefs },
    ]);

    await IntegrationConnection.findOneAndUpdate(
      { provider: "resend" },
      {
        provider: "resend",
        status: "connected",
        credentials: { apiKey: process.env.RESEND_API_KEY || "re_test_key" },
        config: { from: process.env.EMAIL_FROM || "onboarding@resend.dev" },
        connectedAt: new Date(),
      },
      { upsert: true, new: true },
    );

    const campaign = await MarketingCampaign.create({
      name: "Test Email Campaign",
      type: "email",
      status: "draft",
      audienceId: audience._id,
      content: {
        subject: "Welcome to our platform",
        body: "Thank you for joining us",
        htmlBody: "<h1>Welcome</h1><p>Thank you for joining us</p>",
        callToAction: "Get Started",
        callToActionUrl: "https://example.com/start",
      },
    });

    return { audience, campaign };
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
  console.log("Email Marketing Execution Layer Tests");
  console.log("════════════════════════════════════════════════\n");

  await connectDB();
  const workspaceId = new mongoose.Types.ObjectId();
  await cleanup(workspaceId);

  let testData;
  try {
    testData = await setupTestData(workspaceId);
    console.log("✓ Setup: Audience, campaign, and Resend connection\n");
  } catch (error) {
    console.error("Setup failed:", error.message);
    await cleanup(workspaceId);
    await mongoose.connection.close();
    process.exit(1);
  }

  const { campaign } = testData;

  console.log("═══ PHASE 1: POST /api/marketing-campaigns/:id/execute ═══\n");

  await test("POST /:id/execute - Execute to single recipient", async () => {
    const res = await call(workspaceId, "/:id/execute", "post", {
      params: { id: String(campaign._id) },
      body: { recipientEmail: "delivered@resend.dev" },
    });
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!res.body.data.messageId) throw new Error("Missing messageId");
    if (!res.body.data.campaignId) throw new Error("Missing campaignId");
    console.log(`    Message ID: ${res.body.data.messageId}`);
  });

  await test("POST /:id/execute - Missing recipient (400)", async () => {
    const res = await call(workspaceId, "/:id/execute", "post", { params: { id: String(campaign._id) }, body: {} });
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  });

  await test("POST /:id/execute - Invalid email (400)", async () => {
    const res = await call(workspaceId, "/:id/execute", "post", { params: { id: String(campaign._id) }, body: { recipientEmail: "invalid-email" } });
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  });

  await test("POST /:id/execute - Invalid campaign ID (400)", async () => {
    const res = await call(workspaceId, "/:id/execute", "post", { params: { id: "invalid" }, body: { recipientEmail: "test@example.com" } });
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  });

  await test("POST /:id/execute - Non-existent campaign (404)", async () => {
    const fakeId = "507f1f77bcf86cd799439011";
    const res = await call(workspaceId, "/:id/execute", "post", { params: { id: fakeId }, body: { recipientEmail: "test@example.com" } });
    if (res.statusCode !== 404) throw new Error(`Expected 404, got ${res.statusCode}`);
  });

  console.log("\n═══ PHASE 2: POST /api/marketing-campaigns/:id/execute-batch ═══\n");

  await test("POST /:id/execute-batch - Execute to multiple recipients", async () => {
    const res = await call(workspaceId, "/:id/execute-batch", "post", {
      params: { id: String(campaign._id) },
      body: { recipients: ["delivered@resend.dev", "bounced@resend.dev"] },
    });
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!res.body.data.recipientCount) throw new Error("Missing recipientCount");
    console.log(`    Recipients: ${res.body.data.recipientCount}`);
  });

  await test("POST /:id/execute-batch - Missing recipients (400)", async () => {
    const res = await call(workspaceId, "/:id/execute-batch", "post", { params: { id: String(campaign._id) }, body: {} });
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  });

  await test("POST /:id/execute-batch - Invalid recipient email (400)", async () => {
    const res = await call(workspaceId, "/:id/execute-batch", "post", { params: { id: String(campaign._id) }, body: { recipients: ["valid@example.com", "invalid-email"] } });
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  });

  console.log("\n═══ PHASE 3: GET /api/marketing-campaigns/:id/status ═══\n");

  await test("GET /:id/status - Get campaign status", async () => {
    const res = await call(workspaceId, "/:id/status", "get", { params: { id: String(campaign._id) } });
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!res.body.data) throw new Error("Missing campaign data");
    if (!res.body.data.metrics) throw new Error("Missing metrics");
    if (res.body.data.status !== "active") console.log(`    (Status: ${res.body.data.status})`);
  });

  await test("GET /:id/status - Invalid ID (400)", async () => {
    const res = await call(workspaceId, "/:id/status", "get", { params: { id: "invalid" } });
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  });

  console.log("\n═══ PHASE 4: PATCH /api/marketing-campaigns/:id/pause ═══\n");

  await test("PATCH /:id/pause - Pause campaign", async () => {
    const res = await call(workspaceId, "/:id/pause", "patch", { params: { id: String(campaign._id) } });
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (res.body.data.status !== "paused") throw new Error("Status should be paused");
  });

  console.log("\n═══ PHASE 5: PATCH /api/marketing-campaigns/:id/resume ═══\n");

  await test("PATCH /:id/resume - Resume campaign", async () => {
    const res = await call(workspaceId, "/:id/resume", "patch", { params: { id: String(campaign._id) } });
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (res.body.data.status !== "active") throw new Error("Status should be active");
  });

  console.log("\n════════════════════════════════════════════════");
  console.log("Test Summary");
  console.log("════════════════════════════════════════════════");
  console.log(`✓ Passed: ${passed}`);
  console.log(`✗ Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  if (failed === 0) console.log("\n🎉 ALL TESTS PASSED!");
  else console.log("\n⚠️  Some tests failed");

  await cleanup(workspaceId);
  await mongoose.connection.close();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
