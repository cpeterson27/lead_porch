const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function source(file) { return fs.readFileSync(path.join(__dirname, file), "utf8"); }

// Confirmed live on a real campaign: contacts got matched before the owner
// approved a real main email, so regenerateCampaignOutreach fell back to
// campaignMasterTemplate's generic hardcoded placeholder (unrelated
// boilerplate about a different bootcamp entirely, with a broken empty
// image src) and silently wrote it into the campaign as if it were the
// real approved template — building 334 outreach drafts from it. There is
// no safe generic content to substitute here; the only correct behavior
// is to skip until a human approves something real.
const outreachGenSource = source("services/outreachGenerationService.js");
assert.ok(!outreachGenSource.includes('require("./campaignMasterTemplate").effectiveTemplate'), "must not silently fabricate an 'approved' template from the generic fallback");
assert.ok(/if \(!campaign\.emailTemplate\?\.currentVersion\)/.test(outreachGenSource), "must skip draft generation entirely when the campaign has no real approved template yet");

// A draft already marked "approved" used to be frozen forever — even after
// the campaign's real template was later approved, drafts built from the
// bad fallback above stayed stuck with the wrong content. Refreshing on a
// template-version mismatch (regardless of current status, but never
// touching anything already sent) closes that gap.
assert.ok(outreachGenSource.includes("isStaleApproved"), "must detect and refresh an already-approved draft whose content is from an older template version");
assert.ok(/isStaleApproved = exists\.status === "approved" && exists\.templateVersion !== recipientTemplate\.version/.test(outreachGenSource), "staleness must be based on template version, and must never apply to a 'sent' draft");

console.log("Outreach fallback-template safety test passed: no silent fake-approval, and stale-but-approved drafts self-correct.");
