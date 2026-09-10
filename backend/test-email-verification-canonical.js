// Regression coverage for the provider-neutral email-verification layer added on top of the
// existing, working Emailable integration: canonical status mapping, the independently-verified
// gate for automated outreach, suppression, and reverification — all without a default paid
// provider and with zero real network calls.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const service = require("./services/emailVerificationService");
const EmailSuppression = require("./models/EmailSuppression");

const originalFlag = process.env.EMAIL_VERIFICATION_ENABLED;
const originalKey = process.env.EMAILABLE_API_KEY;

function testCanonicalStates() {
  assert.equal(service.canonicalStateFor({ provider: "emailable", state: "deliverable" }), "independently_verified", "a real SMTP-verified deliverable address is independently verified");
  assert.equal(service.canonicalStateFor({ provider: "emailable", state: "undeliverable" }), "invalid");
  assert.equal(service.canonicalStateFor({ provider: "emailable", state: "risky" }), "catch_all_risky");
  assert.equal(service.canonicalStateFor({ provider: "emailable", state: "unknown" }), "unknown");
  assert.equal(service.canonicalStateFor({ provider: "emailable", state: "deliverable", disposable: true }), "invalid", "a disposable address must never be treated as independently verified even if deliverable");
  assert.equal(service.canonicalStateFor({ provider: "some_other_provider", state: "deliverable" }), "unknown", "an unrecognized provider must never be assumed independently verified");
}

function testAutomatedOutreachGate() {
  assert.equal(service.canAutomatedOutreach("independently_verified"), true);
  for (const state of ["provider_validated", "catch_all_risky", "unverified", "invalid", "unknown"]) {
    assert.equal(service.canAutomatedOutreach(state), false, `${state} must never be allowed into approved automated outreach`);
  }
}

async function testNoDefaultProviderChosen() {
  delete process.env.EMAIL_VERIFICATION_ENABLED;
  delete process.env.EMAILABLE_API_KEY;
  assert.equal(service.isEnabled(), false, "email verification must stay disabled with no provider chosen by default");
  await assert.rejects(() => service.createBatch(["a@b.com"]), /not configured/);
}

function testNormalizeIncludesCanonicalStateAndTimestamp() {
  const normalized = service.normalizeVerificationResult({ email: "Jane@Example.com", state: "deliverable", score: 0.98 });
  assert.equal(normalized.email, "jane@example.com");
  assert.equal(normalized.canonicalState, "independently_verified");
  assert.ok(normalized.verifiedAt instanceof Date);
}

function testReverification() {
  assert.equal(service.needsReverification(null), true);
  assert.equal(service.needsReverification({ verifiedAt: new Date() }), false);
  assert.equal(service.needsReverification({ verifiedAt: new Date(Date.now() - 200 * 86400000) }), true, "a result older than the reverification window must be flagged");
}

async function testSuppressionRoundTrip(workspaceId) {
  assert.equal(await service.isSuppressed({ workspaceId, email: "notyet@example.com" }), false);
  await service.suppressHardBounce({ workspaceId, email: "Bounced@Example.com", bounceType: "hard", message: "mailbox does not exist" });
  assert.equal(await service.isSuppressed({ workspaceId, email: "bounced@example.com" }), true, "suppression must be checked case-insensitively");
  // Idempotent: suppressing the same address twice must not create a duplicate record.
  await service.suppressHardBounce({ workspaceId, email: "bounced@example.com", bounceType: "hard" });
  const count = await EmailSuppression.countDocuments({ workspaceId, email: "bounced@example.com" });
  assert.equal(count, 1);
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  try {
    testCanonicalStates();
    testAutomatedOutreachGate();
    await testNoDefaultProviderChosen();
    testNormalizeIncludesCanonicalStateAndTimestamp();
    testReverification();
    await testSuppressionRoundTrip(workspaceId);
  } finally {
    await EmailSuppression.deleteMany({ workspaceId });
    if (originalFlag === undefined) delete process.env.EMAIL_VERIFICATION_ENABLED; else process.env.EMAIL_VERIFICATION_ENABLED = originalFlag;
    if (originalKey === undefined) delete process.env.EMAILABLE_API_KEY; else process.env.EMAILABLE_API_KEY = originalKey;
    await mongoose.disconnect();
  }
}

run()
  .then(() => console.log("Provider-neutral email verification: canonical status mapping, automated-outreach gating, no-default-provider safety, and suppression round-trip all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
