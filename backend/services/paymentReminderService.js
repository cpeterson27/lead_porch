const PaymentInstallment = require("../models/PaymentInstallment");
const PaymentPlan = require("../models/PaymentPlan");
const CrmActivity = require("../models/CrmActivity");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

// Confirmed missing entirely (checklist section 4): installments quietly
// flip to "past_due" with nothing telling the client or staff it happened.
// This logs the status change as a CrmActivity carrying the same
// metadata.eventType shape every other trigger in this codebase uses
// (see googleCalendarService's "coaching.session.scheduled" activity), so
// the existing automation engine picks it up and sends the actual email —
// content stays editable from the same Automations screen as every other
// automated message, instead of being hardcoded here.
async function remindOne(installment, { pastDue }) {
  const plan = await PaymentPlan.findOne({ _id: installment.paymentPlanId, workspaceId: installment.workspaceId }).select("contactId installmentCount").lean();
  if (!plan) return null;
  const idempotencyKey = `payment-reminder:${pastDue ? "pastdue" : "upcoming"}:${installment._id}`;
  const existing = await CrmActivity.findOne({ workspaceId: installment.workspaceId, "metadata.idempotencyKey": idempotencyKey }).select("_id").lean();
  if (existing) return false; // already logged/triggered for this installment/kind
  await CrmActivity.create({
    workspaceId: installment.workspaceId,
    contactId: plan.contactId,
    type: "system",
    title: pastDue ? `Payment past due — installment ${installment.installmentNumber} of ${plan.installmentCount}` : `Upcoming payment — installment ${installment.installmentNumber} of ${plan.installmentCount}`,
    source: "crm",
    dueAt: pastDue ? new Date() : null,
    metadata: {
      eventType: pastDue ? "payment.installment.past_due" : "payment.installment.upcoming",
      idempotencyKey,
      paymentPlanId: plan._id,
      paymentInstallmentId: installment._id,
      amountMinor: installment.amountMinor,
      installmentNumber: installment.installmentNumber,
      installmentCount: plan.installmentCount,
      dueAt: installment.dueAt,
    },
  });
  return true;
}

async function runDuePaymentReminders({ upcomingWindowDays = 3 } = {}) {
  const now = new Date();
  const upcomingWindow = new Date(now.getTime() + upcomingWindowDays * 24 * 60 * 60 * 1000);
  // The transition itself, not just the alert about it — previously only
  // ever happened as a side effect of a different, unrelated transaction
  // event landing on the same plan.
  await PaymentInstallment.updateMany({ status: "scheduled", dueAt: { $lt: now } }, { $set: { status: "past_due" } });
  const [upcoming, pastDue] = await Promise.all([
    PaymentInstallment.find({ status: { $in: ["scheduled", "due"] }, dueAt: { $gte: now, $lte: upcomingWindow } }).select("workspaceId paymentPlanId installmentNumber dueAt amountMinor"),
    PaymentInstallment.find({ status: "past_due" }).select("workspaceId paymentPlanId installmentNumber dueAt amountMinor"),
  ]);
  let sent = 0;
  for (const installment of [...upcoming, ...pastDue]) {
    const pastDueFlag = installment.status === "past_due";
    const result = await runWithWorkspace(installment.workspaceId, () => remindOne(installment, { pastDue: pastDueFlag }));
    if (result) sent += 1;
  }
  return { checked: upcoming.length + pastDue.length, sent };
}

let timer = null;
function startPaymentReminderRunner({ force = false } = {}) {
  if (timer || (!force && process.env.COMMUNICATION_WORKER_MODE === "external")) return timer;
  const interval = Math.max(60 * 60000, Number(process.env.PAYMENT_REMINDER_INTERVAL_MS) || 6 * 60 * 60000);
  timer = setInterval(() => runDuePaymentReminders().catch((error) => console.error("Payment reminder runner failed:", error.message)), interval);
  timer.unref?.();
  return timer;
}
function stopPaymentReminderRunner() { if (timer) clearInterval(timer); timer = null; }

module.exports = { runDuePaymentReminders, startPaymentReminderRunner, stopPaymentReminderRunner };
