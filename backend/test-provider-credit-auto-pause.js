// Regression coverage for leadGenerationCoordinatorService.checkProviderAvailability()'s
// new real-credit auto-pause behavior: a provider that is config-enabled but
// whose real account balance (Apollo's live credit balance, PDL's last-seen
// response header, OpenAI's real org spend vs. spend limit via the Admin
// API) reads zero or below must report available:false with a clear
// "auto-paused" reason distinct from "not enabled" — and must automatically
// report available:true again the moment that balance reads positive.
//
// Fully mocked — NO real database connection or provider HTTP call is made
// anywhere in this file, per this session's standing "no live providers, no
// production writes" constraint.
require("dotenv").config();
const assert = require("node:assert/strict");
const { checkProviderAvailability } = require("./services/leadGenerationCoordinatorService");

async function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) { previous[key] = process.env[key]; process.env[key] = overrides[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(overrides)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
}

const ENABLED_ENV = { APOLLO_ENABLED: "true", APOLLO_API_KEY: "key", PDL_ENABLED: "true", PDL_API_KEY: "key", OPENAI_WEB_SEARCH_ENABLED: "true", OPENAI_API_KEY: "key" };

async function testApolloAutoPausesWhenRealBalanceHitsZero() {
  await withEnv(ENABLED_ENV, async () => {
    const apolloService = { isEnabled: () => true, getCreditBalance: async () => ({ configured: true, healthy: true, remaining: 0 }) };
    const peopleDataLabsService = { isEnabled: () => false, getCachedCreditBalance: () => null };
    const openaiWebSearchService = { masterEnabled: () => false };
    const openaiAdminUsageService = { getAccountBalance: async () => ({ configured: false }) };
    const result = await checkProviderAvailability({ apolloService, peopleDataLabsService, openaiWebSearchService, openaiAdminUsageService });
    assert.equal(result.apollo_person_search.available, false);
    assert.match(result.apollo_person_search.reason, /auto-paused/i);
    assert.match(result.apollo_person_search.reason, /credits/i);
  });
  console.log("PASS testApolloAutoPausesWhenRealBalanceHitsZero");
}

async function testApolloStaysAvailableWithPositiveBalance() {
  await withEnv(ENABLED_ENV, async () => {
    const apolloService = { isEnabled: () => true, getCreditBalance: async () => ({ configured: true, healthy: true, remaining: 42 }) };
    const peopleDataLabsService = { isEnabled: () => false, getCachedCreditBalance: () => null };
    const openaiWebSearchService = { masterEnabled: () => false };
    const openaiAdminUsageService = { getAccountBalance: async () => ({ configured: false }) };
    const result = await checkProviderAvailability({ apolloService, peopleDataLabsService, openaiWebSearchService, openaiAdminUsageService });
    assert.equal(result.apollo_person_search.available, true);
    assert.equal(result.apollo_person_search.reason, "");
  });
  console.log("PASS testApolloStaysAvailableWithPositiveBalance");
}

async function testPdlAutoPausesFromLastSeenHeaderZero() {
  await withEnv(ENABLED_ENV, async () => {
    const apolloService = { isEnabled: () => false, getCreditBalance: async () => ({ configured: false }) };
    const peopleDataLabsService = { isEnabled: () => true, getCachedCreditBalance: () => ({ configured: true, remaining: 0, fetchedAt: new Date().toISOString() }) };
    const openaiWebSearchService = { masterEnabled: () => false };
    const openaiAdminUsageService = { getAccountBalance: async () => ({ configured: false }) };
    const result = await checkProviderAvailability({ apolloService, peopleDataLabsService, openaiWebSearchService, openaiAdminUsageService });
    assert.equal(result.pdl_person_search.available, false);
    assert.match(result.pdl_person_search.reason, /auto-paused/i);
  });
  console.log("PASS testPdlAutoPausesFromLastSeenHeaderZero");
}

async function testOpenAiAutoPausesWhenRealSpendLimitExhausted() {
  await withEnv(ENABLED_ENV, async () => {
    const apolloService = { isEnabled: () => false, getCreditBalance: async () => ({ configured: false }) };
    const peopleDataLabsService = { isEnabled: () => false, getCachedCreditBalance: () => null };
    const openaiWebSearchService = { masterEnabled: () => true };
    const openaiAdminUsageService = { getAccountBalance: async () => ({ configured: true, healthy: true, spentUsd: 5, limitUsd: 5, remaining: 0 }) };
    const result = await checkProviderAvailability({ apolloService, peopleDataLabsService, openaiWebSearchService, openaiAdminUsageService });
    assert.equal(result.openai_web_search.available, false);
    assert.match(result.openai_web_search.reason, /auto-paused/i);
  });
  console.log("PASS testOpenAiAutoPausesWhenRealSpendLimitExhausted");
}

async function testOpenAiUnconfiguredAdminKeyNeverAutoPauses() {
  await withEnv(ENABLED_ENV, async () => {
    const apolloService = { isEnabled: () => false, getCreditBalance: async () => ({ configured: false }) };
    const peopleDataLabsService = { isEnabled: () => false, getCachedCreditBalance: () => null };
    const openaiWebSearchService = { masterEnabled: () => true };
    const openaiAdminUsageService = { getAccountBalance: async () => ({ configured: false }) };
    const result = await checkProviderAvailability({ apolloService, peopleDataLabsService, openaiWebSearchService, openaiAdminUsageService });
    assert.equal(result.openai_web_search.available, true);
  });
  console.log("PASS testOpenAiUnconfiguredAdminKeyNeverAutoPauses");
}

async function testDisabledProviderKeepsTheOriginalNotEnabledReason() {
  const apolloService = { isEnabled: () => false, getCreditBalance: async () => ({ configured: false }) };
  const peopleDataLabsService = { isEnabled: () => false, getCachedCreditBalance: () => null };
  const openaiWebSearchService = { masterEnabled: () => false };
  const openaiAdminUsageService = { getAccountBalance: async () => ({ configured: false }) };
  const result = await checkProviderAvailability({ apolloService, peopleDataLabsService, openaiWebSearchService, openaiAdminUsageService });
  assert.equal(result.apollo_person_search.available, false);
  assert.match(result.apollo_person_search.reason, /not enabled/i);
  console.log("PASS testDisabledProviderKeepsTheOriginalNotEnabledReason");
}

(async () => {
  await testApolloAutoPausesWhenRealBalanceHitsZero();
  await testApolloStaysAvailableWithPositiveBalance();
  await testPdlAutoPausesFromLastSeenHeaderZero();
  await testOpenAiAutoPausesWhenRealSpendLimitExhausted();
  await testOpenAiUnconfiguredAdminKeyNeverAutoPauses();
  await testDisabledProviderKeepsTheOriginalNotEnabledReason();
  console.log("\nAll provider credit auto-pause tests passed.");
})().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
