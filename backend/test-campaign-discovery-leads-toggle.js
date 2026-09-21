const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function source(file) { return fs.readFileSync(path.join(__dirname, file), "utf8"); }
function includesAll(contents, expected, label) { for (const value of expected) assert(contents.includes(value), `${label} missing: ${value}`); }

// An explicit, owner-controlled switch decides which campaign a Discovery
// schedule's auto-enrollment currently routes newly-qualified people into
// — never inferred from dates alone. campaignSendScheduler turns it back
// off automatically the instant that campaign's send completes.
includesAll(source("models/Campaign.js"), [
  "acceptingDiscoveryLeads: { type: Boolean, default: false }",
], "models/Campaign.js");

includesAll(source("routes/campaigns.js"), [
  'router.patch("/:id/discovery-leads"',
  "campaign.acceptingDiscoveryLeads = req.body?.accepting === true",
], "routes/campaigns.js");

includesAll(source("services/discoveryAutoEnrollmentService.js"), [
  "acceptingDiscoveryLeads: true",
], "services/discoveryAutoEnrollmentService.js");

includesAll(source("services/campaignSendScheduler.js"), [
  "acceptingDiscoveryLeads: false",
], "services/campaignSendScheduler.js");

console.log("Campaign discovery-leads toggle tests passed: model field, route, auto-enrollment gate, and auto-close-on-send all present.");
