#!/usr/bin/env node
/**
 * MANUAL smoke test only — never run in CI or automated tests.
 *
 * Makes the smallest possible real Vertex AI request using a real
 * server-side Google Cloud service account, to confirm auth, the endpoint
 * shape, and response parsing in services/vertexGroundingService.js still
 * match Vertex's real API. This is the ONLY thing in this codebase that is
 * allowed to call the Vertex grounding path "live-tested" — until this has
 * been run successfully against a real Google Cloud project, treat it as
 * unverified.
 *
 * Runs two checks: a plain generateContent call, and a grounded
 * generateContent call with the camelCase "googleSearch" tool (Vertex's
 * tool key differs from the Gemini Developer API's snake_case
 * "google_search" — this smoke test is what actually proves which one your
 * configured Vertex API version expects).
 *
 * Usage:
 *   VERTEX_ENABLED=true GOOGLE_APPLICATION_CREDENTIALS_JSON='{...}' \
 *   VERTEX_PROJECT_ID=your-project node scripts/vertex-smoke-test.js
 */
require("dotenv").config();
const axios = require("axios");
const googleAuthService = require("../services/googleAuthService");

async function main() {
  const enabled = process.env.VERTEX_ENABLED === "true";
  if (!enabled || !googleAuthService.configured()) {
    console.log("Vertex AI is not configured (VERTEX_ENABLED must be \"true\" and GOOGLE_APPLICATION_CREDENTIALS_JSON/VERTEX_PROJECT_ID must be set). Nothing to test.");
    return;
  }
  const project = process.env.VERTEX_PROJECT_ID.trim();
  const location = (process.env.VERTEX_AI_LOCATION || "us-central1").trim();
  const model = (process.env.VERTEX_GEMINI_MODEL || "gemini-2.5-flash").trim();
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

  console.log("Requesting a Google Cloud access token...");
  let token;
  try {
    token = await googleAuthService.getAccessToken();
    console.log("Token acquired.");
  } catch (error) {
    console.error(`Failed to acquire an access token: ${error.message}`);
    console.error("This looks like an invalid GOOGLE_APPLICATION_CREDENTIALS_JSON or missing IAM permissions, not an integration bug.");
    process.exitCode = 1;
    return;
  }

  console.log(`\nPlain generateContent request (${endpoint})...`);
  try {
    const response = await axios.post(endpoint, { contents: [{ role: "user", parts: [{ text: "Reply with exactly the word: ok" }] }] }, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    const text = response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") || "";
    console.log(`Plain call working. Model replied: "${text.trim()}". Usage:`, response.data?.usageMetadata || "(no usageMetadata in response)");
  } catch (error) {
    reportError("Plain generateContent", error);
    process.exitCode = 1;
    return;
  }

  console.log("\nGrounded generateContent request (camelCase googleSearch tool)...");
  try {
    const response = await axios.post(endpoint, { contents: [{ role: "user", parts: [{ text: "What real, publicly findable real-estate investors associations are active near Austin, Texas? Cite your sources." }] }], tools: [{ googleSearch: {} }] }, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    const candidate = response.data?.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text).join("") || "";
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    console.log(`Grounded call working. Model replied with ${text.length} characters of text and ${chunks.length} grounding citation(s).`);
    if (chunks.length) console.log("Sample citation:", chunks[0].web);
    else console.log("No groundingChunks were present — verify services/vertexGroundingService.js's tool key (\"googleSearch\") still matches Vertex's current API version. If this fails with an unknown-field error, Vertex may now expect \"google_search\" like the Developer API — update the tool key in that one place if so.");
  } catch (error) {
    reportError("Grounded generateContent", error);
    process.exitCode = 1;
  }
}

function reportError(label, error) {
  const status = error.response?.status;
  console.error(`${label} failed (${status ? `HTTP ${status}` : error.code || "unknown error"}): ${error.message}`);
  if (error.response?.data) console.error("Response body:", JSON.stringify(error.response.data).slice(0, 2000));
  if (status === 401 || status === 403) console.error("This looks like an IAM permissions problem (needs roles/aiplatform.user), not an integration bug.");
}

main().catch((error) => {
  console.error("Vertex smoke test crashed unexpectedly:", error.message);
  process.exitCode = 1;
});
