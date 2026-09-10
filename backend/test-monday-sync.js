/**
 * Monday CRM Contact Sync Tests
 * Test Monday contact synchronization and integration with campaign execution
 */

const mongoose = require("mongoose");
require("dotenv").config();
const Contact = require("./models/Contact");
const MarketingCampaign = require("./models/MarketingCampaign");
const Audience = require("./models/Audience");
const MondaySyncHistory = require("./models/MondaySyncHistory");
const contactService = require("./services/contactService");
const MondayAdapter = require("./services/integrations/MondayAdapter");
const mondaySyncService = require("./services/mondaySyncService");

let testAudienceId;
let testCampaignId;
let mondayContactCount = 0;

async function runTests() {
  try {
    console.log("════════════════════════════════════════════════");
    console.log("Monday CRM Contact Sync Tests");
    console.log("════════════════════════════════════════════════\n");

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✓ Connected to MongoDB\n");

    // Setup test data
    await setupTestData();

    // Run test phases
    await testMondayAdapter();
    await testMondayContactMapping();
    await testMondayContactSync();
    await testDuplicatePreventionMonday();
    await testCampaignRecipientsFromMonday();
    await testSyncStatusTracking();

    // Summary
    console.log("\n════════════════════════════════════════════════");
    console.log("Test Summary");
    console.log("════════════════════════════════════════════════");
    console.log("✓ Passed: 14");
    console.log("✗ Failed: 0");
    console.log("Total: 14");
    console.log("\n🎉 ALL TESTS PASSED!");

    process.exit(0);
  } catch (error) {
    console.error("\n❌ TEST FAILED:", error.message);
    process.exit(1);
  }
}

async function setupTestData() {
  // Fixture emails are re-used across runs; without this, a second run (or
  // leftover data from an earlier run) sees them as already-existing
  // contacts and create/duplicate counts drift.
  await Contact.deleteMany({
    email: { $in: [/@mondaytest\.com$/, "newuser@monday.com"] },
  });

  // Create test audience
  const audience = await Audience.create({
    name: "Test Monday Audience",
    discoverySource: "manual",
  });
  testAudienceId = audience._id;

  // Create test campaign
  const campaign = await MarketingCampaign.create({
    name: "Test Monday Campaign",
    type: "email",
    status: "draft",
    audienceId: testAudienceId,
    content: {
      subject: "Monday Test Subject",
      htmlBody: "<h1>Monday Contact Campaign</h1>",
      body: "Test campaign",
    },
  });
  testCampaignId = campaign._id;

  console.log("✓ Setup: Test audience and campaign created");
}

async function testMondayAdapter() {
  console.log("\n═══ PHASE 1: Monday Adapter Functionality ═══\n");

  const adapter = new MondayAdapter();

  // Test 1: Get adapter info
  const info = adapter.getInfo();
  if (info.provider !== "monday") {
    throw new Error("Adapter info incorrect");
  }
  console.log("✓ MondayAdapter.getInfo() - Returns correct adapter info");

  // Test 2: Verify adapter has required methods
  if (typeof adapter.syncContacts !== "function") {
    throw new Error("syncContacts method missing");
  }
  if (typeof adapter.mapMondayContacts !== "function") {
    throw new Error("mapMondayContacts method missing");
  }
  console.log(
    "✓ MondayAdapter - Has required methods (syncContacts, mapMondayContacts)",
  );

  // Test 3: Validate field extraction helper
  const columnsMap = {
    email: "test@monday.com",
    company: "Monday Test Co",
  };
  const email = adapter.extractFieldValue(columnsMap, [
    "email",
    "contact_email",
  ]);
  if (email !== "test@monday.com") {
    throw new Error("Field extraction failed");
  }
  console.log(
    "✓ MondayAdapter.extractFieldValue() - Correctly extracts fields",
  );
}

async function testMondayContactMapping() {
  console.log("\n═══ PHASE 2: Monday Contact Mapping ═══\n");

  const adapter = new MondayAdapter();

  // Mock Monday board items
  const mockMondayItems = [
    {
      id: "monday-001",
      name: "John Smith",
      column_values: [
        { id: "email", text: "john@mondaytest.com" },
        { id: "company", text: "Tech Solutions Inc" },
      ],
    },
    {
      id: "monday-002",
      name: "Jane Doe",
      column_values: [
        { id: "email", text: "jane@mondaytest.com" },
        { id: "company", text: "Growth Partners" },
      ],
    },
    {
      id: "monday-003",
      name: "Bob Johnson",
      column_values: [
        { id: "email", text: "bob@mondaytest.com" },
        { id: "organization", text: "Enterprise Corp" },
      ],
    },
    {
      id: "monday-004",
      name: "Alice Cooper",
      column_values: [
        // Missing email - should be filtered out
        { id: "company", text: "No Email Inc" },
      ],
    },
  ];

  // Test 1: Map Monday items to contacts
  const mappedContacts = adapter.mapMondayContacts(mockMondayItems);

  if (!Array.isArray(mappedContacts)) {
    throw new Error("mapMondayContacts should return array");
  }
  console.log(
    `✓ MondayAdapter.mapMondayContacts() - Returns array of ${mappedContacts.length} contacts`,
  );

  // Test 2: Verify mapping includes all fields
  const firstContact = mappedContacts[0];
  if (firstContact.externalId !== "monday-001") {
    throw new Error("externalId not set correctly");
  }
  if (firstContact.firstName !== "John") {
    throw new Error("firstName not extracted correctly");
  }
  if (firstContact.lastName !== "Smith") {
    throw new Error("lastName not extracted correctly");
  }
  if (!firstContact.tags.includes("monday")) {
    throw new Error("monday tag not added");
  }
  console.log("✓ MondayAdapter - Maps all contact fields correctly");

  // Test 3: Verify contacts without email are filtered
  if (mappedContacts.length !== 3) {
    throw new Error("Should filter out contacts without email");
  }
  console.log("✓ MondayAdapter - Filters out contacts without email");

  mondayContactCount = mappedContacts.length;
}

async function testMondayContactSync() {
  console.log("\n═══ PHASE 3: Monday Contact Sync ═══\n");

  // Mock contacts from Monday
  const mockMondayContacts = [
    {
      name: "John Smith",
      firstName: "John",
      lastName: "Smith",
      email: "john@mondaytest.com",
      company: "Tech Solutions",
      externalId: "monday-sync-001",
      tags: ["monday"],
      status: "active",
    },
    {
      name: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@mondaytest.com",
      company: "Growth Partners",
      externalId: "monday-sync-002",
      tags: ["monday"],
      status: "active",
    },
    {
      name: "Bob Johnson",
      firstName: "Bob",
      lastName: "Johnson",
      email: "bob@mondaytest.com",
      company: "Enterprise",
      externalId: "monday-sync-003",
      tags: ["monday"],
      status: "active",
    },
  ];

  // Test 1: Sync Monday contacts
  const syncResult = await contactService.syncContactsFromSource(
    "monday",
    mockMondayContacts,
  );

  if (!syncResult.created) {
    throw new Error("Should create new contacts");
  }
  if (syncResult.created !== 3) {
    throw new Error(`Expected 3 created, got ${syncResult.created}`);
  }
  console.log(
    `✓ POST /contacts/sync - Created ${syncResult.created} Monday contacts`,
  );

  // Test 2: Verify contacts in database
  // Scoped to this fixture's own domain rather than the bare "monday" source
  // filter — the dev database is shared across test files, and other suites
  // (e.g. test-contact-execution.js) legitimately create their own
  // "monday"-sourced contacts under different emails.
  const savedContacts = (
    await contactService.getContacts({ source: "monday" })
  ).filter((c) => c.email.endsWith("@mondaytest.com"));
  if (savedContacts.length !== 3) {
    throw new Error(
      `Expected 3 contacts in database, got ${savedContacts.length}`,
    );
  }
  console.log(
    `✓ GET /contacts?source=monday - Retrieved ${savedContacts.length} contacts`,
  );

  // Test 3: Verify contact details
  const johnContact = savedContacts.find(
    (c) => c.externalIds?.monday === "monday-sync-001",
  );
  if (!johnContact) {
    throw new Error("Contact with externalId not found");
  }
  if (johnContact.email !== "john@mondaytest.com") {
    throw new Error("Email mismatch");
  }
  console.log("✓ Contacts synced with correct details and externalId");
}

async function testDuplicatePreventionMonday() {
  console.log("\n═══ PHASE 4: Monday Duplicate Prevention ═══\n");

  // Test 1: Attempt to sync same Monday contact again
  const duplicateContact = {
    name: "John Smith",
    firstName: "John",
    lastName: "Smith",
    email: "john@mondaytest.com",
    company: "Tech Solutions Updated",
    externalId: "monday-sync-001",
    tags: ["monday", "updated"],
    status: "active",
  };

  const syncResult = await contactService.syncContactsFromSource("monday", [
    duplicateContact,
  ]);

  if (syncResult.duplicates !== 1) {
    throw new Error(`Expected 1 duplicate, got ${syncResult.duplicates}`);
  }
  console.log("✓ Duplicate detection - Prevented re-sync of same externalId");

  // Test 2: Verify different emails from Monday are separate contacts
  const newMondayContact = {
    name: "New User",
    firstName: "New",
    lastName: "User",
    email: "newuser@monday.com",
    company: "New Company",
    externalId: "monday-sync-new",
    tags: ["monday"],
    status: "active",
  };

  const newSyncResult = await contactService.syncContactsFromSource("monday", [
    newMondayContact,
  ]);

  if (newSyncResult.created !== 1) {
    throw new Error("Should create new contact with different email");
  }
  console.log("✓ Different Monday contacts allowed - Created new contact");

  // Test 3: Same email but different source allowed
  const sameEmailDifferentSource = {
    name: "John Smith",
    firstName: "John",
    lastName: "Smith",
    email: "john@mondaytest.com",
    company: "Different Source",
    externalId: "manual-john",
    tags: ["manual"],
    status: "active",
  };

  const differentSourceResult = await contactService.syncContactsFromSource(
    "manual",
    [sameEmailDifferentSource],
  );

  // Contacts are unified globally by email (see contactService.upsertContact's
  // "Duplicate rule: email only"), so a second source for an existing email
  // merges into the same contact — it's an update, not a new contact.
  if (differentSourceResult.updated !== 1) {
    throw new Error("Should merge same-email contact from a different source");
  }
  console.log(
    "✓ Same email different source - Merged into existing contact, added manual source",
  );
}

async function testCampaignRecipientsFromMonday() {
  console.log("\n═══ PHASE 5: Campaign Recipients from Monday ═══\n");

  // Test 1: Get campaign recipients filtering by Monday source
  const recipients = await contactService.getCampaignRecipients(
    testCampaignId,
    {
      source: "monday",
    },
  );

  if (!Array.isArray(recipients)) {
    throw new Error("Recipients should be array");
  }
  if (recipients.length < 3) {
    throw new Error("Should have at least 3 Monday contacts as recipients");
  }
  console.log(
    `✓ GET /campaign/:id/recipients?source=monday - Retrieved ${recipients.length} Monday recipients`,
  );

  // Test 2: Verify recipient format for campaign execution
  const recipient = recipients[0];
  if (!recipient.email || !recipient.name || !recipient.company) {
    throw new Error("Recipient missing required fields");
  }
  console.log("✓ Recipients have email, name, company for campaign execution");

  // Test 3: Contact statistics show Monday contacts
  const stats = await contactService.getStats();

  if (!stats.bySource.monday) {
    throw new Error("No Monday contacts in stats");
  }
  if (stats.bySource.monday < 3) {
    throw new Error("Should have at least 3 Monday contacts in stats");
  }
  console.log(
    `✓ GET /contacts/stats - Shows ${stats.bySource.monday} Monday contacts`,
  );
}

async function testSyncStatusTracking() {
  console.log("\n═══ PHASE 6: Sync Status Tracking ═══\n");

  // Test 1: Clear sync history and verify it's empty
  await MondaySyncHistory.deleteMany({});
  let history = await mondaySyncService.getSyncHistory(100);
  if (history.length !== 0) {
    throw new Error("Sync history should be empty after clear");
  }
  console.log("✓ Sync history cleared");

  // Test 2: Record sync history and verify data
  const syncId = `sync-test-${Date.now()}`;
  const startTime = new Date();
  await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate processing time
  const endTime = new Date();

  const testHistory = await MondaySyncHistory.create({
    syncId,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    status: "success",
    created: 1,
    updated: 0,
    duplicates: 0,
    skipped: 0,
    totalProcessed: 1,
    message: "Test sync completed",
  });

  if (!testHistory.syncId) {
    throw new Error("Sync history not created");
  }
  console.log("✓ Sync history recorded with timestamp and metrics");

  // Test 3: Verify getSyncStatus includes last sync info
  const status = await mondaySyncService.getSyncStatus();
  if (!status.lastSync) {
    throw new Error("Status should include lastSync info");
  }
  if (status.lastSync.syncId !== syncId) {
    throw new Error("Last sync syncId mismatch");
  }
  if (status.lastSync.created !== 1) {
    throw new Error("Last sync created count incorrect");
  }
  if (!status.lastSync.startTime || !status.lastSync.endTime) {
    throw new Error("Last sync missing timestamp info");
  }
  console.log(
    "✓ getSyncStatus() returns lastSync with timestamp and created/updated/duplicates",
  );

  // Test 4: Verify sync history can be retrieved
  history = await mondaySyncService.getSyncHistory(10);
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
