#!/usr/bin/env node

/**
 * Integration Connection API Tests
 *
 * Exercises routes/integrationConnections.js in-process (direct Express
 * route-handler invocation with a hand-built authenticated req/res), not via
 * real HTTP — this router requires requireCapability("integrations.manage"),
 * applied router-wide via router.use(), not inline per-route.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const IntegrationConnection = require("./models/IntegrationConnection");
const router = require("./routes/integrationConnections");
const { runWithWorkspace } = require("./tenancy/workspaceContext");

let passed = 0;
let failed = 0;
let workspaceId;

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

// router.use(requireCapability(...)) is applied router-wide, ahead of every
// route, rather than inline per-route — so the walker must also execute
// router-level middleware layers (those with no `.route`), not just the
// matched route's own handler stack.
async function callRoute(path, method, req) {
  const res = fakeRes();
  for (const layer of router.stack) {
    const handlers = layer.route
      ? (layer.route.path === path && layer.route.methods[method] ? layer.route.stack : null)
      : [layer];
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

function authedReq({ auth = {}, ...rest } = {}) {
  return {
    auth: { workspaceId: String(workspaceId), user: { _id: "test-user" }, effectivePermissions: ["integrations.manage"], ...auth },
    body: {},
    params: {},
    query: {},
    ...rest,
  };
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

async function cleanup() {
  try {
    await IntegrationConnection.deleteMany({ workspaceId });
  } catch (error) {
    console.error("Cleanup error:", error.message);
  }
}

async function test(name, fn) {
  try {
    await runWithWorkspace(String(workspaceId), fn);
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
  console.log("Integration Connection API Tests");
  console.log("════════════════════════════════════════════════\n");

  await connectDB();
  workspaceId = new mongoose.Types.ObjectId();
  await cleanup();

  console.log("═══ PHASE 0: Authorization ═══\n");

  await test("POST /connect - No capability (403)", async () => {
    const res = await callRoute("/connect", "post", authedReq({ auth: { effectivePermissions: [] }, body: { provider: "resend", credentials: { apiKey: "x" } } }));
    if (res.statusCode !== 403) throw new Error(`Expected 403, got ${res.statusCode}`);
  });

  console.log("\n═══ PHASE 1: POST /connect ═══\n");

  // Test 1: Connect first provider
  await test("POST /connect - Connect resend", async () => {
    const res = await callRoute("/connect", "post", authedReq({
      body: { provider: "resend", credentials: { apiKey: "re_test_key_12345" }, config: { rateLimit: 100 } },
    }));

    if (res.statusCode !== 201) throw new Error(`Expected 201, got ${res.statusCode}`);
    const data = res.body;
    if (!data.success) throw new Error("Response not successful");
    if (data.data.provider !== "resend") throw new Error("Provider mismatch");
    if (data.data.status !== "configured") throw new Error("Status should be configured");
    if (data.data.credentials) throw new Error("Credentials should not be in response");
  });

  // Test 2: Connect eventbrite
  await test("POST /connect - Connect eventbrite", async () => {
    const res = await callRoute("/connect", "post", authedReq({
      body: { provider: "eventbrite", credentials: { apiKey: "eventbrite_key_abc123" }, config: { organizationId: "org_123" } },
    }));

    if (res.statusCode !== 201) throw new Error(`Expected 201, got ${res.statusCode}`);
    if (res.body.data.provider !== "eventbrite") throw new Error("Provider mismatch");
  });

  // Test 3: Update existing connection
  await test("POST /connect - Update existing connection", async () => {
    const res = await callRoute("/connect", "post", authedReq({
      body: { provider: "resend", credentials: { apiKey: "re_new_key_67890" }, config: { rateLimit: 200 } },
    }));

    if (res.statusCode !== 201) throw new Error(`Expected 201, got ${res.statusCode}`);
    if (!res.body.message.includes("configured")) throw new Error("Should indicate update");
  });

  // Test 4: Missing provider
  await test("POST /connect - Missing provider (400)", async () => {
    const res = await callRoute("/connect", "post", authedReq({ body: { credentials: { apiKey: "test" } } }));
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
    if (!res.body.error.includes("provider")) throw new Error("Error message should mention provider");
  });

  // Test 5: Invalid provider
  await test("POST /connect - Invalid provider (400)", async () => {
    const res = await callRoute("/connect", "post", authedReq({ body: { provider: "invalid_provider", credentials: { apiKey: "test" } } }));
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
    if (!res.body.error.includes("Invalid provider")) throw new Error("Error should mention invalid provider");
  });

  // Test 6: Missing credentials
  await test("POST /connect - Missing credentials (400)", async () => {
    const res = await callRoute("/connect", "post", authedReq({ body: { provider: "linkedin" } }));
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  });

  console.log("\n═══ PHASE 2: GET / ═══\n");

  // Test 7: List all connections
  await test("GET / - List all connections", async () => {
    const res = await callRoute("/", "get", authedReq());
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    const data = res.body;
    if (!data.success) throw new Error("Response not successful");
    if (data.data.total < 2) throw new Error("Should have at least 2 connections");
    if (!data.data.connections || !Array.isArray(data.data.connections)) throw new Error("Missing connections array");
    for (const conn of data.data.connections) {
      if (conn.credentials) throw new Error("Credentials should not be in response");
    }
  });

  // Test 8: List includes all fields
  await test("GET / - Response includes all fields", async () => {
    const res = await callRoute("/", "get", authedReq());
    const conn = res.body.data.connections[0];
    const requiredFields = ["provider", "status", "config", "updatedAt"];
    for (const field of requiredFields) {
      if (!(field in conn)) throw new Error(`Missing field: ${field}`);
    }
  });

  console.log("\n═══ PHASE 3: GET /:provider ═══\n");

  // Test 9: Get specific provider
  await test("GET /:provider - Get resend connection", async () => {
    const res = await callRoute("/:provider", "get", authedReq({ params: { provider: "resend" } }));
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    const data = res.body;
    if (!data.success) throw new Error("Response not successful");
    if (data.data.provider !== "resend") throw new Error("Provider mismatch");
    if (data.data.credentials) throw new Error("Credentials should not be in response");
  });

  // Test 10: Get eventbrite
  await test("GET /:provider - Get eventbrite connection", async () => {
    const res = await callRoute("/:provider", "get", authedReq({ params: { provider: "eventbrite" } }));
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    if (res.body.data.provider !== "eventbrite") throw new Error("Provider mismatch");
  });

  // Test 11: Provider not connected (404)
  await test("GET /:provider - Non-existent provider (404)", async () => {
    const res = await callRoute("/:provider", "get", authedReq({ params: { provider: "linkedin" } }));
    if (res.statusCode !== 404) throw new Error(`Expected 404, got ${res.statusCode}`);
    if (!res.body.error.includes("not connected")) throw new Error("Error should mention not connected");
  });

  // Test 12: Invalid provider (400)
  await test("GET /:provider - Invalid provider (400)", async () => {
    const res = await callRoute("/:provider", "get", authedReq({ params: { provider: "invalid_provider" } }));
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
  });

  console.log("\n═══ PHASE 4: DELETE /:provider ═══\n");

  // Test 13: Delete connection
  await test("DELETE /:provider - Delete resend", async () => {
    const res = await callRoute("/:provider", "delete", authedReq({ params: { provider: "resend" } }));
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
    const data = res.body;
    if (!data.success) throw new Error("Response not successful");
    if (data.data.provider !== "resend") throw new Error("Provider mismatch");
  });

  // Test 14: Verify deleted
  await test("GET /:provider - Verify deleted (404)", async () => {
    const res = await callRoute("/:provider", "get", authedReq({ params: { provider: "resend" } }));
    if (res.statusCode !== 404) throw new Error(`Expected 404, got ${res.statusCode}`);
  });

  // Test 15: Delete non-existent (404)
  await test("DELETE /:provider - Non-existent provider (404)", async () => {
    const res = await callRoute("/:provider", "delete", authedReq({ params: { provider: "linkedin" } }));
    if (res.statusCode !== 404) throw new Error(`Expected 404, got ${res.statusCode}`);
  });

  // Test 16: Invalid provider (400)
  await test("DELETE /:provider - Invalid provider (400)", async () => {
    const res = await callRoute("/:provider", "delete", authedReq({ params: { provider: "invalid" } }));
    if (res.statusCode !== 400) throw new Error(`Expected 400, got ${res.statusCode}`);
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

  await cleanup();
  await mongoose.connection.close();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
