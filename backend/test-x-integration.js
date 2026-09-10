// Regression coverage for the X (Twitter) integration: OAuth PKCE, publishing, and deletion
// already existed in this codebase (verified by inspection) but had no explicit feature-flag gate
// and no deletion support. This adds both and confirms X makes zero real requests while disabled.
require("dotenv").config();
const assert = require("node:assert/strict");
const oauth = require("./services/socialOAuthService");
const publishing = require("./services/socialPublishingService");
const { encryptCredentials } = require("./utils/credentialEncryption");

const ENV_KEYS = ["X_ENABLED", "X_CLIENT_ID", "X_CLIENT_SECRET", "X_REDIRECT_URI", "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY"];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

function testDisabledByDefault() {
  delete process.env.X_ENABLED;
  process.env.X_CLIENT_ID = "x-app";
  process.env.X_CLIENT_SECRET = "fixture";
  process.env.X_REDIRECT_URI = "https://example.test/callback";
  assert.throws(() => oauth.authorizationUrl("x", { workspaceId: "w1", user: { _id: "u1" } }), /X is not enabled/, "X must stay disabled even with real-looking credentials until X_ENABLED=true");
}

function testEnabledButMissingCredentialsStillFails() {
  process.env.X_ENABLED = "true";
  delete process.env.X_CLIENT_ID;
  delete process.env.X_CLIENT_SECRET;
  delete process.env.X_REDIRECT_URI;
  assert.throws(() => oauth.authorizationUrl("x", { workspaceId: "w1", user: { _id: "u1" } }), /X_CLIENT_ID is not configured/);
}

function testFullyConfiguredGeneratesRealPkceUrl() {
  process.env.X_ENABLED = "true";
  process.env.X_CLIENT_ID = "x-app";
  process.env.X_CLIENT_SECRET = "fixture";
  process.env.X_REDIRECT_URI = "https://example.test/callback";
  const url = new URL(oauth.authorizationUrl("x", { workspaceId: "w1", user: { _id: "u1" } }));
  assert.equal(url.hostname, "x.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(url.searchParams.get("client_id"), "x-app");
}

async function testDeletionSuccess() {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = require("crypto").randomBytes(32).toString("base64");
  let deleteCalled = false;
  const item = {
    social: { publications: [{ provider: "x", providerPostId: "12345", assetId: "user1", status: "published" }] },
    save: async () => {},
  };
  const models = {
    SocialConnection: { findOne: () => ({ select: async () => ({ provider: "x", credentialsEncrypted: encryptCredentials({ accessToken: "real-token" }) }) }) },
    http: { delete: async (url, config) => { deleteCalled = true; assert.equal(url, "https://api.x.com/2/tweets/12345"); assert.equal(config.headers.Authorization, "Bearer real-token"); return { data: { data: { deleted: true } } }; } },
  };
  const result = await publishing.deletePublished({ workspaceId: "w1", item }, models);
  assert.equal(deleteCalled, true);
  assert.deepEqual(result.deleted, ["x"]);
  assert.equal(item.social.publications[0].status, "deleted");
}

async function testDeletionAlreadyGoneIsNonBlocking() {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = require("crypto").randomBytes(32).toString("base64");
  const item = { social: { publications: [{ provider: "x", providerPostId: "already-gone", assetId: "user1", status: "published" }] }, save: async () => {} };
  const models = {
    SocialConnection: { findOne: () => ({ select: async () => ({ provider: "x", credentialsEncrypted: encryptCredentials({ accessToken: "real-token" }) }) }) },
    http: { delete: async () => { const error = new Error("Not Found"); error.response = { status: 404 }; throw error; } },
  };
  const result = await publishing.deletePublished({ workspaceId: "w1", item }, models);
  assert.deepEqual(result.deleted, ["x"], "an already-deleted X post must not block the Lead Porch record");
}

async function run() {
  try {
    testDisabledByDefault();
    testEnabledButMissingCredentialsStillFails();
    testFullyConfiguredGeneratesRealPkceUrl();
    await testDeletionSuccess();
    await testDeletionAlreadyGoneIsNonBlocking();
  } finally {
    restoreEnv();
  }
}

run()
  .then(() => console.log("X integration: disabled-by-default gating, PKCE authorization URL generation, and deletion (success + already-gone) all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
