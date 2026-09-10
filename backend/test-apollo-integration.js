// Regression coverage for the Apollo integration: disabled-by-default makes zero real requests,
// email verification-state semantics (placeholder detection, verified-only provider-verified),
// normalization, dedup, and usage logging — all against mocked official-shape fixtures. No real
// network call is ever made in this file.
require("dotenv").config();
const assert = require("node:assert/strict");
const axios = require("axios");
const mongoose = require("mongoose");

const originalApolloEnabled = process.env.APOLLO_ENABLED;
const originalApolloKey = process.env.APOLLO_API_KEY;
const originalCreate = axios.create;

async function testDisabledMakesZeroRequests() {
  delete process.env.APOLLO_ENABLED;
  delete process.env.APOLLO_API_KEY;
  delete require.cache[require.resolve("./services/apolloService")];
  const apollo = require("./services/apolloService");
  assert.equal(apollo.isEnabled(), false);
  let created = false;
  axios.create = () => { created = true; throw new Error("must not construct an HTTP client while disabled"); };
  await assert.rejects(() => apollo.searchPeople({ workspaceId: "w1", filters: {} }), /APOLLO_DISABLED|not enabled/);
  await assert.rejects(() => apollo.enrichPerson({ workspaceId: "w1", matchInput: { email: "a@b.com" } }), /APOLLO_DISABLED|not enabled/);
  await assert.rejects(() => apollo.enrichCompany({ workspaceId: "w1", domain: "example.com" }), /APOLLO_DISABLED|not enabled/);
  assert.equal(created, false, "no HTTP client may be constructed while Apollo is disabled");
  axios.create = originalCreate;
  const health = await apollo.healthCheck({ workspaceId: "w1" });
  assert.deepEqual(health, { enabled: false, configured: false, healthy: false, reason: "disabled" });
}

function testEmailClassification() {
  delete require.cache[require.resolve("./services/apolloService")];
  const apollo = require("./services/apolloService");
  assert.equal(apollo.isPlaceholderEmail("email_not_unlocked@domain.com"), true);
  assert.equal(apollo.isPlaceholderEmail("real.person@company.com"), false);
  assert.deepEqual(apollo.classifyEmail({ email: "real.person@company.com", emailStatus: "verified" }), { state: "verified", providerVerified: true, revealed: true });
  assert.deepEqual(apollo.classifyEmail({ email: "real.person@company.com", emailStatus: "extrapolated" }), { state: "extrapolated", providerVerified: false, revealed: true });
  assert.deepEqual(apollo.classifyEmail({ email: "real.person@company.com", emailStatus: "catch_all" }), { state: "catch_all", providerVerified: false, revealed: true });
  assert.deepEqual(apollo.classifyEmail({ email: "email_not_unlocked@domain.com", emailStatus: "verified" }), { state: "unavailable", providerVerified: false, revealed: false }, "a locked placeholder must never be treated as verified even if email_status says so");
  assert.equal(apollo.classifyEmail({ email: "a@b.com", emailStatus: "verified" }).providerVerified, true);
}

async function testEnabledSearchNormalizesAndCaches(models) {
  process.env.APOLLO_ENABLED = "true";
  process.env.APOLLO_API_KEY = "test-key";
  delete require.cache[require.resolve("./services/apolloService")];
  const apollo = require("./services/apolloService");
  apollo.resetApolloCache();
  const officialFixture = {
    people: [
      { id: "p1", first_name: "Jane", last_name: "Doe", name: "Jane Doe", title: "VP of Sales", organization: { id: "o1", name: "Acme Corp", primary_domain: "acme.com" }, email: "jane.doe@acme.com", email_status: "verified", linkedin_url: "https://linkedin.com/in/janedoe", city: "Austin", state: "TX", country: "US", phone_numbers: [{ sanitized_number: "+15125550100" }] },
      { id: "p2", first_name: "Locked", last_name: "Person", name: "Locked Person", title: "Director", organization: { id: "o2", name: "Beta LLC", primary_domain: "beta.com" }, email: "email_not_unlocked@domain.com", email_status: "verified" },
      { id: "p1", first_name: "Jane", last_name: "Doe", name: "Jane Doe", title: "VP of Sales", organization: { id: "o1", name: "Acme Corp" }, email: "jane.doe@acme.com", email_status: "verified" },
    ],
    pagination: { page: 1, total_entries: 2, total_pages: 1 },
  };
  let calls = 0;
  axios.create = () => ({ post: async (path, body) => { calls += 1; assert.equal(path, "/mixed_people/search"); assert.equal(body.per_page, 25); return { data: officialFixture }; } });
  const result = await apollo.searchPeople({ workspaceId: models.workspaceId, userId: models.userId, filters: { person_titles: ["VP of Sales"] } });
  assert.equal(result.people.length, 2, "duplicate Apollo IDs must be deduplicated");
  const jane = result.people.find((p) => p.externalId === "p1");
  assert.equal(jane.email, "jane.doe@acme.com");
  assert.equal(jane.emailProviderVerified, true);
  assert.equal(jane.companyDomain, "acme.com");
  const locked = result.people.find((p) => p.externalId === "p2");
  assert.equal(locked.email, "", "a locked placeholder email must never be exposed as a real address");
  assert.equal(locked.emailState, "unavailable");
  assert.equal(calls, 1);

  // Cached on the second identical call — no second HTTP call.
  await apollo.searchPeople({ workspaceId: models.workspaceId, filters: { person_titles: ["VP of Sales"] } });
  assert.equal(calls, 1, "an identical search must be served from cache, not a second request");

  const usage = await models.ProviderApiUsage.find({ workspaceId: models.workspaceId, provider: "apollo" }).sort({ createdAt: 1, _id: 1 }).lean();
  assert.equal(usage.length, 2, "one real call and one cache hit must both be logged");
  assert.equal(usage[0].success, true);
  assert.equal(usage[1].cacheHit, true);
  assert.equal(String(usage[0].userId), String(models.userId), "usage must record which user made the request, for audit purposes");

  axios.create = originalCreate;
}

async function testErrorCategorization() {
  process.env.APOLLO_ENABLED = "true";
  process.env.APOLLO_API_KEY = "test-key";
  delete require.cache[require.resolve("./services/apolloService")];
  const apollo = require("./services/apolloService");
  apollo.resetApolloCache();
  axios.create = () => ({ post: async () => { const error = new Error("Unauthorized"); error.response = { status: 401 }; throw error; } });
  await assert.rejects(() => apollo.searchPeople({ workspaceId: "w1", filters: {} }), (error) => { assert.equal(error.category, "authentication"); return true; });
  axios.create = originalCreate;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const ProviderApiUsage = require("./models/ProviderApiUsage");
  const workspaceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  try {
    await testDisabledMakesZeroRequests();
    testEmailClassification();
    await testEnabledSearchNormalizesAndCaches({ workspaceId, userId, ProviderApiUsage });
    await testErrorCategorization();
  } finally {
    await ProviderApiUsage.deleteMany({ workspaceId });
    axios.create = originalCreate;
    if (originalApolloEnabled === undefined) delete process.env.APOLLO_ENABLED; else process.env.APOLLO_ENABLED = originalApolloEnabled;
    if (originalApolloKey === undefined) delete process.env.APOLLO_API_KEY; else process.env.APOLLO_API_KEY = originalApolloKey;
    delete require.cache[require.resolve("./services/apolloService")];
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Apollo integration: disabled-by-default zero-requests, email classification, normalization/dedup/caching, and error categorization all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
