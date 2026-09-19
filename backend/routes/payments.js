const express = require("express");
const { requireCapability } = require("../middleware/auth");
const { createPaymentOAuthState, consumePaymentOAuthState } = require("../services/paymentOAuthService");
const paymentService = require("../services/paymentService");
const paymentPlanService = require("../services/paymentPlanService");
const { getPaymentProvider } = require("../services/payments/providerRegistry");

const router = express.Router();
const frontend = () => (process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0].trim();
const sendError = (res, error, fallback, status = 400) => res.status(error.status || status).json({ error: error.message || fallback, code: error.code || "PAYMENT_REQUEST_FAILED" });

router.get("/square/oauth/callback", async (req, res) => {
  const destination = new URL("/settings/payments", frontend());
  try {
    if (req.query.error) { if (!req.query.state) throw Object.assign(new Error("Square cancellation response is missing OAuth state"), { code: "SQUARE_CALLBACK_INVALID" }); const state = await consumePaymentOAuthState(req.query.state); if (state.provider !== "square") throw Object.assign(new Error("Payment provider does not match OAuth state"), { code: "PAYMENT_OAUTH_PROVIDER_MISMATCH" }); destination.searchParams.set("square", "cancelled"); return res.redirect(destination.toString()); }
    if (!req.query.code || !req.query.state) throw Object.assign(new Error("Square authorization response is incomplete"), { code: "SQUARE_CALLBACK_INVALID" });
    const state = await consumePaymentOAuthState(req.query.state);
    if (state.provider !== "square") throw Object.assign(new Error("Payment provider does not match OAuth state"), { code: "PAYMENT_OAUTH_PROVIDER_MISMATCH" });
    await paymentService.connectSquare({ workspaceId: state.workspaceId, userId: state.userId, code: req.query.code });
    destination.searchParams.set("square", "connected");
  } catch (error) {
    console.error("Square OAuth callback failed", { category: error.code || "square_callback_failed" });
    destination.searchParams.set("square", "failed");
    destination.searchParams.set("reason", error.code || "SQUARE_CONNECTION_FAILED");
  }
  return res.redirect(destination.toString());
});

router.post("/square/webhook", async (req, res) => {
  try { await paymentService.processSquareWebhook({ rawBody: req.rawBody, signature: req.get("x-square-hmacsha256-signature") }); return res.sendStatus(200); }
  catch (error) { console.error("Square webhook rejected", { category: error.code || "square_webhook_failed" }); return res.status(error.status || 400).json({ error: "Webhook could not be accepted", code: error.code || "SQUARE_WEBHOOK_FAILED" }); }
});
router.get("/public/:token", async (req, res) => { try { res.json({ request: await paymentService.publicPaymentRequest(req.params.token) }); } catch (error) { sendError(res, error, "Payment request could not be loaded", 404); } });
router.post("/public/:token/checkout", async (req, res) => { try { res.json(await paymentService.beginPublicCheckout(req.params.token)); } catch (error) { sendError(res, error, "Payment request could not be continued", 409); } });
router.get("/plans/public/:token", async (req, res) => { try { res.json({ plan: await paymentPlanService.publicPlan(req.params.token) }); } catch (error) { sendError(res, error, "Payment plan could not be loaded", 404); } });
router.post("/plans/public/:token/installments/:number/checkout", async (req, res) => { try { res.json(await paymentPlanService.beginInstallmentCheckout(req.params.token, req.params.number)); } catch (error) { sendError(res, error, "Installment checkout could not be opened", 409); } });

router.get("/connection", requireCapability("payments.view", "payments.manage"), async (req, res) => { try { res.json({ connection: await paymentService.connectionStatus(req.auth.workspaceId) }); } catch (error) { sendError(res, error, "Payment connection could not be loaded", 500); } });
router.get("/square/oauth/start", requireCapability("payments.manage"), async (req, res) => { try { const state = await createPaymentOAuthState({ provider: "square", workspaceId: req.auth.workspaceId, userId: req.auth.user._id }); res.json({ authorizationUrl: getPaymentProvider("square").authorizationUrl(state) }); } catch (error) { sendError(res, error, "Square authorization could not be started"); } });
router.post("/square/refresh", requireCapability("payments.manage"), async (req, res) => { try { res.json({ connection: await paymentService.refreshSquare(req.auth.workspaceId) }); } catch (error) { sendError(res, error, "Square authorization could not be refreshed"); } });
router.post("/square/disconnect", requireCapability("payments.manage"), async (req, res) => { try { res.json({ connection: await paymentService.disconnectSquare(req.auth.workspaceId) }); } catch (error) { sendError(res, error, "Square could not be disconnected"); } });
router.get("/transactions", requireCapability("payments.view", "payments.manage"), async (req, res) => { try { res.json({ transactions: await paymentService.listTransactions(req.auth.workspaceId, req.query) }); } catch (error) { sendError(res, error, "Payments could not be loaded", 500); } });
router.post("/checkout", requireCapability("payments.manage"), async (req, res) => { try { const result = await paymentService.createCheckout({ workspaceId: req.auth.workspaceId, userId: req.auth.user._id, input: { ...(req.body || {}), idempotencyKey: req.get("idempotency-key") || req.body?.idempotencyKey } }); res.status(201).json(result); } catch (error) { sendError(res, error, "Payment link could not be created"); } });
router.post("/applications/:id/payment-request", requireCapability("payments.manage"), async (req, res) => { try { const result = await paymentService.acceptApplicationAndCreatePaymentRequest({ workspaceId: req.auth.workspaceId, userId: req.auth.user._id, applicationId: req.params.id, input: { ...(req.body || {}), idempotencyKey: req.get("idempotency-key") || req.body?.idempotencyKey } }); res.status(201).json(result); } catch (error) { sendError(res, error, "Application payment request could not be created"); } });
router.get("/plans", requireCapability("payments.view", "payments.manage"), async (req, res) => { try { res.json({ plans: await paymentPlanService.listPlans(req.auth.workspaceId) }); } catch (error) { sendError(res, error, "Payment plans could not be loaded", 500); } });
router.post("/applications/:id/payment-plan", requireCapability("payments.manage"), async (req, res) => { try { res.status(201).json(await paymentPlanService.createPlan({ workspaceId: req.auth.workspaceId, userId: req.auth.user._id, applicationId: req.params.id, input: req.body || {} })); } catch (error) { sendError(res, error, "Payment plan could not be created"); } });
router.patch("/plans/:id/installments", requireCapability("payments.manage"), async (req, res) => { try { res.json({ plan: await paymentPlanService.updateInstallments({ workspaceId: req.auth.workspaceId, planId: req.params.id, installments: req.body?.installments }) }); } catch (error) { sendError(res, error, "Payment plan could not be updated"); } });
router.post("/plans/:id/cancel", requireCapability("payments.manage"), async (req, res) => { try { res.json({ plan: await paymentPlanService.cancelPlan({ workspaceId: req.auth.workspaceId, planId: req.params.id, userId: req.auth.user._id }) }); } catch (error) { sendError(res, error, "Payment plan could not be canceled"); } });
router.get("/plans/:id/share-link", requireCapability("payments.manage"), async (req, res) => { try { res.json({ publicPaymentPlanUrl: await paymentPlanService.planShareLink(req.auth.workspaceId, req.params.id) }); } catch (error) { sendError(res, error, "Payment plan link could not be loaded", 404); } });
router.post("/transactions/:id/refunds", requireCapability("payments.manage"), async (req, res) => { try { const transaction = await paymentService.refund({ workspaceId: req.auth.workspaceId, userId: req.auth.user._id, transactionId: req.params.id, amountMinor: req.body?.amountMinor, reason: req.body?.reason, idempotencyKey: req.get("idempotency-key") || req.body?.idempotencyKey }); res.json({ transaction }); } catch (error) { sendError(res, error, "Refund could not be submitted"); } });

module.exports = router;
