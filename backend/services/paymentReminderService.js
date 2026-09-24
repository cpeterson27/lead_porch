const PaymentInstallment = require("../models/PaymentInstallment");
const PaymentPlan = require("../models/PaymentPlan");
const CrmActivity = require("../models/CrmActivity");
const { scheduleDirectCommunication } = require("./coachingCommunicationService");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

// Confirmed missing entirely (checklist section 4): installments quietly
// flip to "past_due" with nothing telling the client or staff it happened.
// This closes that gap with the same job-based send pipeline every other
// automated message already uses — no new sending code, just new triggers
// for it, plus the status transition itself (previously only ever run as
// a side effect inside syncTransaction, so a plan with no new activity
// could sit overdue indefinitely without ever actually being marked so).
const money = (minor) => `$${(Number(minor || 0) / 100).toFixed(2)}`;

async function remindOne(installment, { pastDue }) {
  const plan = await PaymentPlan.findOne({ _id: installment.paymentPlanId, workspaceId: installment.workspaceId }).select("contactId coachingProgramId installmentCount").lean();
  if (!plan) return null;
  const idempotencyKey = `payment-reminder:${pastDue ? "pastdue" : "upcoming"}:${installment._id}`;
  const subject = pastDue
    ? `Payment past due — installment ${installment.installmentNumber} of ${plan.installmentCount}`
    : `Upcoming payment — installment ${installment.installmentNumber} of ${plan.installmentCount}`;
  const body = pastDue
    ? `Hi {{contact.firstName}}, installment ${installment.installmentNumber} of ${plan.installmentCount} (${money(installment.amountMinor)}) was due on ${new Date(installment.dueAt).toLocaleDateString()} and hasn't gone through yet. Please update your payment to keep your program on track.`
    : `Hi {{contact.firstName}}, a reminder that installment ${installment.installmentNumber} of ${plan.installmentCount} (${money(installment.amountMinor)}) is due on ${new Date(installment.dueAt).toLocaleDateString()}.`;
  try {
    await scheduleDirectCommunication({
      workspaceId: installment.workspaceId,
      contactId: plan.contactId,
      channel: "email",
      purpose: "transactional",
      scheduledFor: new Date(),
      subject,
      body,
      idempotencyKey,
      metadata: { kind: "payment_reminder", paymentPlanId: String(plan._id), paymentInstallmentId: String(installment._id), pastDue },
    });
    if (pastDue) await CrmActivity.create({ workspaceId: installment.workspaceId, contactId: plan.contactId, type: "system", title: "Payment past due — client and team alerted", source: "crm", metadata: { eventType: "payment.installment.past_due", paymentPlanId: plan._id, paymentInstallmentId: installment._id, amountMinor: installment.amountMinor }, dueAt: new Date() });
    return true;
  } catch (error) {
    if (error.code === 11000) return false; // already reminded for this installment/kind
    throw error;
  }
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
