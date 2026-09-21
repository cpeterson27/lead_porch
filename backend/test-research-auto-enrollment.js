const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function source(file) { return fs.readFileSync(path.join(__dirname, file), "utf8"); }
function includesAll(contents, expected, label) { for (const value of expected) assert(contents.includes(value), `${label} missing: ${value}`); }

// Optional add-on to the daily scheduled search: finds decision-makers at
// newly matched organizations and adds only Apollo-*verified* emails into
// a chosen campaign's outreach queue — everyone else is left alone rather
// than added unqualified, and each organization is only ever searched for
// people once (never re-billed on every subsequent daily run).
includesAll(source("models/Audience.js"), [
  "autoEnrollCampaignId", "autoEnrolledOrganizationIds",
], "models/Audience.js");

includesAll(source("services/audienceAutoEnrollmentService.js"), [
  "autoEnrollPeopleForCampaign",
  "MAX_ORGANIZATIONS_PER_RUN", "MAX_PEOPLE_PER_ORGANIZATION",
  'enriched.emailState !== "verified"',
  "regenerateCampaignOutreach",
], "services/audienceAutoEnrollmentService.js");

includesAll(source("services/researchScheduledSearchRunner.js"), [
  "autoEnrollPeopleForCampaign",
  "autoEnrolledOrganizationIds",
  "$addToSet",
], "services/researchScheduledSearchRunner.js");

includesAll(source("routes/audience.js"), [
  "autoEnrollCampaignId",
  "Choose a valid campaign to auto-add people to",
], "routes/audience.js");

console.log("Research auto-enrollment tests passed: model fields, verified-email gate, dedup tracking, and route validation all present.");
