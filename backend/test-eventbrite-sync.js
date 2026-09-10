/**
 * Eventbrite Attendee Sync Tests
 * Test Eventbrite attendee synchronization and integration with campaign execution
 */

const mongoose = require("mongoose");
require("dotenv").config();
const Contact = require("./models/Contact");
const MarketingCampaign = require("./models/MarketingCampaign");
const Audience = require("./models/Audience");
const EventbriteSyncHistory = require("./models/EventbriteSyncHistory");
const contactService = require("./services/contactService");
const EventbriteAdapter = require("./services/integrations/EventbriteAdapter");
const eventbriteSyncService = require("./services/eventbriteSyncService");

let testAudienceId;
let testCampaignId;

async function runTests() {
  try {
    console.log("════════════════════════════════════════════════");
    console.log("Eventbrite Attendee Sync Tests");
    console.log("════════════════════════════════════════════════\n");

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✓ Connected to MongoDB\n");

    // Setup test data
    await setupTestData();

    // Run test phases
    await testEventbriteAdapter();
    await testEventbriteAttendeeMapping();
    await testEventbriteAttendeeSync();
    await testDuplicatePreventionEventbrite();
    await testCampaignRecipientsFromEventbrite();
    await testSyncStatusTracking();

    // Summary
    console.log("\n════════════════════════════════════════════════");
    console.log("Test Summary");
    console.log("════════════════════════════════════════════════");
    console.log("✓ Passed: 16");
    console.log("✗ Failed: 0");
    console.log("Total: 16");
    console.log("\n🎉 ALL TESTS PASSED!");

    process.exit(0);
  } catch (error) {
    console.error("\n❌ TEST FAILED:", error.message);
    process.exit(1);
  }
}

async function setupTestData() {
  // Fixture emails are re-used across runs; without this, a second run sees
  // them as already-existing contacts and create/duplicate counts drift.
  await Contact.deleteMany({ email: /@eventbritetest\.com$/ });

  // Create test audience
  const audience = await Audience.create({
    name: "Test Eventbrite Audience",
    discoverySource: "manual",
  });
  testAudienceId = audience._id;

  // Create test campaign
  const campaign = await MarketingCampaign.create({
    name: "Test Eventbrite Campaign",
    type: "email",
    status: "draft",
    audienceId: testAudienceId,
    content: {
      subject: "Eventbrite Test Subject",
      htmlBody: "<h1>Eventbrite Attendee Campaign</h1>",
      body: "Test campaign",
    },
  });
  testCampaignId = campaign._id;

  console.log("✓ Setup: Test audience and campaign created");
}

async function testEventbriteAdapter() {
  console.log("\n═══ PHASE 1: Eventbrite Adapter Functionality ═══\n");

  const adapter = new EventbriteAdapter();

  // Test 1: Get adapter info
  const info = adapter.getInfo();
  if (info.provider !== "eventbrite") {
    throw new Error("Adapter info incorrect");
  }
  console.log("✓ EventbriteAdapter.getInfo() - Returns correct adapter info");

  // Test 2: Verify adapter has required methods
  if (typeof adapter.syncAttendees !== "function") {
    throw new Error("syncAttendees method missing");
  }
  if (typeof adapter.mapEventbriteAttendees !== "function") {
    throw new Error("mapEventbriteAttendees method missing");
  }
  console.log(
    "✓ EventbriteAdapter - Has required methods (syncAttendees, mapEventbriteAttendees)",
  );

  // Test 3: Test field extraction
  const testMap = {
    email_col: "john@eventbrite.com",
    company_col: "Eventbrite Inc",
  };
  const extracted = adapter.extractFieldValue(testMap, ["email_col", "email"]);
  if (extracted !== "john@eventbrite.com") {
    throw new Error("Field extraction failed");
  }
  console.log(
    "✓ EventbriteAdapter.extractFieldValue() - Correctly extracts fields",
  );
}

async function testEventbriteAttendeeMapping() {
  console.log("\n═══ PHASE 2: Eventbrite Attendee Mapping ═══\n");

  const adapter = new EventbriteAdapter();

  // Mock Eventbrite attendee data
  const mockAttendees = [
    {
      id: "evt-001",
      status: "Attending",
      profile: {
        name: "John Smith",
        first_name: "John",
        last_name: "Smith",
        email: "john@eventbritetest.com",
        company: "Tech Co",
      },
    },
    {
      id: "evt-002",
      status: "Checked In",
      profile: {
        name: "Jane Doe",
        first_name: "Jane",
        last_name: "Doe",
        email: "jane@eventbritetest.com",
        company: "Growth Inc",
      },
    },
    {
      id: "evt-003",
      status: "Attending",
      profile: {
        name: "No Email User",
        first_name: "No",
        last_name: "Email",
        email: "",
        company: "Invalid",
      },
    },
  ];

  // Test 1: Mapping returns array
  const mappedAttendees = adapter.mapEventbriteAttendees(mockAttendees);
  if (mappedAttendees.length !== 2) {
    throw new Error(
      `Expected 2 valid attendees, got ${mappedAttendees.length}`,
    );
  }
  console.log(
    `✓ EventbriteAdapter.mapEventbriteAttendees() - Returns array of ${mappedAttendees.length} attendees`,
  );

  // Test 2: Verify mapping includes all fields
  const firstAttendee = mappedAttendees[0];
  if (firstAttendee.externalId !== "evt-001") {
    throw new Error("externalId not set correctly");
  }
  if (firstAttendee.firstName !== "John") {
    throw new Error("firstName not extracted correctly");
  }
  if (firstAttendee.lastName !== "Smith") {
    throw new Error("lastName not extracted correctly");
  }
  if (!firstAttendee.tags.includes("eventbrite")) {
    throw new Error("eventbrite tag not added");
  }
  console.log("✓ EventbriteAdapter - Maps all attendee fields correctly");

  // Test 3: Filters out attendees without email
  if (mappedAttendees.some((a) => a.email === "")) {
    throw new Error("Should filter out attendees without email");
  }
  console.log("✓ EventbriteAdapter - Filters out attendees without email");
}

async function testEventbriteAttendeeSync() {
  console.log("\n═══ PHASE 3: Eventbrite Attendee Sync ═══\n");

  // Mock attendees for sync
  const mockEventbriteAttendees = [
    {
      name: "John Smith",
      firstName: "John",
      lastName: "Smith",
      email: "john@eventbritetest.com",
      company: "Tech Solutions",
      externalId: "eventbrite-sync-001",
      tags: ["eventbrite"],
      status: "active",
    },
    {
      name: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@eventbritetest.com",
      company: "Growth Partners",
      externalId: "eventbrite-sync-002",
      tags: ["eventbrite"],
      status: "active",
    },
    {
      name: "Bob Johnson",
      firstName: "Bob",
      lastName: "Johnson",
      email: "bob@eventbritetest.com",
      company: "Enterprise",
      externalId: "eventbrite-sync-003",
      tags: ["eventbrite"],
      status: "active",
    },
  ];

  // Test 1: Sync Eventbrite attendees
  const syncResult = await contactService.syncContactsFromSource(
    "eventbrite",
    mockEventbriteAttendees,
  );

  if (!syncResult.created) {
    throw new Error("Should create new contacts");
  }
  if (syncResult.created !== 3) {
    throw new Error(`Expected 3 created, got ${syncResult.created}`);
  }
  console.log(
    `✓ POST /contacts/sync - Created ${syncResult.created} Eventbrite attendees`,
  );

  // Test 2: Verify contacts in database
  // Scoped to this fixture's own domain rather than the bare "eventbrite"
  // source filter — the dev database is shared across test files, and other
  // suites can legitimately create their own "eventbrite"-sourced contacts
  // under different emails.
  const savedContacts = (
    await contactService.getContacts({ source: "eventbrite" })
  ).filter((c) => c.email.endsWith("@eventbritetest.com"));
  if (savedContacts.length !== 3) {
    throw new Error(
      `Expected 3 contacts in database, got ${savedContacts.length}`,
    );
  }
  console.log(
    `✓ GET /contacts?source=eventbrite - Retrieved ${savedContacts.length} contacts`,
  );

  // Test 3: Verify contact details
  const johnContact = savedContacts.find(
    (c) => c.externalIds?.eventbrite === "eventbrite-sync-001",
  );
  if (!johnContact) {
    throw new Error("Contact with externalId not found");
  }
  if (johnContact.email !== "john@eventbritetest.com") {
    throw new Error("Email mismatch");
  }
  console.log("✓ Attendees synced with correct details and externalId");
}

async function testDuplicatePreventionEventbrite() {
  console.log("\n═══ PHASE 4: Eventbrite Duplicate Prevention ═══\n");

  // Test 1: Attempt to sync same Eventbrite attendee again
  const duplicateAttendee = {
    name: "John Smith",
    firstName: "John",
    lastName: "Smith",
    email: "john@eventbritetest.com",
    company: "Tech Solutions Updated",
    externalId: "eventbrite-sync-001",
    tags: ["eventbrite", "updated"],
    status: "active",
  };

  const syncResult = await contactService.syncContactsFromSource("eventbrite", [
    duplicateAttendee,
  ]);

  if (syncResult.duplicates !== 1) {
    throw new Error(`Expected 1 duplicate, got ${syncResult.duplicates}`);
  }
  console.log("✓ Duplicate detection - Prevented re-sync of same externalId");

  // Test 2: Verify different emails from Eventbrite are separate contacts
  const newEventbriteAttendee = {
    name: "New Attendee",
    firstName: "New",
    lastName: "Attendee",
    email: "newattendee@eventbritetest.com",
    company: "New Company",
    externalId: "eventbrite-sync-new-001",
    tags: ["eventbrite"],
    status: "active",
  };

  const syncResult2 = await contactService.syncContactsFromSource(
    "eventbrite",
    [newEventbriteAttendee],
  );

  if (syncResult2.created !== 1) {
    throw new Error(
      `Expected 1 new attendee created, got ${syncResult2.created}`,
    );
  }
  console.log("✓ Different Eventbrite attendees allowed - Created new contact");

  // Test 3: Same email from different source is separate contact
  const manualContact = {
    name: "John Smith",
    firstName: "John",
    lastName: "Smith",
    email: "john@eventbritetest.com", // Same email as eventbrite contact
    company: "Manual Entry",
    source: "manual",
    tags: ["manual"],
    status: "active",
  };

  const syncResult3 = await contactService.syncContactsFromSource("manual", [
    manualContact,
  ]);

  // Contacts are unified globally by email (see contactService.upsertContact's
  // "Duplicate rule: email only"), so a second source for an existing email
  // merges into the same contact — it's an update, not a new contact.
  if (syncResult3.updated !== 1) {
    throw new Error(
      `Expected manual source merged into existing contact, got updated=${syncResult3.updated}`,
    );
  }
  console.log(
    "✓ Same email different source - Merged into existing contact, added manual source",
  );
}

async function testCampaignRecipientsFromEventbrite() {
  console.log("\n═══ PHASE 5: Campaign Recipients from Eventbrite ═══\n");

  // Test 1: Get campaign recipients from Eventbrite source
  const recipients = await contactService.getCampaignRecipients(
    testCampaignId,
    {
      source: "eventbrite",
    },
  );

  if (!Array.isArray(recipients)) {
    throw new Error("Recipients should be array");
  }
  if (recipients.length < 3) {
    throw new Error("Should have at least 3 Eventbrite contacts as recipients");
  }
  console.log(
    `✓ GET /campaign/:id/recipients?source=eventbrite - Retrieved ${recipients.length} Eventbrite recipients`,
  );

  // Test 2: Verify recipient format for campaign execution
  const recipient = recipients[0];
  if (!recipient.email || !recipient.name || !recipient.company) {
    throw new Error("Recipient missing required fields");
  }
  console.log("✓ Recipients have email, name, company for campaign execution");

  // Test 3: Contact statistics show Eventbrite contacts
  const stats = await contactService.getStats();

  if (!stats.bySource.eventbrite) {
    throw new Error("No Eventbrite contacts in stats");
  }
  if (stats.bySource.eventbrite < 3) {
    throw new Error("Should have at least 3 Eventbrite contacts in stats");
  }
  console.log(
    `✓ GET /contacts/stats - Shows ${stats.bySource.eventbrite} Eventbrite contacts`,
  );
}

async function testSyncStatusTracking() {
  console.log("\n═══ PHASE 6: Sync Status Tracking ═══\n");

  // Test 1: Clear sync history and verify it's empty
  await EventbriteSyncHistory.deleteMany({});
  let history = await eventbriteSyncService.getSyncHistory(100);
  if (history.length !== 0) {
    throw new Error("Sync history should be empty after clear");
  }
  console.log("✓ Sync history cleared");

  // Test 2: Record sync history and verify data
  const syncId = `sync-test-${Date.now()}`;
  const startTime = new Date();
  await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate processing time
  const endTime = new Date();

  const testHistory = await EventbriteSyncHistory.create({
    syncId,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    status: "success",
    created: 2,
    updated: 1,
    duplicates: 0,
    skipped: 0,
    totalProcessed: 3,
    message: "Test sync completed",
  });

  if (!testHistory.syncId) {
    throw new Error("Sync history not created");
  }
  console.log("✓ Sync history recorded with timestamp and metrics");

  // Test 3: Verify getSyncStatus includes last sync info
  const status = await eventbriteSyncService.getSyncStatus();
  if (!status.lastSync) {
    throw new Error("Status should include lastSync info");
  }
  if (status.lastSync.syncId !== syncId) {
    throw new Error("Last sync syncId mismatch");
  }
  if (status.lastSync.created !== 2) {
    throw new Error("Last sync created count incorrect");
  }
  if (!status.lastSync.startTime || !status.lastSync.endTime) {
    throw new Error("Last sync missing timestamp info");
  }
  console.log(
    "✓ getSyncStatus() returns lastSync with timestamp and created/updated/duplicates",
  );

  // Test 4: Verify sync history can be retrieved
  history = await eventbriteSyncService.getSyncHistory(10);
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error("Sync history retrieval failed");
  }
  if (history[0].syncId !== syncId) {
    throw new Error("Retrieved sync history has incorrect data");
  }
  console.log(
    `✓ getSyncHistory() returns recent syncs (${history.length} records)`,
  );
}

// Run tests
runTests().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
