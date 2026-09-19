const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const SquarePaymentProvider = require("./services/payments/SquarePaymentProvider");
const { createPaymentOAuthState, consumePaymentOAuthState } = require("./services/paymentOAuthService");
const { CAPABILITIES, effectivePermissions } = require("./authorization/capabilities");

async function providerContractChecks() {
  const calls = [];
  const http = {
    async get(url) { calls.push(["get", url]); if (url.endsWith("/merchants/me")) return { data: { merchant: { id: "merchant-review", business_name: "Review Seller" } } }; return { data: { locations: [{ id: "location-1", name: "Main", status: "ACTIVE", capabilities: ["CREDIT_CARD_PROCESSING"] }] } }; },
    async post(url, body) { calls.push(["post", url, body]); if (url.endsWith("/token")) return { data: { access_token: "secret-access", refresh_token: "secret-refresh", merchant_id: "merchant-review" } }; if (url.endsWith("/payment-links")) return { data: { payment_link: { id: "checkout-1", order_id: "order-1", url: "https://square.test/pay" } } }; if (url.endsWith("/refunds")) return { data: { refund: { id: "refund-1", status: "COMPLETED" } } }; return { data: {} }; },
  };
  const provider = new SquarePaymentProvider({ http, appId: "app", appSecret: "secret", redirectUri: "https://api.test/api/payments/square/oauth/callback", environment: "sandbox", version: "2026-08-19", webhookUrl: "https://api.test/api/payments/square/webhook", signatureKey: "signature-key" });
  const auth = new URL(provider.authorizationUrl("signed-state"));
  assert.equal(auth.hostname, "connect.squareupsandbox.com"); assert.equal(auth.searchParams.get("session"), "false"); assert.equal(auth.searchParams.get("state"), "signed-state");
  assert.deepEqual(new Set(auth.searchParams.get("scope").split(" ")), new Set(["MERCHANT_PROFILE_READ", "PAYMENTS_READ", "PAYMENTS_WRITE", "ORDERS_READ", "ORDERS_WRITE"]));
  const token = await provider.exchangeAuthorizationCode("code"); assert.equal(token.access_token, "secret-access");
  const verified = await provider.verifyAuthorization(token.access_token); assert.equal(verified.merchantId, "merchant-review"); assert.equal(verified.locationId, "location-1");
  const checkout = await provider.createHostedCheckout(token.access_token, { idempotencyKey: "key", locationId: "location-1", referenceId: "ref", description: "Program", amountMinor: 170000, currency: "USD", redirectUrl: "https://app.test/payment-complete" }); assert.equal(checkout.url, "https://square.test/pay");
  const raw = JSON.stringify({ event_id: "event-1" }); const signature = crypto.createHmac("sha256", "signature-key").update(`https://api.test/api/payments/square/webhook${raw}`).digest("base64"); assert.equal(provider.verifyWebhookSignature(raw, signature), true); assert.equal(provider.verifyWebhookSignature(raw, "wrong"), false);
  assert(calls.some(([method, url, body]) => method === "post" && url.endsWith("/payment-links") && body.idempotency_key === "key"));
  const refund = await provider.refundPayment(token.access_token, { idempotencyKey: "refund-key", paymentId: "payment-1", amountMinor: 5000, currency: "USD", reason: "Requested" });
  assert.equal(refund.id, "refund-1");
  assert(calls.some(([method, url, body]) => method === "post" && url.endsWith("/refunds") && body.idempotency_key === "refund-key"));
}

async function oauthStateChecks() {
  const previous = process.env.PAYMENT_OAUTH_STATE_SECRET;
  process.env.PAYMENT_OAUTH_STATE_SECRET = "test-only-square-oauth-state-secret";
  let stored = null;
  const deps = {
    PaymentOAuthState: {
      async create(value) { stored = { ...value, consumedAt: null }; },
      async findOneAndUpdate(filter) {
        if (!stored || stored.consumedAt || String(filter.workspaceId) !== String(stored.workspaceId) || String(filter.userId) !== String(stored.userId) || filter.nonceHash !== stored.nonceHash) return null;
        stored.consumedAt = new Date(); return stored;
      },
    },
    WorkspaceMembership: { async findOne(filter) { return filter.status === "active" ? { role: "owner", roles: ["owner"], status: "active", workspaceId: filter.workspaceId, userId: filter.userId } : null; } },
    Workspace: { async findById(id) { return { _id: id }; } },
  };
  try {
    const state = await createPaymentOAuthState({ provider: "square", workspaceId: "workspace-a", userId: "user-a" }, deps);
    const payload = await consumePaymentOAuthState(state, deps);
    assert.equal(payload.workspaceId, "workspace-a"); assert.equal(payload.userId, "user-a");
    await assert.rejects(() => consumePaymentOAuthState(state, deps), error => error.code === "PAYMENT_OAUTH_STATE_REPLAYED");
    await assert.rejects(() => consumePaymentOAuthState(`${state.slice(0, -1)}x`, deps), error => error.code === "PAYMENT_OAUTH_STATE_INVALID");
    const fresh = await createPaymentOAuthState({ provider: "square", workspaceId: "workspace-a", userId: "user-a" }, deps);
    const [freshEncoded] = fresh.split(".");
    const expiredPayload = JSON.parse(Buffer.from(freshEncoded, "base64url").toString("utf8"));
    expiredPayload.exp = Date.now() - 1;
    const expiredEncoded = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
    const expiredSignature = crypto.createHmac("sha256", process.env.PAYMENT_OAUTH_STATE_SECRET).update(expiredEncoded).digest("base64url");
    await assert.rejects(() => consumePaymentOAuthState(`${expiredEncoded}.${expiredSignature}`, deps), error => error.code === "PAYMENT_OAUTH_STATE_EXPIRED");
    const tamperedPayload = { ...expiredPayload, exp: Date.now() + 60000, workspaceId: "workspace-other" };
    const tamperedEncoded = Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url");
    await assert.rejects(() => consumePaymentOAuthState(`${tamperedEncoded}.${expiredSignature}`, deps), error => error.code === "PAYMENT_OAUTH_STATE_INVALID");
    const revokedState = await createPaymentOAuthState({ provider: "square", workspaceId: "workspace-b", userId: "user-b" }, deps);
    deps.WorkspaceMembership.findOne = async () => null;
    await assert.rejects(() => consumePaymentOAuthState(revokedState, deps), error => error.code === "PAYMENT_OAUTH_ACCESS_REVOKED");
  } finally { if (previous === undefined) delete process.env.PAYMENT_OAUTH_STATE_SECRET; else process.env.PAYMENT_OAUTH_STATE_SECRET = previous; }
}

function rbacAndSafetyChecks() {
  assert(CAPABILITIES.includes("payments.view")); assert(CAPABILITIES.includes("payments.manage"));
  assert(effectivePermissions({ role: "owner", roles: ["owner"] }).includes("payments.manage"));
  assert(!effectivePermissions({ role: "coach", roles: ["coach"] }).includes("payments.view"));
  assert(!effectivePermissions({ role: "viewer", roles: ["viewer"] }).includes("payments.manage"));
  const service = fs.readFileSync(path.join(__dirname, "services/paymentService.js"), "utf8");
  // Auto-enrollment on verified payment is unconditional by explicit
  // product decision — it must never again be gated behind a settings
  // flag/toggle. Assert the flag is actually gone, not just that the
  // enrollment call exists (that would pass even with a gate re-added).
  assert(!service.includes("autoEnrollOnVerifiedPayment"), "Auto-enrollment must not be a togglable setting — it always happens on a verified payment");
  assert(service.includes("async function maybeEnroll(transaction) { if (transaction.paymentPlanId || !transaction.contactId || !transaction.coachingProgramId || transaction.enrollmentId) return;"), "maybeEnroll must run unconditionally once past its own data-completeness guards — no settings lookup in between");
  assert(service.includes("PAYMENT_RECURRING_UNSUPPORTED")); assert(service.includes("PAYMENT_KIND_INVALID")); assert(service.includes("PAYMENT_ASSOCIATION_MISMATCH")); assert(service.includes("SQUARE_PAYMENT_AMOUNT_MISMATCH")); assert(service.includes("SQUARE_REFUND_AMOUNT_MISMATCH")); assert(service.includes("PAYMENT_TRANSACTION_NOT_READY")); assert(service.includes('status: "processing"')); assert(service.includes("refund_not_initiated_by_workspace"));
  for (const required of ["PAYMENT_APPLICATION_PROGRAM_MISMATCH", "PAYMENT_PROGRAM_NOT_PUBLISHED", "PAYMENT_REQUEST_ALREADY_EXISTS", "publicAccessTokenHash", "publicPaymentRequest", "beginPublicCheckout", '"payment.status": "paid"', '"paymentSummary.status": "paid"']) assert(service.includes(required), `Missing application payment protection: ${required}`);
  // Instant (no-application) public program checkout: the function must
  // still gate on the program actually being active/published/opted-in and
  // priced, and must never accept card data of its own — it only ever
  // reuses createCheckout's own Square hosted-checkout flow.
  for (const required of ["beginPublicProgramCheckout", '"publicPresentation.status": "published"', '"publicPresentation.instantEnrollEnabled": true', "PAYMENT_PROGRAM_NOT_AVAILABLE", "PAYMENT_PROGRAM_PRICE_MISSING", "PAYMENT_NAME_REQUIRED", "PAYMENT_EMAIL_INVALID"]) assert(service.includes(required), `Missing instant-enrollment protection: ${required}`);
  const routes = fs.readFileSync(path.join(__dirname, "routes/payments.js"), "utf8");
  assert(routes.includes('/applications/:id/payment-request')); assert(routes.includes('/public/:token')); assert(routes.includes('requireCapability("payments.manage")'));
  const publicSiteRoutes = fs.readFileSync(path.join(__dirname, "routes/publicSite.js"), "utf8");
  assert(publicSiteRoutes.includes('/programs/:slug/checkout'), "Instant enrollment needs its own public, unauthenticated checkout route");
  assert(publicSiteRoutes.includes("limited"), "Instant enrollment's public checkout route must be rate-limited like the other public form routes");
  const programModel = fs.readFileSync(path.join(__dirname, "models/CoachingProgram.js"), "utf8");
  assert(programModel.includes("instantEnrollEnabled")); assert(programModel.includes("instantEnrollCtaLabel"));
  const publicManagementRoutes = fs.readFileSync(path.join(__dirname, "routes/publicManagement.js"), "utf8");
  assert(publicManagementRoutes.includes("Set a price for this program before enabling instant enrollment"), "Staff must not be able to turn on instant enrollment for an unpriced program");
  const transactionModel = fs.readFileSync(path.join(__dirname, "models/PaymentTransaction.js"), "utf8"); assert(transactionModel.includes("publicAccessTokenHash")); assert(transactionModel.includes("partialFilterExpression"));
  assert(!/createdBy:\s*\{[^}]*required:\s*true/.test(transactionModel), "createdBy must stay optional — instant public checkouts have no staff user to attribute the transaction to");
  assert(!service.includes("cardNumber")); assert(!service.includes("cvv"));
  const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8"); assert(server.includes('/api/payments/square/webhook')); assert(server.includes('req.path.startsWith("/payments/public/")'));
}

Promise.all([providerContractChecks(), oauthStateChecks()]).then(() => { rbacAndSafetyChecks(); console.log("Square provider, OAuth state/replay, webhook signature, refund, least-privilege RBAC, and hosted-checkout checks passed."); }).catch((error) => { console.error(error); process.exitCode = 1; });
