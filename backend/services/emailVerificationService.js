const axios = require("axios");
const crypto = require("crypto");
const EmailSuppression = require("../models/EmailSuppression");

const emailable = axios.create({
  baseURL: "https://api.emailable.com/v1",
  timeout: 20000,
});

// Provider-neutral canonical statuses. No paid provider is chosen by
// default — this stays disabled until EMAIL_VERIFICATION_ENABLED and a
// provider key are both set. Emailable is the one wired-in provider today;
// the canonical layer exists so a second provider can be added later
// without changing any caller.
const CANONICAL_STATES = Object.freeze(["independently_verified", "provider_validated", "catch_all_risky", "unverified", "invalid", "unknown"]);

function getApiKey() {
  return String(process.env.EMAILABLE_API_KEY || "").trim();
}

// Status-only signal for the new provider-neutral surfaces (health/status reporting, automated
// outreach gating). Deliberately NOT a new hard requirement on the existing, already-working
// createBatch/getBatch below — those keep their original key-only gate so a workspace already
// using EMAILABLE_API_KEY is never silently broken by this addition.
function isEnabled() {
  return Boolean(getApiKey());
}

function requireApiKey() {
  const key = getApiKey();
  if (!key) {
    const error = new Error("Email verification is not configured");
    error.code = "email_verification_not_configured";
    throw error;
  }
  return key;
}

/**
 * Map a provider-specific verification state to the provider-neutral
 * canonical status. Emailable performs real SMTP-level deliverability
 * checks, so its "deliverable" result is treated as independently verified
 * — never label anything "independently verified" that a provider only
 * infers or extrapolates (see Apollo/PDL, which are provider-validated at
 * best, never independently verified here).
 */
function canonicalStateFor({ provider = "emailable", state, disposable = false } = {}) {
  const normalized = String(state || "unknown").toLowerCase();
  if (provider !== "emailable") return "unknown";
  if (disposable) return "invalid";
  if (normalized === "deliverable") return "independently_verified";
  if (normalized === "undeliverable") return "invalid";
  if (normalized === "risky") return "catch_all_risky";
  if (normalized === "unknown") return "unknown";
  return "unverified";
}

/** Only an independently verified address may enter approved automated email outreach. */
function canAutomatedOutreach(canonicalState) {
  return canonicalState === "independently_verified";
}

async function isSuppressed({ workspaceId, email }, models = { EmailSuppression }) {
  if (!workspaceId || !email) return false;
  const address = String(email).trim().toLowerCase();
  return Boolean(await models.EmailSuppression.findOne({ workspaceId, email: address }).select("_id").lean());
}

/** Hard bounces must be suppressed from all future automated outreach. */
async function suppressHardBounce({ workspaceId, email, bounceType = "", bounceSubType = "", message = "" }, models = { EmailSuppression }) {
  if (!workspaceId || !email) { const error = new Error("workspaceId and email are required"); error.code = "EMAIL_SUPPRESSION_INPUT_REQUIRED"; throw error; }
  const address = String(email).trim().toLowerCase();
  return models.EmailSuppression.findOneAndUpdate(
    { workspaceId, email: address },
    { $setOnInsert: { workspaceId, email: address, reason: "bounce", provider: "emailable", bounceType, bounceSubType, message, suppressedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

function cleanEmails(emails) {
  return [...new Set(
    (Array.isArray(emails) ? emails : [])
      .map((email) => String(email || "").trim().toLowerCase())
      .filter(Boolean),
  )];
}

function fingerprintEmails(emails) {
  return crypto.createHash("sha256").update(cleanEmails(emails).sort().join("\n")).digest("hex");
}

function normalizeVerificationResult(result = {}) {
  const email = String(result.email || "").trim().toLowerCase();
  const state = String(result.state || "unknown").toLowerCase();
  const disposable = Boolean(result.disposable);
  return {
    email,
    state,
    canonicalState: canonicalStateFor({ provider: "emailable", state, disposable }),
    reason: String(result.reason || ""),
    score: Number.isFinite(Number(result.score)) ? Number(result.score) : null,
    didYouMean: String(result.did_you_mean || ""),
    acceptAll: Boolean(result.accept_all),
    disposable,
    role: Boolean(result.role),
    verifiedAt: new Date(),
  };
}

/** An independently-verified result older than this should be re-checked before automated outreach. */
const REVERIFICATION_MAX_AGE_DAYS = 90;
function needsReverification(result, maxAgeDays = REVERIFICATION_MAX_AGE_DAYS) {
  if (!result?.verifiedAt) return true;
  return Date.now() - new Date(result.verifiedAt).getTime() > maxAgeDays * 86400000;
}

function normalizeBatch(data = {}) {
  const results = Array.isArray(data.emails)
    ? data.emails.map(normalizeVerificationResult).filter((item) => item.email)
    : [];
  const processed = Number(data.total_counts?.processed ?? data.processed ?? results.length ?? 0);
  const total = Number(data.total_counts?.total ?? data.total ?? processed ?? 0);
  return {
    id: String(data.id || ""),
    processed,
    total,
    complete: total > 0 && processed >= total,
    counts: data.total_counts || {},
    results,
  };
}

async function createBatch(emails) {
  const cleaned = cleanEmails(emails);
  if (!cleaned.length) throw new Error("At least one email is required");
  if (cleaned.length > 500) throw new Error("A maximum of 500 emails can be verified at once");

  const response = await emailable.post(
    "/batch",
    { emails: cleaned.join(","), retries: true },
    { headers: { Authorization: `Bearer ${requireApiKey()}` } },
  );
  return { id: String(response.data?.id || ""), total: cleaned.length };
}

async function getBatch(id) {
  const response = await emailable.get("/batch", {
    params: { id, partial: true },
    headers: { Authorization: `Bearer ${requireApiKey()}` },
  });
  return normalizeBatch({ ...response.data, id: response.data?.id || id });
}

module.exports = {
  CANONICAL_STATES,
  REVERIFICATION_MAX_AGE_DAYS,
  cleanEmails,
  fingerprintEmails,
  createBatch,
  getBatch,
  getApiKey,
  isEnabled,
  canonicalStateFor,
  canAutomatedOutreach,
  isSuppressed,
  suppressHardBounce,
  needsReverification,
  normalizeBatch,
  normalizeVerificationResult,
};
