/**
 * Multi-step LinkedIn outreach campaigns: connection request -> wait for
 * acceptance -> opener message -> AI-assisted (optionally autonomous) reply
 * handling until a meeting is booked or the contact opts out.
 *
 * The runner leases due enrollments the same way
 * services/researchMonitorService.js leases due research monitors, so
 * multiple app instances never send the same LinkedIn action twice.
 */
const crypto = require("node:crypto");
const os = require("node:os");
const LinkedinSequence = require("../models/LinkedinSequence");
const LinkedinSequenceEnrollment = require("../models/LinkedinSequenceEnrollment");
const Contact = require("../models/Contact");
const CrmActivity = require("../models/CrmActivity");
const outreachEngine = require("./linkedinOutreachEngineService");
const unipile = require("./unipileService");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

const RUNNER_INTERVAL_MS = Math.max(30000, Number(process.env.LINKEDIN_SEQUENCE_WORKER_POLL_MS) || 5 * 60000);
const LEASE_MS = Math.max(120000, Number(process.env.LINKEDIN_SEQUENCE_WORKER_LEASE_MS) || 10 * 60000);
// How often the runner re-checks a pending connection request for
// acceptance. See the TODO on checkConnectionAcceptance below.
const ACCEPTANCE_RECHECK_MS = 6 * 60 * 60000;
const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
let timer = null;
let polling = false;

function renderTemplate(template, contact) {
  const firstName = String(contact.firstName || contact.name || "there").trim().split(/\s+/)[0];
  const values = {
    firstName,
    name: contact.name || firstName,
    company: contact.company || "",
    title: contact.title || "",
  };
  return String(template || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => values[key] ?? match);
}

async function logHistory(enrollment, entry) {
  enrollment.history.push(entry);
  await enrollment.save();
}

async function stopEnrollment(enrollment, reason) {
  enrollment.status = "stopped";
  enrollment.stoppedReason = reason;
  enrollment.nextActionDueAt = null;
  await enrollment.save();
}

/**
 * Enroll a set of contacts into a sequence. Skips contacts already enrolled
 * in this sequence (idempotent) and contacts with no LinkedIn URL.
 */
async function enrollContacts({ sequence, contactIds, workspaceId }) {
  const contacts = await Contact.find({ _id: { $in: contactIds }, linkedin: { $ne: "" } });
  const results = [];
  for (const contact of contacts) {
    try {
      const enrollment = await LinkedinSequenceEnrollment.findOneAndUpdate(
        { workspaceId, sequenceId: sequence._id, contactId: contact._id },
        { $setOnInsert: { status: "pending", nextActionDueAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      results.push(enrollment);
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }
  return results;
}

/**
 * Unipile has no webhook for "connection request accepted" (confirmed —
 * only message_received/message_read/message_reaction exist), so
 * acceptance is detected by polling GET /users/relations and looking for
 * the target provider_id. Paged defensively since the response can be
 * large for an active account; stops after a bounded number of pages so a
 * single enrollment check can't run away.
 */
async function checkConnectionAcceptance(enrollment, accountId) {
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    let response;
    try {
      response = await unipile.getAllRelations({ accountId, cursor });
    } catch (error) {
      console.warn(`[LinkedIn sequence] relations check failed: ${error.message}`);
      return { accepted: false, checked: false };
    }
    const items = response.items || response.data || (Array.isArray(response) ? response : []);
    if (items.some((relation) => unipile.relationMatchesProviderId(relation, enrollment.unipileProviderId)))
      return { accepted: true, checked: true };
    cursor = response.cursor || response.next_cursor;
    if (!cursor) break;
  }
  return { accepted: false, checked: true };
}

async function advanceEnrollment(enrollment) {
  const sequence = await LinkedinSequence.findById(enrollment.sequenceId);
  const contact = await Contact.findById(enrollment.contactId);
  if (!sequence || sequence.status !== "active" || !contact) {
    return stopEnrollment(enrollment, !sequence ? "sequence_deleted" : !contact ? "contact_deleted" : "sequence_not_active");
  }

  if (enrollment.status === "pending") {
    const step = sequence.steps[0];
    try {
      const { accountId, providerId } = await outreachEngine.sendConnectionRequestToContact({
        workspaceId: enrollment.workspaceId,
        contact,
        message: renderTemplate(step.messageTemplate, contact),
      });
      enrollment.unipileProviderId = providerId;
      enrollment.unipileAccountId = accountId;
      enrollment.status = "connection_sent";
      enrollment.currentStepIndex = 0;
      enrollment.nextActionDueAt = new Date(Date.now() + ACCEPTANCE_RECHECK_MS);
      await logHistory(enrollment, { stepIndex: 0, type: "connection_request", result: "sent" });
    } catch (error) {
      if (error.code === "LINKEDIN_URL_MISSING" || error.code === "LINKEDIN_PROFILE_UNRESOLVED") {
        await stopEnrollment(enrollment, error.message);
      } else {
        // Transient failure (rate limit, network, disabled integration) -
        // retry on the same cadence rather than losing the enrollment.
        enrollment.nextActionDueAt = new Date(Date.now() + ACCEPTANCE_RECHECK_MS);
        await logHistory(enrollment, { stepIndex: 0, type: "connection_request", result: "failed", detail: error.message });
      }
    }
    return;
  }

  if (enrollment.status === "connection_sent") {
    const { accepted } = await checkConnectionAcceptance(enrollment, enrollment.unipileAccountId);
    if (accepted) {
      enrollment.status = "connection_accepted";
      const nextStep = sequence.steps[1];
      enrollment.nextActionDueAt = nextStep
        ? new Date(Date.now() + nextStep.delayMinutes * 60000)
        : null;
      await logHistory(enrollment, { stepIndex: 0, type: "connection_request", result: "accepted" });
      if (!nextStep) enrollment.status = "completed";
    } else {
      enrollment.nextActionDueAt = new Date(Date.now() + ACCEPTANCE_RECHECK_MS);
    }
    return enrollment.save();
  }

  if (enrollment.status === "connection_accepted") {
    const step = sequence.steps[enrollment.currentStepIndex + 1];
    if (!step) return stopEnrollment(enrollment, "sequence_complete");
    try {
      const chat = await unipile.startNewChat({
        accountId: enrollment.unipileAccountId,
        providerId: enrollment.unipileProviderId,
        text: renderTemplate(step.messageTemplate, contact),
      });
      enrollment.unipileChatId = chat.chat_id || chat.id || "";
      enrollment.currentStepIndex += 1;
      enrollment.status = "awaiting_reply";
      enrollment.nextActionDueAt = null;
      await logHistory(enrollment, { stepIndex: enrollment.currentStepIndex, type: step.type, result: "sent" });
      await CrmActivity.create({
        contactId: contact._id,
        type: "system",
        title: "LinkedIn opener message sent",
        source: "integration",
        metadata: { eventType: "social.linkedin.sequence_message_sent", sequenceId: sequence._id },
      });
    } catch (error) {
      // Retry shortly rather than losing the enrollment on a transient
      // failure (rate limit, momentary API error).
      enrollment.nextActionDueAt = new Date(Date.now() + 30 * 60000);
      await logHistory(enrollment, {
        stepIndex: enrollment.currentStepIndex + 1,
        type: step.type,
        result: "failed",
        detail: error.message,
      });
    }
  }
}

async function claimDueEnrollment() {
  const now = new Date();
  return LinkedinSequenceEnrollment.findOneAndUpdate(
    {
      status: { $in: ["pending", "connection_sent", "connection_accepted"] },
      nextActionDueAt: { $lte: now },
      $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
    },
    { $set: { leaseOwner: WORKER_ID, leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
    { new: true },
  );
}

async function runDueEnrollments() {
  if (polling) return;
  polling = true;
  try {
    let enrollment;
    // eslint-disable-next-line no-cond-assign
    while ((enrollment = await claimDueEnrollment())) {
      await runWithWorkspace(enrollment.workspaceId, () => advanceEnrollment(enrollment));
    }
  } finally {
    polling = false;
  }
}

function startLinkedinSequenceRunner() {
  if (timer) return;
  timer = setInterval(
    () => runDueEnrollments().catch((error) => console.error("LinkedIn sequence worker failed:", error.message)),
    RUNNER_INTERVAL_MS,
  );
}

module.exports = {
  enrollContacts,
  advanceEnrollment,
  runDueEnrollments,
  startLinkedinSequenceRunner,
  renderTemplate,
};
