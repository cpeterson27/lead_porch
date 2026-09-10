#!/usr/bin/env node
/**
 * MANUAL smoke test only — never run in CI or automated tests.
 * Makes the smallest possible real Apollo request (1 result) using real
 * server-side credentials, to confirm the endpoint shape and auth header
 * still match what services/apolloService.js expects.
 *
 * Usage:
 *   APOLLO_ENABLED=true APOLLO_API_KEY=... node scripts/apollo-smoke-test.js
 */
require("dotenv").config();
const apollo = require("../services/apolloService");

async function main() {
  if (!apollo.isEnabled()) {
    console.error("Apollo is not enabled. Set APOLLO_ENABLED=true and APOLLO_API_KEY, then re-run this script manually.");
    process.exitCode = 1;
    return;
  }
  console.log("Making the smallest possible real Apollo request (1 result, no email reveal)...");
  const result = await apollo.searchPeople({ filters: { person_titles: ["Founder"] }, page: 1, perPage: 1 });
  console.log(`Received ${result.people.length} result(s). Pagination:`, result.pagination);
  if (result.people[0]) console.log("Sample normalized record (no credentials, no full contact fields logged):", { fullName: result.people[0].fullName, title: result.people[0].title, company: result.people[0].company, emailState: result.people[0].emailState });
}

main().catch((error) => {
  console.error("Apollo smoke test failed:", error.message, error.category ? `(${error.category})` : "");
  process.exitCode = 1;
});
