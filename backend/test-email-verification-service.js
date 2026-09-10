const assert = require("assert");
const {
  cleanEmails,
  normalizeBatch,
  normalizeVerificationResult,
} = require("./services/emailVerificationService");

assert.deepStrictEqual(
  cleanEmails([" Test@Example.com ", "test@example.com", "", null]),
  ["test@example.com"],
);

const normalized = normalizeVerificationResult({
  email: "PERSON@EXAMPLE.COM",
  state: "deliverable",
  score: "0.98",
  accept_all: false,
});
assert.deepStrictEqual(
  { email: normalized.email, state: normalized.state, reason: normalized.reason, score: normalized.score, didYouMean: normalized.didYouMean, acceptAll: normalized.acceptAll, disposable: normalized.disposable, role: normalized.role },
  {
    email: "person@example.com",
    state: "deliverable",
    reason: "",
    score: 0.98,
    didYouMean: "",
    acceptAll: false,
    disposable: false,
    role: false,
  },
);
// Provider-neutral canonical layer: a real Emailable "deliverable" result is independently verified.
assert.strictEqual(normalized.canonicalState, "independently_verified");
assert.ok(normalized.verifiedAt instanceof Date);

const partial = normalizeBatch({
  id: "batch-1",
  processed: 1,
  total: 2,
  emails: [{ email: "one@example.com", state: "risky", reason: "accept_all" }],
});
assert.strictEqual(partial.complete, false);
assert.strictEqual(partial.results[0].state, "risky");

const complete = normalizeBatch({
  id: "batch-1",
  processed: 2,
  total: 2,
  emails: [
    { email: "one@example.com", state: "risky" },
    { email: "two@example.com", state: "deliverable" },
  ],
});
assert.strictEqual(complete.complete, true);
assert.strictEqual(complete.results.length, 2);

console.log("Email verification service tests passed");
