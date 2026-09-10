#!/usr/bin/env node
/**
 * MANUAL smoke test only — never run in CI or automated tests.
 *
 * Makes the smallest possible real Gemini request using real server-side
 * credentials (GEMINI_API_KEY), to confirm the endpoint shape, auth, and
 * response parsing in services/geminiService.js still match Gemini's real
 * API. This is the ONLY thing in this codebase that is allowed to call this
 * "live-tested" — until this has been run successfully against real
 * credentials, treat the Gemini integration as unverified.
 *
 * Runs two checks: a plain generateContent call (what Workspace Context uses)
 * and a grounded generateContent call with the google_search tool (what
 * Grounded Search uses), so both code paths get exercised independently.
 *
 * Usage:
 *   GEMINI_ENABLED=true GEMINI_API_KEY=... node scripts/gemini-smoke-test.js
 */
require("dotenv").config();
const axios = require("axios");

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

async function call(model, body, apiKey) {
  return axios.post(`${BASE_URL}/models/${model}:generateContent`, body, { params: { key: apiKey }, timeout: 20000 });
}

async function main() {
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (process.env.GEMINI_ENABLED !== "true" || !apiKey) {
    console.log("Gemini is not configured (GEMINI_ENABLED must be \"true\" and GEMINI_API_KEY must be set). Nothing to test.");
    return;
  }
  const model = process.env.GEMINI_WORKSPACE_CONTEXT_MODEL || "gemini-2.5-flash";

  console.log(`Plain generateContent request (model: ${model})...`);
  try {
    const response = await call(model, { contents: [{ role: "user", parts: [{ text: "Reply with exactly the word: ok" }] }] }, apiKey);
    const text = response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") || "";
    console.log(`Plain call working. Model replied: "${text.trim()}". Usage:`, response.data?.usageMetadata || "(no usageMetadata in response)");
  } catch (error) {
    reportError("Plain generateContent", error);
    process.exitCode = 1;
    return;
  }

  console.log("\nGrounded generateContent request (google_search tool)...");
  try {
    const response = await call(model, { contents: [{ role: "user", parts: [{ text: "What real, publicly findable real-estate investors associations are active near Austin, Texas? Cite your sources." }] }], tools: [{ google_search: {} }] }, apiKey);
    const candidate = response.data?.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text).join("") || "";
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    console.log(`Grounded call working. Model replied with ${text.length} characters of text and ${chunks.length} grounding citation(s).`);
    if (chunks.length) console.log("Sample citation:", chunks[0].web);
    else console.log("No groundingChunks were present in the response — verify services/geminiService.js's normalizeGroundingCitations() still matches the real response shape.");
  } catch (error) {
    reportError("Grounded generateContent", error);
    process.exitCode = 1;
  }
}

function reportError(label, error) {
  const status = error.response?.status;
  console.error(`${label} failed (${status ? `HTTP ${status}` : error.code || "unknown error"}): ${error.message}`);
  if (status === 401 || status === 403) console.error("This looks like an invalid/revoked GEMINI_API_KEY, not an integration bug.");
}

main().catch((error) => {
  console.error("Gemini smoke test crashed unexpectedly:", error.message);
  process.exitCode = 1;
});
