// Targeted regression coverage for connecting Vertex AI Grounding to
// Discovery as an optional public-web research source: results land in a
// review queue with citations and are never auto-created as leads;
// deduplication merges repeat finds instead of duplicating; saving a
// reviewed result creates the correct CRM entity (person -> Contact,
// organization -> Organization, deduplicated by domain) with source
// attribution, while community/event honestly stay in the review queue
// (no invented CRM entity type); Apollo/PDL and OpenAI/Jarvis are untouched
// (not called anywhere in this path). vertexGroundingService itself is
// mocked — no real network/Google call is made.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const vertexGroundingDiscoveryService = require("./services/vertexGroundingDiscoveryService");
const GroundingResearchResult = require("./models/GroundingResearchResult");
const Organization = require("./models/Organization");
const Contact = require("./models/Contact");
async function testSearchStagesResultsWithoutCreatingAnyLead() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const vertexGroundingService = {
    groundedSearch: async () => ({
      results: [
        { type: "person", name: "Jane Owner", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "A local association organizer.", evidenceUrls: ["https://metroreia.org/about"], confidence: "single_source" },
        { type: "organization", name: "Metro REIA", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "A real estate investors association.", evidenceUrls: ["https://metroreia.org"], confidence: "single_source" },
      ],
      groundingCitations: [{ url: "https://metroreia.org/events", title: "Metro REIA Events" }],
    }),
  };
  const result = await vertexGroundingDiscoveryService.search({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, query: "real estate investor associations", resultTypes: ["person", "organization"] }, { vertexGroundingService });
  assert.equal(result.created, 2);
  assert.equal(result.merged, 0);

  const rows = await GroundingResearchResult.find({ workspaceId }).lean();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === "pending_review"), "every result must start pending_review, never an auto-created lead");
  assert.ok(rows.every((row) => row.evidenceUrls.length > 0), "every staged result must carry its citation");

  const contactCount = await Contact.countDocuments({ workspaceId });
  const orgCount = await Organization.countDocuments({ workspaceId });
  assert.equal(contactCount, 0, "search() alone must never create a Contact");
  assert.equal(orgCount, 0, "search() alone must never create an Organization");

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testRepeatSearchMergesInsteadOfDuplicating() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const firstFind = { type: "person", name: "Jane Owner", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "Organizer.", evidenceUrls: ["https://metroreia.org/about"], confidence: "single_source" };
  const secondFind = { ...firstFind, evidenceUrls: ["https://news.example.com/jane-owner-profile"], confidence: "corroborated" };

  await vertexGroundingDiscoveryService.search({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, query: "q1", resultTypes: ["person"] }, { vertexGroundingService: { groundedSearch: async () => ({ results: [firstFind], groundingCitations: [] }) } });
  const secondRun = await vertexGroundingDiscoveryService.search({ workspaceId, userId, auth: { workspaceId: String(workspaceId) }, query: "q2", resultTypes: ["person"] }, { vertexGroundingService: { groundedSearch: async () => ({ results: [secondFind], groundingCitations: [] }) } });

  assert.equal(secondRun.created, 0);
  assert.equal(secondRun.merged, 1, "finding the same person again must merge into the existing pending row, not create a duplicate");

  const rows = await GroundingResearchResult.find({ workspaceId }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].evidenceUrls.length, 2, "evidence from both finds must be combined");
  assert.equal(rows[0].confidence, "corroborated", "a later corroborated find must upgrade confidence on the merged row");

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testSavingAPersonCreatesAnAttributedContact() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const row = await GroundingResearchResult.create({ workspaceId, query: "q", type: "person", name: "Jane Owner", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "Organizer.", evidenceUrls: ["https://metroreia.org/about"], confidence: "single_source", status: "pending_review" });

  const saved = await vertexGroundingDiscoveryService.saveResult({ workspaceId, userId, resultId: row._id });
  assert.equal(saved.status, "saved");
  assert.ok(saved.savedContactId, "saving a person must produce a real Contact");

  const contact = await Contact.findById(saved.savedContactId).lean();
  assert.ok(contact, "the referenced Contact must actually exist");
  assert.ok(contact.sources.includes("vertex_grounding"), "the Contact must carry real source attribution back to Vertex Grounding");

  // A second save attempt on the same, now-reviewed row must be refused.
  await assert.rejects(() => vertexGroundingDiscoveryService.saveResult({ workspaceId, userId, resultId: row._id }), (error) => error.code === "GROUNDING_RESULT_ALREADY_REVIEWED");

  await GroundingResearchResult.deleteMany({ workspaceId });
  await Contact.deleteMany({ workspaceId });
}

async function testSavingAnOrganizationDedupesByDomain() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  await Organization.create({ workspaceId, name: "Metro REIA (existing)", domain: "metroreia.org", source: "manual" });

  const row = await GroundingResearchResult.create({ workspaceId, query: "q", type: "organization", name: "Metro REIA", organizationName: "Metro REIA", organizationDomain: "metroreia.org", summary: "A REIA.", evidenceUrls: ["https://metroreia.org"], confidence: "single_source", status: "pending_review" });
  const saved = await vertexGroundingDiscoveryService.saveResult({ workspaceId, userId, resultId: row._id });

  const orgCount = await Organization.countDocuments({ workspaceId, domain: "metroreia.org" });
  assert.equal(orgCount, 1, "saving an organization that already exists by domain must update it, never duplicate it");
  const organization = await Organization.findById(saved.savedOrganizationId).lean();
  assert.equal(organization.source, "vertex_grounding");

  await GroundingResearchResult.deleteMany({ workspaceId });
  await Organization.deleteMany({ workspaceId });
}

async function testSavingCommunityOrEventNeverInventsACrmEntity() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const row = await GroundingResearchResult.create({ workspaceId, query: "q", type: "community", name: "Austin Multifamily Meetup", summary: "A recurring public meetup.", evidenceUrls: ["https://meetup.example.com/austin-multifamily"], confidence: "single_source", status: "pending_review" });
  const saved = await vertexGroundingDiscoveryService.saveResult({ workspaceId, userId, resultId: row._id });

  assert.equal(saved.status, "saved");
  assert.equal(saved.savedContactId, null);
  assert.equal(saved.savedOrganizationId, null);
  assert.equal((await Contact.countDocuments({ workspaceId })), 0);
  assert.equal((await Organization.countDocuments({ workspaceId })), 0);
  // The evidence itself IS the saved record for a type with no CRM equivalent.
  const reloaded = await GroundingResearchResult.findById(row._id).lean();
  assert.deepEqual(reloaded.evidenceUrls, ["https://meetup.example.com/austin-multifamily"]);

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function testDismissNeverCreatesAnything() {
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const row = await GroundingResearchResult.create({ workspaceId, query: "q", type: "person", name: "No Thanks", evidenceUrls: ["https://example.com"], status: "pending_review" });
  const dismissed = await vertexGroundingDiscoveryService.dismissResult({ workspaceId, userId, resultId: row._id });
  assert.equal(dismissed.status, "dismissed");
  assert.equal((await Contact.countDocuments({ workspaceId })), 0);

  await GroundingResearchResult.deleteMany({ workspaceId });
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  try {
    await testSearchStagesResultsWithoutCreatingAnyLead();
    await testRepeatSearchMergesInsteadOfDuplicating();
    await testSavingAPersonCreatesAnAttributedContact();
    await testSavingAnOrganizationDedupesByDomain();
    await testSavingCommunityOrEventNeverInventsACrmEntity();
    await testDismissNeverCreatesAnything();
    console.log("Vertex Grounding Discovery integration: results stage to a review queue with citations and never auto-create a lead, repeat finds merge and corroborate instead of duplicating, saving a person/organization creates the correct attributed+deduplicated CRM entity, community/event save honestly without inventing a CRM type, and dismiss creates nothing — all passed.");
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
