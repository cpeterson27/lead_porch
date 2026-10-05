/**
 * Timed, multi-step email nurture sequences — the email equivalent of
 * services/linkedinSequenceService.js's LinkedIn sequences, and built to the
 * same lease-based polling pattern services/researchMonitorService.js
 * already uses for its own due-item runner. Each step sends as a real
 * Outreach record under the sequence's own campaignId, so it inherits that
 * campaign's sender identity, compliance footer, and suppression/
 * unsubscribe handling from services/email.js exactly as a one-shot
 * campaign send does — no email logic is reimplemented here.
 */
const EmailSequence = require("../models/EmailSequence");
const EmailSequenceEnrollment = require("../models/EmailSequenceEnrollment");
const Campaign = require("../models/Campaign");
const Contact = require("../models/Contact");
const Outreach = require("../models/Outreach");
const { sendEmail } = require("./email");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

const RUNNER_INTERVAL_MS = Math.max(15000, Number(process.env.EMAIL_SEQUENCE_WORKER_POLL_MS) || 60000);
const LEASE_MS = 5 * 60000;
const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let timer = null;
let polling = false;

function applyTokens(text, contact) {
  const firstName = String(contact?.firstName || contact?.name || "").trim().split(/\s+/)[0] || "there";
  const lastName = String(contact?.lastName || "").trim();
  const company = String(contact?.company || "").trim();
  return String(text || "")
    .replaceAll("{{firstName}}", firstName)
    .replaceAll("{{lastName}}", lastName)
    .replaceAll("{{company}}", company);
}

async function listSequences(workspaceId) {
  const sequences = await EmailSequence.find({ workspaceId }).sort({ createdAt: -1 }).lean();
  const counts = await EmailSequenceEnrollment.aggregate([
    { $match: { workspaceId } },
    { $group: { _id: { sequenceId: "$sequenceId", status: "$status" }, count: { $sum: 1 } } },
  ]);
  const countsBySequence = new Map();
  for (const row of counts) {
    const key = String(row._id.sequenceId);
    const target = countsBySequence.get(key) || {};
    target[row._id.status] = row.count;
    countsBySequence.set(key, target);
  }
  return sequences.map((sequence) => ({ ...sequence, enrollmentCounts: countsBySequence.get(String(sequence._id)) || {} }));
}

async function getSequence(workspaceId, sequenceId) {
  const sequence = await EmailSequence.findOne({ _id: sequenceId, workspaceId }).lean();
  if (!sequence) { const error = new Error("Sequence not found"); error.code = "EMAIL_SEQUENCE_NOT_FOUND"; throw error; }
  return sequence;
}

async function createSequence({ workspaceId, userId, name, description, campaignId, steps, stopOnReply }) {
  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId }).select("_id").lean();
  if (!campaign) { const error = new Error("Choose a real campaign for this sequence to send under"); error.code = "EMAIL_SEQUENCE_CAMPAIGN_REQUIRED"; throw error; }
  if (!Array.isArray(steps) || !steps.length) { const error = new Error("A sequence needs at least one step"); error.code = "EMAIL_SEQUENCE_STEP_REQUIRED"; throw error; }
  return EmailSequence.create({
    workspaceId, name: String(name || "").trim().slice(0, 180), description: String(description || "").slice(0, 2000),
    campaignId, stopOnReply: stopOnReply !== false,
    steps: steps.map((step) => ({ subject: String(step.subject || "").trim().slice(0, 300), body: String(step.body || "").slice(0, 20000), delayDays: Math.max(0, Math.min(365, Number(step.delayDays) || 0)) })),
    createdBy: userId, updatedBy: userId,
  });
}

async function updateSequence({ workspaceId, userId, sequenceId, name, description, status, steps, stopOnReply }) {
  const sequence = await EmailSequence.findOne({ _id: sequenceId, workspaceId });
  if (!sequence) { const error = new Error("Sequence not found"); error.code = "EMAIL_SEQUENCE_NOT_FOUND"; throw error; }
  if (name !== undefined) sequence.name = String(name).trim().slice(0, 180);
  if (description !== undefined) sequence.description = String(description).slice(0, 2000);
  if (status !== undefined) sequence.status = status;
  if (stopOnReply !== undefined) sequence.stopOnReply = Boolean(stopOnReply);
  if (steps !== undefined) {
    if (!Array.isArray(steps) || !steps.length) { const error = new Error("A sequence needs at least one step"); error.code = "EMAIL_SEQUENCE_STEP_REQUIRED"; throw error; }
    sequence.steps = steps.map((step) => ({ subject: String(step.subject || "").trim().slice(0, 300), body: String(step.body || "").slice(0, 20000), delayDays: Math.max(0, Math.min(365, Number(step.delayDays) || 0)) }));
  }
  sequence.updatedBy = userId;
  await sequence.save();
  return sequence;
}

/**
 * Enrolls contacts, skipping — never silently dropping — anyone this
 * sequence genuinely cannot email: no address on file, already unsubscribed/
 * invalid/archived, or already enrolled in this exact sequence. Every
 * skip is reported back with its reason so a bulk enroll from the CRM is
 * never a black box about why the count came back lower than selected.
 */
async function enrollContacts({ workspaceId, userId, sequenceId, contactIds }) {
  const sequence = await EmailSequence.findOne({ _id: sequenceId, workspaceId }).lean();
  if (!sequence) { const error = new Error("Sequence not found"); error.code = "EMAIL_SEQUENCE_NOT_FOUND"; throw error; }
  const ids = [...new Set((Array.isArray(contactIds) ? contactIds : []).map(String))];
  const contacts = await Contact.find({ _id: { $in: ids }, workspaceId }).select("email status emailBounced emailStatus").lean();
  const contactById = new Map(contacts.map((contact) => [String(contact._id), contact]));
  const existing = await EmailSequenceEnrollment.find({ workspaceId, sequenceId, contactId: { $in: ids } }).select("contactId").lean();
  const alreadyEnrolled = new Set(existing.map((row) => String(row.contactId)));
  const skipped = [];
  const toEnroll = [];
  for (const id of ids) {
    const contact = contactById.get(id);
    if (!contact) { skipped.push({ contactId: id, reason: "not_found" }); continue; }
    if (alreadyEnrolled.has(id)) { skipped.push({ contactId: id, reason: "already_enrolled" }); continue; }
    if (!String(contact.email || "").trim()) { skipped.push({ contactId: id, reason: "no_email" }); continue; }
    if (["invalid", "unsubscribed", "archived"].includes(contact.status) || contact.emailBounced === true || contact.emailStatus === "undeliverable") { skipped.push({ contactId: id, reason: "suppressed" }); continue; }
    toEnroll.push({ workspaceId, sequenceId, contactId: id, enrolledBy: userId, nextActionDueAt: new Date() });
  }
  const created = toEnroll.length ? await EmailSequenceEnrollment.insertMany(toEnroll, { ordered: false }).catch((error) => {
    // A unique-index race (the same contact enrolled twice in parallel
    // requests) must not fail the whole batch — every other row in it
    // already succeeded.
    if (error.code === 11000) return error.insertedDocs || [];
    throw error;
  }) : [];
  return { enrolledCount: created.length || toEnroll.length, skipped };
}

async function setEnrollmentStatus({ workspaceId, enrollmentId, status, reason = "" }) {
  const enrollment = await EmailSequenceEnrollment.findOne({ _id: enrollmentId, workspaceId });
  if (!enrollment) { const error = new Error("Enrollment not found"); error.code = "EMAIL_SEQUENCE_ENROLLMENT_NOT_FOUND"; throw error; }
  enrollment.status = status;
  if (status === "stopped") enrollment.stoppedReason = reason || "Stopped by owner";
  if (status === "active") enrollment.nextActionDueAt = new Date();
  await enrollment.save();
  return enrollment;
}

async function listEnrollments({ workspaceId, sequenceId }) {
  return EmailSequenceEnrollment.find({ workspaceId, sequenceId }).populate("contactId", "firstName lastName name email company").sort({ createdAt: -1 }).lean();
}

/** One enrollment's due step, sent the same way a one-shot campaign send works. */
async function processDueEnrollment(enrollment) {
  const sequence = await EmailSequence.findById(enrollment.sequenceId).lean();
  if (!sequence || sequence.status !== "active") {
    enrollment.status = "paused";
    enrollment.leaseOwner = ""; enrollment.leaseExpiresAt = null;
    await enrollment.save();
    return;
  }
  const contact = await Contact.findById(enrollment.contactId);
  if (!contact) {
    enrollment.status = "failed"; enrollment.stoppedReason = "Contact no longer exists";
    enrollment.leaseOwner = ""; enrollment.leaseExpiresAt = null;
    await enrollment.save();
    return;
  }
  if (sequence.stopOnReply && contact.replied) {
    enrollment.status = "completed"; enrollment.stoppedReason = "Contact replied — sequence stopped automatically";
    enrollment.leaseOwner = ""; enrollment.leaseExpiresAt = null;
    await enrollment.save();
    return;
  }
  const nextStepIndex = enrollment.currentStepIndex + 1;
  const step = sequence.steps[nextStepIndex];
  if (!step) {
    enrollment.status = "completed";
    enrollment.leaseOwner = ""; enrollment.leaseExpiresAt = null;
    await enrollment.save();
    return;
  }
  const suppressed = ["invalid", "unsubscribed", "archived"].includes(contact.status) || contact.emailBounced === true || contact.emailStatus === "undeliverable";
  const historyEntry = { stepIndex: nextStepIndex, occurredAt: new Date() };
  if (suppressed || !contact.email) {
    historyEntry.result = "suppressed";
    historyEntry.detail = !contact.email ? "No email on file" : "Suppressed — previously bounced or cannot receive marketing email";
    enrollment.status = "stopped";
    enrollment.stoppedReason = historyEntry.detail;
    enrollment.history.push(historyEntry);
    enrollment.leaseOwner = ""; enrollment.leaseExpiresAt = null;
    await enrollment.save();
    return;
  }
  const outreach = await Outreach.create({
    campaignId: sequence.campaignId, contactId: contact._id, workspaceId: enrollment.workspaceId,
    organization: contact.company || contact.name || "Contact", contactName: contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
    contactEmail: contact.email, contactRole: contact.title || "",
    subject: applyTokens(step.subject, contact), emailDraft: applyTokens(step.body, contact),
    emailTopic: "program_offers", deliveryPurpose: "marketing", status: "approved",
  });
  const result = await sendEmail(outreach, { deliveryPurpose: "marketing" });
  if (result.success) {
    outreach.status = "sent"; outreach.sentAt = new Date(); outreach.messageId = result.id || ""; outreach.deliveryStatus = "accepted";
    await outreach.save();
    await Campaign.updateOne({ _id: sequence.campaignId }, { $inc: { "metrics.sent": 1 } });
    historyEntry.result = "sent"; historyEntry.outreachId = outreach._id;
    enrollment.currentStepIndex = nextStepIndex;
    const nextStep = sequence.steps[nextStepIndex + 1];
    if (nextStep) {
      enrollment.nextActionDueAt = new Date(Date.now() + Math.max(0, nextStep.delayDays) * 86400000);
    } else {
      enrollment.status = "completed";
    }
  } else if (result.code === "RATE_LIMITED") {
    // Leave nextActionDueAt as-is (now) so the next runner pass retries
    // once the hourly cap clears, exactly like
    // scheduledCampaignSendService.js's own rate-limit handling — never
    // mark this a permanent failure for a transient cap.
    await outreach.deleteOne();
    historyEntry.result = "rate_limited"; historyEntry.detail = result.message;
  } else {
    outreach.status = "failed"; outreach.failedAt = new Date(); outreach.deliveryStatus = "failed"; outreach.errorMessage = result.message;
    await outreach.save();
    historyEntry.result = "failed"; historyEntry.detail = result.message; historyEntry.outreachId = outreach._id;
    enrollment.status = "failed"; enrollment.stoppedReason = result.message;
  }
  enrollment.history.push(historyEntry);
  enrollment.leaseOwner = ""; enrollment.leaseExpiresAt = null;
  await enrollment.save();
}

async function runDueEmailSequenceEnrollments() {
  if (polling) return;
  polling = true;
  try {
    const now = new Date();
    await EmailSequenceEnrollment.updateMany({ leaseExpiresAt: { $lte: now }, status: "active" }, { $set: { leaseOwner: "", leaseExpiresAt: null } });
    const due = await EmailSequenceEnrollment.find({ status: "active", nextActionDueAt: { $lte: now }, $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] })
      .sort({ nextActionDueAt: 1 }).limit(25);
    for (const enrollment of due) {
      const leased = await EmailSequenceEnrollment.findOneAndUpdate(
        { _id: enrollment._id, status: "active", $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] },
        { $set: { leaseOwner: WORKER_ID, leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
        { new: true },
      );
      if (!leased) continue;
      // eslint-disable-next-line no-await-in-loop
      await runWithWorkspace(leased.workspaceId, () => processDueEnrollment(leased)).catch((error) => console.error("Email sequence worker failed:", error.message));
    }
  } finally { polling = false; }
}

function startEmailSequenceRunner() {
  if (timer) return timer;
  timer = setInterval(() => runDueEmailSequenceEnrollments().catch((error) => console.error("Email sequence worker failed:", error.message)), RUNNER_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => runDueEmailSequenceEnrollments().catch(() => {}), 1000).unref?.();
  return timer;
}

module.exports = {
  listSequences, getSequence, createSequence, updateSequence,
  enrollContacts, setEnrollmentStatus, listEnrollments,
  runDueEmailSequenceEnrollments, startEmailSequenceRunner,
};
