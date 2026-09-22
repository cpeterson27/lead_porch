const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function source(file) { return fs.readFileSync(path.join(__dirname, file), "utf8"); }

// A campaign's status was set to "active" at creation and never changed
// again by any code path — confirmed by grepping the whole backend for a
// transition to "completed" — so every campaign kept showing "ACTIVE" on
// its card forever, even one that had already fully sent (334/334
// delivered, nothing left to do). The scheduled-send claim is the one
// moment that unambiguously marks a campaign as done, whether the send
// itself succeeds or fails, so it's the right place to flip status.
const schedulerSource = source("services/campaignSendScheduler.js");
assert.ok(/\$set:\s*{\s*scheduledSendCompletedAt:\s*new Date\(\),\s*acceptingDiscoveryLeads:\s*false,\s*status:\s*"completed"/.test(schedulerSource), "the scheduled-send claim must also set campaign.status to completed");

console.log("Campaign status-completed test passed: a fired scheduled send marks the campaign completed.");
