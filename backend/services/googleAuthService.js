/**
 * Shared server-side Google Cloud authentication for the Vertex AI and
 * Discovery Engine providers. Narrowly scoped: the only OAuth scope
 * requested is cloud-platform, via ONE dedicated service-account key held
 * only in GOOGLE_APPLICATION_CREDENTIALS_JSON (never a file path — this app
 * never writes the key to disk, and it is never sent to the frontend under
 * any circumstance). See the IAM setup walkthrough in .env.example for the
 * minimal roles that key actually needs.
 *
 * google-auth-library caches and refreshes the underlying access token
 * itself; this module only needs to hand back a client/token on request.
 */
const { GoogleAuth } = require("google-auth-library");

let cachedAuth = null;
let cachedCredentialsJson = "";

function credentialsJson() {
  return String(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "").trim();
}

function configured() {
  return Boolean(credentialsJson() && process.env.VERTEX_PROJECT_ID?.trim());
}

/** Re-parses only when the env var actually changes (keeps tests that swap credentials mid-run correct). */
function auth() {
  const json = credentialsJson();
  if (!json) throw Object.assign(new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not configured"), { code: "GOOGLE_CREDENTIALS_MISSING" });
  if (cachedAuth && cachedCredentialsJson === json) return cachedAuth;
  let credentials;
  try {
    credentials = JSON.parse(json);
  } catch {
    throw Object.assign(new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON"), { code: "GOOGLE_CREDENTIALS_INVALID" });
  }
  cachedAuth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  cachedCredentialsJson = json;
  return cachedAuth;
}

async function getAccessToken() {
  const client = await auth().getClient();
  const token = await client.getAccessToken();
  const value = typeof token === "string" ? token : token?.token;
  if (!value) throw Object.assign(new Error("Google Cloud did not return an access token"), { code: "GOOGLE_TOKEN_UNAVAILABLE" });
  return value;
}

/** Test-only: forces the next auth() call to re-parse credentials instead of reusing a cached client. */
function resetCache() {
  cachedAuth = null;
  cachedCredentialsJson = "";
}

module.exports = { configured, getAccessToken, resetCache };
