const Contact = require("../models/Contact");
const CoachingSession = require("../models/CoachingSession");
const CoachProfile = require("../models/CoachProfile");
const CoachingProgram = require("../models/CoachingProgram");
const Enrollment = require("../models/Enrollment");
const MarketingCampaign = require("../models/MarketingCampaign");
const CommunicationJob = require("../models/CommunicationJob");
const EmailSuppression = require("../models/EmailSuppression");
const MessagingSender = require("../models/MessagingSender");
const ConversationThread = require("../models/ConversationThread");
const ConversationMessage = require("../models/ConversationMessage");
const CrmActivity = require("../models/CrmActivity");
const integrationHub = require("./integrationHub");
const segmentService = require("./communicationSegmentService");
const { twilioConversationAdapter } = require("./conversations/twilioConversationAdapter");
const { ingestProviderMessage } = require("./conversations/conversationIngestionService");
const { evaluateOutboundCommunication } = require("./communicationPolicyService");
const { createUnsubscribeToken, publicBackendUrl } = require("../utils/unsubscribe");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

const deps = { Contact, CoachingSession, CoachProfile, CoachingProgram, Enrollment, MarketingCampaign, CommunicationJob, EmailSuppression, MessagingSender, ConversationThread, ConversationMessage, CrmActivity, integrationHub, segmentService, twilioConversationAdapter, ingestProviderMessage };
function communicationError(message, code = "COMMUNICATION_INVALID") { const error = new Error(message); error.code = code; return error; }
function firstName(contact) { return contact.firstName || String(contact.name || "there").trim().split(/\s+/)[0] || "there"; }
function render(value, context) { return String(value || "").replace(/{{\s*([a-zA-Z0-9_.]+)\s*}}/g, (_all, key) => key.split(".").reduce((current, part) => current?.[part], context) ?? ""); }
function safeContact(contact) { return { id: contact._id, name: contact.name, firstName: firstName(contact), email: contact.email, phone: contact.mobilePhone || contact.phone || contact.workDirectPhone || "" }; }

async function emailPolicy(contact, purpose, models = deps, topic = "general") {
  if (!contact?.email) return { allowed: false, reason: "Contact has no email address" };
  const suppression = await models.EmailSuppression.findOne({ workspaceId: contact.workspaceId, email: String(contact.email).toLowerCase() }).lean();
  if (suppression || contact.emailBounced) return { allowed: false, reason: "Email address is suppressed or bounced" };
  if (["invalid", "archived"].includes(contact.status)) return { allowed: false, reason: "Contact is not deliverable" };
  if (purpose === "marketing" && (contact.status === "unsubscribed" || contact.emailPreferences?.marketingStatus !== "subscribed" || !contact.emailPreferences?.consentAt)) return { allowed: false, reason: "Marketing email consent is not active" };
  const topicField = { event_invitations: "eventInvitations", program_offers: "programOffers", educational_newsletter: "educationalNewsletter" }[topic];
  if (purpose === "marketing" && topicField && contact.emailPreferences?.topics?.[topicField] !== true) return { allowed: false, reason: "Contact is not subscribed to this marketing topic" };
  return { allowed: true };
}

async function createCampaign(input, models = deps) {
  if (!input.name || !input.content?.body || !["marketing", "transactional"].includes(input.purpose)) throw communicationError("Name, body, and communication purpose are required");
  const channels = [...new Set((input.channels || ["email"]).filter((value) => ["email", "sms"].includes(value)))];
  if (!channels.length) throw communicationError("At least one channel is required");
  const campaign = await models.MarketingCampaign.create({ workspaceId: input.workspaceId, name: input.name, type: channels.length > 1 ? "multi_channel" : channels[0], status: "draft", content: { subject: input.content.subject || "", previewText: input.content.previewText || "", body: input.content.body, htmlBody: input.content.htmlBody || "", callToAction: input.content.callToAction || "", callToActionUrl: input.content.callToActionUrl || "" }, communication: { purpose: input.purpose, topic: input.topic || "general", channels, segment: input.segment || {}, approvalStatus: "draft" }, scheduledFor: input.scheduledFor || null, notes: input.notes || "", createdBy: String(input.actorUserId || "") });
  return campaign;
}

async function previewCampaign({ workspaceId, campaignId }, models = deps) {
  const campaign = await models.MarketingCampaign.findOne({ _id: campaignId, workspaceId }).lean();
  if (!campaign) throw communicationError("Communication campaign not found", "CAMPAIGN_NOT_FOUND");
  const contacts = await models.segmentService.resolveSegment({ workspaceId, segment: campaign.communication?.segment }, models.segmentModels);
  const results = [];
  for (const contact of contacts) results.push({ contact: safeContact(contact), email: await emailPolicy(contact, campaign.communication.purpose, models, campaign.communication.topic) });
  return { campaign, total: contacts.length, eligibleEmail: results.filter((row) => row.email.allowed).length, recipients: results.slice(0, 100) };
}

async function approveAndSchedule({ workspaceId, campaignId, scheduledFor, actorUserId }, models = deps) {
  const campaign = await models.MarketingCampaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) throw communicationError("Communication campaign not found", "CAMPAIGN_NOT_FOUND");
  if (campaign.status !== "draft") throw communicationError("Only a draft communication can be approved and scheduled", "CAMPAIGN_NOT_DRAFT");
  const runAt = scheduledFor ? new Date(scheduledFor) : new Date();
  if (Number.isNaN(runAt.getTime())) throw communicationError("A valid scheduled time is required");
  const contacts = await models.segmentService.resolveSegment({ workspaceId, segment: campaign.communication.segment }, models.segmentModels);
  let created = 0;
  for (const contact of contacts) for (const channel of campaign.communication.channels) {
    const key = `campaign:${campaign._id}:${contact._id}:${channel}`;
    try { await models.CommunicationJob.create({ workspaceId, kind: "campaign_message", channel, purpose: campaign.communication.purpose, contactId: contact._id, campaignId: campaign._id, scheduledFor: runAt, idempotencyKey: key, content: { subject: campaign.content.subject || "", previewText: campaign.content.previewText || "", body: campaign.content.body, html: campaign.content.htmlBody || "" }, createdBy: actorUserId, metadata: { topic: campaign.communication.topic || "general" } }); created += 1; } catch (error) { if (error.code !== 11000) throw error; }
  }
  campaign.status = runAt > new Date() ? "scheduled" : "active"; campaign.scheduledFor = runAt; campaign.communication.approvalStatus = "approved"; campaign.communication.approvedBy = actorUserId; campaign.communication.approvedAt = new Date(); await campaign.save();
  await models.CrmActivity.create({ workspaceId, type: "system", title: "Coaching communication scheduled", source: "crm", createdBy: actorUserId, metadata: { eventType: "coaching.communication.scheduled", campaignId: campaign._id, recipientJobs: created } });
  return { campaign, jobsCreated: created };
}

async function scheduleSessionReminders({ workspaceId, sessionId, offsetsMinutes = [1440, 120], channels = ["email"], actorUserId }, models = deps) {
  const session = await models.CoachingSession.findOne({ _id: sessionId, workspaceId, status: "scheduled" });
  if (!session) throw communicationError("Scheduled coaching session not found", "SESSION_NOT_FOUND");
  const [contact, coach, program] = await Promise.all([models.Contact.findOne({ _id: session.contactId, workspaceId }), models.CoachProfile.findOne({ _id: session.coachProfileId, workspaceId }), models.CoachingProgram.findOne({ _id: session.coachingProgramId, workspaceId })]);
  if (!contact || !coach || !program) throw communicationError("Session communication context is incomplete");
  let created = 0;
  for (const offset of [...new Set(offsetsMinutes.map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 10080))]) for (const channel of channels.filter((value) => ["email", "sms"].includes(value))) {
    const scheduledFor = new Date(new Date(session.startsAt).getTime() - offset * 60000);
    if (scheduledFor <= new Date()) continue;
    const key = `session:${session._id}:${new Date(session.startsAt).toISOString()}:${offset}:${channel}`;
    const context = { contact: safeContact(contact), session: { name: program.name, startsAt: new Date(session.startsAt).toLocaleString("en-US", { timeZone: session.timezone || "UTC", dateStyle: "medium", timeStyle: "short" }), timezone: session.timezone, joinUrl: session.videoMode === "zoom" ? session.zoom?.joinUrl || "" : "" }, coach: { name: coach.displayName } };
    const body = render("Hi {{contact.firstName}}, reminder: {{session.name}} with {{coach.name}} is {{session.startsAt}} ({{session.timezone}}). {{session.joinUrl}}", context).trim();
    try { await models.CommunicationJob.create({ workspaceId, kind: "session_reminder", channel, purpose: "transactional", contactId: contact._id, coachingSessionId: session._id, enrollmentId: session.enrollmentId, scheduledFor, idempotencyKey: key, sessionStartsAtSnapshot: session.startsAt, content: { subject: `Reminder: ${program.name}`, body }, createdBy: actorUserId, metadata: { offsetMinutes: offset } }); created += 1; } catch (error) { if (error.code !== 11000) throw error; }
  }
  return { jobsCreated: created };
}

async function cancelSessionReminders({ workspaceId, sessionId, reason = "Session changed" }, models = deps) { return models.CommunicationJob.updateMany({ workspaceId, coachingSessionId: sessionId, status: "pending" }, { $set: { status: "cancelled", cancelledAt: new Date(), blockReason: reason } }); }

async function scheduleOnboarding({ workspaceId, enrollmentId, channels = ["email", "sms"], actorUserId }, models = deps) {
  const enrollment = await models.Enrollment.findOne({ _id: enrollmentId, workspaceId });
  if (!enrollment || enrollment.status !== "active") throw communicationError("Active enrollment required", "ENROLLMENT_NOT_ACTIVE");
  const [contact, program] = await Promise.all([models.Contact.findOne({ _id: enrollment.contactId, workspaceId }), models.CoachingProgram.findOne({ _id: enrollment.coachingProgramId, workspaceId })]);
  if (!contact || !program) throw communicationError("Enrollment communication context is incomplete");
  const skool = program.skoolMapping?.groupUrl ? `Skool: ${program.skoolMapping.groupUrl} (${enrollment.externalRefs?.skoolStatus || "access pending"})` : "Skool access details will follow.";
  const body = `Hi ${firstName(contact)}, welcome to ${program.name}. ${skool} Your coaching team will share your first-session details next.`;
  let created = 0;
  for (const channel of channels.filter((value) => ["email", "sms"].includes(value))) try { await models.CommunicationJob.create({ workspaceId, kind: "onboarding", channel, purpose: "transactional", contactId: contact._id, enrollmentId: enrollment._id, scheduledFor: new Date(), idempotencyKey: `onboarding:${enrollment._id}:${channel}`, content: { subject: `Welcome to ${program.name}`, body }, createdBy: actorUserId }); created += 1; } catch (error) { if (error.code !== 11000) throw error; }
  return { jobsCreated: created };
}

async function scheduleDirectCommunication({ workspaceId, contactId, channel, purpose = "transactional", scheduledFor = new Date(), subject = "", body, actorUserId, idempotencyKey, metadata = {} }, models = deps) {
  if (!contactId || !["email", "sms"].includes(channel) || !String(body || "").trim() || !idempotencyKey) throw communicationError("Contact, channel, body, and idempotency key are required", "DIRECT_COMMUNICATION_INVALID");
  if (!await models.Contact.exists({ _id: contactId, workspaceId })) throw communicationError("Contact not found", "CONTACT_NOT_FOUND");
  try { return await models.CommunicationJob.create({ workspaceId, kind: "campaign_message", channel, purpose, contactId, scheduledFor, idempotencyKey, content: { subject, body }, createdBy: actorUserId || null, metadata: { ...metadata, automation: true } }); }
  catch (error) { if (error.code === 11000) return models.CommunicationJob.findOne({ workspaceId, idempotencyKey }); throw error; }
}

async function recordCanonicalMessage({ job, contact, channel, provider, providerMessageId, senderAddress, recipientAddress }, models = deps) {
  return models.ingestProviderMessage({ thread: { channel, provider, providerThreadId: `${channel}:${contact._id}`, contactIds: [contact._id], participants: [{ kind: "user", role: "from", address: senderAddress }, { kind: "contact", role: "to", address: recipientAddress, contactId: contact._id }], tags: ["coaching-communication"] }, message: { providerMessageId, direction: "outbound", subject: job.content.subject, body: job.content.body, html: job.content.html, sender: { address: senderAddress }, recipients: [{ address: recipientAddress, role: "to" }], deliveryStatus: "queued", contactId: contact._id, metadata: { communicationJobId: job._id, campaignId: job.campaignId, coachingSessionId: job.coachingSessionId, purpose: job.purpose } } });
}

async function processJob(job, models = deps) {
  if (job.status !== "processing") return job;
  const contact = await models.Contact.findOne({ _id: job.contactId, workspaceId: job.workspaceId });
  if (!contact) { job.status = "blocked"; job.blockReason = "Contact not found"; await job.save(); return job; }
  if (job.coachingSessionId) { const session = await models.CoachingSession.findOne({ _id: job.coachingSessionId, workspaceId: job.workspaceId }); if (!session || session.status !== "scheduled" || new Date(session.startsAt).getTime() !== new Date(job.sessionStartsAtSnapshot).getTime()) { job.status = "cancelled"; job.cancelledAt = new Date(); job.blockReason = "Session was cancelled or rescheduled"; await job.save(); return job; } }
  try {
    let response;
    if (job.channel === "email") {
      const policy = await emailPolicy(contact, job.purpose, models, job.metadata?.topic); if (!policy.allowed) throw communicationError(policy.reason, "COMMUNICATION_BLOCKED");
      const unsubscribeUrl = `${publicBackendUrl()}/api/unsubscribe/${encodeURIComponent(createUnsubscribeToken(contact))}`;
      response = await models.integrationHub.execute("resend", "sendEmail", { from: process.env.EMAIL_FROM || "Growth Operator <onboarding@resend.dev>", to: contact.email, subject: render(job.content.subject, { contact: safeContact(contact) }), text: render(job.content.body, { contact: safeContact(contact) }), html: job.content.html ? render(job.content.html, { contact: safeContact(contact) }) : undefined, headers: job.purpose === "marketing" ? { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined });
      await recordCanonicalMessage({ job, contact, channel: "email", provider: "resend", providerMessageId: response.messageId, senderAddress: process.env.EMAIL_FROM || "onboarding@resend.dev", recipientAddress: contact.email }, models);
    } else {
      const sender = await models.MessagingSender.findOne({ workspaceId: job.workspaceId, provider: "twilio", status: "active" }); if (!sender) throw communicationError("No active Twilio sender", "COMMUNICATION_BLOCKED");
      const to = contact.mobilePhone || contact.phone || contact.workDirectPhone;
      // The same real gate the one-off /telephony/messages route already
      // uses — opt-out status, documented marketing consent (required only
      // for purpose "marketing", never for a transactional reminder to an
      // existing student), US A2P approval, sender active, quiet hours.
      // Nothing reaches Twilio from a scheduled job without passing this.
      const policy = await evaluateOutboundCommunication({ channel: "sms", address: to, purpose: job.purpose, sender, timezone: contact.timezone });
      if (!policy.allowed) throw communicationError(policy.reasons.join("; "), "COMMUNICATION_BLOCKED");
      response = await models.twilioConversationAdapter.sendMessage({ sender, to, body: render(job.content.body, { contact: safeContact(contact) }), purpose: job.purpose, timezone: contact.timezone });
      await recordCanonicalMessage({ job, contact, channel: "sms", provider: "twilio", providerMessageId: response.sid, senderAddress: sender.phoneNumber, recipientAddress: to }, models);
    }
    job.status = "sent"; job.sentAt = new Date(); job.providerMessageId = response.messageId || response.sid; job.attempts += 1; job.lastAttemptAt = new Date(); await job.save();
    if (job.campaignId) {
      await models.MarketingCampaign.updateOne({ _id: job.campaignId, workspaceId: job.workspaceId }, { $inc: { "metrics.sent": 1 }, $set: { "metrics._updated": new Date() } });
      const remaining = await models.CommunicationJob.countDocuments({ workspaceId: job.workspaceId, campaignId: job.campaignId, status: { $in: ["pending", "processing"] } });
      if (!remaining) {
        const completed = await models.MarketingCampaign.findOneAndUpdate({ _id: job.campaignId, workspaceId: job.workspaceId, status: { $ne: "completed" } }, { $set: { status: "completed", endedAt: new Date() } }, { new: true });
        if (completed) await models.CrmActivity.create({ workspaceId: job.workspaceId, type: "system", title: "Coaching newsletter delivery run completed", source: "crm", metadata: { eventType: "coaching.newsletter.sent", campaignId: job.campaignId } });
      }
    }
    if (job.kind === "session_reminder") await models.CrmActivity.create({ workspaceId: job.workspaceId, contactId: contact._id, type: "system", title: "Coaching reminder sent", source: "crm", metadata: { eventType: "coaching.reminder.sent", communicationJobId: job._id, coachingSessionId: job.coachingSessionId, channel: job.channel } });
    return job;
  } catch (error) { job.attempts += 1; job.lastAttemptAt = new Date(); job.status = error.code === "COMMUNICATION_BLOCKED" ? "blocked" : "failed"; job.blockReason = String(error.message || error).slice(0, 1000); await job.save(); return job; }
}

async function processDueJobs({ now = new Date(), limit = 100 } = {}, models = deps) {
  const jobs = await models.CommunicationJob.find({ status: "pending", scheduledFor: { $lte: now } }).sort({ scheduledFor: 1 }).limit(limit);
  const results = [];
  for (const candidate of jobs) { const job = await models.CommunicationJob.findOneAndUpdate({ _id: candidate._id, status: "pending" }, { $set: { status: "processing" } }, { new: true }); if (job) results.push(await runWithWorkspace(job.workspaceId, () => processJob(job, models))); }
  return results;
}

module.exports = { approveAndSchedule, cancelSessionReminders, createCampaign, emailPolicy, previewCampaign, processDueJobs, processJob, recordCanonicalMessage, render, scheduleDirectCommunication, scheduleOnboarding, scheduleSessionReminders, _deps: deps };
