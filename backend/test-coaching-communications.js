const assert = require("assert");
const segments = require("./services/communicationSegmentService");
const service = require("./services/coachingCommunicationService");

function query(rows) { return { select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => rows }; }

async function run() {
  const workspaceId = "64b000000000000000000001";
  const segmentModels = {
    Contact: { find: (filter) => query(filter.sourceProvider || filter.$or || filter.eventParticipations ? [{ _id: "event-contact" }] : [{ _id: "prospect-contact" }]) },
    Enrollment: { find: (filter) => query(filter.coachingProgramId ? [{ contactId: "program-contact" }] : [{ contactId: "active-contact" }]) },
    CoachAssignment: { find: () => query([{ contactId: "coach-contact" }]) },
    CoachingSession: { find: () => query([{ contactId: "upcoming-contact" }]) },
    SalesOpportunity: { find: () => query([{ primaryContactId: "sales-contact" }]) },
    SkoolPurchase: { find: () => query([{ contactId: "addon-contact" }]) },
  };
  assert.deepEqual(await segments.contactIdsForSegment({ workspaceId, segment: { kind: "active_students" } }, segmentModels), ["active-contact"]);
  assert.deepEqual(await segments.contactIdsForSegment({ workspaceId, segment: { kind: "program", coachingProgramId: "p1" } }, segmentModels), ["program-contact"]);
  assert.deepEqual(await segments.contactIdsForSegment({ workspaceId, segment: { kind: "coach_students", coachProfileId: "c1" } }, segmentModels), ["coach-contact"]);
  assert.deepEqual(await segments.contactIdsForSegment({ workspaceId, segment: { kind: "eventbrite_registrants" } }, segmentModels), ["event-contact"]);
  assert.deepEqual(await segments.contactIdsForSegment({ workspaceId, segment: { kind: "eventbrite_attendees" } }, segmentModels), ["event-contact"]);

  const baseContact = { _id: "contact-1", workspaceId, email: "student@example.com", status: "unsubscribed", emailPreferences: { marketingStatus: "unsubscribed" } };
  const policyModels = { EmailSuppression: { findOne: () => ({ lean: async () => null }) } };
  assert.equal((await service.emailPolicy(baseContact, "marketing", policyModels)).allowed, false);
  assert.equal((await service.emailPolicy(baseContact, "transactional", policyModels)).allowed, true);
  const suppressedModels = { EmailSuppression: { findOne: () => ({ lean: async () => ({ reason: "bounce" }) }) } };
  assert.equal((await service.emailPolicy({ ...baseContact, status: "active" }, "transactional", suppressedModels)).allowed, false);

  const created = [];
  // Must stay far enough in the future that both reminder offsets
  // (1440 and 60 minutes before startsAt) are still ahead of "now".
  const startsAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const reminderModels = {
    CoachingSession: { findOne: async () => ({ _id: "session-1", workspaceId, contactId: "contact-1", coachProfileId: "coach-1", coachingProgramId: "program-1", enrollmentId: "enroll-1", startsAt, timezone: "America/Los_Angeles", status: "scheduled", videoMode: "zoom", zoom: { joinUrl: "https://zoom.example/join-safe" } }) },
    Contact: { findOne: async () => ({ _id: "contact-1", workspaceId, name: "Alex Student", firstName: "Alex", email: "alex@example.com" }) },
    CoachProfile: { findOne: async () => ({ displayName: "Coach Taylor" }) },
    CoachingProgram: { findOne: async () => ({ name: "Six Week Program" }) },
    CommunicationJob: { create: async (value) => { if (created.some((row) => row.idempotencyKey === value.idempotencyKey)) { const error = new Error("duplicate"); error.code = 11000; throw error; } created.push(value); } },
  };
  const first = await service.scheduleSessionReminders({ workspaceId, sessionId: "session-1", offsetsMinutes: [1440, 60], channels: ["email", "sms"] }, reminderModels);
  const duplicate = await service.scheduleSessionReminders({ workspaceId, sessionId: "session-1", offsetsMinutes: [1440, 60], channels: ["email", "sms"] }, reminderModels);
  assert.equal(first.jobsCreated, 4); assert.equal(duplicate.jobsCreated, 0); assert.equal(created.length, 4);
  assert.ok(created[0].content.body.includes("Coach Taylor")); assert.ok(created[0].content.body.includes("zoom.example/join-safe"));

  let providerCalled = false;
  const staleJob = { status: "processing", workspaceId, contactId: "contact-1", coachingSessionId: "session-1", sessionStartsAtSnapshot: startsAt, save: async () => {} };
  await service.processJob(staleJob, { Contact: { findOne: async () => baseContact }, CoachingSession: { findOne: async () => ({ status: "cancelled", startsAt }) }, integrationHub: { execute: async () => { providerCalled = true; } } });
  assert.equal(staleJob.status, "cancelled"); assert.equal(providerCalled, false);

  console.log("Coaching communication segmentation, consent, reminder, and idempotency tests passed");
}
run().catch((error) => { console.error(error); process.exit(1); });
