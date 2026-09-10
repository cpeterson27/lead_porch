/**
 * Growth Operator Foundation Test Suite
 * Tests integrations and marketing campaigns
 *
 * Rewritten from real unauthenticated HTTP calls (pre-auth-system legacy) to
 * in-process authenticated route invocation, matching this codebase's
 * established convention (see test-automation-recommendation.js).
 */

const mongoose = require("mongoose");
require("dotenv").config();

const MarketingCampaign = require("./models/MarketingCampaign");
const Audience = require("./models/Audience");
const integrationsRouter = require("./routes/integrations");
const marketingCampaignsRouter = require("./routes/marketingCampaigns");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

// routes/integrations.js gates its whole router via router.use(requireCapability(...))
// rather than inline per-route, so the walker must also execute router-level
// middleware layers (those with no `.route`), not just the matched route's stack.
async function callRoute(router, path, method, req) {
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
  return { status: res.statusCode, body: res.body };
}

const workspaceId = new mongoose.Types.ObjectId().toString();
const authorizedReq = () => ({ auth: { workspaceId, user: { _id: "test-user" }, effectivePermissions: ["integrations.manage"] } });

async function runTests() {
  console.log("════════════════════════════════════════════════");
  console.log("Growth Operator Foundation Test Suite");
  console.log("════════════════════════════════════════════════\n");

  let passCount = 0;
  let failCount = 0;

  console.log("Connecting to MongoDB...");
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✓ Connected\n");

  let testAudId;
  let createdCampaignIds = [];
  try {
    const audience = await Audience.create({
      name: "Growth Operator Foundation Test",
      workspaceId,
    });
    testAudId = audience._id;
    console.log(`✓ Test audience: ${testAudId}\n`);

    // ═══════════════════════════════════════════════════════════════
    // PHASE 1: Integration Tests
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ PHASE 1: Integration Architecture ═══\n");

    console.log("TEST 1: Get all integrations");
    try {
      const res = await callRoute(integrationsRouter, "/", "get", authorizedReq());
      if (res.status === 200 && res.body.success && res.body.data.integrations) {
        console.log(`✓ PASS: Found ${res.body.data.integrations.length} integrations`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 2: Get integration status");
    try {
      const res = await callRoute(integrationsRouter, "/status", "get", authorizedReq());
      if (res.status === 200 && res.body.success && res.body.data) {
        console.log(`✓ PASS: Integration status retrieved`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 3: Get specific integration (Resend)");
    try {
      const res = await callRoute(integrationsRouter, "/:id", "get", { ...authorizedReq(), params: { id: "resend" } });
      if (res.status === 200 && res.body.success && res.body.data.name === "Resend") {
        console.log(`✓ PASS: Resend integration found (type=${res.body.data.type}, version=${res.body.data.version})`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 4: Get non-existent integration (should 404)");
    try {
      const res = await callRoute(integrationsRouter, "/:id", "get", { ...authorizedReq(), params: { id: "nonexistent" } });
      if (res.status === 404 && !res.body.success) {
        console.log(`✓ PASS: Non-existent integration correctly rejected`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Expected 404, got ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 4b: Missing capability -> 403");
    try {
      const res = await callRoute(integrationsRouter, "/", "get", { auth: { workspaceId, effectivePermissions: [] } });
      if (res.status === 403) {
        console.log(`✓ PASS: Missing integrations.manage capability correctly rejected`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Expected 403, got ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // PHASE 2: Marketing Campaign CRUD Tests
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ PHASE 2: Marketing Campaigns ═══\n");

    let createdCampaignId;

    console.log("TEST 5: Create email campaign");
    try {
      const res = await callRoute(marketingCampaignsRouter, "/", "post", {
        auth: { workspaceId, user: { _id: "test-user" }, effectivePermissions: [] },
        body: {
          name: "Q3 Product Launch",
          type: "email",
          audienceId: testAudId.toString(),
          content: {
            subject: "Exciting New Features Coming Soon",
            body: "We're thrilled to announce...",
            callToAction: "Learn More",
            callToActionUrl: "https://example.com/launch",
          },
          notes: "Test email campaign",
          scheduledFor: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });
      if (res.status === 201 && res.body.success && res.body.data.campaign._id) {
        createdCampaignId = String(res.body.data.campaign._id);
        createdCampaignIds.push(createdCampaignId);
        console.log(`✓ PASS: Email campaign created (id=${createdCampaignId}, status=${res.body.data.campaign.status})`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.status}, error: ${res.body.error}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 6: Create social campaign");
    try {
      const res = await callRoute(marketingCampaignsRouter, "/", "post", {
        auth: { workspaceId, user: { _id: "test-user" }, effectivePermissions: [] },
        body: {
          name: "LinkedIn Thought Leadership",
          type: "social",
          audienceId: testAudId.toString(),
          content: {
            caption: "Excited to share insights on growth marketing",
            hashtags: ["growth", "marketing", "strategy"],
            imageUrls: ["https://example.com/image1.jpg"],
          },
          notes: "LinkedIn campaign",
        },
      });
      if (res.status === 201 && res.body.success) {
        createdCampaignIds.push(res.body.data.campaign._id);
        console.log(`✓ PASS: Social campaign created (type=${res.body.data.campaign.type})`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 7: Create event campaign");
    try {
      const res = await callRoute(marketingCampaignsRouter, "/", "post", {
        auth: { workspaceId, user: { _id: "test-user" }, effectivePermissions: [] },
        body: {
          name: "Virtual Summit 2026",
          type: "event",
          audienceId: testAudId.toString(),
          content: {
            eventName: "Growth Operator Summit",
            eventDescription: "Annual conference for growth leaders",
            eventDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
            eventLocation: "San Francisco, CA",
          },
        },
      });
      if (res.status === 201 && res.body.success) {
        createdCampaignIds.push(res.body.data.campaign._id);
        console.log(`✓ PASS: Event campaign created (type=${res.body.data.campaign.type})`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 8: List all campaigns");
    try {
      const res = await callRoute(marketingCampaignsRouter, "/", "get", { auth: { workspaceId, effectivePermissions: [] }, query: {} });
      if (res.status === 200 && res.body.success && res.body.data.campaigns) {
        console.log(`✓ PASS: Campaigns retrieved (total=${res.body.data.pagination.total}, returned=${res.body.data.campaigns.length})`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 9: Filter campaigns by type");
    try {
      const res = await callRoute(marketingCampaignsRouter, "/", "get", { auth: { workspaceId, effectivePermissions: [] }, query: { type: "email" } });
      if (res.status === 200 && res.body.success) {
        const allEmail = res.body.data.campaigns.every((c) => c.type === "email");
        console.log(`✓ PASS: Filtered by type (email) — results=${res.body.data.campaigns.length}, allEmail=${allEmail}`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 10: Get campaign details");
    try {
      const res = await callRoute(marketingCampaignsRouter, "/:id", "get", { auth: { workspaceId, effectivePermissions: [] }, params: { id: createdCampaignId } });
      if (res.status === 200 && res.body.success && res.body.data.campaign) {
        console.log(`✓ PASS: Campaign details retrieved (name=${res.body.data.campaign.name}, status=${res.body.data.campaign.status})`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 11: Update campaign status");
    try {
      const res = await callRoute(marketingCampaignsRouter, "/:id", "patch", {
        auth: { workspaceId, user: { _id: "test-user" }, effectivePermissions: [] },
        params: { id: createdCampaignId },
        body: { status: "scheduled", notes: "Updated campaign notes" },
      });
      if (res.status === 200 && res.body.success && res.body.data.campaign.status === "scheduled") {
        console.log(`✓ PASS: Campaign status updated to ${res.body.data.campaign.status}`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Status ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // PHASE 3: Validation Tests
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ PHASE 3: Validation & Error Handling ═══\n");

    console.log("TEST 12: Invalid campaign type (should 400)");
    try {
      const res = await callRoute(marketingCampaignsRouter, "/", "post", {
        auth: { workspaceId, user: { _id: "test-user" }, effectivePermissions: [] },
        body: { name: "Invalid Campaign", type: "invalid_type", audienceId: testAudId.toString(), content: { caption: "Test" } },
      });
      if (res.status === 400 && !res.body.success) {
        console.log(`✓ PASS: Invalid type rejected`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Expected 400, got ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 13: Invalid audience ID (should 404)");
    try {
      const res = await callRoute(marketingCampaignsRouter, "/", "post", {
        auth: { workspaceId, user: { _id: "test-user" }, effectivePermissions: [] },
        body: { name: "No Audience Campaign", type: "email", audienceId: new mongoose.Types.ObjectId().toString(), content: { subject: "Test", body: "Test" } },
      });
      if (res.status === 404 && !res.body.success) {
        console.log(`✓ PASS: Invalid audience rejected`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Expected 404, got ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 14: Invalid status update (should 400)");
    try {
      const res = await callRoute(marketingCampaignsRouter, "/:id", "patch", {
        auth: { workspaceId, user: { _id: "test-user" }, effectivePermissions: [] },
        params: { id: createdCampaignId },
        body: { status: "invalid_status" },
      });
      if (res.status === 400 && !res.body.success) {
        console.log(`✓ PASS: Invalid status rejected`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Expected 400, got ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");

    console.log("TEST 15: Missing required fields (should 400)");
    try {
      const res = await callRoute(marketingCampaignsRouter, "/", "post", {
        auth: { workspaceId, user: { _id: "test-user" }, effectivePermissions: [] },
        body: { name: "Incomplete Campaign" },
      });
      if (res.status === 400 && !res.body.success) {
        console.log(`✓ PASS: Missing fields rejected`);
        passCount++;
      } else {
        console.log(`❌ FAIL: Expected 400, got ${res.status}`);
        failCount++;
      }
    } catch (err) { console.log(`❌ FAIL: ${err.message}`); failCount++; }
    console.log("");
  } finally {
    await MarketingCampaign.deleteMany({ _id: { $in: createdCampaignIds } });
    if (testAudId) await Audience.deleteOne({ _id: testAudId });
    await mongoose.disconnect();
  }

  console.log("════════════════════════════════════════════════");
  console.log("Test Summary");
  console.log("════════════════════════════════════════════════");
  console.log(`✓ Passed: ${passCount}`);
  console.log(`❌ Failed: ${failCount}`);
  console.log(`Total: ${passCount + failCount}`);
  console.log("");

  if (failCount === 0) {
    console.log("🎉 ALL TESTS PASSED!");
    process.exit(0);
  } else {
    console.log("⚠️  Some tests failed");
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
