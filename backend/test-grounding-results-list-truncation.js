// Regression coverage for vertexGroundingDiscoveryService.listResults()'s
// totalCount/truncated fields — the fix for a real, user-caught gap: the
// endpoint used to hard-cap at 200 rows with zero indication, so anyone
// with more than 200 matching results (a normal outcome after a large
// Apollo/PDL pull) had the rest silently, permanently invisible with no
// way to tell leads existed at all. Now the real total is always reported
// alongside whatever page of rows was actually fetched.
//
// Fully mocked — NO real database connection is made anywhere in this
// file, per this session's standing "no live providers, no production
// writes" constraint. (services/vertexGroundingDiscoveryService.js's own
// integration test, test-vertex-grounding-discovery.js, connects directly
// to process.env.MONGO_URI with no TEST_MONGO_URI guard — that is this
// project's real, live production database. It must never be executed
// from this environment.)
require("dotenv").config();
const assert = require("node:assert/strict");
const { listResults } = require("./services/vertexGroundingDiscoveryService");

const WORKSPACE_ID = "workspace-1";

function fakeGroundingModel(totalDocs, pageSize) {
  const returned = totalDocs.slice(0, pageSize);
  return {
    find: () => ({
      sort: () => ({
        limit: () => ({ lean: async () => returned }),
      }),
    }),
    countDocuments: async () => totalDocs.length,
  };
}

async function testReportsNotTruncatedWhenEverythingFits() {
  const docs = Array.from({ length: 3 }, (_, i) => ({ _id: `r${i}`, status: "pending_review", createdAt: new Date() }));
  const GroundingResearchResult = fakeGroundingModel(docs, 500);
  const result = await listResults({ workspaceId: WORKSPACE_ID }, { GroundingResearchResult });
  assert.equal(result.totalCount, 3);
  assert.equal(result.rows.length, 3);
  assert.equal(result.truncated, false);
  console.log("PASS testReportsNotTruncatedWhenEverythingFits");
}

async function testReportsTruncatedWithTheRealTotalWhenOverTheLimit() {
  const docs = Array.from({ length: 743 }, (_, i) => ({ _id: `r${i}`, status: "pending_review", createdAt: new Date() }));
  const GroundingResearchResult = fakeGroundingModel(docs, 500);
  const result = await listResults({ workspaceId: WORKSPACE_ID }, { GroundingResearchResult });
  assert.equal(result.totalCount, 743, "the real total must be reported even though only a page was fetched");
  assert.equal(result.rows.length, 500);
  assert.equal(result.truncated, true, "the caller must be told rows are missing rather than silently only seeing 500");
  console.log("PASS testReportsTruncatedWithTheRealTotalWhenOverTheLimit");
}

(async () => {
  await testReportsNotTruncatedWhenEverythingFits();
  await testReportsTruncatedWithTheRealTotalWhenOverTheLimit();
  console.log("\nAll grounding-results-list truncation tests passed.");
})().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
