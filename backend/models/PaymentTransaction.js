const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const refundSchema = new mongoose.Schema({
  externalRefundId: { type: String, default: "" },
  idempotencyKey: { type: String, required: true, maxlength: 45 },
  amountMinor: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ["pending", "completed", "failed", "rejected"], default: "pending" },
  reason: { type: String, required: true, maxlength: 500 },
  initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  initiatedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  providerUpdatedAt: { type: Date, default: null },
}, { _id: false });

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  provider: { type: String, enum: ["square"], default: "square", required: true },
  kind: { type: String, enum: ["full", "deposit", "installment", "recurring"], default: "full" },
  status: { type: String, enum: ["pending", "requires_action", "paid", "partially_refunded", "refunded", "failed", "canceled", "expired", "disputed"], default: "pending", index: true },
  amountMinor: { type: Number, required: true, min: 1 },
  totalAmountMinor: { type: Number, required: true, min: 1 },
  remainingBalanceMinor: { type: Number, required: true, min: 0 },
  currency: { type: String, default: "USD", uppercase: true, maxlength: 3 },
  refundedAmountMinor: { type: Number, default: 0, min: 0 },
  idempotencyKey: { type: String, required: true, maxlength: 45 },
  externalCheckoutId: { type: String, default: "" },
  externalOrderId: { type: String, default: "" },
  externalPaymentId: { type: String, default: "" },
  checkoutUrl: { type: String, default: "", maxlength: 2000 },
  publicAccessTokenHash: { type: String, default: "", select: false },
  publicAccessExpiresAt: { type: Date, default: null, index: true },
  checkoutStartedAt: { type: Date, default: null },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", default: null, index: true },
  coachingApplicationId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachingApplication", default: null },
  coachingProgramId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachingProgram", default: null },
  paymentPlanId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentPlan", default: null, index: true },
  paymentInstallmentId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentInstallment", default: null, index: true },
  salesOpportunityId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesOpportunity", default: null },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Enrollment", default: null },
  description: { type: String, default: "", maxlength: 500 },
  // null means the checkout was self-served by a public website visitor
  // (instant enrollment) rather than created by a staff member.
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  paidAt: { type: Date, default: null },
  canceledAt: { type: Date, default: null },
  refundedAt: { type: Date, default: null },
  providerUpdatedAt: { type: Date, default: null },
  providerEventIds: { type: [String], default: [] },
  refunds: { type: [refundSchema], default: [] },
}, { timestamps: true, collection: "payment_transactions" });

schema.index({ workspaceId: 1, provider: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ provider: 1, externalCheckoutId: 1 }, { unique: true, partialFilterExpression: { externalCheckoutId: { $type: "string", $gt: "" } } });
schema.index({ provider: 1, externalPaymentId: 1 }, { unique: true, partialFilterExpression: { externalPaymentId: { $type: "string", $gt: "" } } });
schema.index({ publicAccessTokenHash: 1 }, { unique: true, partialFilterExpression: { publicAccessTokenHash: { $type: "string", $gt: "" } } });
schema.index({ workspaceId: 1, createdAt: -1 });
schema.index({ workspaceId: 1, paymentInstallmentId: 1 }, { unique: true, name: "workspace_payment_installment_transaction", partialFilterExpression: { paymentInstallmentId: { $type: "objectId" } } });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("PaymentTransaction", schema);
