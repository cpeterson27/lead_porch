// Targeted regression coverage for the new manual discovery-track override
// ("Move to Live Leads" / "Not a fit" / "Restore" buttons on the Watchlist/
// Rejected/Community Opportunities tracks in Discovery): a human decision
// must always win over the automatic bucket classifier, and must never be
// silently reversed by the next fetch's re-assessment.
//
// Fully mocked — NO real or test database connection is made anywhere in
// this file. TEST_MONGO_URI is still not configured in this environment.
require("dotenv").config();
const assert = require("node:assert/strict");
const { applyManualBucketOverride } = require("./services/researchMonitorService");

function testNoOverridePassesTheAutomaticResultThrough() {
  const automatic = { bucket: "watchlist", rejectionReason: "" };
  assert.deepEqual(applyManualBucketOverride(automatic, null), automatic, "with no manual override, the automatic classifier's result must be used unchanged");
  assert.deepEqual(applyManualBucketOverride(automatic, undefined), automatic);
  assert.deepEqual(applyManualBucketOverride(automatic, ""), automatic, "an empty-string override (schema default) must not be treated as an active override");
}

function testMoveToLiveLeadsOverridesTheAutomaticWatchlistResult() {
  const automatic = { bucket: "watchlist", rejectionReason: "" };
  const result = applyManualBucketOverride(automatic, "live_lead");
  assert.equal(result.bucket, "live_lead", "a manual 'Move to Live Leads' decision must win over the automatic classifier, every time it's re-assessed");
  assert.equal(result.rejectionReason, "", "promoting to live_lead must never carry a rejection reason");
}

function testNotAFitOverridesEvenAPreviouslyLiveLeadResult() {
  const automatic = { bucket: "live_lead", rejectionReason: "" };
  const result = applyManualBucketOverride(automatic, "rejected");
  assert.equal(result.bucket, "rejected", "'Not a fit' must move even an automatically-accepted signal out of Live Leads");
  assert.equal(result.rejectionReason, "other", "a manual rejection must still carry a valid, schema-allowed rejectionReason value");
}

function testRestoreClearsTheOverrideAndFallsBackToAutomaticClassification() {
  const automatic = { bucket: "rejected", rejectionReason: "no_current_need" };
  // manualBucketOverride: null (cleared via POST .../move with bucket: null)
  const result = applyManualBucketOverride(automatic, null);
  assert.deepEqual(result, automatic, "clearing the override (Restore) must fall back to whatever the automatic classifier currently decides, not stay pinned to the old manual choice");
}

function run() {
  testNoOverridePassesTheAutomaticResultThrough();
  testMoveToLiveLeadsOverridesTheAutomaticWatchlistResult();
  testNotAFitOverridesEvenAPreviouslyLiveLeadResult();
  testRestoreClearsTheOverrideAndFallsBackToAutomaticClassification();
  console.log("Manual discovery-track override: applyManualBucketOverride() lets an explicit owner decision (Move to Live Leads / Not a fit / Restore) win over the automatic Watchlist/Rejected/Community-Opportunity classifier every time signals are re-assessed, never silently reverts on the next fetch, and Restore correctly falls back to live automatic classification rather than a stale manual choice — all passed.");
}

run();
