const crypto = require("crypto");
const PaymentConnection = require("../models/PaymentConnection");
const PaymentTransaction = require("../models/PaymentTransaction");
const PaymentWebhookEvent = require("../models/PaymentWebhookEvent");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const Contact = require("../models/Contact");
const CoachingApplication = require("../models/CoachingApplication");
const CoachingProgram = require("../models/CoachingProgram");
const SalesOpportunity = require("../models/SalesOpportunity");
const PaymentPlan = require("../models/PaymentPlan");
const Enrollment = require("../models/Enrollment");
const CrmActivity = require("../models/CrmActivity");
const { encryptCredentials, decryptCredentials } = require("../utils/credentialEncryption");
const { getPaymentProvider } = require("./payments/providerRegistry");
const coachingDomainService = require("./coachingDomainService");
const paymentPlanService = require("./paymentPlanService");

const safeConnection = (connection) => connection ? { id: connection._id, provider: connection.provider, status: connection.status, merchantName: connection.merchantName, locationName: connection.locationName, scopes: connection.scopes, capabilities: connection.capabilities, tokenExpiresAt: connection.tokenExpiresAt, connectedAt: connection.connectedAt, lastVerifiedAt: connection.lastVerifiedAt, lastErrorCategory: connection.lastErrorCategory } : null;
const normalizeKey = (value) => { const key = String(value || crypto.randomUUID()).trim(); if (!/^[A-Za-z0-9_-]{8,45}$/.test(key)) throw Object.assign(new Error("Idempotency key must be 8-45 letters, numbers, hyphens, or underscores"), { code: "PAYMENT_IDEMPOTENCY_KEY_INVALID" }); return key; };
const credentials = async (workspaceId, provider = "square", { allowExpired = false } = {}) => { const statuses = allowExpired ? ["connected", "attention_required", "expired"] : ["connected", "attention_required"]; const connection = await PaymentConnection.findOne({ workspaceId, provider, status: { $in: statuses } }).select("+credentialsEncrypted"); if (!connection) throw Object.assign(new Error("Connect Square before using payments"), { code: "PAYMENT_CONNECTION_REQUIRED" }); if (!allowExpired && connection.tokenExpiresAt && new Date(connection.tokenExpiresAt) <= new Date()) throw Object.assign(new Error("Square authorization has expired; refresh or reconnect it"), { code: "SQUARE_AUTHORIZATION_EXPIRED" }); return { connection, value: decryptCredentials(connection.credentialsEncrypted) }; };
const dateFrom = (value) => value ? new Date(value) : null;
const publicTokenHash = (value) => crypto.createHash("sha256").update(String(value || "")).digest("hex");
const publicPaymentBase = () => (process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0].trim();

async function connectSquare({ workspaceId, userId, code, provider = getPaymentProvider("square") }) {
  const token = await provider.exchangeAuthorizationCode(code);
  let persisted = false;
  try {
    const verified = await provider.verifyAuthorization(token.access_token);
    if (!verified.merchantId) throw Object.assign(new Error("Square did not return a merchant account"), { code: "SQUARE_MERCHANT_MISSING" });
    const collision = await PaymentConnection.findOne({ provider: "square", externalMerchantId: verified.merchantId, workspaceId: { $ne: workspaceId }, status: { $ne: "disconnected" } });
    if (collision) throw Object.assign(new Error("This Square seller is already connected to another workspace"), { code: "SQUARE_MERCHANT_ALREADY_CONNECTED" });
    const connection = await PaymentConnection.findOneAndUpdate({ workspaceId, provider: "square" }, { $set: { status: "connected", externalMerchantId: verified.merchantId, externalLocationId: verified.locationId, merchantName: verified.merchantName, locationName: verified.locationName, scopes: token.scopes || token.scope?.split(" ") || provider.constructor.DEFAULT_SCOPES || [], capabilities: { location: verified.capabilities }, credentialsEncrypted: encryptCredentials({ accessToken: token.access_token, refreshToken: token.refresh_token }), tokenExpiresAt: dateFrom(token.expires_at), connectedBy: userId, connectedAt: new Date(), lastVerifiedAt: new Date(), disconnectedAt: null, lastErrorCategory: "" } }, { new: true, upsert: true, setDefaultsOnInsert: true });
    persisted = true;
    return safeConnection(connection);
  } catch (error) {
    if (!persisted && token?.access_token) await provider.revokeAuthorization(token.access_token).catch(() => {});
    throw error;
  }
}
async function connectionStatus(workspaceId) { const result = safeConnection(await PaymentConnection.findOne({ workspaceId, provider: "square" })); if (result?.tokenExpiresAt && new Date(result.tokenExpiresAt) <= new Date() && result.status !== "disconnected") result.status = "expired"; return result; }
async function refreshSquare(workspaceId) { const provider = getPaymentProvider("square"); const current = await credentials(workspaceId, "square", { allowExpired: true }); if (!current.value.refreshToken) throw Object.assign(new Error("Reconnect Square to renew authorization"), { code: "SQUARE_RECONNECT_REQUIRED" }); let token; try { token = await provider.refreshAuthorization(current.value.refreshToken); const verified = await provider.verifyAuthorization(token.access_token); if (!verified.merchantId || verified.merchantId !== current.connection.externalMerchantId) throw Object.assign(new Error("Refreshed authorization did not match the connected Square seller"), { code: "SQUARE_MERCHANT_MISMATCH" }); current.connection.credentialsEncrypted = encryptCredentials({ accessToken: token.access_token, refreshToken: token.refresh_token || current.value.refreshToken }); current.connection.tokenExpiresAt = dateFrom(token.expires_at); current.connection.status = "connected"; current.connection.lastVerifiedAt = new Date(); current.connection.externalLocationId = verified.locationId; current.connection.merchantName = verified.merchantName; current.connection.locationName = verified.locationName; current.connection.lastErrorCategory = ""; await current.connection.save(); return safeConnection(current.connection); } catch (error) { if (token?.access_token) await provider.revokeAuthorization(token.access_token).catch(() => {}); current.connection.status = "attention_required"; current.connection.lastErrorCategory = error.code || "square_refresh_failed"; await current.connection.save().catch(() => {}); throw error; } }
async function disconnectSquare(workspaceId) { const provider = getPaymentProvider("square"); const current = await credentials(workspaceId, "square", { allowExpired: true }); await provider.revokeAuthorization(current.value.accessToken); current.connection.status = "disconnected"; current.connection.disconnectedAt = new Date(); current.connection.credentialsEncrypted = encryptCredentials({ revoked: true }); await current.connection.save(); return safeConnection(current.connection); }

async function validateAssociations(workspaceId, input) {
  const query = (Model, id) => id ? Model.findOne({ _id: id, workspaceId }).lean() : null;
  const [contact, application, program, opportunity] = await Promise.all([query(Contact, input.contactId), query(CoachingApplication, input.coachingApplicationId), query(CoachingProgram, input.coachingProgramId), query(SalesOpportunity, input.salesOpportunityId)]);
  if (input.contactId && !contact) throw Object.assign(new Error("Contact does not belong to this workspace"), { code: "PAYMENT_CONTACT_INVALID" });
  if (input.coachingApplicationId && !application) throw Object.assign(new Error("Application does not belong to this workspace"), { code: "PAYMENT_APPLICATION_INVALID" });
  if (input.coachingProgramId && !program) throw Object.assign(new Error("Program does not belong to this workspace"), { code: "PAYMENT_PROGRAM_INVALID" });
  if (input.salesOpportunityId && !opportunity) throw Object.assign(new Error("Opportunity does not belong to this workspace"), { code: "PAYMENT_OPPORTUNITY_INVALID" });
  if (application && !["qualified", "converted"].includes(application.status)) throw Object.assign(new Error("Payment requests require a qualified application"), { code: "PAYMENT_APPLICATION_NOT_ACCEPTED" });
  if (application && (!program || String(application.coachingProgramId || "") !== String(program._id))) throw Object.assign(new Error("Payment program must match the accepted application"), { code: "PAYMENT_APPLICATION_PROGRAM_MISMATCH" });
  if (program && (program.status !== "active" || program.publicPresentation?.status !== "published")) throw Object.assign(new Error("Payment requests require an active published program"), { code: "PAYMENT_PROGRAM_NOT_PUBLISHED" });
  const contactIds = [contact?._id, application?.contactId, opportunity?.primaryContactId].filter(Boolean).map(String);
  if (new Set(contactIds).size > 1) throw Object.assign(new Error("Payment contact, application, and opportunity associations do not match"), { code: "PAYMENT_ASSOCIATION_MISMATCH" });
  const resolvedContactId = contact?._id || application?.contactId || opportunity?.primaryContactId || null;
  return { contactId: resolvedContactId, application, program, opportunity };
}
async function createCheckout({ workspaceId, userId, input }) {
  const kind = input.kind || "full";
  if (kind === "recurring") throw Object.assign(new Error("Recurring Square billing is not enabled for this integration"), { code: "PAYMENT_RECURRING_UNSUPPORTED" });
  if (!["full", "deposit"].includes(kind)) throw Object.assign(new Error("Payment type is not supported"), { code: "PAYMENT_KIND_INVALID" });
  const association = await validateAssociations(workspaceId, input);
  const canonicalProgramAmount = association.program?.defaultPrice?.amount ? Math.round(Number(association.program.defaultPrice.amount) * 100) : null;
  const requestedAmount = Number(input.amountMinor);
  const amountMinor = kind === "full" && canonicalProgramAmount ? canonicalProgramAmount : requestedAmount;
  const totalAmountMinor = canonicalProgramAmount || amountMinor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > 100000000) throw Object.assign(new Error("Amount must be a positive whole number of cents within the supported limit"), { code: "PAYMENT_AMOUNT_INVALID" });
  if (kind === "deposit" && (!canonicalProgramAmount || amountMinor >= canonicalProgramAmount)) throw Object.assign(new Error("A deposit must be less than the program's server-side price"), { code: "PAYMENT_DEPOSIT_INVALID" });
  const current = await credentials(workspaceId); const provider = getPaymentProvider("square");
  const idempotencyKey = normalizeKey(input.idempotencyKey);
  const existing = await PaymentTransaction.findOne({ workspaceId, provider: "square", idempotencyKey });
  if (existing) { const same = existing.kind === kind && existing.amountMinor === amountMinor && String(existing.contactId || "") === String(association.contactId || "") && String(existing.coachingProgramId || "") === String(association.program?._id || "") && String(existing.coachingApplicationId || "") === String(association.application?._id || "") && String(existing.salesOpportunityId || "") === String(association.opportunity?._id || ""); if (!same) throw Object.assign(new Error("Idempotency key was already used for a different payment request"), { code: "PAYMENT_IDEMPOTENCY_CONFLICT" }); return { transaction: existing, publicPaymentUrl: "" }; }
  const duplicatePending = association.application ? await PaymentTransaction.findOne({ workspaceId, coachingApplicationId: association.application._id, status: { $in: ["pending", "requires_action", "paid", "partially_refunded", "refunded"] } }) : null;
  if (duplicatePending) throw Object.assign(new Error("This application already has an active or completed payment request of this type"), { code: "PAYMENT_REQUEST_ALREADY_EXISTS" });
  const publicToken = crypto.randomBytes(32).toString("base64url"), publicAccessExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const publicPaymentUrl = `${publicPaymentBase()}/payment/${publicToken}`;
  const hosted = await provider.createHostedCheckout(current.value.accessToken, { idempotencyKey, locationId: current.connection.externalLocationId, referenceId: idempotencyKey, description: String(input.description || association.program?.name || "Program payment").slice(0, 500), amountMinor, currency: "USD", redirectUrl: `${publicPaymentUrl}?returned=1` });
  if (!hosted?.checkoutId || !hosted?.orderId || !/^https:\/\//i.test(String(hosted?.url || ""))) throw Object.assign(new Error("Square did not return a valid hosted checkout"), { code: "SQUARE_CHECKOUT_RESPONSE_INVALID" });
  let transaction;
  try { transaction = await PaymentTransaction.create({ workspaceId, provider: "square", kind, amountMinor, totalAmountMinor, remainingBalanceMinor: Math.max(totalAmountMinor - amountMinor, 0), currency: "USD", idempotencyKey, externalCheckoutId: hosted.checkoutId, externalOrderId: hosted.orderId, checkoutUrl: hosted.url, publicAccessTokenHash: publicTokenHash(publicToken), publicAccessExpiresAt, contactId: association.contactId, coachingApplicationId: association.application?._id || null, coachingProgramId: association.program?._id || null, salesOpportunityId: association.opportunity?._id || null, description: input.description || association.program?.name || "Program payment", createdBy: userId }); } catch (error) { if (error?.code !== 11000) throw error; transaction = await PaymentTransaction.findOne({ workspaceId, provider: "square", idempotencyKey }); if (!transaction) throw error; const same = transaction.kind === kind && transaction.amountMinor === amountMinor && String(transaction.contactId || "") === String(association.contactId || "") && String(transaction.coachingProgramId || "") === String(association.program?._id || "") && String(transaction.coachingApplicationId || "") === String(association.application?._id || "") && String(transaction.salesOpportunityId || "") === String(association.opportunity?._id || ""); if (!same) throw Object.assign(new Error("Idempotency key was concurrently used for a different payment request"), { code: "PAYMENT_IDEMPOTENCY_CONFLICT" }); }
  if (transaction.contactId) await CrmActivity.create({ workspaceId, contactId: transaction.contactId, type: "system", title: "Payment link created", body: transaction.description, source: "integration", createdBy: userId, metadata: { paymentTransactionId: transaction._id, provider: "square", amountMinor, currency: transaction.currency } });
  if (association.application) await CoachingApplication.updateOne({ _id: association.application._id, workspaceId }, { $set: { status: "qualified", acceptedAt: association.application.acceptedAt || new Date(), acceptedBy: association.application.acceptedBy || userId, payment: { transactionId: transaction._id, status: "pending", kind, amountMinor, requestedAt: new Date(), paidAt: null } } });
  if (transaction.contactId) await Contact.updateOne({ _id: transaction.contactId, workspaceId }, { $set: { "paymentSummary.status": "pending", "paymentSummary.lastTransactionId": transaction._id, "paymentSummary.lastAmountMinor": amountMinor } });
  return { transaction, publicPaymentUrl };
}
async function acceptApplicationAndCreatePaymentRequest({ workspaceId, userId, applicationId, input }) {
  const application = await CoachingApplication.findOne({ _id: applicationId, workspaceId });
  if (!application) throw Object.assign(new Error("Application was not found in this workspace"), { code: "PAYMENT_APPLICATION_INVALID", status: 404 });
  if (["not_fit", "converted"].includes(application.status)) throw Object.assign(new Error("This application cannot receive a new payment request"), { code: "PAYMENT_APPLICATION_STATE_INVALID" });
  if (!application.coachingProgramId) throw Object.assign(new Error("The application must have a selected program"), { code: "PAYMENT_APPLICATION_PROGRAM_REQUIRED" });
  application.status = "qualified"; application.acceptedAt = application.acceptedAt || new Date(); application.acceptedBy = application.acceptedBy || userId; await application.save();
  return createCheckout({ workspaceId, userId, input: { kind: input.kind, amountMinor: input.amountMinor, idempotencyKey: input.idempotencyKey, coachingApplicationId: application._id, coachingProgramId: application.coachingProgramId, contactId: application.contactId, salesOpportunityId: application.salesOpportunityId, description: input.description } });
}
// Lets an anonymous public website visitor pay for and enroll in a program
// immediately, with no staff involvement and no application — the
// alternative path to acceptApplicationAndCreatePaymentRequest above, for
// programs the owner has explicitly opted in to instant checkout. Reuses
// createCheckout for every real payment/idempotency/hosted-checkout rule
// rather than duplicating any of it; the only new work here is resolving
// (or creating) the buyer's Contact record from a name/email a stranger
// just typed in, mirroring publicApplicationService's contact pattern.
async function beginPublicProgramCheckout({ workspaceId, programId, input }) {
  const program = await CoachingProgram.findOne({
    _id: programId,
    workspaceId,
    status: "active",
    "publicPresentation.status": "published",
    "publicPresentation.instantEnrollEnabled": true,
  });
  if (!program) throw Object.assign(new Error("This program is not available for instant enrollment"), { code: "PAYMENT_PROGRAM_NOT_AVAILABLE", status: 404 });
  if (!program.defaultPrice?.amount || Number(program.defaultPrice.amount) <= 0) throw Object.assign(new Error("This program does not have a price set yet"), { code: "PAYMENT_PROGRAM_PRICE_MISSING" });
  const firstName = String(input.firstName || "").trim().slice(0, 120);
  const lastName = String(input.lastName || "").trim().slice(0, 120);
  const normalizedEmail = String(input.email || "").trim().toLowerCase().slice(0, 255);
  if (!firstName || !lastName) throw Object.assign(new Error("First and last name are required"), { code: "PAYMENT_NAME_REQUIRED" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw Object.assign(new Error("A valid email is required"), { code: "PAYMENT_EMAIL_INVALID" });
  let contact = await Contact.findOne({ workspaceId, email: normalizedEmail });
  if (!contact) {
    contact = new Contact({ workspaceId, name: `${firstName} ${lastName}`, firstName, lastName, email: normalizedEmail, type: "lead", status: "active", sources: ["public_checkout"], tags: ["instant-enrollment"] });
  } else {
    contact.firstName = contact.firstName || firstName;
    contact.lastName = contact.lastName || lastName;
    contact.name = contact.name || `${firstName} ${lastName}`;
    contact.sources = [...new Set([...(contact.sources || []), "public_checkout"])];
    contact.tags = [...new Set([...(contact.tags || []), "instant-enrollment"])];
  }
  await contact.save();
  const { publicPaymentUrl } = await createCheckout({
    workspaceId,
    userId: null,
    input: { kind: "full", coachingProgramId: program._id, contactId: contact._id, description: program.publicPresentation?.title || program.name },
  });
  return { publicPaymentUrl };
}
async function publicPaymentRequest(token) {
  const transaction = await PaymentTransaction.findOne({ publicAccessTokenHash: publicTokenHash(token) }).select("+publicAccessTokenHash").populate("coachingProgramId", "name defaultPrice");
  if (!transaction) throw Object.assign(new Error("This payment request is invalid"), { code: "PAYMENT_REQUEST_INVALID", status: 404 });
  if (transaction.status === "pending" && transaction.publicAccessExpiresAt && transaction.publicAccessExpiresAt <= new Date()) { transaction.status = "expired"; await transaction.save(); }
  const config = await WorkspaceConfig.findOne({ workspaceId: transaction.workspaceId, key: "primary" }).lean();
  const connection = await PaymentConnection.findOne({ workspaceId: transaction.workspaceId, provider: "square" }).lean();
  return { programName: transaction.coachingProgramId?.name || transaction.description, amountMinor: transaction.amountMinor, totalAmountMinor: transaction.totalAmountMinor, currency: transaction.currency, paymentType: transaction.kind, status: transaction.status, expiresAt: transaction.publicAccessExpiresAt, businessName: config?.branding?.publicSiteName || config?.workspaceName || config?.legalBusinessName || connection?.merchantName || "Program provider", canContinue: ["pending", "requires_action"].includes(transaction.status) && (!transaction.publicAccessExpiresAt || transaction.publicAccessExpiresAt > new Date()) };
}
async function beginPublicCheckout(token) {
  const transaction = await PaymentTransaction.findOneAndUpdate({ publicAccessTokenHash: publicTokenHash(token), status: { $in: ["pending", "requires_action"] }, publicAccessExpiresAt: { $gt: new Date() } }, { $set: { checkoutStartedAt: new Date(), status: "requires_action" } }, { new: true }).select("+publicAccessTokenHash");
  if (!transaction) { await publicPaymentRequest(token); throw Object.assign(new Error("This payment request can no longer be used"), { code: "PAYMENT_REQUEST_NOT_AVAILABLE", status: 409 }); }
  return { checkoutUrl: transaction.checkoutUrl };
}
async function listTransactions(workspaceId, query = {}) { const filter = { workspaceId }; if (query.status) filter.status = query.status; if (query.contactId) filter.contactId = query.contactId; return PaymentTransaction.find(filter).populate("contactId", "name email").populate("coachingProgramId", "name").sort({ createdAt: -1 }).limit(Math.min(Number(query.limit) || 100, 200)).lean(); }
async function refund({ workspaceId, userId, transactionId, amountMinor, reason, idempotencyKey }) {
  const amount = Number(amountMinor), key = normalizeKey(idempotencyKey), cleanReason = String(reason || "").trim();
  if (!Number.isSafeInteger(amount) || amount < 1) throw Object.assign(new Error("Refund amount must be a positive whole number of cents"), { code: "REFUND_AMOUNT_INVALID" });
  if (!cleanReason) throw Object.assign(new Error("Refund reason is required"), { code: "REFUND_REASON_REQUIRED" });
  const existingTransaction = await PaymentTransaction.findOne({ _id: transactionId, workspaceId });
  if (!existingTransaction || !existingTransaction.externalPaymentId || !["paid", "partially_refunded"].includes(existingTransaction.status)) throw Object.assign(new Error("Only a verified paid transaction can be refunded"), { code: "PAYMENT_NOT_REFUNDABLE" });
  const existingRefund = existingTransaction.refunds.find((item) => item.idempotencyKey === key);
  if (existingRefund) { if (existingRefund.amountMinor !== amount || existingRefund.reason !== cleanReason) throw Object.assign(new Error("Idempotency key was already used for a different refund request"), { code: "PAYMENT_IDEMPOTENCY_CONFLICT" }); return existingTransaction; }
  const reserved = await PaymentTransaction.findOneAndUpdate({
    _id: transactionId, workspaceId, status: { $in: ["paid", "partially_refunded"] }, externalPaymentId: existingTransaction.externalPaymentId,
    "refunds.idempotencyKey": { $ne: key },
    $expr: { $lte: [amount, { $subtract: ["$amountMinor", { $sum: { $map: { input: "$refunds", as: "refund", in: { $cond: [{ $in: ["$$refund.status", ["pending", "completed"]] }, "$$refund.amountMinor", 0] } } } }] }] },
  }, { $push: { refunds: { externalRefundId: "", idempotencyKey: key, amountMinor: amount, status: "pending", reason: cleanReason, initiatedBy: userId, initiatedAt: new Date() } } }, { new: true });
  if (!reserved) {
    const current = await PaymentTransaction.findOne({ _id: transactionId, workspaceId });
    const duplicate = current?.refunds.find((item) => item.idempotencyKey === key);
    if (duplicate) { if (duplicate.amountMinor !== amount || duplicate.reason !== cleanReason) throw Object.assign(new Error("Idempotency key was already used for a different refund request"), { code: "PAYMENT_IDEMPOTENCY_CONFLICT" }); return current; }
    throw Object.assign(new Error("Refund exceeds the remaining refundable balance"), { code: "REFUND_AMOUNT_INVALID" });
  }
  const refundRecord = reserved.refunds.find((item) => item.idempotencyKey === key);
  try {
    const current = await credentials(workspaceId);
    const result = await getPaymentProvider("square").refundPayment(current.value.accessToken, { idempotencyKey: key, paymentId: reserved.externalPaymentId, amountMinor: amount, currency: reserved.currency, reason: cleanReason });
    refundRecord.externalRefundId = result?.id || "";
    refundRecord.status = result?.status === "COMPLETED" ? "completed" : ["FAILED", "REJECTED"].includes(result?.status) ? "failed" : "pending";
    refundRecord.completedAt = result?.status === "COMPLETED" ? new Date() : null;
    reserved.refundedAmountMinor = reserved.refunds.filter((item) => item.status === "completed").reduce((sum, item) => sum + item.amountMinor, 0);
    if (reserved.refundedAmountMinor > 0) reserved.status = reserved.refundedAmountMinor >= reserved.amountMinor ? "refunded" : "partially_refunded";
    if (reserved.status === "refunded") reserved.refundedAt = new Date();
    await reserved.save();
    await paymentPlanService.syncTransaction(reserved);
    if (reserved.coachingApplicationId) await CoachingApplication.updateOne({ _id: reserved.coachingApplicationId, workspaceId }, { $set: { "payment.status": reserved.status } });
    if (reserved.contactId) await Contact.updateOne({ _id: reserved.contactId, workspaceId }, { $set: { "paymentSummary.status": reserved.status } });
    if (reserved.contactId) await CrmActivity.create({ workspaceId, contactId: reserved.contactId, type: "system", title: "Payment refund requested", body: cleanReason, source: "integration", createdBy: userId, metadata: { paymentTransactionId: reserved._id, amountMinor: amount, currency: reserved.currency } });
    return reserved;
  } catch (error) {
    const providerStatus = Number(error?.response?.status || 0);
    if (providerStatus >= 400 && providerStatus < 500 && providerStatus !== 429) refundRecord.status = "failed";
    await reserved.save(); throw error;
  }
}

// Always runs once a Square webhook has genuinely verified a payment —
// there is no settings flag gating this. A verified payment is treated as
// unconditional enrollment intent; nothing less than that (checkout merely
// started, a client-side claim) can ever reach here in the first place.
async function maybeEnroll(transaction) { if (transaction.paymentPlanId || !transaction.contactId || !transaction.coachingProgramId || transaction.enrollmentId) return; const existing = await Enrollment.findOne({ workspaceId: transaction.workspaceId, contactId: transaction.contactId, coachingProgramId: transaction.coachingProgramId, status: { $ne: "cancelled" } }); if (existing) { transaction.enrollmentId = existing._id; await transaction.save(); return; } const enrollment = await coachingDomainService.createEnrollment({ workspaceId: transaction.workspaceId, contactId: transaction.contactId, coachingProgramId: transaction.coachingProgramId, sourceOpportunityId: transaction.salesOpportunityId, status: "pending", createdBy: transaction.createdBy }); transaction.enrollmentId = enrollment._id; await transaction.save(); }
// A paid client moves the CRM automatically instead of relying on staff to
// notice — but "Closed Won" and "Cash Collected" are deliberately kept
// separate: a deal is Won the moment someone commits and pays anything
// (deposit or in full), while Cash Collected keeps accumulating separately
// as a payment plan's later installments come in. Contracted Revenue
// (opportunity.value) is set once, from the plan's full total if this is a
// plan payment or from this transaction's own amount if it's a one-time
// payment — never overwritten afterward, so a partial refund or a later
// installment doesn't silently change what was actually contracted.
async function closeOpportunityWon(transaction) {
  if (!transaction.salesOpportunityId) return;
  const opportunity = await SalesOpportunity.findOne({ _id: transaction.salesOpportunityId, workspaceId: transaction.workspaceId });
  if (!opportunity || opportunity.stageKey === "lost") return;
  if (!opportunity.value) {
    if (transaction.paymentPlanId) {
      const plan = await PaymentPlan.findOne({ _id: transaction.paymentPlanId, workspaceId: transaction.workspaceId }).select("totalAmountMinor");
      opportunity.value = plan ? plan.totalAmountMinor / 100 : transaction.amountMinor / 100;
    } else {
      opportunity.value = transaction.amountMinor / 100;
    }
  }
  opportunity.cashCollected = Math.round(((opportunity.cashCollected || 0) + transaction.amountMinor / 100) * 100) / 100;
  if (opportunity.stageKey !== "won") { opportunity.stageKey = "won"; opportunity.wonAt = transaction.paidAt || new Date(); opportunity.nextAction = "Begin onboarding"; }
  await opportunity.save();
}
async function processSquareWebhook({ rawBody, signature }) {
  const provider = getPaymentProvider("square");
  if (!provider.verifyWebhookSignature(rawBody, signature)) throw Object.assign(new Error("Square webhook signature is invalid"), { code: "SQUARE_WEBHOOK_SIGNATURE_INVALID", status: 401 });
  let payload;
  try { payload = JSON.parse(rawBody); } catch { throw Object.assign(new Error("Square webhook payload is invalid"), { code: "SQUARE_WEBHOOK_PAYLOAD_INVALID" }); }
  const eventId = payload.event_id;
  if (!eventId) throw Object.assign(new Error("Square webhook event ID is missing"), { code: "SQUARE_WEBHOOK_EVENT_INVALID" });
  const digest = crypto.createHash("sha256").update(rawBody).digest("hex");
  const now = new Date();
  let receipt;
  try {
    receipt = await PaymentWebhookEvent.create({ provider: "square", eventId, eventType: payload.type || "unknown", merchantId: payload.merchant_id || "", payloadDigest: digest, status: "processing", processingAt: now });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await PaymentWebhookEvent.findOne({ provider: "square", eventId });
    if (!existing || existing.payloadDigest !== digest) throw Object.assign(new Error("Webhook event ID was reused with a different payload"), { code: "SQUARE_WEBHOOK_EVENT_CONFLICT" });
    if (["processed", "ignored"].includes(existing.status)) return { duplicate: true };
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
    receipt = await PaymentWebhookEvent.findOneAndUpdate({ _id: existing._id, $or: [{ status: "failed" }, { status: "received" }, { status: "processing", processingAt: { $lt: staleBefore } }] }, { $set: { status: "processing", processingAt: now }, $inc: { attempts: 1 } }, { new: true });
    if (!receipt) return { duplicate: true, processing: true };
  }
  const completeReceipt = async (status, category = "") => { receipt.status = status; receipt.errorCategory = category; receipt.processedAt = new Date(); await receipt.save(); };
  try {
    const connection = await PaymentConnection.findOne({ provider: "square", externalMerchantId: payload.merchant_id, status: { $ne: "disconnected" } });
    if (!connection) { await completeReceipt("ignored", "merchant_not_connected"); return { ignored: true }; }
    receipt.workspaceId = connection.workspaceId;
    if (String(payload.type || "").includes("oauth.authorization.revoked")) { connection.status = "disconnected"; connection.disconnectedAt = new Date(); connection.credentialsEncrypted = encryptCredentials({ revoked: true }); await connection.save(); await completeReceipt("processed"); return { processed: true }; }
    const refundEvent = payload.data?.object?.refund;
    if (refundEvent?.id && refundEvent.payment_id) {
      const transaction = await PaymentTransaction.findOne({ workspaceId: connection.workspaceId, externalPaymentId: refundEvent.payment_id });
      if (!transaction) throw Object.assign(new Error("Payment transaction is not available yet"), { code: "PAYMENT_TRANSACTION_NOT_READY", status: 503 });
      const amount = Number(refundEvent.amount_money?.amount);
      let refundRecord = transaction.refunds.find((item) => item.externalRefundId === refundEvent.id);
      if (!refundRecord) { const candidates = transaction.refunds.filter((item) => item.status === "pending" && !item.externalRefundId && item.amountMinor === amount); if (candidates.length === 1) { refundRecord = candidates[0]; refundRecord.externalRefundId = refundEvent.id; } }
      if (!refundRecord) { await completeReceipt("ignored", "refund_not_initiated_by_workspace"); return { ignored: true }; }
      if (amount !== refundRecord.amountMinor || String(refundEvent.amount_money?.currency || transaction.currency).toUpperCase() !== transaction.currency) throw Object.assign(new Error("Square refund amount did not match the reserved refund"), { code: "SQUARE_REFUND_AMOUNT_MISMATCH", status: 409 });
      const incomingAt = dateFrom(refundEvent.updated_at) || new Date();
      if (refundRecord.providerUpdatedAt && incomingAt < refundRecord.providerUpdatedAt) { await completeReceipt("processed"); return { processed: true, stale: true }; }
      const refundStatus = String(refundEvent.status || "").toUpperCase();
      if (refundRecord.status !== "completed" || refundStatus === "COMPLETED") refundRecord.status = refundStatus === "COMPLETED" ? "completed" : ["FAILED", "REJECTED"].includes(refundStatus) ? "failed" : "pending";
      refundRecord.providerUpdatedAt = incomingAt;
      if (refundStatus === "COMPLETED") refundRecord.completedAt = incomingAt;
      transaction.refundedAmountMinor = transaction.refunds.filter((item) => item.status === "completed").reduce((sum, item) => sum + item.amountMinor, 0);
      if (transaction.refundedAmountMinor > 0) transaction.status = transaction.refundedAmountMinor >= transaction.amountMinor ? "refunded" : "partially_refunded";
      if (transaction.status === "refunded") transaction.refundedAt = refundRecord.completedAt || new Date();
      if (!transaction.providerEventIds.includes(eventId)) transaction.providerEventIds.push(eventId);
      await transaction.save();
      await paymentPlanService.syncTransaction(transaction);
      if (transaction.coachingApplicationId) await CoachingApplication.updateOne({ _id: transaction.coachingApplicationId, workspaceId: transaction.workspaceId }, { $set: { "payment.status": transaction.status } });
      if (transaction.contactId) await Contact.updateOne({ _id: transaction.contactId, workspaceId: transaction.workspaceId }, { $set: { "paymentSummary.status": transaction.status } });
      await completeReceipt("processed"); return { processed: true };
    }
    const payment = payload.data?.object?.payment;
    if (!payment?.id) { await completeReceipt("ignored", "event_not_actionable"); return { ignored: true }; }
    const transaction = await PaymentTransaction.findOne({ workspaceId: connection.workspaceId, $or: [{ externalPaymentId: payment.id }, { externalOrderId: payment.order_id }] });
    if (!transaction) throw Object.assign(new Error("Payment transaction is not available yet"), { code: "PAYMENT_TRANSACTION_NOT_READY", status: 503 });
    const paidAmount = Number(payment.amount_money?.amount);
    const paidCurrency = String(payment.amount_money?.currency || "").toUpperCase();
    if (paidAmount !== transaction.amountMinor || paidCurrency !== transaction.currency) throw Object.assign(new Error("Square payment amount did not match the server-created checkout"), { code: "SQUARE_PAYMENT_AMOUNT_MISMATCH", status: 409 });
    const incomingAt = dateFrom(payment.updated_at) || new Date();
    if (transaction.providerUpdatedAt && incomingAt < transaction.providerUpdatedAt) { await completeReceipt("processed"); return { processed: true, stale: true }; }
    const squareStatus = String(payment.status || "").toUpperCase();
    transaction.externalPaymentId = payment.id;
    transaction.providerUpdatedAt = incomingAt;
    if (!transaction.providerEventIds.includes(eventId)) transaction.providerEventIds.push(eventId);
    if (squareStatus === "COMPLETED" && !["paid", "partially_refunded", "refunded"].includes(transaction.status)) { transaction.status = "paid"; transaction.paidAt = dateFrom(payment.created_at) || new Date(); await transaction.save(); await paymentPlanService.syncTransaction(transaction); if (transaction.coachingApplicationId && !transaction.paymentPlanId) await CoachingApplication.updateOne({ _id: transaction.coachingApplicationId, workspaceId: transaction.workspaceId }, { $set: { "payment.status": "paid", "payment.paidAt": transaction.paidAt } }); if (transaction.contactId && !transaction.paymentPlanId) { await Contact.updateOne({ _id: transaction.contactId, workspaceId: transaction.workspaceId }, { $set: { "paymentSummary.status": "paid", "paymentSummary.lastTransactionId": transaction._id, "paymentSummary.lastAmountMinor": transaction.amountMinor, "paymentSummary.lastPaidAt": transaction.paidAt } }); await CrmActivity.create({ workspaceId: transaction.workspaceId, contactId: transaction.contactId, type: "system", title: "Payment verified", body: transaction.description, source: "integration", metadata: { paymentTransactionId: transaction._id, provider: "square", amountMinor: transaction.amountMinor, currency: transaction.currency, webhookEventId: eventId } }); } await maybeEnroll(transaction); await closeOpportunityWon(transaction); }
    else if (["FAILED", "CANCELED"].includes(squareStatus) && !["paid", "partially_refunded", "refunded"].includes(transaction.status)) { transaction.status = squareStatus === "FAILED" ? "failed" : "canceled"; transaction.canceledAt = squareStatus === "CANCELED" ? incomingAt : transaction.canceledAt; await transaction.save(); await paymentPlanService.syncTransaction(transaction); if (transaction.coachingApplicationId && !transaction.paymentPlanId) await CoachingApplication.updateOne({ _id: transaction.coachingApplicationId, workspaceId: transaction.workspaceId }, { $set: { "payment.status": transaction.status } }); if (transaction.contactId && !transaction.paymentPlanId) await Contact.updateOne({ _id: transaction.contactId, workspaceId: transaction.workspaceId }, { $set: { "paymentSummary.status": transaction.status } }); }
    else await transaction.save();
    await completeReceipt("processed"); return { processed: true };
  } catch (error) { receipt.status = "failed"; receipt.errorCategory = error.code || "processing_failed"; await receipt.save(); throw error; }
}
module.exports = { acceptApplicationAndCreatePaymentRequest, beginPublicCheckout, beginPublicProgramCheckout, connectSquare, connectionStatus, createCheckout, disconnectSquare, listTransactions, processSquareWebhook, publicPaymentRequest, refreshSquare, refund, safeConnection, validateAssociations };
