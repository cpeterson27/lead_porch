/**
 * Every backend test-*.js file MUST connect through this helper instead of
 * calling mongoose.connect(process.env.MONGO_URI) directly. It refuses to
 * connect to anything that looks like the production database, even if
 * TEST_MONGO_URI is missing or misconfigured to point at production.
 *
 * Background: on 2026-09-10, test-jarvis.js and test-jarvis-actions.js's
 * unscoped Organization/OrganizationRelationship/Audience/Contact/
 * MarketingCampaign.deleteMany({}) calls ran directly against production
 * (MONGO_URI IS production; there was no separate test database) and
 * destroyed real customer data for every workspace. This module exists so
 * that mistake becomes structurally impossible to repeat. See also the
 * schema-level guard in tenancy/workspacePlugin.js, which independently
 * refuses any unscoped deleteMany/updateMany regardless of which database
 * a call is aimed at.
 *
 * NOT YET wired into every test-*.js file in this directory — only
 * test-jarvis.js and test-jarvis-actions.js (the two confirmed offenders)
 * use it so far. Migrating every remaining test file to require this
 * helper is a deliberately separate, still-open follow-up.
 */
const mongoose = require("mongoose");

const KNOWN_PRODUCTION_DB_NAMES = ["ellie-ai"];
const KNOWN_PRODUCTION_HOSTS = ["ellie-growth-operator.rmran1u.mongodb.net"];

function hostAndDbOf(uri) {
  if (!uri) return null;
  try {
    const normalized = uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://");
    const parsed = new URL(normalized);
    const db = parsed.pathname.replace(/^\//, "").split("?")[0];
    return { host: parsed.hostname, db };
  } catch {
    return null;
  }
}

function assertSafeTestTarget() {
  const testUri = process.env.TEST_MONGO_URI;
  if (!testUri) {
    throw new Error(
      "TEST_MONGO_URI is not set. Tests must never connect via MONGO_URI (that is the production " +
      "database). Set TEST_MONGO_URI to a separate test database before running any test file.",
    );
  }
  const test = hostAndDbOf(testUri);
  if (!test) throw new Error("TEST_MONGO_URI could not be parsed as a valid MongoDB connection string.");

  const prod = hostAndDbOf(process.env.MONGO_URI);
  if (prod && test.host === prod.host && test.db === prod.db) {
    throw new Error(
      `TEST_MONGO_URI resolves to the SAME host+database as MONGO_URI (${test.host}/${test.db}). ` +
      "Refusing to run tests against what looks like production.",
    );
  }
  if (KNOWN_PRODUCTION_DB_NAMES.includes(test.db) || KNOWN_PRODUCTION_HOSTS.some((host) => test.host.includes(host))) {
    throw new Error(
      `TEST_MONGO_URI (${test.host}/${test.db}) matches a known-production name/host. Refusing to run tests. ` +
      "Update KNOWN_PRODUCTION_DB_NAMES/KNOWN_PRODUCTION_HOSTS here only if this is genuinely a false positive.",
    );
  }
  return test;
}

async function connectTestDatabase() {
  assertSafeTestTarget();
  await mongoose.connect(process.env.TEST_MONGO_URI);
  return mongoose.connection;
}

async function disconnectTestDatabase() {
  await mongoose.disconnect();
}

module.exports = { assertSafeTestTarget, connectTestDatabase, disconnectTestDatabase };
