#!/usr/bin/env node
/**
 * MANUAL smoke test only — never run in CI or automated tests.
 * Makes the smallest possible real PDL enrichment request using real
 * server-side credentials, to confirm the endpoint shape, auth header, and
 * the min_likelihood behavior still match what
 * services/peopleDataLabsService.js expects.
 *
 * Usage:
 *   PDL_ENABLED=true PDL_API_KEY=... node scripts/pdl-smoke-test.js
 */
require("dotenv").config();
const pdl = require("../services/peopleDataLabsService");

async function main() {
  if (!pdl.isEnabled()) {
    console.error("PDL is not enabled. Set PDL_ENABLED=true and PDL_API_KEY, then re-run this script manually.");
    process.exitCode = 1;
    return;
  }
  console.log("Making the smallest possible real PDL enrichment request (well-known public identity, two inputs)...");
  const result = await pdl.enrichPerson({ inputs: { name: "Satya Nadella", company: "Microsoft" } });
  if (!result.matched) {
    console.log(`No match at or above the required likelihood threshold (${pdl.MIN_LIKELIHOOD}). Likelihood returned:`, result.likelihood);
    return;
  }
  console.log("Matched. Sample normalized record (no credentials logged):", { fullName: result.person.fullName, title: result.person.title, company: result.person.company, emailState: result.person.emailState, likelihood: result.likelihood, provenance: result.person.provenance });
}

main().catch((error) => {
  console.error("PDL smoke test failed:", error.message, error.category ? `(${error.category})` : "");
  process.exitCode = 1;
});
