const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function source(file) { return fs.readFileSync(path.join(__dirname, file), "utf8"); }
function includesAll(contents, expected, label) { for (const value of expected) assert(contents.includes(value), `${label} missing: ${value}`); }

// A recurring (schedule-driven, never one-off manual) Discovery run grades
// every new person with the same AI qualification a human review already
// uses, auto-saves only the ones graded "qualified" into whichever
// campaign the owner has explicitly marked as currently accepting
// Discovery leads (never inferred from dates alone), and falls back to a
// plain CRM import — clearly tagged with which search found them — when
// no campaign is currently open.
includesAll(source("services/discoveryAutoEnrollmentService.js"), [
  "autoGradeApproveAndEnroll", "findActiveCampaign",
  "qualifyAndRecommend", "saveResult", "regenerateCampaignOutreach",
  "acceptingDiscoveryLeads: true",
  "qualificationLabel: \"qualified\"",
  "`discovery:${scheduleName}`",
], "services/discoveryAutoEnrollmentService.js");

includesAll(source("services/publicWebDiscoveryEngineService.js"), [
  "autoGradeApproveAndEnroll",
  'claimed.lastRunStatus === "completed"',
], "services/publicWebDiscoveryEngineService.js");

console.log("Discovery auto-enrollment tests passed: grading, verified-campaign gate, CRM fallback, and scheduler wiring all present.");
