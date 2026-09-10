// Regression coverage for the People Data Labs (PDL) integration: disabled-by-default makes zero
// real requests, the min_likelihood >= 6 high-accuracy threshold is enforced, multiple
// corroborating identity inputs are required for enrichment, provenance fields are preserved,
// and the top-level work email is labeled provider-validated (never independently verified).
require("dotenv").config();
const assert = require("node:assert/strict");
const axios = require("axios");
const mongoose = require("mongoose");

const originalPdlEnabled = process.env.PDL_ENABLED;
const originalPdlKey = process.env.PDL_API_KEY;
const originalCreate = axios.create;

async function testDisabledMakesZeroRequests() {
  delete process.env.PDL_ENABLED;
  delete process.env.PDL_API_KEY;
  delete require.cache[require.resolve("./services/peopleDataLabsService")];
  const pdl = require("./services/peopleDataLabsService");
  assert.equal(pdl.isEnabled(), false);
  let created = false;
  axios.create = () => { created = true; throw new Error("must not construct an HTTP client while disabled"); };
  await assert.rejects(() => pdl.searchPeople({ workspaceId: "w1", sql: "SELECT * FROM person" }), /PDL_DISABLED|not enabled/);
  await assert.rejects(() => pdl.enrichPerson({ workspaceId: "w1", inputs: { name: "Jane Doe", company: "Acme" } }), /PDL_DISABLED|not enabled/);
  await assert.rejects(() => pdl.enrichCompany({ workspaceId: "w1", website: "acme.com" }), /PDL_DISABLED|not enabled/);
  assert.equal(created, false, "no HTTP client may be constructed while PDL is disabled");
  axios.create = originalCreate;
  const health = await pdl.healthCheck({ workspaceId: "w1" });
  assert.deepEqual(health, { enabled: false, configured: false, healthy: false, reason: "disabled" });
}

function testLikelihoodAndWorkEmailSemantics() {
  delete require.cache[require.resolve("./services/peopleDataLabsService")];
  const pdl = require("./services/peopleDataLabsService");
  assert.equal(pdl.MIN_LIKELIHOOD, 6);
  assert.equal(pdl.meetsMatchThreshold(6), true);
  assert.equal(pdl.meetsMatchThreshold(5), false, "likelihood below the documented high-accuracy threshold must not count as a match");
  assert.equal(pdl.meetsMatchThreshold(10), true);
  assert.deepEqual(pdl.classifyWorkEmail("jane@acme.com"), { email: "jane@acme.com", state: "provider_validated" }, "PDL's work_email is provider-validated, never independently verified");
  assert.deepEqual(pdl.classifyWorkEmail(""), { email: "", state: "unavailable" });
}

async function testEnrichmentRequiresMultipleInputs() {
  process.env.PDL_ENABLED = "true";
  process.env.PDL_API_KEY = "test-key";
  delete require.cache[require.resolve("./services/peopleDataLabsService")];
  const pdl = require("./services/peopleDataLabsService");
  let called = false;
  axios.create = () => ({ get: async () => { called = true; return { data: {} }; } });
  await assert.rejects(() => pdl.enrichPerson({ workspaceId: "w1", inputs: { name: "Jane Doe" } }), /PDL_INSUFFICIENT_INPUTS|corroborating/);
  assert.equal(called, false, "enrichment must reject a single loose identity input before ever calling PDL");
  axios.create = originalCreate;
}

async function testEnrichmentPreservesProvenanceAndThreshold(models) {
  process.env.PDL_ENABLED = "true";
  process.env.PDL_API_KEY = "test-key";
  delete require.cache[require.resolve("./services/peopleDataLabsService")];
  const pdl = require("./services/peopleDataLabsService");
  const officialFixture = {
    likelihood: 8,
    data: {
      id: "pdl123",
      full_name: "Jane Doe",
      first_name: "Jane",
      last_name: "Doe",
      job_title: "VP of Sales",
      job_company_name: "Acme Corp",
      job_company_website: "acme.com",
      work_email: "jane.doe@acme.com",
      linkedin_url: "https://linkedin.com/in/janedoe",
      location_name: "Austin, Texas, United States",
      dataset_version: "22.5",
      job_last_verified: "2026-01-15",
      job_last_changed: "2025-11-02",
      location_last_updated: "2026-02-01",
      conflicts: ["multiple LinkedIn profiles matched"],
    },
  };
  let capturedParams = null;
  axios.create = () => ({ get: async (path, config) => { capturedParams = config.params; return { data: officialFixture }; } });
  const result = await pdl.enrichPerson({ workspaceId: models.workspaceId, inputs: { name: "Jane Doe", company: "Acme Corp" } });
  assert.equal(capturedParams.min_likelihood, 6, "the documented high-accuracy threshold must always be sent, even if a caller asks for less");
  assert.equal(result.matched, true);
  assert.equal(result.person.email, "jane.doe@acme.com");
  assert.equal(result.person.emailState, "provider_validated");
  assert.equal(result.person.provenance.datasetVersion, "22.5");
  assert.equal(result.person.provenance.jobLastVerified, "2026-01-15");
  assert.equal(result.person.provenance.jobLastChanged, "2025-11-02");
  assert.equal(result.person.provenance.locationLastUpdated, "2026-02-01");
  assert.deepEqual(result.person.conflicts, ["multiple LinkedIn profiles matched"]);
  assert.ok(result.person.retrievedAt);

  // Below-threshold likelihood must not be treated as a real match.
  axios.create = () => ({ get: async () => ({ data: { likelihood: 4, data: officialFixture.data } }) });
  const weak = await pdl.enrichPerson({ workspaceId: models.workspaceId, inputs: { name: "Jane Doe", company: "Acme Corp" } });
  assert.equal(weak.matched, false);
  assert.equal(weak.person, null);

  const usage = await models.ProviderApiUsage.find({ workspaceId: models.workspaceId, provider: "people_data_labs" }).lean();
  assert.equal(usage.length, 2);
  assert.equal(usage.every((row) => row.success), true, "a below-threshold non-match is not a provider failure");

  axios.create = originalCreate;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const ProviderApiUsage = require("./models/ProviderApiUsage");
  const workspaceId = new mongoose.Types.ObjectId();
  try {
    await testDisabledMakesZeroRequests();
    testLikelihoodAndWorkEmailSemantics();
    await testEnrichmentRequiresMultipleInputs();
    await testEnrichmentPreservesProvenanceAndThreshold({ workspaceId, ProviderApiUsage });
  } finally {
    await ProviderApiUsage.deleteMany({ workspaceId });
    axios.create = originalCreate;
    if (originalPdlEnabled === undefined) delete process.env.PDL_ENABLED; else process.env.PDL_ENABLED = originalPdlEnabled;
    if (originalPdlKey === undefined) delete process.env.PDL_API_KEY; else process.env.PDL_API_KEY = originalPdlKey;
    delete require.cache[require.resolve("./services/peopleDataLabsService")];
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("PDL integration: disabled-by-default zero-requests, likelihood threshold enforcement, multi-input enrichment gating, and provenance preservation all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
