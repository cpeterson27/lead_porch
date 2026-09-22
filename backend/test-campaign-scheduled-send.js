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
  "scheduledSendAt", "scheduledSendDeliveryPurpose", "scheduledSendProspectingAttestedAt", "scheduledSendCompletedAt", "scheduledSendResult",
], "models/Campaign.js");

includesAll(source("routes/campaigns.js"), [
  'router.patch("/:id/scheduled-send"',
  "Approve at least one draft",
  "Choose a real date and time in the future",
], "routes/campaigns.js");

// Scheduling a send used to be hardcoded to "marketing" purpose because cold
// outreach needs an in-the-moment attestation an unattended background send
// can't provide — but that blocked the exact workflow the owner actually
// wants (a Discovery schedule finding cold Apollo leads overnight, then an
// auto-send the next morning). Collecting the attestation once, at schedule
// time, is what makes that workflow possible without weakening the
// underlying safeguard.
includesAll(source("routes/campaigns.js"), [
  'req.body?.prospectingAttested !== true',
  "Confirm you're authorized to send cold business outreach",
  "!approvedCount && !campaign.acceptingDiscoveryLeads",
], "routes/campaigns.js (scheduled cold-outreach attestation)");

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

// Drafts used to always start "pending" and need a second, per-recipient
// manual approval even though the template they're built from was already
// human-approved — that blocked the owner's actual workflow (a Discovery
// schedule adding leads overnight, expected to be ready for a same-morning
// scheduled send with nobody manually clicking through each one). Every
// draft regenerateCampaignOutreach creates or refreshes is now built only
// from already-approved templates, so it goes straight to "approved".
const outreachGenSource = source("services/outreachGenerationService.js");
assert(!outreachGenSource.includes('status: "pending"'), 'outreachGenerationService.js must not set new/refreshed drafts to "pending" — the source template is always already approved by the time a draft is generated from it');
assert((outreachGenSource.match(/status = "approved"|status: "approved"/g) || []).length >= 2, "both the create-new and refresh-existing draft paths must set status to approved");

console.log("Campaign scheduled-send tests passed: model fields, route, atomic-claim scheduler, auto-approved drafts, and server wiring all present.");
