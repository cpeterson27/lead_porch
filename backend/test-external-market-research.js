// Regression coverage for services/externalMarketResearchService.js after
// replacing the old "owned business index" (services/businessDataSourceService.js,
// deleted — it had zero real records in production) with real Apollo
// Organization Search. This is what powers company research triggered from
// the ChatGPT Actions endpoints (routes/gptActions.js), the MCP server
// (services/mcpServer.js), and routes/audience.js's own research routes —
// all three funnel through the one runMarketResearchJob() this file tests.
//
// Fully mocked — NO real database connection and NO real Apollo API call is
// made anywhere in this file, per this session's standing "no live
// providers, no production writes/spend" constraint.
require("dotenv").config();
const assert = require("node:assert/strict");
const {
  buildApolloCompanyFilters, searchApolloCompanies, runMarketResearchJob, sourceStatus,
} = require("./services/externalMarketResearchService");

function testBuildApolloCompanyFiltersMapsLocationsIndustriesKeywords() {
  const filters = buildApolloCompanyFilters({
    locations: ["Sacramento, CA"], industries: ["Multifamily Coaching"], keywords: ["syndication"],
    employeeRange: { min: 5, max: 50 },
  });
  assert.deepEqual(filters.organization_locations, ["Sacramento, CA"]);
  assert.deepEqual(filters.q_organization_keyword_tags, ["Multifamily Coaching", "syndication"]);
  assert.deepEqual(filters.organization_num_employees_ranges, ["5,50"]);
  console.log("PASS testBuildApolloCompanyFiltersMapsLocationsIndustriesKeywords");
}

function testBuildApolloCompanyFiltersSkipsEmployeeRangeWhenEitherBoundIsNull() {
  // Regression: Number(null) === 0, so a naive Number.isFinite() check would
  // have silently built a bogus "0,0" range when only one side of the
  // compiled plan's employeeRange was actually specified.
  const onlyMin = buildApolloCompanyFilters({ employeeRange: { min: 10, max: null } });
  const onlyMax = buildApolloCompanyFilters({ employeeRange: { min: null, max: 100 } });
  const neither = buildApolloCompanyFilters({ employeeRange: { min: null, max: null } });
  assert.equal(onlyMin.organization_num_employees_ranges, undefined);
  assert.equal(onlyMax.organization_num_employees_ranges, undefined);
  assert.equal(neither.organization_num_employees_ranges, undefined);
  console.log("PASS testBuildApolloCompanyFiltersSkipsEmployeeRangeWhenEitherBoundIsNull");
}

async function testSearchApolloCompaniesReturnsSourceRequiredWhenApolloDisabled() {
  const fakeApollo = { searchCompanies: async () => { const error = new Error("Apollo is not enabled"); error.code = "APOLLO_DISABLED"; throw error; } };
  const page = await searchApolloCompanies({ workspaceId: "w1", plan: { criteria: {} } }, { apolloService: fakeApollo });
  assert.equal(page.success, false);
  assert.equal(page.code, "source_required");
  console.log("PASS testSearchApolloCompaniesReturnsSourceRequiredWhenApolloDisabled");
}

async function testSearchApolloCompaniesMapsResultsAndOnlyKeepsLinkedinEvidence() {
  const fakeApollo = {
    searchCompanies: async ({ page }) => ({
      companies: [
        { externalId: "a1", name: "Acme Coaching", domain: "acme.com", industry: "Coaching", employeeCount: 12, location: "Austin, TX", linkedinUrl: "https://linkedin.com/company/acme" },
        { externalId: "a2", name: "No Evidence Co", domain: "", industry: "", employeeCount: null, location: "", linkedinUrl: "" },
      ],
      pagination: { page, totalEntries: 2, totalPages: 1 },
    }),
  };
  const page = await searchApolloCompanies({ workspaceId: "w1", plan: { criteria: {} } }, { apolloService: fakeApollo });
  assert.equal(page.success, true);
  assert.equal(page.results.length, 2);
  assert.equal(page.results[0].evidence.length, 1);
  assert.equal(page.results[0].evidence[0].sourceUrl, "https://linkedin.com/company/acme");
  assert.equal(page.results[1].evidence.length, 0, "never invents an evidence URL when Apollo supplied none");
  assert.equal(page.cursor, null, "a single, non-full page must not claim there's more");
  console.log("PASS testSearchApolloCompaniesMapsResultsAndOnlyKeepsLinkedinEvidence");
}

async function testSearchApolloCompaniesNeverExceedsThreePagesRegardlessOfTotalPages() {
  let calls = 0;
  const fakeApollo = {
    searchCompanies: async ({ page }) => {
      calls += 1;
      return { companies: [{ externalId: `p${page}`, name: `Company ${page}`, domain: `p${page}.com`, linkedinUrl: `https://linkedin.com/company/p${page}` }], pagination: { page, totalEntries: 1000, totalPages: 50 } };
    },
  };
  let cursor = null;
  let pagesFetched = 0;
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const page = await searchApolloCompanies({ workspaceId: "w1", plan: { criteria: {} }, cursor }, { apolloService: fakeApollo });
    if (page.results.length) pagesFetched += 1;
    cursor = page.cursor;
    if (!cursor) break;
  }
  assert.equal(calls, 3, "even a provider reporting 50 total pages must never be asked for more than the hard 3-page safety cap — each page is a real paid Apollo call");
  assert.equal(pagesFetched, 3);
  console.log("PASS testSearchApolloCompaniesNeverExceedsThreePagesRegardlessOfTotalPages");
}

async function testRunMarketResearchJobCreatesAndUpdatesOrganizationsThenCompletes() {
  const jobDoc = { _id: "job1", workspaceId: "w1", userId: "u1", audienceId: "aud1", plan: { criteria: { locations: ["Austin"] } }, status: "queued", statistics: { received: 0, created: 0, updated: 0, duplicates: 0, rejected: 0 }, save: async function save() { return this; } };
  const JobModel = { findById: async () => jobDoc };
  const orgs = new Map();
  const OrgModel = {
    findOne: async (filter) => [...orgs.values()].find((o) => (filter.domain && o.domain === filter.domain)) || null,
    findOneAndUpdate: async (filter, update) => {
      const existing = [...orgs.values()].find((o) => (filter.domain && o.domain === filter.domain));
      const doc = { _id: existing?._id || `org-${orgs.size + 1}`, ...update.$set };
      orgs.set(doc._id, doc);
      return doc;
    },
  };
  const audienceDoc = { _id: "aud1", organizationIds: [], save: async function save() { return this; } };
  const AudienceModel = { findById: async () => audienceDoc };
  const fakeApollo = {
    searchCompanies: async ({ page }) => page === 1
      ? { companies: [{ externalId: "c1", name: "First Co", domain: "first.com", linkedinUrl: "https://linkedin.com/company/first" }], pagination: { page, totalEntries: 1, totalPages: 1 } }
      : { companies: [], pagination: { page, totalEntries: 1, totalPages: 1 } },
  };
  const result = await runMarketResearchJob("job1", { maxResults: 100 }, { MarketResearchJob: JobModel, Organization: OrgModel, Audience: AudienceModel, apolloService: fakeApollo });
  assert.equal(result.status, "completed");
  assert.equal(result.statistics.received, 1);
  assert.equal(result.statistics.created, 1);
  assert.equal(orgs.size, 1);
  assert.equal(audienceDoc.organizationIds.length, 1);
  console.log("PASS testRunMarketResearchJobCreatesAndUpdatesOrganizationsThenCompletes");
}

async function testRunMarketResearchJobMarksSourceRequiredWhenApolloDisabled() {
  const jobDoc = { _id: "job2", workspaceId: "w1", plan: { criteria: {} }, status: "queued", statistics: { received: 0, created: 0, updated: 0, duplicates: 0, rejected: 0 }, save: async function save() { return this; } };
  const JobModel = { findById: async () => jobDoc };
  const fakeApollo = { searchCompanies: async () => { const error = new Error("disabled"); error.code = "APOLLO_DISABLED"; throw error; } };
  const result = await runMarketResearchJob("job2", {}, { MarketResearchJob: JobModel, apolloService: fakeApollo });
  assert.equal(result.status, "source_required");
  assert.ok(result.error.includes("Apollo"));
  console.log("PASS testRunMarketResearchJobMarksSourceRequiredWhenApolloDisabled");
}

function testSourceStatusReflectsApolloConfiguration() {
  const originalEnabled = process.env.APOLLO_ENABLED;
  const originalKey = process.env.APOLLO_API_KEY;
  try {
    delete process.env.APOLLO_ENABLED;
    delete process.env.APOLLO_API_KEY;
    assert.equal(sourceStatus().configured, false);
    process.env.APOLLO_ENABLED = "true";
    process.env.APOLLO_API_KEY = "test-key";
    assert.equal(sourceStatus().configured, true);
    assert.equal(sourceStatus().id, "apollo_company_search");
  } finally {
    if (originalEnabled === undefined) delete process.env.APOLLO_ENABLED; else process.env.APOLLO_ENABLED = originalEnabled;
    if (originalKey === undefined) delete process.env.APOLLO_API_KEY; else process.env.APOLLO_API_KEY = originalKey;
  }
  console.log("PASS testSourceStatusReflectsApolloConfiguration");
}

(async () => {
  testBuildApolloCompanyFiltersMapsLocationsIndustriesKeywords();
  testBuildApolloCompanyFiltersSkipsEmployeeRangeWhenEitherBoundIsNull();
  await testSearchApolloCompaniesReturnsSourceRequiredWhenApolloDisabled();
  await testSearchApolloCompaniesMapsResultsAndOnlyKeepsLinkedinEvidence();
  await testSearchApolloCompaniesNeverExceedsThreePagesRegardlessOfTotalPages();
  await testRunMarketResearchJobCreatesAndUpdatesOrganizationsThenCompletes();
  await testRunMarketResearchJobMarksSourceRequiredWhenApolloDisabled();
  testSourceStatusReflectsApolloConfiguration();
  console.log("\nAll external market research (Apollo-backed) tests passed.");
})().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
