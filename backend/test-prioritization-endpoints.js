// Regression coverage for the Organization Prioritization Retrieval API
// (GET /audience/:id/organizations/prioritized and
// GET /audience/organizations/:id/priority): response structure, tier/score
// filters, pagination, single-organization detail, and validation errors —
// all against real fixtures in the test database, invoked in-process
// (no real HTTP server, no unauthenticated real-network calls).
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./routes/audience");
const Audience = require("./models/Audience");
const Organization = require("./models/Organization");
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
  for (const routeLayer of layer.route.stack) {
    let calledNext = false, nextError = null;
    await routeLayer.handle(req, res, (error) => { calledNext = true; nextError = error; });
    if (nextError) throw nextError;
    if (!calledNext) break;
  }
  return res;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  let passCount = 0;
  let failCount = 0;
  const check = (label, condition, detail = "") => {
    if (condition) {
      console.log(`✓ PASS: ${label}`);
      passCount++;
    } else {
      console.log(`❌ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
      failCount++;
    }
  };

  const orgs = await Organization.create([
    { workspaceId, name: "Hot Org", source: "manual", priorityScore: 92, priorityTier: "hot", priorityReasons: ["Recently discovered"], prioritySignals: { audienceFit: 35, industryMatch: 15, companySize: 15, keywordMatch: 8, dataQuality: 9, recency: 10 }, priorityCalculatedAt: new Date(), discoveredAt: new Date() },
    { workspaceId, name: "Warm Org", source: "manual", priorityScore: 60, priorityTier: "warm", discoveredAt: new Date() },
    { workspaceId, name: "Cold Org", source: "manual", priorityScore: 20, priorityTier: "cold", discoveredAt: new Date() },
  ]);
  const audience = await Audience.create({ workspaceId, name: "Test Audience", status: "active", source: "manual", organizationIds: orgs.map((o) => o._id) });
  const audienceId = String(audience._id);
  const organizationId = String(orgs[0]._id);
  const authReq = (extra = {}) => ({ auth: { workspaceId: String(workspaceId), user: { _id: "u1" }, effectivePermissions: [] }, params: {}, query: {}, ...extra });

  try {
    // Test 1: Basic response structure.
    let res = await runWithWorkspace(String(workspaceId), () =>
      runRoute("/:id/organizations/prioritized", "get", authReq({ params: { id: audienceId }, query: {} })),
    );
    check(
      "Basic GET /audience/:id/organizations/prioritized — response structure correct",
      res.statusCode === 200 && res.body.success && Array.isArray(res.body.organizations) && res.body.summary && res.body.pagination,
      JSON.stringify(res.body),
    );
    if (res.body.summary) console.log(`  - Summary: hot=${res.body.summary.byTier.hot}, warm=${res.body.summary.byTier.warm}, cold=${res.body.summary.byTier.cold}`);

    // Test 2: Tier filter (hot).
    res = await runWithWorkspace(String(workspaceId), () =>
      runRoute("/:id/organizations/prioritized", "get", authReq({ params: { id: audienceId }, query: { tier: "hot" } })),
    );
    check(
      "Tier filter tier=hot — all results hot",
      res.statusCode === 200 && res.body.success && res.body.organizations.length === 1 && res.body.organizations.every((org) => org.priorityTier === "hot"),
    );

    // Test 3: Score filter (minScore=80).
    res = await runWithWorkspace(String(workspaceId), () =>
      runRoute("/:id/organizations/prioritized", "get", authReq({ params: { id: audienceId }, query: { minScore: "80" } })),
    );
    check(
      "Score filter minScore=80 — all scores >= 80",
      res.statusCode === 200 && res.body.success && res.body.organizations.length === 1 && res.body.organizations.every((org) => org.priorityScore >= 80),
    );

    // Test 4: Pagination.
    res = await runWithWorkspace(String(workspaceId), () =>
      runRoute("/:id/organizations/prioritized", "get", authReq({ params: { id: audienceId }, query: { page: "1", limit: "10" } })),
    );
    check(
      "Pagination page=1&limit=10 — parameters correct",
      res.statusCode === 200 && res.body.success && res.body.pagination.page === 1 && res.body.pagination.limit === 10 && res.body.organizations.length <= 10,
    );

    // Test 5: Single organization priority detail.
    res = await runWithWorkspace(String(workspaceId), () =>
      runRoute("/organizations/:id/priority", "get", authReq({ params: { id: organizationId } })),
    );
    const hasRequiredFields = res.body?.priority && res.body.priority.score !== undefined && res.body.priority.tier && res.body.priority.signals && res.body.priority.calculatedAt;
    check(
      "Single organization GET /audience/organizations/:id/priority — required fields present",
      res.statusCode === 200 && res.body.success && res.body.organization && hasRequiredFields,
      JSON.stringify(res.body),
    );

    // Test 6: Invalid audience ID -> 404.
    res = await runWithWorkspace(String(workspaceId), () =>
      runRoute("/:id/organizations/prioritized", "get", authReq({ params: { id: "invalid123" }, query: {} })),
    );
    check("Invalid audience ID — 404", res.statusCode === 404 && !res.body.success);

    // Test 7: Invalid tier -> 400.
    res = await runWithWorkspace(String(workspaceId), () =>
      runRoute("/:id/organizations/prioritized", "get", authReq({ params: { id: audienceId }, query: { tier: "invalid" } })),
    );
    check("Invalid tier parameter — 400", res.statusCode === 400 && !res.body.success);

    // Test 8: Invalid score -> 400.
    res = await runWithWorkspace(String(workspaceId), () =>
      runRoute("/:id/organizations/prioritized", "get", authReq({ params: { id: audienceId }, query: { minScore: "150" } })),
    );
    check("Out-of-range minScore parameter — 400", res.statusCode === 400 && !res.body.success);
  } finally {
    await Organization.deleteMany({ workspaceId });
    await Audience.deleteMany({ workspaceId });
    await mongoose.disconnect();
  }

  console.log("\n========================================");
  console.log("Test Summary");
  console.log("========================================");
  console.log(`✓ Passed: ${passCount}`);
  console.log(`❌ Failed: ${failCount}`);
  console.log(`Total: ${passCount + failCount}`);
  if (failCount === 0) {
    console.log("\n🎉 ALL TESTS PASSED!");
  } else {
    console.log("\n⚠️  Some tests failed");
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
