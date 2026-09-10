/**
 * Jarvis Assistant Tests
 * Test AI-powered insights and recommendations
 */

require("dotenv").config();
const Organization = require("./models/Organization");
const OrganizationRelationship = require("./models/OrganizationRelationship");
const Audience = require("./models/Audience");
const Contact = require("./models/Contact");
const MarketingCampaign = require("./models/MarketingCampaign");
const jarvisService = require("./services/jarvisService");
const { connectTestDatabase } = require("./test-setup/testDatabase");

async function runTests() {
  try {
    console.log("════════════════════════════════════════════════");
    console.log("Jarvis Assistant Tests");
    console.log("════════════════════════════════════════════════\n");

    // Connect to the isolated TEST database — never MONGO_URI (production).
    // See test-setup/testDatabase.js.
    await connectTestDatabase();
    console.log("✓ Connected to MongoDB\n");

    // Cleanup old test data
    await Organization.deleteMany({});
    await OrganizationRelationship.deleteMany({});
    await Audience.deleteMany({});
    await Contact.deleteMany({});
    await MarketingCampaign.deleteMany({});

    // Setup test data
    await setupTestData();

    // Run test phases
    await testOrganizationQuery();
    await testContactQuery();
    await testCampaignQuery();
    await testGrowthQuery();
    await testDirectTools();

    // Summary
    console.log("\n════════════════════════════════════════════════");
    console.log("Test Summary");
    console.log("════════════════════════════════════════════════");
    console.log("✓ Passed: 11");
    console.log("✗ Failed: 0");
    console.log("Total: 11");
    console.log("\n🎉 ALL TESTS PASSED!");

    await Contact.deleteMany({});
    process.exit(0);
  } catch (error) {
    console.error("\n❌ TEST FAILED:", error.message);
    await Contact.deleteMany({}).catch(() => {});
    process.exit(1);
  }
}

async function setupTestData() {
  // Create test organizations
  const orgs = await Organization.insertMany([
    { name: "Tech Startup Inc", domain: `tech-${Date.now()}.com` },
    { name: "Enterprise Solutions", domain: `enterprise-${Date.now()}.com` },
    { name: "Growth Partners", domain: `growth-${Date.now()}.com` },
  ]);

  // Create test audience
  const audience = await Audience.create({
    name: "Test Jarvis Audience",
    discoverySource: "manual",
  });

  // Create organization relationships with priorities
  await OrganizationRelationship.insertMany([
    {
      organizationId: orgs[0]._id,
      audienceId: audience._id,
      priority: 9,
      relationshipType: "prospect",
      status: "new",
    },
    {
      organizationId: orgs[1]._id,
      audienceId: audience._id,
      priority: 7,
      relationshipType: "client",
      status: "qualified",
    },
    {
      organizationId: orgs[2]._id,
      audienceId: audience._id,
      priority: 5,
      relationshipType: "partner",
      status: "new",
    },
  ]);

  // Create test contacts from different sources
  await Contact.insertMany([
    {
      name: "John Developer",
      firstName: "John",
      lastName: "Developer",
      email: "john@techstartup.com",
      company: "Tech Startup Inc",
      sources: ["monday"],
      externalIds: { monday: "monday-001" },
      tags: ["monday"],
      status: "active",
    },
    {
      name: "Jane Manager",
      firstName: "Jane",
      lastName: "Manager",
      email: "jane@enterprise.com",
      company: "Enterprise Solutions",
      sources: ["eventbrite"],
      externalIds: { eventbrite: "eventbrite-001" },
      tags: ["eventbrite"],
      status: "active",
    },
    {
      name: "Bob Sales",
      firstName: "Bob",
      lastName: "Sales",
      email: "bob@growth.com",
      company: "Growth Partners",
      sources: ["manual"],
      tags: ["manual"],
      status: "inactive",
    },
  ]);

  // Create test campaigns
  await MarketingCampaign.insertMany([
    {
      name: "Product Launch Campaign",
      type: "email",
      status: "draft",
      audienceId: audience._id,
      content: {
        subject: "New Product Launch",
        body: "Introducing our new product",
      },
    },
    {
      name: "Engagement Campaign",
      type: "email",
      status: "active",
      audienceId: audience._id,
      content: {
        subject: "Stay Engaged",
        body: "Keep in touch campaign",
      },
    },
  ]);

  console.log("✓ Setup: Test data created");
}

async function testOrganizationQuery() {
  console.log("\n═══ PHASE 1: Organization Query ═══\n");

  // Test 1: Ask about priorities
  const result1 = await jarvisService.processQuery(
    "What organizations should we focus on?",
  );

  if (!result1.answer || !result1.data) {
    throw new Error("Organization query failed");
  }
  if (!result1.answer.includes("Organization")) {
    throw new Error("Response missing organization info");
  }
  console.log("✓ Query: 'What organizations should we focus on?'");
  console.log(`  Answer length: ${result1.answer.length} chars`);

  // Test 2: Get top organizations directly
  const topOrgs = await jarvisService.getTopOrganizations();
  if (!Array.isArray(topOrgs) || topOrgs.length === 0) {
    throw new Error("No top organizations returned");
  }
  if (topOrgs[0].name !== "Tech Startup Inc") {
    throw new Error("Top organization incorrect (should be highest priority)");
  }
  console.log(`✓ getTopOrganizations(): ${topOrgs.length} organizations`);
  console.log(`  Top: ${topOrgs[0].name} (Priority: ${topOrgs[0].priority})`);

  // Test 3: Get priority summary
  const summary = await jarvisService.getPrioritySummary();
  if (summary.totalOrganizations !== 3) {
    throw new Error("Priority summary count mismatch");
  }
  if (summary.highPriority !== 2) {
    throw new Error("High priority count incorrect");
  }
  console.log(`✓ getPrioritySummary(): ${summary.totalOrganizations} total`);
  console.log(
    `  High: ${summary.highPriority}, Medium: ${summary.mediumPriority}`,
  );
}

async function testContactQuery() {
  console.log("\n═══ PHASE 2: Contact Query ═══\n");

  // Test 1: Ask about contacts
  const result = await jarvisService.processQuery(
    "How many contacts do we have?",
  );

  if (!result.answer || !result.data) {
    throw new Error("Contact query failed");
  }
  if (!result.answer.includes("Contact")) {
    throw new Error("Response missing contact info");
  }
  console.log("✓ Query: 'How many contacts do we have?'");

  // Test 2: Get contact stats
  const stats = await jarvisService.getContactStats();
  if (stats.total !== 3) {
    throw new Error(`Expected 3 contacts, got ${stats.total}`);
  }
  if (!stats.bySource.monday || !stats.bySource.eventbrite) {
    throw new Error("Contact bySource missing data");
  }
  console.log(`✓ getContactStats(): ${stats.total} total contacts`);
  console.log(`  By source: ${JSON.stringify(stats.bySource)}`);
  console.log(`  By status: ${JSON.stringify(stats.byStatus)}`);
}

async function testCampaignQuery() {
  console.log("\n═══ PHASE 3: Campaign Query ═══\n");

  // Test 1: Ask about campaigns
  const result = await jarvisService.processQuery(
    "What is the status of our campaigns?",
  );

  if (!result.answer || !result.data) {
    throw new Error("Campaign query failed");
  }
  if (!result.answer.includes("Campaign")) {
    throw new Error("Response missing campaign info");
  }
  console.log("✓ Query: 'What is the status of our campaigns?'");

  // Test 2: Get campaign status
  const status = await jarvisService.getCampaignStatus();
  if (status.total !== 2) {
    throw new Error(`Expected 2 campaigns, got ${status.total}`);
  }
  if (!status.byStatus.draft || status.byStatus.draft !== 1) {
    throw new Error("Campaign status count incorrect");
  }
  console.log(`✓ getCampaignStatus(): ${status.total} total campaigns`);
  console.log(`  By status: ${JSON.stringify(status.byStatus)}`);
}

async function testGrowthQuery() {
  console.log("\n═══ PHASE 4: Growth Opportunities ═══\n");

  // Test 1: Ask about growth
  const result = await jarvisService.processQuery(
    "What growth opportunities exist?",
  );

  if (!result.answer || !result.data) {
    throw new Error("Growth query failed");
  }
  if (!result.answer.includes("Growth")) {
    throw new Error("Response missing growth info");
  }
  console.log("✓ Query: 'What growth opportunities exist?'");

  // Test 2: Get opportunities directly
  const opportunities = await jarvisService.getGrowthOpportunities();
  if (!Array.isArray(opportunities.opportunities)) {
    throw new Error("Opportunities not returned");
  }
  if (opportunities.total > 0 && !opportunities.recommendation) {
    throw new Error("Recommendation missing");
  }
  console.log(
    `✓ getGrowthOpportunities(): ${opportunities.total} opportunities`,
  );
}

async function testDirectTools() {
  console.log("\n═══ PHASE 5: Direct Tool Access ═══\n");

  // Test 1: Get audience stats
  const audienceStats = await jarvisService.getAudienceStats();
  if (audienceStats.total === 0) {
    throw new Error("Audience stats failed");
  }
  console.log(`✓ getAudienceStats(): ${audienceStats.total} audiences`);

  // Test 2: Get stats
  const stats = await jarvisService.getStats();
  if (
    !stats.organizations ||
    !stats.audiences ||
    !stats.contacts ||
    !stats.campaigns
  ) {
    throw new Error("Stats incomplete");
  }
  console.log("✓ getStats():");
  console.log(
    `  Organizations: ${stats.organizations}, Audiences: ${stats.audiences}`,
  );
  console.log(`  Contacts: ${stats.contacts}, Campaigns: ${stats.campaigns}`);

  // Test 3: General query
  const generalResult = await jarvisService.processQuery(
    "Tell me everything about my business",
  );
  if (!generalResult.answer || !generalResult.actionsAvailable) {
    throw new Error("General query failed");
  }
  console.log("✓ General query processed");
  console.log(`  Actions available: ${generalResult.actionsAvailable.length}`);
}

// Run tests
runTests().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
