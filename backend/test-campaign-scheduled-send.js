const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function source(file) { return fs.readFileSync(path.join(__dirname, file), "utf8"); }
function includesAll(contents, expected, label) { for (const value of expected) assert(contents.includes(value), `${label} missing: ${value}`); }

// Auto-sends every currently-approved draft for a campaign at a chosen time,
// with no one needing to click Send — confirms the pieces are wired
// together rather than re-testing Mongo/Resend behavior already covered
// elsewhere (test-communications-core.js, the manual send route).
includesAll(source("models/Campaign.js"), [
  "scheduledSendAt", "scheduledSendDeliveryPurpose", "scheduledSendCompletedAt", "scheduledSendResult",
], "models/Campaign.js");

includesAll(source("routes/campaigns.js"), [
  'router.patch("/:id/scheduled-send"',
  "Approve at least one draft before scheduling",
  "Choose a real date and time in the future",
], "routes/campaigns.js");

includesAll(source("services/scheduledCampaignSendService.js"), [
  "sendApprovedOutreachForCampaign",
  'status: "approved"',
  "Suppressed because this address previously bounced",
], "services/scheduledCampaignSendService.js");

includesAll(source("services/campaignSendScheduler.js"), [
  "runDueCampaignSends",
  "findOneAndUpdate",
  "scheduledSendCompletedAt: null",
  "startCampaignSendScheduler",
  "stopCampaignSendScheduler",
], "services/campaignSendScheduler.js");

includesAll(source("server.js"), [
  "startCampaignSendScheduler",
], "server.js");

console.log("Campaign scheduled-send tests passed: model fields, route, atomic-claim scheduler, and server wiring all present.");
