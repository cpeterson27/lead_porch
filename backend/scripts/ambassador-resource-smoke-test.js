#!/usr/bin/env node
/**
 * MANUAL smoke test only — never run in CI or automated tests.
 *
 * Uploads a tiny real PDF to Cloudinary as an "authenticated" (private)
 * resource, confirms the public delivery URL genuinely refuses access,
 * then generates a real signed "private download" URL and confirms THAT
 * one works — exercising the exact flow
 * services/ambassadorResourceService.js relies on. Cleans up the test
 * upload afterward.
 *
 * Usage:
 *   CLOUDINARY_URL=cloudinary://key:secret@cloud node scripts/ambassador-resource-smoke-test.js
 */
require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");
const { credentials } = require("../services/imageAssetService");

function signature(values, secret) {
  return crypto.createHash("sha1").update(`${Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("&")}${secret}`).digest("hex");
}

async function main() {
  let creds;
  try { creds = credentials(); }
  catch { console.log("Cloudinary is not configured (CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET unset). Nothing to test."); return; }
  const { cloudName, apiKey, apiSecret } = creds;
  const publicId = `ambassador-resources/smoke-test-${Date.now()}`;
  const tinyPdf = Buffer.from("%PDF-1.4\n%smoke test\n%%EOF");

  console.log("Uploading a tiny PDF as an authenticated (private) resource...");
  const FormData = require("form-data");
  const timestamp = Math.floor(Date.now() / 1000);
  const uploadSigned = { public_id: publicId, timestamp, type: "authenticated" };
  const body = new FormData();
  body.append("file", tinyPdf, { filename: "smoke-test.pdf", contentType: "application/pdf" });
  body.append("api_key", apiKey);
  body.append("timestamp", String(timestamp));
  body.append("public_id", publicId);
  body.append("type", "authenticated");
  body.append("signature", signature(uploadSigned, apiSecret));

  let uploadResult;
  try {
    const response = await axios.post(`https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`, body, { headers: body.getHeaders() });
    uploadResult = response.data;
    console.log(`Upload working. public_id=${uploadResult.public_id}`);
  } catch (error) {
    console.error(`Upload failed (${error.response?.status || error.code}): ${error.response?.data?.error?.message || error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nConfirming the plain public delivery URL genuinely refuses access...");
  try {
    await axios.get(`https://res.cloudinary.com/${cloudName}/raw/upload/${publicId}`, { timeout: 10000 });
    console.error("UNEXPECTED: the public delivery URL served the file — this resource is NOT actually private. Investigate before trusting this integration.");
    process.exitCode = 1;
  } catch (error) {
    if (error.response?.status === 401 || error.response?.status === 404) console.log(`Confirmed private: public URL returned ${error.response.status}.`);
    else { console.error(`Unexpected error checking the public URL: ${error.message}`); process.exitCode = 1; }
  }

  console.log("\nFetching the file via a signed authenticated-download request...");
  try {
    // Cloudinary's /{resource_type}/download endpoint (Admin-API-style
    // timestamp+signature, like upload) returns the FILE BYTES directly on
    // success — it is not a URL-issuing endpoint. The signed string
    // includes public_id, timestamp, and type — never resource_type (that's
    // routing-only, via the URL path).
    const downloadTimestamp = Math.floor(Date.now() / 1000);
    const downloadParams = { public_id: uploadResult.public_id, timestamp: downloadTimestamp, type: "authenticated" };
    const download = await axios.get(`https://api.cloudinary.com/v1_1/${cloudName}/raw/download`, { params: { ...downloadParams, api_key: apiKey, signature: signature(downloadParams, apiSecret) }, responseType: "arraybuffer", timeout: 10000 });
    console.log(`Signed download working. Retrieved ${download.data.length} bytes.`);
  } catch (error) {
    console.error(`Signed download failed (${error.response?.status || error.code}): ${error.response?.data?.error?.message || error.message}`);
    process.exitCode = 1;
  }

  console.log("\nCleaning up the test upload...");
  try {
    const destroyTimestamp = Math.floor(Date.now() / 1000);
    const destroyParams = { public_id: uploadResult.public_id, timestamp: destroyTimestamp, type: "authenticated" };
    await axios.post(`https://api.cloudinary.com/v1_1/${cloudName}/raw/destroy`, new URLSearchParams({ ...destroyParams, api_key: apiKey, signature: signature(destroyParams, apiSecret) }), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    console.log("Cleaned up.");
  } catch (error) {
    console.warn(`Cleanup failed (not fatal, but the test file will linger in Cloudinary): ${error.message}`);
  }
}

main().catch((error) => {
  console.error("Ambassador resource smoke test crashed unexpectedly:", error.message);
  process.exitCode = 1;
});
