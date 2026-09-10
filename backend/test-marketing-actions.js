#!/usr/bin/env node

/**
 * Marketing Action Layer Tests
 * Tests: Opportunity → Action conversion, action endpoints, filtering, summaries
 *
 * Converted from real unauthenticated HTTP calls (pre-tenancy legacy pattern)
 * to in-process, workspace-scoped route invocation. growthOperators.js routes
 * carry no per-route capability gate of their own — auth is enforced globally
 * in server.js before routing ever reaches this router — so what these routes
 * actually depend on is workspace context (via the tenancy AsyncLocalStorage),
 * not a req.auth object; runWithWorkspace() supplies that directly.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { runWithWorkspace } = require("./tenancy/workspaceContext");

const router = require("./routes/growthOperators");
const GrowthOperator = require("./models/GrowthOperator");
const GrowthOpportunity = require("./models/GrowthOpportunity");
const Audience = require("./models/Audience");
const Organization = require("./models/Organization");
const OrganizationRelationship = require("./models/OrganizationRelationship");
const MarketingCampaign = require("./models/MarketingCampaign");

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

function matchParams(path, template) {
  const pathParts = path.split("/").filter(Boolean);
  const templateParts = template.split("/").filter(Boolean);
  const params = {};
  templateParts.forEach((part, i) => {
    if (part.startsWith(":")) params[part.slice(1)] = pathParts[i];
  });
  return params;
}

async function getJson(fullPath, workspaceId) {
  const [path, query = ""] = fullPath.split("?");
  const req = {
    params: matchParams(path, matchingTemplate(path)),
    query: Object.fromEntries(new URLSearchParams(query)),
  };
  const template = matchingTemplate(path);
  return runWithWorkspace(workspaceId, () => runRoute(template, "get", req));
}

const TEMPLATES = ["/:operatorId/actions/summary", "/:operatorId/actions/history", "/:operatorId/actions", "/:operatorId"];
function matchingTemplate(path) {
  const parts = path.split("/").filter(Boolean);
  for (const template of TEMPLATES) {
    const templateParts = template.split("/").filter(Boolean);
    if (templateParts.length !== parts.length) continue;
    if (templateParts.every((part, i) => part.startsWith(":") || part === parts[i])) return template;
  }
  throw new Error(`No route template matches ${path}`);
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
      GrowthOperator.deleteMany({ workspaceId }),
      GrowthOpportunity.deleteMany({ workspaceId }),
      OrganizationRelationship.deleteMany({ workspaceId }),
      MarketingCampaign.deleteMany({ workspaceId }),
      Audience.deleteMany({ workspaceId }),
      Organization.deleteMany({ workspaceId }),
    ]);
  } catch (error) {
    console.error("Cleanup error:", error.message);
  }
}

async function setupTestData(workspaceId) {
  return runWithWorkspace(workspaceId, async () => {
    const audience = await Audience.create({
      name: "Marketing Action Test",
      description: "Test audience for marketing actions",
    });

    // Three high-priority organizations: two get relationships/campaigns
    // (so they're excluded from "new_organization" opportunities), one is
    // left bare so analysis has a guaranteed create_campaign opportunity.
    const orgs = await Organization.create([
      { name: "Acme Org", source: "manual", priorityScore: 85 },
      { name: "Beta Org", source: "manual", priorityScore: 82 },
      { name: "Gamma Org", source: "manual", priorityScore: 90 },
    ]);

    audience.organizationIds = orgs.map((o) => o._id);
    await audience.save();

    await OrganizationRelationship.create({
      organizationId: orgs[0]._id,
      audienceId: audience._id,
      status: "reviewing",
    });
    await MarketingCampaign.create({
      name: "Email campaign 1",
      type: "email",
      status: "active",
      audienceId: audience._id,
      organizationIds: [orgs[0]._id],
      content: { subject: "Test", body: "Test body" },
    });
    await OrganizationRelationship.create({
      organizationId: orgs[1]._id,
      audienceId: audience._id,
      status: "new",
    });

    // POST /analyze/:audienceId — starts analysis synchronously (creates and
    // saves the GrowthOperator) but runs the actual per-organization scoring
    // in the background (fire-and-forget), so callers must poll for completion.
    const analyzeRes = await runRoute("/analyze/:audienceId", "post", {
      params: { audienceId: String(audience._id) },
      body: {},
    });
    if (analyzeRes.statusCode !== 201) {
      throw new Error(`Analysis start failed: ${JSON.stringify(analyzeRes.body)}`);
    }
    const operatorId = analyzeRes.body.data.operatorId;

    // Poll for the background analysis to finish instead of a fixed sleep.
    // status starts as "active" (the model's default) and moves to
    // "completed"/"failed" once runAnalysis's fire-and-forget work lands.
    const deadline = Date.now() + 10000;
    let operator;
    do {
      operator = await GrowthOperator.findById(operatorId);
      if (["completed", "failed"].includes(operator.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    if (operator.status === "active") throw new Error("Analysis did not complete in time");
    if (operator.status === "failed") throw new Error(`Analysis failed: ${operator.lastError}`);

    return { audience, orgs, operatorId };
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
  console.log("Marketing Action Layer Tests");
  console.log("════════════════════════════════════════════════\n");

  await connectDB();
  const workspaceId = new mongoose.Types.ObjectId();
  await cleanup(workspaceId);

  let testData;
  try {
    testData = await setupTestData(workspaceId);
    console.log(
      `✓ Setup: Audience, ${testData.orgs.length} organizations, and operator\n`,
    );
  } catch (error) {
    console.error("Setup failed:", error.message);
    await cleanup(workspaceId);
    await mongoose.connection.close();
    process.exit(1);
  }

  const { operatorId } = testData;

  console.log(
    "═══ PHASE 1: GET /api/growth-operators/:operatorId/actions ═══\n",
  );

  await test("GET /:operatorId/actions - Get all actions", async () => {
    const res = await getJson(`/${operatorId}/actions`, workspaceId);
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!Array.isArray(res.body.data.actions)) throw new Error("Missing actions array");
    console.log(`    Found ${res.body.data.actions.length} actions`);
    if (res.body.data.actions.length === 0) throw new Error("Expected at least one action from the bare high-priority organization");

    const action = res.body.data.actions[0];
    if (!action.organizationId) throw new Error("Missing organizationId");
    if (!action.organizationName) throw new Error("Missing organizationName");
    if (!action.opportunityType) throw new Error("Missing opportunityType");
    if (!action.recommendedAction) throw new Error("Missing recommendedAction");
    if (!action.priority && action.priority !== 0) throw new Error("Missing priority");
    if (!action.status) throw new Error("Missing status");
  });

  await test("GET /:operatorId/actions - Filter by opportunityType", async () => {
    const res = await getJson(`/${operatorId}/actions?opportunityType=new_organization`, workspaceId);
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (res.body.data.actions.length === 0) throw new Error("Expected at least one new_organization action");
    for (const action of res.body.data.actions) {
      if (action.opportunityType !== "new_organization") {
        throw new Error(`Action has wrong opportunityType: ${action.opportunityType}`);
      }
    }
  });

  await test("GET /:operatorId/actions - Filter by minPriority", async () => {
    const res = await getJson(`/${operatorId}/actions?minPriority=70`, workspaceId);
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    for (const action of res.body.data.actions) {
      if (action.priority < 70) throw new Error(`Action priority ${action.priority} below 70`);
    }
  });

  await test("GET /:operatorId/actions - Pagination", async () => {
    const res = await getJson(`/${operatorId}/actions?page=1&limit=5`, workspaceId);
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (!res.body.data.pagination) throw new Error("Missing pagination");
    if (res.body.data.pagination.limit !== 5) throw new Error("Limit should be 5");
    if (res.body.data.pagination.page !== 1) throw new Error("Page should be 1");
  });

  await test("GET /:operatorId/actions - Invalid operatorId (400)", async () => {
    const res = await getJson("/invalid/actions", workspaceId);
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  });

  await test("GET /:operatorId/actions - Non-existent (404)", async () => {
    const fakeId = "507f1f77bcf86cd799439011";
    const res = await getJson(`/${fakeId}/actions`, workspaceId);
    if (res.statusCode !== 404) throw new Error(`Expected 404, got ${res.statusCode}`);
  });

  console.log(
    "\n═══ PHASE 2: GET /api/growth-operators/:operatorId/actions/summary ═══\n",
  );

  await test("GET /:operatorId/actions/summary - Get summary statistics", async () => {
    const res = await getJson(`/${operatorId}/actions/summary`, workspaceId);
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (!res.body.success) throw new Error("Response not successful");
    if (!res.body.data.summary) throw new Error("Missing summary");

    const { summary } = res.body.data;
    if (!summary.totalActions && summary.totalActions !== 0) throw new Error("Missing totalActions");
    if (!summary.byRecommendedAction) throw new Error("Missing byRecommendedAction");
    if (!summary.byStatus) throw new Error("Missing byStatus");
    if (!summary.byPriority) throw new Error("Missing byPriority");

    console.log(`    Total actions: ${summary.totalActions}`);
  });

  await test("GET /:operatorId/actions/summary - Invalid ID (400)", async () => {
    const res = await getJson("/invalid/actions/summary", workspaceId);
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  });

  await test("GET /:operatorId/actions/summary - Non-existent (404)", async () => {
    const fakeId = "507f1f77bcf86cd799439011";
    const res = await getJson(`/${fakeId}/actions/summary`, workspaceId);
    if (res.statusCode !== 404) throw new Error(`Expected 404, got ${res.statusCode}`);
  });

  console.log("\n═══ PHASE 3: Action Details and Structure ═══\n");

  await test("Action details - create_campaign has campaignDetails", async () => {
    const res = await getJson(`/${operatorId}/actions`, workspaceId);
    const campaignActions = res.body.data.actions.filter((a) => a.recommendedAction === "create_campaign");
    if (campaignActions.length === 0) {
      console.log("    (No create_campaign actions to verify)");
      return;
    }
    for (const action of campaignActions) {
      if (!action.campaignDetails) throw new Error("Missing campaignDetails");
      if (!action.campaignDetails.suggestedType) throw new Error("Missing suggestedType");
      if (!action.campaignDetails.existingCampaigns) throw new Error("Missing existingCampaigns");
    }
    console.log(`    Verified ${campaignActions.length} create_campaign actions`);
  });

  await test("Action statuses - status field is set correctly", async () => {
    const res = await getJson(`/${operatorId}/actions`, workspaceId);
    const validStatuses = ["ready", "in_progress", "completed", "skipped", "pending"];
    for (const action of res.body.data.actions) {
      if (!validStatuses.includes(action.status)) throw new Error(`Invalid status: ${action.status}`);
    }
    console.log(`    Verified all ${res.body.data.actions.length} actions have valid status`);
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
