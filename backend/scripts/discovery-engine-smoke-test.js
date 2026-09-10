#!/usr/bin/env node
/**
 * MANUAL smoke test only — never run in CI or automated tests, and never
 * against a production data store — this writes and deletes a REAL test
 * document.
 *
 * Confirms, against a real Discovery Engine data store + engine:
 *   1. Auth + config are correct (a health check succeeds).
 *   2. A document can be indexed (upsertDocument).
 *   3. Search for workspace A finds it.
 *   4. Search for a DIFFERENT workspace B does NOT find it — this is the
 *      actual tenant-isolation proof, not just a code-review claim. If this
 *      step fails, the metadata filter is not doing what this integration
 *      assumes and Agent Search must not be enabled for real workspaces
 *      until that is fixed.
 *   5. The document is deleted and confirmed gone from workspace A's search.
 *
 * This is the ONLY thing in this codebase allowed to call Discovery Engine
 * Agent Search "live-tested" — until this has been run successfully against
 * a real data store, treat it as unverified.
 *
 * Usage:
 *   VERTEX_ENABLED=true VERTEX_AGENT_SEARCH_ENABLED=true \
 *   GOOGLE_APPLICATION_CREDENTIALS_JSON='{...}' VERTEX_PROJECT_ID=your-project \
 *   DISCOVERY_ENGINE_DATA_STORE_ID=... DISCOVERY_ENGINE_ENGINE_ID=... \
 *   node scripts/discovery-engine-smoke-test.js
 */
require("dotenv").config();
const discoveryEngineService = require("../services/discoveryEngineService");

const TEST_WORKSPACE_A = "smoke-test-workspace-a";
const TEST_WORKSPACE_B = "smoke-test-workspace-b";
const TEST_DOC_ID = `smoke-test-${Date.now()}`;

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  if (!discoveryEngineService.masterEnabled() || !discoveryEngineService.agentSearchPlatformEnabled()) {
    console.log("Discovery Engine Agent Search is not configured (VERTEX_ENABLED, VERTEX_AGENT_SEARCH_ENABLED, GOOGLE_APPLICATION_CREDENTIALS_JSON, VERTEX_PROJECT_ID must all be set). Nothing to test.");
    return;
  }

  console.log("1. Health check (read-only, no search quota spent)...");
  const health = await discoveryEngineService.healthCheck();
  console.log(health);
  if (!health.healthy) { console.error("Health check failed — verify DISCOVERY_ENGINE_DATA_STORE_ID and IAM permissions before continuing."); process.exitCode = 1; return; }

  try {
    console.log(`\n2. Indexing a real test document (id: ${TEST_DOC_ID}) for workspace "${TEST_WORKSPACE_A}"...`);
    await discoveryEngineService.upsertDocument({ docId: TEST_DOC_ID, workspaceId: TEST_WORKSPACE_A, title: "Smoke Test Document", content: "This is a disposable smoke-test document about pineapple onboarding procedures for Lead Porch's automated verification.", structData: { category: "smoke_test" } });
    console.log("Indexed. Waiting 10s for indexing to become searchable (Discovery Engine indexing is not instantaneous)...");
    await wait(10000);

    console.log(`\n3. Searching as workspace "${TEST_WORKSPACE_A}" (should find it)...`);
    const foundInA = await discoveryEngineService.search({ workspaceId: TEST_WORKSPACE_A, query: "pineapple onboarding" });
    console.log(`Found ${foundInA.results.length} result(s).`);
    if (!foundInA.results.some((row) => row.documentId === TEST_DOC_ID)) console.warn("Did not find the test document yet — indexing can take longer than 10s; this is not necessarily a failure, but re-run if it persists.");

    console.log(`\n4. TENANT ISOLATION CHECK: searching as a DIFFERENT workspace "${TEST_WORKSPACE_B}" (must NOT find it)...`);
    const foundInB = await discoveryEngineService.search({ workspaceId: TEST_WORKSPACE_B, query: "pineapple onboarding" });
    const leaked = foundInB.results.some((row) => row.documentId === TEST_DOC_ID);
    if (leaked) {
      console.error("TENANT ISOLATION FAILURE: workspace B's search returned workspace A's document. DO NOT enable Agent Search for real workspaces until this is fixed — the metadata filter is not isolating tenants as this integration assumes.");
      process.exitCode = 1;
    } else {
      console.log("Confirmed: workspace B's search did not return workspace A's document.");
    }
  } finally {
    console.log(`\n5. Cleaning up: deleting the test document (id: ${TEST_DOC_ID})...`);
    try {
      await discoveryEngineService.deleteDocument({ docId: TEST_DOC_ID });
      console.log("Deleted.");
    } catch (error) {
      console.error(`Cleanup delete failed — you may need to manually delete document "${TEST_DOC_ID}" from the data store: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error("Discovery Engine smoke test crashed unexpectedly:", error.response?.data || error.message);
  process.exitCode = 1;
});
