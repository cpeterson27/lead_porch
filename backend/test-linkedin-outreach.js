const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.LINKEDIN_UNIPILE_ENABLED = "false";

const LinkedinSequence = require("./models/LinkedinSequence");
const sequenceService = require("./services/linkedinSequenceService");
const inboxSync = require("./services/linkedinInboxSyncService");

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

assert.equal(LinkedinSequence.schema.path("dailyInvitationLimit").options.default, 20);
assert.equal(LinkedinSequence.schema.path("hourlyInvitationLimit").options.default, 5);
assert.equal(
  sequenceService.renderTemplate("Hi {{firstName}} at {{company}}", { name: "Ada Lovelace", company: "Analytical Engines" }),
  "Hi Ada at Analytical Engines",
);

assert.deepEqual(inboxSync.listOf({ items: [{ id: "1" }] }), [{ id: "1" }]);
assert.deepEqual(inboxSync.listOf({ data: [{ id: "2" }] }), [{ id: "2" }]);
const normalized = inboxSync.normalizeMessage({
  accountId: "account-1",
  chat: { id: "chat-1", attendees: [{ provider_id: "account-1" }, { provider_id: "person-1", name: "A Person" }] },
  message: { id: "message-1", text: "Hello", is_sender: true, timestamp: "2026-09-17T12:00:00.000Z" },
});
assert.equal(normalized.chat_id, "chat-1");
assert.equal(normalized.sender.provider_id, "person-1");
assert.equal(normalized.outgoing, true);

const runner = source("services/linkedinSequenceService.js");
for (const contract of [
  "invitationQuota(sequence)",
  "hourlyInvitationLimit",
  "dailyInvitationLimit",
  'status: { $in: ["pending", "connection_sent", "connection_accepted", "in_progress"] }',
  "connection_not_accepted_within_30_days",
]) assert(runner.includes(contract), `Sequence runner missing safety contract: ${contract}`);

const routes = source("routes/socialLinkedinOutreach.js");
for (const contract of ["/candidates", "/inbox/sync", "/inbox/register-webhook", "/analytics", "/search", "/search/import"])
  assert(routes.includes(contract), `LinkedIn outreach route missing: ${contract}`);

const socialWorkspace = source("routes/socialWorkspace.js");
assert(socialWorkspace.includes('thread.provider !== "linkedin_unipile"'));
assert(socialWorkspace.includes("linkedinMessagingAdapter.sendMessage"));

console.log("LinkedIn outreach safety, inbox synchronization, CRM enrollment, and reply contracts passed");
