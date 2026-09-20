const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
function source(file) { return fs.readFileSync(path.join(__dirname, file), "utf8"); }
function includesAll(contents, expected, label) { for (const value of expected) assert(contents.includes(value), `${label} missing: ${value}`); }

for (const [file, contracts] of Object.entries({
  "models/CommunicationConsent.js": ['collection: "communication_consents"', '"unknown", "opted_in", "opted_out"', "consentedAt", "revokedAt", "proof", "workspacePlugin"],
  "models/MessagingSender.js": ['collection: "messaging_senders"', "a2p", "quietHours", "recordingPolicy", "transcriptionPolicy", "workspacePlugin"],
  "models/CallRecord.js": ['collection: "call_records"', "providerCallId", "recording", "transcription", "consentConfirmed", "workspacePlugin"],
  "models/MessageDeliveryEvent.js": ['collection: "message_delivery_events"', "providerMessageId", "errorCode", "workspacePlugin"],
  "routes/telephony.js": ['router.post("/messages/preview"', 'router.post("/messages/send"', 'approved !== true', 'code: "COMMUNICATION_BLOCKED"', 'router.post("/calls"', "recordingConsentConfirmed", "purchaseEnabled: false"],
  "routes/webhooks.js": ['/twilio/message-inbound', "/twilio/message-status", "/twilio/call-status", "/twilio/recording-status", "validTwilioRequest", "OptOutType", "/^join$/i", 'purpose: "marketing"', "source: \"keyword\""],
  "services/conversations/twilioConversationAdapter.js": ["validateTwilioSignature", "sendMessage", "placeCall", "searchAvailableNumbers", "purchaseNumber", "ingestInbound"],
  "server.js": ['req.path.startsWith("/webhooks/twilio/")', 'app.use("/api/telephony", telephonyRouter)'],
})) includesAll(source(file), contracts, file);

// Real, reported gap: the one-off /telephony/messages/send route already
// gated every SMS through evaluateOutboundCommunication (opt-out, quiet
// hours, US A2P approval, and — critically — documented marketing consent
// for purpose "marketing"), but the scheduled-job pipeline that actually
// powers campaign sends and reminders (processJob, run every 60s by
// communicationJobRunner) never called it at all — its SMS branch only
// checked that an active sender existed. That meant a marketing SMS
// campaign, sent through the campaign composer, could reach a contact with
// zero documented consent. Assert the gate now runs there too, in the same
// order (evaluated, then blocked) as the email branch's emailPolicy check.
{
  const service = source("services/coachingCommunicationService.js");
  assert(service.includes('require("./communicationPolicyService")'), "processJob must import the same compliance gate the manual send route uses");
  const smsBranchStart = service.indexOf('models.MessagingSender.findOne({ workspaceId: job.workspaceId, provider: "twilio"');
  const sendCallIndex = service.indexOf("models.twilioConversationAdapter.sendMessage(", smsBranchStart);
  const policyCallIndex = service.indexOf("evaluateOutboundCommunication({", smsBranchStart);
  assert(smsBranchStart !== -1 && sendCallIndex !== -1, "processJob's SMS branch must still exist in the expected shape");
  assert(policyCallIndex !== -1 && policyCallIndex < sendCallIndex, "evaluateOutboundCommunication must run, and be checked, before a scheduled SMS job ever reaches Twilio");
  assert(service.includes('if (!policy.allowed) throw communicationError(policy.reasons.join("; ")'), "an unmet policy (including missing marketing consent) must actually block the send, not just be computed and ignored");
}

const { inQuietHours, localHour, normalizePhone } = require("./services/communicationPolicyService");
assert.equal(normalizePhone("+1 (310) 555-1212"), "+13105551212");
assert.equal(normalizePhone("310-555-1212"), "");
assert.equal(inQuietHours(22, { startHour: 21, endHour: 8 }), true);
assert.equal(inQuietHours(12, { startHour: 21, endHour: 8 }), false);
assert.equal(Number.isInteger(localHour("America/Los_Angeles", new Date("2026-08-18T19:00:00Z"))), true);
console.log("Communication core contracts passed: consent, A2P gates, quiet hours, messaging, calls, callbacks, and recording policy.");
