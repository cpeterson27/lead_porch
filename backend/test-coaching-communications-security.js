const assert = require("assert");
const fs = require("fs");
const path = require("path");
const routes = fs.readFileSync(path.join(__dirname, "routes/coaching.js"), "utf8");
const service = fs.readFileSync(path.join(__dirname, "services/coachingCommunicationService.js"), "utf8");
const webhooks = fs.readFileSync(path.join(__dirname, "routes/webhooks.js"), "utf8");
assert.match(routes, /communications\/campaigns", requireAdmin/);
assert.match(routes, /communications\/segments\/preview", requireAdmin/);
assert.match(routes, /communications\/jobs", requireAdmin/);
assert.match(routes, /sessions\/:id\/reminders", requireAdmin/);
assert.match(routes, /const communicationFilter = \{ workspaceId: req\.auth\.workspaceId, contactId: contact\._id/);
assert.match(routes, /ConversationMessage\.find\(communicationFilter\)/);
assert.match(service, /CommunicationJob/);
assert.match(service, /ingestProviderMessage/);
// 2026-10-05: email sends now go through services/email.js's sendEmail()
// (the same protected path every campaign/sequence/newsletter send uses —
// real rate cap, real sender identity, real compliance footer) instead of
// a second, separate List-Unsubscribe header built inline here. Assert the
// delegation instead of the now-relocated header text.
assert.match(service, /sendProtectedEmail/);
assert.match(service, /deliveryPurpose: job\.purpose/);
assert.doesNotMatch(service, /hostUrl|start_url|coachingNotes|CoachingNote/);
assert.match(webhooks, /provider: "resend", providerMessageId: messageId/);
assert.match(webhooks, /MessageDeliveryEvent\.create/);
console.log("Coaching communication API, RBAC, and canonical-history contracts passed");
