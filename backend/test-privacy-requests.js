const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const service = require("./services/privacyRequestService");

const query = (value) => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, async lean() { return value; } });
const doc = (values) => ({ ...values, auditTrail: values.auditTrail || [], async save() { this.saved = true; return this; } });

async function detectionChecks() {
  let created = 0; let notified = 0; let destructiveCalls = 0;
  const models = {
    PrivacyRequest: { async create(values) { created += 1; assert.equal(values.workspaceId, "ws-a"); return { _id: "request-1", ...values }; }, findOne() { throw new Error("duplicate lookup not expected"); } },
    InAppNotification: { async create(values) { notified += 1; assert.equal(values.workspaceId, "ws-a"); assert.equal(values.type, "privacy_request"); } },
    Contact: { async updateMany() { destructiveCalls += 1; } },
  };
  assert.equal(await service.detectIncoming({ workspaceId: "ws-a", threadId: "thread-1", message: { providerMessageId: "message-0", direction: "inbound", subject: "Another subject" } }, models), null);
  const request = await service.detectIncoming({ workspaceId: "ws-a", threadId: "thread-1", message: { providerMessageId: "message-1", direction: "inbound", subject: "Meta Data Deletion Request", body: "Instagram @student.one", sender: { name: "Student", address: "Student@Example.com" } } }, models);
  assert.equal(request.requester.email, "student@example.com"); assert.deepEqual(request.requester.metaIdentifiers, ["@student.one"]);
  assert.equal(created, 1); assert.equal(notified, 1); assert.equal(destructiveCalls, 0, "email receipt must never destroy data");

  let duplicateNotification = 0;
  const duplicateModels = { PrivacyRequest: { async create() { const error = new Error("duplicate"); error.code = 11000; throw error; }, findOne(filter) { assert.deepEqual(filter, { workspaceId: "ws-a", source: "gmail", providerMessageId: "message-1" }); return { _id: "request-1" }; } }, InAppNotification: { async create() { duplicateNotification += 1; } } };
  const duplicate = await service.detectIncoming({ workspaceId: "ws-a", threadId: "thread-1", message: { providerMessageId: "message-1", direction: "inbound", subject: "Meta Data Deletion Request" } }, duplicateModels);
  assert.equal(duplicate._id, "request-1"); assert.equal(duplicateNotification, 0, "provider retries must not duplicate notifications");
}

async function reviewAndApprovalChecks() {
  const request = doc({ _id: "request-1", status: "under_review", requester: { email: "student@example.com", metaIdentifiers: ["@student.one"] } });
  const transitionModels = { PrivacyRequest: { async findOne(filter) { assert.deepEqual(filter, { _id: "request-1", workspaceId: "ws-a" }); return request; } } };
  await assert.rejects(() => service.transition({ workspaceId: "ws-a", requestId: "request-1", action: "verify", notes: "", userId: "owner-1" }, transitionModels), /Record how/);
  await service.transition({ workspaceId: "ws-a", requestId: "request-1", action: "verify", notes: "Matched the requester's account using the approved business process.", userId: "owner-1" }, transitionModels);
  assert.equal(request.status, "verified"); assert.equal(request.verifiedBy, "owner-1");

  const touched = [];
  const candidateContact = { _id: "contact-1", name: "Student", email: "student@example.com", status: "active" };
  const models = {
    PrivacyRequest: { async findOne(filter) { assert.equal(filter.workspaceId, "ws-a"); return request; } },
    Contact: {
      find(filter) { assert.equal(filter.workspaceId, "ws-a"); return query(filter.email ? [candidateContact] : [candidateContact]); },
      async updateMany(filter) { touched.push(["contacts", filter]); return { modifiedCount: 1 }; },
    },
    SocialIdentity: { find(filter) { assert.equal(filter.workspaceId, "ws-a"); return query(filter.contactId ? [{ _id: "identity-1" }] : [{ _id: "identity-1", contactId: "contact-1", provider: "instagram", username: "student.one" }]); }, async deleteMany(filter) { touched.push(["identities", filter]); return { deletedCount: 1 }; } },
    SocialProviderEvent: { async countDocuments(filter) { assert.equal(filter.workspaceId, "ws-a"); return 1; }, async updateMany(filter) { touched.push(["events", filter]); return { modifiedCount: 1 }; } },
    ConversationMessage: { async countDocuments(filter) { assert.equal(filter.workspaceId, "ws-a"); return 1; }, find(filter) { assert.equal(filter.workspaceId, "ws-a"); return query([{ threadId: "thread-1" }]); }, async updateMany(filter) { touched.push(["messages", filter]); return { modifiedCount: 1 }; } },
    ConversationThread: { async updateMany(filter) { touched.push(["threads", filter]); return { modifiedCount: 1 }; } },
    TrackedLink: { async countDocuments(filter) { assert.equal(filter.workspaceId, "ws-a"); return 1; }, async deleteMany(filter) { touched.push(["links", filter]); return { deletedCount: 1 }; } },
    CoachingApplication: { async countDocuments(filter) { assert.equal(filter.workspaceId, "ws-a"); return 1; }, async updateMany(filter) { touched.push(["applications", filter]); return { modifiedCount: 1 }; } },
    SocialConnection: { findOne(filter) { assert.equal(filter.workspaceId, "ws-a"); return query(null); } },
    CrmActivity: { async create(values) { touched.push(["audit", values]); } },
    InAppNotification: { async updateMany(filter) { assert.equal(filter.workspaceId, "ws-a"); } },
  };
  await assert.rejects(() => service.approve({ workspaceId: "ws-a", requestId: "request-1", contactIds: ["contact-1"], categories: ["contact"], confirmation: "yes", userId: "owner-1" }, models), /Type DELETE VERIFIED/);
  const result = await service.approve({ workspaceId: "ws-a", requestId: "request-1", contactIds: ["contact-1"], categories: ["contact", "social_identity", "social_events", "conversations", "tracked_links", "applications"], confirmation: service.CONFIRMATION, userId: "owner-1" }, models);
  assert.equal(request.status, "completed"); assert.equal(request.requester.email, ""); assert.match(request.requester.emailHash, /^[a-f0-9]{64}$/);
  assert.equal(result.confirmation.to, "student@example.com"); assert.match(result.confirmation.body, /completed/);
  assert.deepEqual(new Set(touched.map(([name]) => name)), new Set(["contacts", "identities", "events", "messages", "threads", "links", "applications", "audit"]));
  for (const [, filter] of touched.filter(([name]) => name !== "audit")) assert.equal(filter.workspaceId, "ws-a", "every data action must remain workspace scoped");
}

function staticSecurityChecks() {
  const route = fs.readFileSync(path.join(__dirname, "routes/privacyRequests.js"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../frontend/src/App.jsx"), "utf8");
  const legal = fs.readFileSync(path.join(__dirname, "../frontend/src/pages/PublicLegal.jsx"), "utf8");
  const privacyUi = fs.readFileSync(path.join(__dirname, "../frontend/src/components/PrivacyRequests.jsx"), "utf8");
  const serviceSource = fs.readFileSync(path.join(__dirname, "services/privacyRequestService.js"), "utf8");
  assert.ok(route.includes('requireRole("owner", "admin")')); assert.ok(route.includes("req.auth.workspaceId"));
  assert.ok(app.includes('path="/settings/privacy"')); assert.ok(privacyUi.includes("DELETE VERIFIED REQUEST DATA") === false, "server supplies the approval phrase");
  // Contact email is a per-workspace field (Lead Porch is a white-label
  // product, not hardcoded to one brand), rendered via ContactMethod reading
  // site.publicSite.contactEmail — never a hardcoded address.
  assert.ok(legal.includes("site?.publicSite?.contactEmail"));
  assert.equal(/[a-z0-9.+_-]+@elliescoaching\.com/i.test(legal), false, "legal pages must not hardcode a brand-specific email address");
  for (const forbidden of ["gmail.send", "sendEmail(", "axios", "metaMessaging"]) assert.equal(serviceSource.includes(forbidden), false, `privacy workflow must not call provider: ${forbidden}`);
}

Promise.resolve().then(detectionChecks).then(reviewAndApprovalChecks).then(staticSecurityChecks)
  .then(() => console.log("Privacy request checks passed: exact-subject detection, retry safety, no auto-deletion, Owner/Admin RBAC, workspace scope, human verification, explicit approval, selective actions, audit trail, and unsent confirmation draft."))
  .catch((error) => { console.error(error); process.exitCode = 1; });
