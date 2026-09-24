const Automation = require("../models/Automation");
const AutomationExecution = require("../models/AutomationExecution");
const CrmActivity = require("../models/CrmActivity");
const Contact = require("../models/Contact");
const SalesOpportunity = require("../models/SalesOpportunity");
const Enrollment = require("../models/Enrollment");
const CoachAssignment = require("../models/CoachAssignment");
const CoachingSession = require("../models/CoachingSession");
const ReferralAttribution = require("../models/ReferralAttribution");
const CommunicationConsent = require("../models/CommunicationConsent");
const CommunicationJob = require("../models/CommunicationJob");
const SocialIdentity = require("../models/SocialIdentity");
const ConversationThread = require("../models/ConversationThread");
const coachingDomainService = require("./coachingDomainService");
const coachAssignmentService = require("./coachAssignmentService");
const communicationService = require("./coachingCommunicationService");
const skoolService = require("./skoolIntegrationService");
const commissionService = require("./referralCommissionService");
const socialLeadService = require("./socialLeadAutomationService");
const { metaMessagingAdapter } = require("./conversations/metaMessagingAdapter");
const { runWithWorkspace } = require("../tenancy/workspaceContext");
const meetupService = require("./meetupService");

const deps = { Automation, AutomationExecution, CrmActivity, Contact, SalesOpportunity, Enrollment, CoachAssignment, CoachingSession, ReferralAttribution, CommunicationConsent, CommunicationJob, SocialIdentity, ConversationThread, coachingDomainService, coachAssignmentService, communicationService, skoolService, commissionService, socialLeadService, metaMessagingAdapter, meetupService };

const TRIGGERS = Object.freeze([
  "contact.created", "application.completed", "opportunity.stage_changed", "opportunity.closed_won", "opportunity.closed_lost",
  "student.enrolled", "coaching.enrollment.transitioned", "coaching.program.completed", "coach.assigned", "coach.assignment.completed", "coaching.handoff.completed",
  "coaching.session.scheduled", "coaching.session.rescheduled", "coaching.session.cancelled", "coaching.session.attended", "coaching.session.no_show",
  "coaching.referral.attributed", "coaching.commission.created", "coaching.commission.approved", "coaching.commission.paid",
  "skool.access.requested", "skool.member.joined", "skool.addon.purchased", "email.delivered", "email.opened", "email.clicked", "email.bounced", "sms.delivered", "sms.replied",
  "team.invitation.sent", "team.invitation.failed", "team.invitation.accepted", "ambassador.added", "ambassador.profile.completed", "ambassador.profile.updated", "ambassador.content.assigned", "ambassador.content.viewed", "ambassador.content.in_progress", "ambassador.content.completed", "ambassador.content.declined", "ambassador.welcome.generated", "social.content.approve", "social.content.schedule", "social.content.published", "social.content.failed",
  "social.mention.received", "social.postback.received", "social.referral.received", "social.optin.received", "event.registered", "event.attended", "social.dm.received", "social.comment.received", "social.keyword.matched", "social.story.reply", "social.lead.created", "social.link.clicked",
  "payment.installment.upcoming", "payment.installment.past_due",
]);
const CONDITION_FIELDS = Object.freeze(["event.roles", "contact.status", "contact.stage", "contact.source", "contact.marketingConsent", "contact.smsConsent", "contact.tags", "contact.qualification", "contact.applicationCompleted", "contact.callBooked", "opportunity.stage", "enrollment.status", "enrollment.programId", "enrollment.skoolStatus", "assignment.coachProfileId", "session.status", "session.attendance", "event.provider", "event.campaignId", "event.occurredAt", "referral.present"]);
const ACTIONS = Object.freeze(["ambassador.profile_reminder", "ambassador.welcome_draft", "contact.add_tag", "contact.remove_tag", "contact.update_status", "task.create", "opportunity.assign_closer", "communication.email", "communication.sms", "enrollment.create", "enrollment.activate", "coach.assign", "communication.onboarding", "communication.session_reminders", "skool.request_access", "commission.generate", "social.response", "social.tracked_link", "meetup.request_action", "notification.create"]);

function automationError(message, code = "AUTOMATION_INVALID") { const error = new Error(message); error.code = code; return error; }
function id(value) { return value == null ? "" : String(value); }
function array(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function get(object, path) { return String(path).split(".").reduce((value, part) => value?.[part], object); }
function compare(actual, operator, expected, now = new Date()) {
  if (operator === "exists") return actual !== undefined && actual !== null && actual !== "";
  if (operator === "not_exists") return actual === undefined || actual === null || actual === "";
  if (operator === "contains") return array(actual).map(String).includes(String(expected));
  if (operator === "in") return array(expected).map(String).includes(String(actual));
  if (operator === "not_in") return !array(expected).map(String).includes(String(actual));
  if (operator === "gte") return Number(actual) >= Number(expected);
  if (operator === "lte") return Number(actual) <= Number(expected);
  if (operator === "older_than_minutes") return actual && now.getTime() - new Date(actual).getTime() >= Number(expected) * 60000;
  if (operator === "not_equals") return String(actual ?? "") !== String(expected ?? "");
  return String(actual ?? "") === String(expected ?? "");
}

function normalizeDefinition(input) {
  const eventType = String(input.trigger?.eventType || "");
  if (!TRIGGERS.includes(eventType)) throw automationError("Unsupported automation trigger", "TRIGGER_UNSUPPORTED");
  const conditions = array(input.conditions).slice(0, 20).map((condition) => { if (!CONDITION_FIELDS.includes(condition.field)) throw automationError(`Unsupported condition: ${condition.field}`, "CONDITION_UNSUPPORTED"); return { field: condition.field, operator: condition.operator || "equals", value: condition.value }; });
  const actions = array(input.actions).slice(0, 20).map((action) => { if (!ACTIONS.includes(action.type)) throw automationError(`Unsupported action: ${action.type}`, "ACTION_UNSUPPORTED"); return { type: action.type, delayMinutes: Math.max(0, Math.min(525600, Number(action.delayMinutes) || 0)), conditions: array(action.conditions), config: action.config || {} }; });
  if (!actions.length) throw automationError("At least one action is required");
  return { name: String(input.name || "").trim(), description: String(input.description || "").trim(), trigger: { eventType }, conditions, actions, templateKey: String(input.templateKey || "") };
}

async function contextFor(execution, activity, models = deps) {
  const metadata = activity.metadata || {};
  const contactId = execution.contactId || activity.contactId;
  const opportunityId = execution.opportunityId || metadata.opportunityId;
  const enrollmentId = execution.enrollmentId || metadata.enrollmentId;
  const sessionId = execution.coachingSessionId || metadata.coachingSessionId;
  const assignmentId = execution.coachAssignmentId || metadata.coachAssignmentId || metadata.toAssignmentId;
  const [contact, opportunity, enrollment, session, assignment, referral] = await Promise.all([
    contactId ? models.Contact.findById(contactId).lean() : null, opportunityId ? models.SalesOpportunity.findById(opportunityId).lean() : null,
    enrollmentId ? models.Enrollment.findById(enrollmentId).lean() : null, sessionId ? models.CoachingSession.findById(sessionId).lean() : null,
    assignmentId ? models.CoachAssignment.findById(assignmentId).lean() : null, contactId ? models.ReferralAttribution.findOne({ contactId }).lean() : null,
  ]);
  let smsConsent = null;
  const phone = contact?.mobilePhone || contact?.phone || contact?.workDirectPhone;
  if (phone) smsConsent = await models.CommunicationConsent.findOne({ channel: "sms", address: phone, purpose: "all" }).lean();
  return { event: { ...metadata, eventType: execution.triggerEventType, campaignId: activity.campaignId, occurredAt: activity.occurredAt }, contact: contact ? { ...contact, source: contact.socialAttribution?.latest?.provider || contact.sourceProvider || contact.sources?.[0] || "", marketingConsent: contact.emailPreferences?.marketingStatus === "subscribed", smsConsent: smsConsent?.status === "opted_in", qualification: contact.additionalFields?.socialIntent || [], applicationCompleted: Boolean(contact.additionalFields?.applicationCompletedAt || contact.tags?.includes("application-completed")), callBooked: Boolean(contact.additionalFields?.callBookedAt) } : null, opportunity: opportunity ? { ...opportunity, stage: opportunity.stageKey } : null, enrollment: enrollment ? { ...enrollment, programId: id(enrollment.coachingProgramId), skoolStatus: enrollment.externalRefs?.skoolStatus || "" } : null, session: session ? { ...session, attendance: session.zoom?.attendance?.state || "unknown" } : null, assignment: assignment ? { ...assignment, coachProfileId: id(assignment.coachProfileId) } : null, referral: { present: Boolean(referral), ...(referral || {}) }, activity };
}

function conditionsPass(conditions, context) { return array(conditions).every((condition) => compare(get(context, condition.field), condition.operator, condition.value)); }
function resultId(value) { return value?._id || value?.id || value?.token || null; }

async function executeAction({ automation, execution, action, index, context }, models = deps) {
  if (action.type === "ambassador.profile_reminder") {
    const workspaceId = execution.workspaceId;
    const profile = await require("../models/AmbassadorProfile").findOne({ workspaceId, userId: context.event.userId, status: "active" }).populate("userId", require("./userProfileService").selection).lean();
    if (!profile) return { status: "skipped" };
    const settings = await require("../models/WorkspaceConfig").findOne({ workspaceId, key: "primary" }).select("ambassadorOnboarding").lean();
    if (require("./ambassadorWelcomeService").completeness(profile, profile.userId, settings?.ambassadorOnboarding?.requiredFields).complete) return { status: "already_complete" };
    return require("../models/InAppNotification").findOneAndUpdate({ workspaceId, userId: profile.userId._id, type: "ambassador_reminder", actionUrl: `/ambassador?reminder=${execution._id}:${index}` }, { $setOnInsert: { title: String(action.config?.title || "Complete your profile").slice(0, 180), message: String(action.config?.body || "Please complete your ambassador profile.").slice(0, 2000) } }, { upsert: true, new: true });
  }
  if (action.type === "ambassador.welcome_draft") {
    const settings = await require("../models/WorkspaceConfig").findOne({ workspaceId: execution.workspaceId, key: "primary" }).select("ambassadorOnboarding").lean();
    if (!settings?.ambassadorOnboarding?.welcomeDraftOnComplete) throw automationError("Automatic welcome drafts require workspace permission", "ACTION_BLOCKED");
    const profileId = context.event.ambassadorProfileId;
    if (!profileId) throw automationError("Ambassador profile required", "ACTION_BLOCKED");
    const profile = await require("../models/AmbassadorProfile").findOne({ _id: profileId, workspaceId: execution.workspaceId }).lean();
    if (!profile || profile.status !== "active") throw automationError("Active ambassador profile required", "ACTION_BLOCKED");
    if (profile.welcomePost?.contentBriefId) return { _id: profile.welcomePost.contentBriefId, status: "already_generated" };
    return require("./ambassadorWelcomeService").generate({ workspaceId: execution.workspaceId, ambassadorProfileId: profileId, userId: automation.updatedBy });
  }
  const workspaceId = execution.workspaceId; const contactId = context.contact?._id; const key = `automation:${execution._id}:action:${index}`; const config = action.config || {};
  if (action.type.startsWith("contact.") && !contactId) throw automationError("Action needs a Contact", "ACTION_BLOCKED");
  if (action.type === "contact.add_tag") return models.Contact.findByIdAndUpdate(contactId, { $addToSet: { tags: String(config.tag || "").trim() } }, { new: true });
  if (action.type === "contact.remove_tag") return models.Contact.findByIdAndUpdate(contactId, { $pull: { tags: String(config.tag || "").trim() } }, { new: true });
  if (action.type === "contact.update_status") { if (!["active", "prospect", "rejected", "inactive", "unsubscribed", "invalid", "archived"].includes(config.status)) throw automationError("Unsafe Contact status", "ACTION_BLOCKED"); return models.Contact.findByIdAndUpdate(contactId, { $set: { status: config.status } }, { new: true }); }
  if (action.type === "task.create") { const existing = await models.CrmActivity.findOne({ "metadata.idempotencyKey": key }); return existing || models.CrmActivity.create({ workspaceId, contactId: contactId || null, type: "task", title: String(config.title || automation.name).slice(0, 180), body: String(config.body || "").slice(0, 5000), dueAt: new Date(Date.now() + Math.max(0, Number(config.dueMinutes) || 0) * 60000), source: "crm", metadata: { eventType: "automation.task.created", automationExecutionId: execution._id, assignedUserId: config.userId || context.opportunity?.ownerId || null, idempotencyKey: key } }); }
  if (action.type === "opportunity.assign_closer") { if (!context.opportunity?._id || !config.userId) throw automationError("Opportunity and closer are required", "ACTION_BLOCKED"); return models.SalesOpportunity.findByIdAndUpdate(context.opportunity._id, { $set: { ownerId: config.userId } }, { new: true }); }
  if (["communication.email", "communication.sms"].includes(action.type)) return models.communicationService.scheduleDirectCommunication({ workspaceId, contactId, channel: action.type.endsWith("email") ? "email" : "sms", purpose: config.purpose || "transactional", scheduledFor: new Date(), subject: config.subject || "", body: config.body || "", actorUserId: automation.updatedBy, idempotencyKey: key, metadata: { automationExecutionId: execution._id } });
  if (action.type === "enrollment.create") return models.coachingDomainService.createEnrollment({ workspaceId, contactId, coachingProgramId: config.coachingProgramId, sourceOpportunityId: context.opportunity?._id || null, status: config.status || "pending", startsAt: new Date(), createdBy: automation.updatedBy });
  if (action.type === "enrollment.activate") { if (!context.enrollment?._id) throw automationError("Enrollment required", "ACTION_BLOCKED"); if (context.enrollment.status === "active") return context.enrollment; return models.coachingDomainService.transitionEnrollment({ workspaceId, enrollmentId: context.enrollment._id, status: "active", createdBy: automation.updatedBy }); }
  if (action.type === "coach.assign") { if (!context.enrollment?._id || !config.coachProfileId) throw automationError("Enrollment and coach are required", "ACTION_BLOCKED"); return models.coachAssignmentService.createCoachAssignment({ workspaceId, enrollmentId: context.enrollment._id, coachProfileId: config.coachProfileId, stageKey: config.stageKey || context.enrollment.currentStageKey, startsAt: new Date(), createdBy: automation.updatedBy }); }
  if (action.type === "communication.onboarding") return models.communicationService.scheduleOnboarding({ workspaceId, enrollmentId: context.enrollment?._id, channels: config.channels || ["email", "sms"], actorUserId: automation.updatedBy });
  if (action.type === "communication.session_reminders") return models.communicationService.scheduleSessionReminders({ workspaceId, sessionId: context.session?._id, offsetsMinutes: config.offsetsMinutes || [1440, 120], channels: config.channels || ["email"], actorUserId: automation.updatedBy });
  if (action.type === "skool.request_access") return models.skoolService.createAccessRequest({ workspaceId, enrollmentId: context.enrollment?._id, actorUserId: automation.updatedBy });
  if (action.type === "commission.generate") { if (!context.opportunity?._id) throw automationError("Closed-won opportunity required", "ACTION_BLOCKED"); return models.commissionService.generateFromOpportunity({ workspaceId, opportunity: context.opportunity, actorUserId: automation.updatedBy }); }
  if (action.type === "social.tracked_link") return models.socialLeadService.createTrackedLink({ destination: config.destination, provider: context.event.provider || config.provider, contactId, campaignId: context.event.campaignId || null, automationId: context.event.automationId || null, contentId: context.event.contentId || "", referralCode: config.referralCode || "", utm: config.utm || {}, idempotencyKey: key }, automation.updatedBy);
  if (action.type === "social.response") { if (process.env.META_AUTOMATIC_REPLIES_ENABLED !== "true") throw automationError("Automatic social replies are disabled", "ACTION_BLOCKED"); return require("./metaAutomationReplyService").fromAutomation({ workspaceId, contactId, event: context.event, body: config.body }); }
  if (action.type === "meetup.request_action") { if (!["create_event", "update_event", "announce_event"].includes(config.action)) throw automationError("Unsupported Meetup action", "ACTION_BLOCKED"); return models.meetupService.requestAction({ workspaceId, contactId, automationId: automation._id, automationExecutionId: execution._id, action: config.action, payload: config.payload || {}, requestedBy: automation.updatedBy, idempotencyKey: key }); }
  if (action.type === "notification.create") { const existing = await models.CrmActivity.findOne({ "metadata.idempotencyKey": key }); return existing || models.CrmActivity.create({ workspaceId, contactId: contactId || null, type: "task", title: String(config.title || `Automation notification: ${automation.name}`).slice(0, 180), body: String(config.body || "").slice(0, 5000), dueAt: new Date(), source: "crm", metadata: { eventType: "automation.notification.created", recipientRole: config.role || "owner", recipientUserId: config.userId || context.assignment?.coachUserId || context.opportunity?.ownerId || null, automationExecutionId: execution._id, idempotencyKey: key } }); }
  throw automationError("Action is not implemented", "ACTION_UNSUPPORTED");
}

async function createExecution(automation, activity, models = deps) {
  const metadata = activity.metadata || {};
  try { const execution = await models.AutomationExecution.create({ workspaceId: automation.workspaceId, automationId: automation._id, triggerActivityId: activity._id, triggerEventType: metadata.eventType, contactId: activity.contactId || null, enrollmentId: metadata.enrollmentId || null, opportunityId: metadata.opportunityId || null, coachingSessionId: metadata.coachingSessionId || null, coachAssignmentId: metadata.coachAssignmentId || metadata.toAssignmentId || null, status: "pending", runAt: new Date(), contextSnapshot: { event: metadata } }); await models.CrmActivity.create({ workspaceId: automation.workspaceId, contactId: activity.contactId || null, type: "system", title: "Automation started", source: "crm", metadata: { eventType: "automation.started", automationId: automation._id, automationExecutionId: execution._id, triggerActivityId: activity._id } }); return execution; }
  catch (error) { if (error.code === 11000) return models.AutomationExecution.findOne({ automationId: automation._id, triggerActivityId: activity._id }); throw error; }
}

async function discoverExecutions({ now = new Date(), limitPerAutomation = 200 } = {}, models = deps) {
  const automations = await models.Automation.find({ status: "enabled" }); const created = [];
  for (const automation of automations) await runWithWorkspace(automation.workspaceId, async () => {
    const from = automation.lastScannedAt || automation.enabledAt || automation.createdAt;
    const activities = await models.CrmActivity.find({ "metadata.eventType": automation.trigger.eventType, occurredAt: { $gte: from, $lte: now } }).sort({ occurredAt: 1 }).limit(limitPerAutomation);
    for (const activity of activities) created.push(await createExecution(automation, activity, models));
    automation.lastScannedAt = now; await automation.save();
  });
  return created;
}

async function processExecution(execution, models = deps) {
  if (!["pending", "waiting", "processing", "failed"].includes(execution.status) || execution.status === "cancelled") return execution;
  const automation = await models.Automation.findById(execution.automationId); const activity = await models.CrmActivity.findById(execution.triggerActivityId);
  if (!automation || automation.status !== "enabled" || !activity) { execution.status = "cancelled"; execution.cancelledAt = new Date(); execution.lastError = "Automation disabled or trigger unavailable"; await execution.save(); return execution; }
  let context = await contextFor(execution, activity, models);
  if (!conditionsPass(automation.conditions, context)) { execution.status = "skipped"; execution.completedAt = new Date(); execution.lastError = "Automation conditions no longer match"; await execution.save(); return execution; }
  execution.status = "processing"; execution.startedAt ||= new Date(); execution.attempts += 1; await execution.save();
  for (let index = execution.nextActionIndex; index < automation.actions.length; index += 1) {
    const action = automation.actions[index]; const existing = execution.steps.find((step) => step.actionIndex === index);
    if (existing?.status === "completed" || existing?.status === "skipped" || existing?.status === "blocked") { execution.nextActionIndex = index + 1; continue; }
    if (!conditionsPass(action.conditions, context)) { execution.steps.push({ actionIndex: index, actionType: action.type, status: "skipped", idempotencyKey: `automation:${execution._id}:action:${index}`, completedAt: new Date(), reason: "Action conditions did not match" }); execution.nextActionIndex = index + 1; await models.CrmActivity.create({ workspaceId: execution.workspaceId, contactId: execution.contactId, type: "system", title: "Automation action skipped", source: "crm", metadata: { eventType: "automation.action.skipped", automationId: automation._id, automationExecutionId: execution._id, actionIndex: index, reason: "conditions" } }); continue; }
    if (action.delayMinutes > 0 && execution.waitingActionIndex !== index) { execution.status = "waiting"; execution.waitingActionIndex = index; execution.runAt = new Date(Date.now() + action.delayMinutes * 60000); execution.steps.push({ actionIndex: index, actionType: action.type, status: "waiting", idempotencyKey: `automation:${execution._id}:action:${index}`, reason: `Waiting ${action.delayMinutes} minutes` }); await execution.save(); return execution; }
    const step = existing || execution.steps.find((item) => item.actionIndex === index); if (step) { step.status = "processing"; step.startedAt ||= new Date(); step.attempts += 1; } else execution.steps.push({ actionIndex: index, actionType: action.type, status: "processing", idempotencyKey: `automation:${execution._id}:action:${index}`, startedAt: new Date(), attempts: 1 });
    execution.waitingActionIndex = null;
    try { const result = await executeAction({ automation, execution, action, index, context }, models); if (action.type === "enrollment.create" && result?._id) execution.enrollmentId = result._id; if (action.type === "coach.assign" && result?._id) execution.coachAssignmentId = result._id; const current = execution.steps.find((item) => item.actionIndex === index); current.status = "completed"; current.completedAt = new Date(); current.result = { id: resultId(result), status: result?.status || "completed" }; execution.nextActionIndex = index + 1; await execution.save(); context = await contextFor(execution, activity, models); }
    catch (error) { const current = execution.steps.find((item) => item.actionIndex === index); const blocked = error.code === "ACTION_BLOCKED" || /consent|STOP|suppressed|not found|required|unavailable|window/i.test(error.message); current.status = blocked ? "blocked" : "failed"; current.reason = String(error.message || error).slice(0, 2000); current.completedAt = blocked ? new Date() : null; execution.status = blocked ? "blocked" : "failed"; execution.lastError = current.reason; execution.runAt = new Date(Date.now() + Math.min(60, 2 ** execution.attempts) * 60000); await execution.save(); await models.CrmActivity.create({ workspaceId: execution.workspaceId, contactId: execution.contactId, type: "system", title: blocked ? "Automation action blocked" : "Automation failed", source: "crm", metadata: { eventType: blocked ? "automation.action.skipped" : "automation.failed", automationId: automation._id, automationExecutionId: execution._id, actionIndex: index, reason: current.reason } }); return execution; }
  }
  execution.status = "completed"; execution.completedAt = new Date(); execution.lastError = ""; await execution.save();
  await models.CrmActivity.create({ workspaceId: execution.workspaceId, contactId: execution.contactId, type: "system", title: "Automation completed", source: "crm", metadata: { eventType: "automation.completed", automationId: automation._id, automationExecutionId: execution._id } });
  return execution;
}

async function processDueExecutions({ now = new Date(), limit = 100 } = {}, models = deps) {
  const candidates = await models.AutomationExecution.find({ status: { $in: ["pending", "waiting", "failed"] }, runAt: { $lte: now }, attempts: { $lt: 3 } }).sort({ runAt: 1 }).limit(limit); const results = [];
  for (const candidate of candidates) { const claimed = await models.AutomationExecution.findOneAndUpdate({ _id: candidate._id, status: candidate.status }, { $set: { status: "processing" } }, { new: true }); if (claimed) results.push(await runWithWorkspace(claimed.workspaceId, () => processExecution(claimed, models))); }
  return results;
}

async function runAutomationCycle(options = {}, models = deps) { await discoverExecutions(options, models); return processDueExecutions(options, models); }
module.exports = { ACTIONS, CONDITION_FIELDS, TRIGGERS, compare, conditionsPass, contextFor, createExecution, discoverExecutions, executeAction, normalizeDefinition, processDueExecutions, processExecution, runAutomationCycle, _deps: deps };
