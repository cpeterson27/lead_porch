const express = require("express");
const mongoose = require("mongoose");
const CoachProfile = require("../models/CoachProfile");
const CoachingProgram = require("../models/CoachingProgram");
const Enrollment = require("../models/Enrollment");
const CoachAssignment = require("../models/CoachAssignment");
const Contact = require("../models/Contact");
const CoachingNote = require("../models/CoachingNote");
const CoachingHandoff = require("../models/CoachingHandoff");
const CrmActivity = require("../models/CrmActivity");
const CoachingSession = require("../models/CoachingSession");
const IntegrationConnection = require("../models/IntegrationConnection");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const ZoomWebhookEvent = require("../models/ZoomWebhookEvent");
const SkoolAccessRequest = require("../models/SkoolAccessRequest");
const SkoolPurchase = require("../models/SkoolPurchase");
const SkoolAdapterEvent = require("../models/SkoolAdapterEvent");
const MarketingCampaign = require("../models/MarketingCampaign");
const CommunicationJob = require("../models/CommunicationJob");
const ConversationMessage = require("../models/ConversationMessage");
const ConversationThread = require("../models/ConversationThread");
const ReferralAttribution = require("../models/ReferralAttribution"); const CommissionRule = require("../models/CommissionRule"); const CommissionLedger = require("../models/CommissionLedger");
const domainService = require("../services/coachingDomainService");
const assignmentService = require("../services/coachAssignmentService");
const historyService = require("../services/coachingHistoryService");
const referralCommissionService = require("../services/referralCommissionService");
const coachingAuthorization = require("../services/coachingAuthorizationService");
const googleCalendarService = require("../services/googleCalendarService");
const zoomService = require("../services/zoomService");
const skoolIntegrationService = require("../services/skoolIntegrationService");
const communicationSegmentService = require("../services/communicationSegmentService");
const coachingCommunicationService = require("../services/coachingCommunicationService");
const coachingSchedulingService = require("../services/coachingSchedulingService");
const workspaceMemberService = require("../services/workspaceMemberService");
const agentExecutionService = require("../services/agentExecutionService");
const coachingSuccessPatternsService = require("../services/coachingSuccessPatternsService");
const { authenticatedUserId, isAdminRole } = require("../authorization/accessPolicy");
const { hasRole } = require("../authorization/capabilities");
const { requireCapability } = require("../middleware/auth");
const { runWithWorkspace } = require("../tenancy/workspaceContext");

const defaultDependencies = {
  CoachProfile,
  CoachingProgram,
  Enrollment,
  CoachAssignment,
  Contact,
  CoachingNote,
  CoachingHandoff,
  CrmActivity,
  CoachingSession,
  IntegrationConnection,
  WorkspaceMembership,
  ZoomWebhookEvent,
  SkoolAccessRequest,
  SkoolPurchase,
  SkoolAdapterEvent,
  MarketingCampaign,
  CommunicationJob,
  ConversationMessage,
  ConversationThread,
  ReferralAttribution, CommissionRule, CommissionLedger,
  domainService,
  assignmentService,
  historyService,
  referralCommissionService,
  coachingAuthorization,
  googleCalendarService,
  zoomService,
  skoolIntegrationService,
  communicationSegmentService,
  coachingCommunicationService,
  coachingSchedulingService,
  workspaceMemberService,
  agentExecutionService,
  coachingSuccessPatternsService,
};

const CONTACT_FIELDS = "name firstName lastName email phone title company organizationId status tags";
const PROGRAM_COACH_FIELDS = "name status duration stages version skoolMapping.enabled skoolMapping.groupUrl skoolMapping.courseLabels";

function validId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

function safeLimit(value) {
  return Math.min(200, Math.max(1, Number.parseInt(value, 10) || 50));
}

function dateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function errorResponse(error, res) {
  const status = error?.code?.includes("FORBIDDEN") ? 403
    : error?.code?.includes("NOT_FOUND") ? 404
    : error?.code?.includes("MISMATCH") || error?.code?.includes("REQUIRED") || error?.code?.includes("INVALID") || error?.code?.includes("CONFLICT") || error?.code?.includes("ARCHIVED") || error?.code?.includes("CLOSED") ? 400
      : error?.code === 11000 ? 409 : 400;
  return res.status(status).json({ success: false, error: error.message || "Unable to complete coaching operation", code: error.code || "COACHING_OPERATION_FAILED" });
}

function requireAdmin(req, res, next) {
  return req.auth?.effectivePermissions?.includes("coaching.view")
    ? next()
    : res.status(403).json({ success: false, error: "Owner or admin access is required", code: "ROLE_FORBIDDEN" });
}

async function historyActor(req, deps) {
  return {
    role: req.auth.role,
    userId: authenticatedUserId(req),
    access: await deps.coachingAuthorization.resolveCoachingAccess(req),
  };
}

function createCoachingRouter(overrides = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  const router = express.Router();

  router.get("/calendar/oauth/callback", asyncRoute(async (req, res) => {
    const frontend = String(process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
    try {
      const state = deps.googleCalendarService.verifyState(req.query.state);
      if (!state) throw new Error("Google Calendar connection request expired or is invalid");
      const identity = await runWithWorkspace(state.workspaceId, () => deps.googleCalendarService.validateStateIdentity(state, { ...deps, WorkspaceMembership: deps.WorkspaceMembership }));
      if (!req.query.code) throw new Error(req.query.error || "Google did not return an authorization code");
      const tokens = await deps.googleCalendarService.googleAdapter.exchangeCode(req.query.code);
      const profile = await deps.googleCalendarService.googleAdapter.profile(tokens.access_token);
      await runWithWorkspace(state.workspaceId, () => deps.googleCalendarService.saveConnection(identity, tokens, profile, deps));
      return res.redirect(`${frontend}/coach/schedule?calendar=connected`);
    } catch (error) {
      return res.redirect(`${frontend}/coach/schedule?calendar=error&message=${encodeURIComponent(error.message)}`);
    }
  }));

  router.get("/zoom/oauth/callback", asyncRoute(async (req, res) => {
    const frontend = String(process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
    try {
      const state = deps.zoomService.verifyState(req.query.state); if (!state) throw new Error("Zoom connection request expired or is invalid");
      const identity = await runWithWorkspace(state.workspaceId, () => deps.zoomService.validateStateIdentity(state, deps));
      if (!req.query.code) throw new Error(req.query.error || "Zoom did not return an authorization code");
      const tokens = await deps.zoomService.zoomAdapter.exchangeCode(req.query.code); const profile = await deps.zoomService.zoomAdapter.profile(tokens.access_token);
      await runWithWorkspace(state.workspaceId, () => deps.zoomService.saveConnection(identity, tokens, profile, deps));
      return res.redirect(`${frontend}/coach/schedule?zoom=connected`);
    } catch (error) { return res.redirect(`${frontend}/coach/schedule?zoom=error&message=${encodeURIComponent(error.message)}`); }
  }));

  router.post("/zoom/webhook", asyncRoute(async (req, res) => {
    const rawBody = req.rawBody || JSON.stringify(req.body || {}); const timestamp = req.get("x-zm-request-timestamp"); const signature = req.get("x-zm-signature");
    if (!deps.zoomService.verifyWebhook(rawBody, timestamp, signature)) return res.status(403).json({ error: "Invalid Zoom webhook signature" });
    if (req.body?.event === "endpoint.url_validation") return res.json(deps.zoomService.validationResponse(req.body?.payload?.plainToken));
    return res.json({ received: true, ...(await deps.zoomService.processWebhook(req.body || {}, deps)) });
  }));

  // This is a signed Growth Operator adapter endpoint for Zapier. It is not
  // presented as an official Skool webhook and accepts no browser identity.
  router.post("/skool/adapter/events", asyncRoute(async (req, res) => {
    const workspaceId = String(req.get("x-growth-operator-workspace") || "");
    if (!validId(workspaceId)) return res.status(403).json({ success: false, error: "Invalid adapter identity" });
    const credentials = await runWithWorkspace(workspaceId, () => deps.skoolIntegrationService.adapterCredentials(workspaceId, deps));
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    if (!credentials || !deps.skoolIntegrationService.verifyAdapter(rawBody, credentials.adapterSecret, req.get("x-growth-operator-signature"))) {
      return res.status(403).json({ success: false, error: "Invalid adapter signature" });
    }
    try {
      const result = await runWithWorkspace(workspaceId, () => deps.skoolIntegrationService.ingestEvent({ workspaceId, providerEventId: req.body?.providerEventId, eventType: req.body?.eventType, payload: req.body?.payload }, deps));
      return res.json({ success: true, duplicate: Boolean(result?.duplicate) });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.use(requireCapability("coaching.view", "coaching.view_assigned"));

  router.get("/skool/status", requireAdmin, asyncRoute(async (req, res) => res.json({ success: true, data: await deps.skoolIntegrationService.status(req.auth.workspaceId, deps) })));

  router.put("/skool/configure", requireAdmin, asyncRoute(async (req, res) => {
    try { return res.json({ success: true, data: await deps.skoolIntegrationService.configure({ ...req.body, workspaceId: req.auth.workspaceId }, deps) }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.get("/skool/access-requests", requireAdmin, asyncRoute(async (req, res) => {
    const filter = { workspaceId: req.auth.workspaceId };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.enrollmentId && validId(req.query.enrollmentId)) filter.enrollmentId = req.query.enrollmentId;
    const data = await deps.SkoolAccessRequest.find(filter).populate("contactId", CONTACT_FIELDS).populate("coachingProgramId", "name skoolMapping").sort({ createdAt: -1 }).limit(safeLimit(req.query.limit)).lean();
    return res.json({ success: true, data });
  }));

  router.get("/skool/purchases", requireAdmin, asyncRoute(async (req, res) => {
    const filter = { workspaceId: req.auth.workspaceId };
    if (req.query.contactId && validId(req.query.contactId)) filter.contactId = req.query.contactId;
    const data = await deps.SkoolPurchase.find(filter).populate("contactId", CONTACT_FIELDS).sort({ purchasedAt: -1 }).limit(safeLimit(req.query.limit)).lean();
    return res.json({ success: true, data });
  }));

  router.post("/skool/access-requests/:id/retry", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid Skool access request", code: "ID_INVALID" });
    const request = await deps.SkoolAccessRequest.findOne({ _id: req.params.id, workspaceId: req.auth.workspaceId });
    if (!request) return res.status(404).json({ success: false, error: "Skool access request not found", code: "SKOOL_REQUEST_NOT_FOUND" });
    try { return res.json({ success: true, data: await deps.skoolIntegrationService.dispatch(request, req.auth.workspaceId, deps) }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.post("/communications/segments/preview", requireAdmin, asyncRoute(async (req, res) => {
    try { const contacts = await deps.communicationSegmentService.resolveSegment({ workspaceId: req.auth.workspaceId, segment: req.body?.segment }, undefined); return res.json({ success: true, data: { count: contacts.length, contacts: contacts.slice(0, 100).map((contact) => ({ _id: contact._id, name: contact.name, email: contact.email, phone: contact.mobilePhone || contact.phone || "" })) } }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.get("/communications/campaigns", requireAdmin, asyncRoute(async (req, res) => {
    const data = await deps.MarketingCampaign.find({ workspaceId: req.auth.workspaceId, type: { $in: ["email", "sms", "multi_channel"] }, "communication.segment.kind": { $exists: true } }).sort({ createdAt: -1 }).limit(safeLimit(req.query.limit)).lean();
    return res.json({ success: true, data });
  }));

  router.post("/communications/campaigns", requireAdmin, asyncRoute(async (req, res) => {
    try { const data = await deps.coachingCommunicationService.createCampaign({ ...req.body, workspaceId: req.auth.workspaceId, actorUserId: authenticatedUserId(req) }); return res.status(201).json({ success: true, data }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.get("/communications/campaigns/:id/preview", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid campaign", code: "ID_INVALID" });
    try { return res.json({ success: true, data: await deps.coachingCommunicationService.previewCampaign({ workspaceId: req.auth.workspaceId, campaignId: req.params.id }) }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.post("/communications/campaigns/:id/schedule", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid campaign", code: "ID_INVALID" });
    try { return res.json({ success: true, data: await deps.coachingCommunicationService.approveAndSchedule({ workspaceId: req.auth.workspaceId, campaignId: req.params.id, scheduledFor: req.body?.scheduledFor, actorUserId: authenticatedUserId(req) }) }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.get("/communications/jobs", requireAdmin, asyncRoute(async (req, res) => {
    const filter = { workspaceId: req.auth.workspaceId }; if (req.query.status) filter.status = req.query.status;
    const data = await deps.CommunicationJob.find(filter).populate("contactId", CONTACT_FIELDS).populate("campaignId", "name content communication status").populate("coachingSessionId", "startsAt timezone status videoMode zoom.joinUrl").sort({ scheduledFor: -1 }).limit(safeLimit(req.query.limit)).lean();
    return res.json({ success: true, data });
  }));

  router.post("/sessions/:id/reminders", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid session", code: "ID_INVALID" });
    try { return res.status(201).json({ success: true, data: await deps.coachingCommunicationService.scheduleSessionReminders({ workspaceId: req.auth.workspaceId, sessionId: req.params.id, offsetsMinutes: req.body?.offsetsMinutes, channels: req.body?.channels, actorUserId: authenticatedUserId(req) }) }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.post("/enrollments/:id/onboarding-communications", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid enrollment", code: "ID_INVALID" });
    try { return res.status(201).json({ success: true, data: await deps.coachingCommunicationService.scheduleOnboarding({ workspaceId: req.auth.workspaceId, enrollmentId: req.params.id, channels: req.body?.channels, actorUserId: authenticatedUserId(req) }) }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.get("/calendar/connection", asyncRoute(async (req, res) => {
    if (!hasRole(req.auth, "coach")) return res.status(403).json({ success: false, error: "Coaches connect their own Google Calendar", code: "COACH_SELF_SERVICE_REQUIRED" });
    const identity = await deps.googleCalendarService.coachIdentity({ workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req) }, deps);
    return res.json({ success: true, data: await deps.googleCalendarService.ownStatus(identity, deps) });
  }));

  router.get("/calendar/oauth/start", asyncRoute(async (req, res) => {
    if (!hasRole(req.auth, "coach")) return res.status(403).json({ success: false, error: "Coaches connect their own Google Calendar", code: "COACH_SELF_SERVICE_REQUIRED" });
    const identity = await deps.googleCalendarService.coachIdentity({ workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req) }, deps);
    return res.json({ success: true, authorizationUrl: deps.googleCalendarService.authorizationUrl(identity) });
  }));

  router.delete("/calendar/connection", asyncRoute(async (req, res) => {
    if (!hasRole(req.auth, "coach")) return res.status(403).json({ success: false, error: "Coaches disconnect their own Google Calendar", code: "COACH_SELF_SERVICE_REQUIRED" });
    const identity = await deps.googleCalendarService.coachIdentity({ workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req) }, deps);
    return res.json({ success: true, data: await deps.googleCalendarService.disconnect(identity, deps) });
  }));

  router.get("/calendar/calendars", asyncRoute(async (req, res) => {
    if (!hasRole(req.auth, "coach")) return res.status(403).json({ success: false, error: "Coach access is required", code: "ROLE_FORBIDDEN" });
    const identity = await deps.googleCalendarService.coachIdentity({ workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req) }, deps);
    return res.json({ success: true, data: await deps.googleCalendarService.listCalendars(identity, deps) });
  }));

  router.patch("/calendar/selection", asyncRoute(async (req, res) => {
    if (!hasRole(req.auth, "coach")) return res.status(403).json({ success: false, error: "Coach access is required", code: "ROLE_FORBIDDEN" });
    const identity = await deps.googleCalendarService.coachIdentity({ workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req) }, deps);
    return res.json({ success: true, data: await deps.googleCalendarService.selectCalendar(identity, { calendarId: String(req.body?.calendarId || ""), timezone: String(req.body?.timezone || "") }, deps) });
  }));

  router.get("/calendar/connections", requireAdmin, asyncRoute(async (req, res) => {
    const coaches = await deps.CoachProfile.find({ workspaceId: req.auth.workspaceId }).populate("userId", "name email avatarUrl").sort({ displayName: 1 }).lean();
    const connections = await deps.IntegrationConnection.find({ workspaceId: req.auth.workspaceId, provider: "google_calendar", accountScope: "user" }).lean();
    const byCoach = new Map(connections.map((item) => [String(item.coachProfileId), item]));
    return res.json({ success: true, data: coaches.map((coach) => ({ coach, connection: deps.googleCalendarService.publicConnection(byCoach.get(String(coach._id))) })) });
  }));

  router.get("/zoom/connection", asyncRoute(async (req, res) => {
    if (!hasRole(req.auth, "coach")) return res.status(403).json({ success: false, error: "Coaches connect their own Zoom account", code: "COACH_SELF_SERVICE_REQUIRED" });
    const identity = await deps.zoomService.coachIdentity({ workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req) }, deps); return res.json({ success: true, data: await deps.zoomService.ownStatus(identity, deps) });
  }));
  router.get("/zoom/oauth/start", asyncRoute(async (req, res) => {
    if (!hasRole(req.auth, "coach")) return res.status(403).json({ success: false, error: "Coaches connect their own Zoom account", code: "COACH_SELF_SERVICE_REQUIRED" });
    const identity = await deps.zoomService.coachIdentity({ workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req) }, deps); return res.json({ success: true, authorizationUrl: deps.zoomService.authorizationUrl(identity) });
  }));
  router.delete("/zoom/connection", asyncRoute(async (req, res) => {
    if (!hasRole(req.auth, "coach")) return res.status(403).json({ success: false, error: "Coaches disconnect their own Zoom account", code: "COACH_SELF_SERVICE_REQUIRED" });
    const identity = await deps.zoomService.coachIdentity({ workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req) }, deps); return res.json({ success: true, data: await deps.zoomService.disconnect(identity, deps) });
  }));
  router.get("/zoom/connections", requireAdmin, asyncRoute(async (req, res) => {
    const coaches = await deps.CoachProfile.find({ workspaceId: req.auth.workspaceId }).populate("userId", "name email avatarUrl").sort({ displayName: 1 }).lean(); const connections = await deps.IntegrationConnection.find({ workspaceId: req.auth.workspaceId, provider: "zoom", accountScope: "user" }).lean(); const byCoach = new Map(connections.map((item) => [String(item.coachProfileId), item]));
    return res.json({ success: true, data: coaches.map((coach) => ({ coach, connection: deps.zoomService.publicConnection(byCoach.get(String(coach._id))) })) });
  }));

  router.get("/sessions", asyncRoute(async (req, res) => {
    const filter = { workspaceId: req.auth.workspaceId };
    if (isAdminRole(req.auth.role)) {
      if (req.query.coachProfileId && validId(req.query.coachProfileId)) filter.coachProfileId = req.query.coachProfileId;
    } else {
      const identity = await deps.googleCalendarService.coachIdentity({ workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req) }, deps);
      filter.coachProfileId = identity.coachProfileId;
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.view === "upcoming") Object.assign(filter, { status: "scheduled", startsAt: { $gte: new Date() } });
    const data = await deps.CoachingSession.find(filter).populate("contactId", CONTACT_FIELDS).populate("coachProfileId", "displayName userId timezone status").populate("coachingProgramId", "name stages").populate("enrollmentId", "status currentStageKey").sort({ startsAt: 1 }).limit(safeLimit(req.query.limit)).lean();
    const reminderRows = await deps.CommunicationJob.find({ workspaceId: req.auth.workspaceId, coachingSessionId: { $in: data.map((item) => item._id) }, kind: "session_reminder" }).select("coachingSessionId channel status scheduledFor sentAt blockReason").sort({ scheduledFor: 1 }).lean();
    return res.json({ success: true, data: data.map((session) => ({ ...session, reminders: reminderRows.filter((row) => String(row.coachingSessionId) === String(session._id)) })) });
  }));

  router.post("/sessions/availability", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.body?.coachProfileId)) return res.status(400).json({ success: false, error: "A valid coach is required", code: "ID_INVALID" });
    try { return res.json({ success: true, data: await deps.googleCalendarService.availability({ workspaceId: req.auth.workspaceId, coachProfileId: req.body.coachProfileId, startsAt: req.body.startsAt, durationMinutes: req.body.durationMinutes }, deps) }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.post("/sessions", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.body?.enrollmentId) || !validId(req.body?.coachProfileId)) return res.status(400).json({ success: false, error: "Valid enrollment and coach are required", code: "ID_INVALID" });
    try { const data = await deps.coachingSchedulingService.schedule({ workspaceId: req.auth.workspaceId, enrollmentId: req.body.enrollmentId, coachProfileId: req.body.coachProfileId, startsAt: req.body.startsAt, durationMinutes: req.body.durationMinutes, stageKey: req.body.stageKey, videoMode: req.body.videoMode, createdBy: authenticatedUserId(req) }, deps); return res.status(201).json({ success: true, data }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.patch("/sessions/:id/reschedule", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid session", code: "ID_INVALID" });
    try { return res.json({ success: true, data: await deps.coachingSchedulingService.reschedule({ workspaceId: req.auth.workspaceId, sessionId: req.params.id, startsAt: req.body?.startsAt, durationMinutes: req.body?.durationMinutes, updatedBy: authenticatedUserId(req) }, deps) }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.post("/sessions/:id/cancel", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid session", code: "ID_INVALID" });
    try { return res.json({ success: true, data: await deps.coachingSchedulingService.cancel({ workspaceId: req.auth.workspaceId, sessionId: req.params.id, reason: req.body?.reason, updatedBy: authenticatedUserId(req) }, deps) }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.get("/coaches", asyncRoute(async (req, res) => {
    const filter = { workspaceId: req.auth.workspaceId };
    if (!isAdminRole(req.auth.role)) filter.userId = authenticatedUserId(req);
    if (isAdminRole(req.auth.role) && req.query.status) filter.status = req.query.status;
    const data = await deps.CoachProfile.find(filter).populate("userId", "name firstName lastName phone email status avatarUrl").sort({ displayName: 1, createdAt: 1 }).lean();
    return res.json({ success: true, data });
  }));

  router.get("/coaches/me", asyncRoute(async (req, res) => {
    const data = await deps.CoachProfile.findOne({ workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req) })
      .populate("userId", "name firstName lastName phone email status avatarUrl").lean();
    return data ? res.json({ success: true, data }) : res.status(404).json({ success: false, error: "Coach profile not found", code: "COACH_NOT_FOUND" });
  }));

  router.get("/coaches/:id", asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid coach profile", code: "ID_INVALID" });
    const filter = { _id: req.params.id, workspaceId: req.auth.workspaceId };
    if (!isAdminRole(req.auth.role)) filter.userId = authenticatedUserId(req);
    const data = await deps.CoachProfile.findOne(filter).populate("userId", "name firstName lastName phone email status avatarUrl").lean();
    return data ? res.json({ success: true, data }) : res.status(404).json({ success: false, error: "Coach profile not found", code: "COACH_NOT_FOUND" });
  }));

  router.post("/coaches", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.body?.userId)) return res.status(400).json({ success: false, error: "A valid workspace user is required", code: "ID_INVALID" });
    try {
      const data = await deps.domainService.createCoachProfile({
        workspaceId: req.auth.workspaceId,
        userId: req.body.userId,
        displayName: req.body.displayName,
        timezone: req.body.timezone,
        capacity: req.body.capacity,
      });
      return res.status(201).json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.post("/coaches/onboard", requireAdmin, asyncRoute(async (req, res) => {
    try {
      const data = await deps.workspaceMemberService.onboardCoach({
        workspaceId: req.auth.workspaceId,
        actorUserId: authenticatedUserId(req),
        name: req.body?.name,
        firstName: req.body?.firstName,
        lastName: req.body?.lastName,
        phone: req.body?.phone,
        email: req.body?.email,
        timezone: req.body?.timezone,
        capacity: req.body?.capacity,
        programIds: req.body?.programIds,
      });
      const lifecycle = data.membership.status === "invited" ? "invite_ready" : "coach_profile_active";
      return res.status(data.alreadyActive ? 200 : 201).json({ success: true, data: { coachProfile: data.coachProfile, membershipStatus: data.membership.status, lifecycle, invitation: data.invitation ? { id: data.invitation._id, status: data.invitation.status, deliveryStatus: data.invitation.deliveryStatus, roleKey: data.invitation.roleKey, templateVersion: data.invitation.templateVersion, subject: data.invitation.subject, body: data.invitation.body, expiresAt: data.invitation.expiresAt } : null } });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.patch("/coaches/:id", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid coach profile", code: "ID_INVALID" });
    try {
      const data = await deps.domainService.updateCoachProfile({
        workspaceId: req.auth.workspaceId,
        coachProfileId: req.params.id,
        changes: { displayName: req.body?.displayName, timezone: req.body?.timezone, capacity: req.body?.capacity },
      });
      return res.json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.patch("/coaches/:id/status", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id) || !["active", "inactive"].includes(req.body?.status)) return res.status(400).json({ success: false, error: "Valid coach and status are required", code: "INPUT_INVALID" });
    try {
      const operation = req.body.status === "active" ? deps.domainService.activateCoachProfile : deps.domainService.deactivateCoachProfile;
      const data = await operation({ workspaceId: req.auth.workspaceId, coachProfileId: req.params.id });
      return res.json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.get("/programs", asyncRoute(async (req, res) => {
    const filter = { workspaceId: req.auth.workspaceId };
    if (isAdminRole(req.auth.role)) {
      if (req.query.status) filter.status = req.query.status;
    } else {
      const access = await deps.coachingAuthorization.resolveCoachingAccess(req);
      const assigned = await deps.Enrollment.find({ _id: { $in: access.enrollmentIds }, workspaceId: req.auth.workspaceId }).select("coachingProgramId").lean();
      filter._id = { $in: assigned.map((item) => item.coachingProgramId) };
      filter.status = { $ne: "archived" };
    }
    let query = deps.CoachingProgram.find(filter).sort({ name: 1 });
    if (!isAdminRole(req.auth.role)) query = query.select(PROGRAM_COACH_FIELDS);
    return res.json({ success: true, data: await query.lean() });
  }));

  router.get("/programs/:id", asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid coaching program", code: "ID_INVALID" });
    const filter = { _id: req.params.id, workspaceId: req.auth.workspaceId };
    if (!isAdminRole(req.auth.role)) {
      const access = await deps.coachingAuthorization.resolveCoachingAccess(req);
      const assigned = await deps.Enrollment.exists({ _id: { $in: access.enrollmentIds }, coachingProgramId: req.params.id, workspaceId: req.auth.workspaceId });
      if (!assigned) return res.status(404).json({ success: false, error: "Coaching program not found", code: "PROGRAM_NOT_FOUND" });
      filter.status = { $ne: "archived" };
    }
    let query = deps.CoachingProgram.findOne(filter);
    if (!isAdminRole(req.auth.role)) query = query.select(PROGRAM_COACH_FIELDS);
    const data = await query.lean();
    return data ? res.json({ success: true, data }) : res.status(404).json({ success: false, error: "Coaching program not found", code: "PROGRAM_NOT_FOUND" });
  }));

  router.post("/programs", requireAdmin, asyncRoute(async (req, res) => {
    try {
      const data = await deps.domainService.createCoachingProgram({ ...req.body, workspaceId: req.auth.workspaceId });
      return res.status(201).json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.patch("/programs/:id", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid coaching program", code: "ID_INVALID" });
    try {
      const data = await deps.domainService.updateCoachingProgram({ workspaceId: req.auth.workspaceId, coachingProgramId: req.params.id, changes: req.body || {} });
      return res.json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.post("/programs/:id/archive", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid coaching program", code: "ID_INVALID" });
    try {
      const data = await deps.domainService.archiveCoachingProgram({ workspaceId: req.auth.workspaceId, coachingProgramId: req.params.id });
      return res.json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.patch("/programs/:id/skool-mapping", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid coaching program", code: "ID_INVALID" });
    try { return res.json({ success: true, data: await deps.skoolIntegrationService.saveProgramMapping({ ...req.body, workspaceId: req.auth.workspaceId, coachingProgramId: req.params.id }, deps) }); }
    catch (error) { return errorResponse(error, res); }
  }));

  router.get("/enrollments", asyncRoute(async (req, res) => {
    const filter = { workspaceId: req.auth.workspaceId };
    if (!isAdminRole(req.auth.role)) {
      const access = await deps.coachingAuthorization.resolveCoachingAccess(req);
      filter._id = { $in: access.enrollmentIds };
    }
    if (req.query.programId && validId(req.query.programId)) filter.coachingProgramId = req.query.programId;
    if (req.query.status) filter.status = req.query.status;
    const from = dateValue(req.query.startsFrom); const to = dateValue(req.query.startsTo);
    if (from || to) filter.startsAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    if (isAdminRole(req.auth.role) && req.query.coachProfileId && validId(req.query.coachProfileId)) {
      const linked = await deps.CoachAssignment.find({ workspaceId: req.auth.workspaceId, coachProfileId: req.query.coachProfileId }).select("enrollmentId").lean();
      filter._id = { $in: linked.map((item) => item.enrollmentId) };
    }
    const search = String(req.query.search || "").trim().slice(0, 120);
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const contacts = await deps.Contact.find({ workspaceId: req.auth.workspaceId, $or: [{ name: { $regex: escaped, $options: "i" } }, { email: { $regex: escaped, $options: "i" } }] }).select("_id").limit(500).lean();
      filter.contactId = { $in: contacts.map((item) => item._id) };
    }
    let query = deps.Enrollment.find(filter)
      .populate("contactId", CONTACT_FIELDS)
      .populate("coachingProgramId", "name status duration stages version")
      .sort({ startsAt: -1, createdAt: -1 }).limit(safeLimit(req.query.limit));
    if (!isAdminRole(req.auth.role)) query = query.select("contactId coachingProgramId status startsAt expectedEndAt completedAt currentStageKey programVersion externalRefs.skoolStatus externalRefs.skoolJoinedAt externalRefs.skoolInvitedAt externalRefs.skoolLastSyncedAt");
    const data = await query.lean();
    return res.json({ success: true, data });
  }));

  router.get("/enrollments/:id", asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid enrollment", code: "ID_INVALID" });
    const filter = { _id: req.params.id, workspaceId: req.auth.workspaceId };
    if (!isAdminRole(req.auth.role)) {
      const access = await deps.coachingAuthorization.resolveCoachingAccess(req);
      filter._id = { $in: access.enrollmentIds.filter((id) => String(id) === String(req.params.id)) };
    }
    let query = deps.Enrollment.findOne(filter).populate("contactId", CONTACT_FIELDS).populate("coachingProgramId", "name status duration stages version");
    if (!isAdminRole(req.auth.role)) query = query.select("contactId coachingProgramId status startsAt expectedEndAt completedAt currentStageKey programVersion externalRefs.skoolStatus externalRefs.skoolJoinedAt externalRefs.skoolInvitedAt externalRefs.skoolLastSyncedAt");
    const data = await query.lean();
    return data ? res.json({ success: true, data }) : res.status(404).json({ success: false, error: "Enrollment not found", code: "ENROLLMENT_NOT_FOUND" });
  }));

  router.post("/enrollments", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.body?.contactId) || !validId(req.body?.coachingProgramId)) return res.status(400).json({ success: false, error: "Valid Contact and Coaching Program are required", code: "ID_INVALID" });
    try {
      const data = await deps.domainService.createEnrollment({
        workspaceId: req.auth.workspaceId,
        contactId: req.body.contactId,
        coachingProgramId: req.body.coachingProgramId,
        sourceOpportunityId: req.body.sourceOpportunityId,
        status: req.body.status,
        startsAt: req.body.startsAt,
        expectedEndAt: req.body.expectedEndAt,
        currentStageKey: req.body.currentStageKey,
        createdBy: authenticatedUserId(req),
      });
      return res.status(201).json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.post("/enrollments/:id/transition", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid enrollment", code: "ID_INVALID" });
    try {
      const data = await deps.domainService.transitionEnrollment({ workspaceId: req.auth.workspaceId, enrollmentId: req.params.id, status: req.body?.status, currentStageKey: req.body?.currentStageKey, createdBy: authenticatedUserId(req) });
      return res.json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.post("/enrollments/:id/skool-access", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid enrollment", code: "ID_INVALID" });
    try {
      let data = await deps.skoolIntegrationService.createAccessRequest({ workspaceId: req.auth.workspaceId, enrollmentId: req.params.id, actorUserId: authenticatedUserId(req) }, deps);
      if (req.body?.dispatch === true) data = await deps.skoolIntegrationService.dispatch(data, req.auth.workspaceId, deps);
      return res.status(201).json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.get("/assignments", asyncRoute(async (req, res) => {
    const filter = { workspaceId: req.auth.workspaceId };
    if (!isAdminRole(req.auth.role)) {
      const access = await deps.coachingAuthorization.resolveCoachingAccess(req);
      filter._id = { $in: access.assignmentIds };
    } else if (req.query.coachProfileId && validId(req.query.coachProfileId)) filter.coachProfileId = req.query.coachProfileId;
    if (req.query.enrollmentId && validId(req.query.enrollmentId)) filter.enrollmentId = req.query.enrollmentId;
    if (req.query.programId && validId(req.query.programId)) {
      const programEnrollments = await deps.Enrollment.find({ workspaceId: req.auth.workspaceId, coachingProgramId: req.query.programId }).select("_id").lean();
      const programEnrollmentIds = programEnrollments.map((item) => item._id);
      if (filter.enrollmentId && !filter.enrollmentId.$in) {
        filter.enrollmentId = { $in: programEnrollmentIds.filter((id) => String(id) === String(filter.enrollmentId)) };
      } else {
        filter.enrollmentId = { $in: programEnrollmentIds };
      }
    }
    if (req.query.status) filter.status = req.query.status;
    const now = new Date();
    if (req.query.view === "current") Object.assign(filter, { status: "active", startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gt: now } }] });
    if (req.query.view === "upcoming") Object.assign(filter, { status: "scheduled", startsAt: { $gte: now } });
    if (req.query.view === "history") filter.status = { $in: ["completed", "cancelled"] };
    const data = await deps.CoachAssignment.find(filter)
      .populate({ path: "coachProfileId", populate: { path: "userId", select: "name email" } })
      .populate({ path: "enrollmentId", select: "contactId coachingProgramId status startsAt expectedEndAt completedAt currentStageKey programVersion", populate: [{ path: "contactId", select: CONTACT_FIELDS }, { path: "coachingProgramId", select: "name status duration stages version" }] })
      .sort({ startsAt: 1, createdAt: 1 }).limit(safeLimit(req.query.limit)).lean();
    return res.json({ success: true, data });
  }));

  router.get("/assignments/:id", asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid coach assignment", code: "ID_INVALID" });
    const filter = { _id: req.params.id, workspaceId: req.auth.workspaceId };
    if (!isAdminRole(req.auth.role)) {
      const access = await deps.coachingAuthorization.resolveCoachingAccess(req);
      filter._id = { $in: access.assignmentIds.filter((id) => String(id) === String(req.params.id)) };
    }
    const data = await deps.CoachAssignment.findOne(filter)
      .populate({ path: "coachProfileId", select: "displayName userId status", populate: { path: "userId", select: "name email" } })
      .populate({ path: "enrollmentId", select: "contactId coachingProgramId status startsAt expectedEndAt completedAt currentStageKey programVersion", populate: [{ path: "contactId", select: CONTACT_FIELDS }, { path: "coachingProgramId", select: "name status duration stages version" }] })
      .lean();
    return data ? res.json({ success: true, data }) : res.status(404).json({ success: false, error: "Coach assignment not found", code: "ASSIGNMENT_NOT_FOUND" });
  }));

  router.post("/assignments", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.body?.enrollmentId) || !validId(req.body?.coachProfileId)) return res.status(400).json({ success: false, error: "Valid Enrollment and Coach are required", code: "ID_INVALID" });
    try {
      const data = await deps.assignmentService.createCoachAssignment({
        workspaceId: req.auth.workspaceId,
        enrollmentId: req.body.enrollmentId,
        coachProfileId: req.body.coachProfileId,
        stageKey: req.body.stageKey,
        sequence: req.body.sequence,
        startsAt: req.body.startsAt,
        endsAt: req.body.endsAt,
        createdBy: authenticatedUserId(req),
      });
      return res.status(201).json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.post("/assignments/:id/complete", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid coach assignment", code: "ID_INVALID" });
    try {
      const data = await deps.assignmentService.completeCoachAssignment({ workspaceId: req.auth.workspaceId, coachAssignmentId: req.params.id, createdBy: authenticatedUserId(req) });
      return res.json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.post("/assignments/:id/transition", requireAdmin, asyncRoute(async (req, res) => {
    if (!validId(req.params.id) || !validId(req.body?.coachProfileId)) return res.status(400).json({ success: false, error: "Valid assignment and next coach are required", code: "ID_INVALID" });
    try {
      const data = await deps.assignmentService.transitionCoachAssignment({
        workspaceId: req.auth.workspaceId,
        currentAssignmentId: req.params.id,
        next: { coachProfileId: req.body.coachProfileId, stageKey: req.body.stageKey, sequence: req.body.sequence, startsAt: req.body.startsAt, endsAt: req.body.endsAt },
        createdBy: authenticatedUserId(req),
      });
      return res.json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.get("/students/:contactId/notes", asyncRoute(async (req, res) => {
    if (!validId(req.params.contactId)) return res.status(400).json({ success: false, error: "Invalid student Contact", code: "ID_INVALID" });
    const actor = await historyActor(req, deps);
    const filter = { workspaceId: req.auth.workspaceId, contactId: req.params.contactId };
    if (!isAdminRole(req.auth.role)) {
      if (!actor.access.contactIds.some((id) => String(id) === String(req.params.contactId))) return res.status(404).json({ success: false, error: "Coaching student not found", code: "STUDENT_NOT_FOUND" });
      filter.enrollmentId = { $in: actor.access.enrollmentIds };
    }
    if (req.query.enrollmentId && validId(req.query.enrollmentId)) {
      if (filter.enrollmentId?.$in && !filter.enrollmentId.$in.some((id) => String(id) === String(req.query.enrollmentId))) return res.json({ success: true, data: [] });
      filter.enrollmentId = req.query.enrollmentId;
    }
    const data = await deps.CoachingNote.find(filter)
      .populate("authorUserId", "name email")
      .populate("authorCoachProfileId", "displayName")
      .populate("coachAssignmentId", "stageKey status startsAt endsAt")
      .sort({ createdAt: -1 }).limit(safeLimit(req.query.limit)).lean();
    return res.json({ success: true, data });
  }));

  router.post("/students/:contactId/notes", asyncRoute(async (req, res) => {
    if (!validId(req.params.contactId) || !validId(req.body?.enrollmentId) || (req.body?.coachAssignmentId && !validId(req.body.coachAssignmentId))) return res.status(400).json({ success: false, error: "Valid Contact, Enrollment and optional Assignment are required", code: "ID_INVALID" });
    try {
      const data = await deps.historyService.createNote({
        workspaceId: req.auth.workspaceId, contactId: req.params.contactId, enrollmentId: req.body.enrollmentId,
        coachAssignmentId: req.body.coachAssignmentId || null, category: req.body.category, body: req.body.body,
      }, await historyActor(req, deps));
      return res.status(201).json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.patch("/notes/:id", asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid coaching note", code: "ID_INVALID" });
    try {
      const data = await deps.historyService.updateNote({ workspaceId: req.auth.workspaceId, noteId: req.params.id, body: req.body?.body, category: req.body?.category }, await historyActor(req, deps));
      return res.json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.get("/students/:contactId/handoffs", asyncRoute(async (req, res) => {
    if (!validId(req.params.contactId)) return res.status(400).json({ success: false, error: "Invalid student Contact", code: "ID_INVALID" });
    const actor = await historyActor(req, deps);
    const filter = { workspaceId: req.auth.workspaceId, contactId: req.params.contactId };
    if (!isAdminRole(req.auth.role)) {
      if (!actor.access.contactIds.some((id) => String(id) === String(req.params.contactId))) return res.status(404).json({ success: false, error: "Coaching student not found", code: "STUDENT_NOT_FOUND" });
      filter.enrollmentId = { $in: actor.access.enrollmentIds };
    }
    const data = await deps.CoachingHandoff.find(filter)
      .populate("fromCoachProfileId", "displayName")
      .populate("toCoachProfileId", "displayName")
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 }).limit(safeLimit(req.query.limit)).lean();
    return res.json({ success: true, data });
  }));

  router.get("/assignments/:id/handoff", asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid coach assignment", code: "ID_INVALID" });
    const actor = await historyActor(req, deps);
    if (!isAdminRole(req.auth.role) && !actor.access.assignmentIds.some((id) => String(id) === String(req.params.id))) return res.status(404).json({ success: false, error: "Coach assignment not found", code: "ASSIGNMENT_NOT_FOUND" });
    const data = await deps.CoachingHandoff.findOne({ workspaceId: req.auth.workspaceId, fromAssignmentId: req.params.id }).lean();
    return data ? res.json({ success: true, data }) : res.status(404).json({ success: false, error: "Handoff not found", code: "HANDOFF_NOT_FOUND" });
  }));

  router.post("/assignments/:id/handoff", asyncRoute(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "Invalid coach assignment", code: "ID_INVALID" });
    try {
      const data = await deps.historyService.upsertHandoff({
        workspaceId: req.auth.workspaceId, fromAssignmentId: req.params.id, summary: req.body?.summary,
        progress: req.body?.progress, observations: req.body?.observations, actionItems: req.body?.actionItems, submit: Boolean(req.body?.submit),
      }, await historyActor(req, deps));
      return res.status(data.createdAt?.getTime?.() === data.updatedAt?.getTime?.() ? 201 : 200).json({ success: true, data });
    } catch (error) { return errorResponse(error, res); }
  }));

  router.get("/referral-identities", asyncRoute(async (req, res) => {
    const filter = { workspaceId: req.auth.workspaceId };
    if (!isAdminRole(req.auth.role)) filter.userId = authenticatedUserId(req);
    const data = await deps.CoachProfile.find(filter).populate("userId", "name email avatarUrl").sort({ displayName: 1 }).lean();
    return res.json({ success: true, data });
  }));
  router.patch("/coaches/:id/referral-identity", requireAdmin, asyncRoute(async (req, res) => { try { const data = await deps.referralCommissionService.setReferralIdentity({ workspaceId: req.auth.workspaceId, coachProfileId: req.params.id, referralCode: req.body?.referralCode, referralSlug: req.body?.referralSlug, actorUserId: authenticatedUserId(req) }); return res.json({ success: true, data }); } catch (error) { return errorResponse(error, res); } }));
  router.get("/referrals", asyncRoute(async (req, res) => {
    const filter = { workspaceId: req.auth.workspaceId };
    if (!isAdminRole(req.auth.role)) { const profile = await deps.CoachProfile.findOne({ workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req) }).lean(); if (!profile) return res.json({ success: true, data: [] }); filter.coachProfileId = profile._id; }
    if (req.query.coachProfileId && isAdminRole(req.auth.role)) filter.coachProfileId = req.query.coachProfileId;
    const data = await deps.ReferralAttribution.find(filter).populate("contactId", CONTACT_FIELDS).populate("coachProfileId", "displayName referralCode referralSlug").sort({ attributedAt: -1 }).limit(safeLimit(req.query.limit)).lean();
    const revenueRows = await deps.CommissionLedger.find({ workspaceId: req.auth.workspaceId, contactId: { $in: data.map((item) => item.contactId?._id || item.contactId) }, ...(filter.coachProfileId ? { coachProfileId: filter.coachProfileId } : {}) }).select("contactId coachProfileId grossAmountMinor currency productLabel coachingProgramId status").lean();
    const enriched = data.map((item) => { const matching = revenueRows.filter((row) => String(row.contactId) === String(item.contactId?._id || item.contactId) && String(row.coachProfileId) === String(item.coachProfileId?._id || item.coachProfileId)); return { ...item, referredRevenueMinor: matching.filter((row) => row.status !== "reversed").reduce((sum, row) => sum + row.grossAmountMinor, 0), currency: matching[0]?.currency || "USD", products: [...new Set(matching.map((row) => row.productLabel).filter(Boolean))] }; });
    return res.json({ success: true, data: enriched });
  }));
  router.post("/referrals", requireAdmin, asyncRoute(async (req, res) => { try { const data = await deps.referralCommissionService.attributeReferral({ workspaceId: req.auth.workspaceId, contactId: req.body?.contactId, referralCode: req.body?.referralCode, source: req.body?.source || "manual", actorUserId: authenticatedUserId(req), correct: Boolean(req.body?.correct), correctionReason: req.body?.correctionReason || "" }); return res.status(201).json({ success: true, data }); } catch (error) { return errorResponse(error, res); } }));
  router.get("/commission-rules", requireAdmin, asyncRoute(async (req, res) => { const data = await deps.CommissionRule.find({ workspaceId: req.auth.workspaceId }).populate("coachProfileId", "displayName").populate("coachingProgramId", "name").sort({ scope: 1, label: 1 }).lean(); return res.json({ success: true, data }); }));
  router.post("/commission-rules", requireAdmin, asyncRoute(async (req, res) => { try { const data = await deps.referralCommissionService.saveRule({ ...req.body, workspaceId: req.auth.workspaceId, actorUserId: authenticatedUserId(req) }); return res.status(201).json({ success: true, data }); } catch (error) { return errorResponse(error, res); } }));
  router.get("/commissions", asyncRoute(async (req, res) => { const filter = { workspaceId: req.auth.workspaceId }; if (!isAdminRole(req.auth.role)) filter.coachUserId = authenticatedUserId(req); else if (req.query.coachProfileId) filter.coachProfileId = req.query.coachProfileId; if (req.query.status) filter.status = req.query.status; if (req.query.coachingProgramId) filter.coachingProgramId = req.query.coachingProgramId; const data = await deps.CommissionLedger.find(filter).populate("contactId", CONTACT_FIELDS).populate("coachProfileId", "displayName referralCode").populate("coachingProgramId", "name").sort({ calculatedAt: -1 }).limit(safeLimit(req.query.limit)).lean(); return res.json({ success: true, data }); }));
  router.patch("/commissions/:id/status", requireAdmin, asyncRoute(async (req, res) => { try { const data = await deps.referralCommissionService.transitionCommission({ workspaceId: req.auth.workspaceId, commissionId: req.params.id, status: req.body?.status, reason: req.body?.reason || "", actorUserId: authenticatedUserId(req) }); return res.json({ success: true, data }); } catch (error) { return errorResponse(error, res); } }));

  router.get("/students/:contactId", asyncRoute(async (req, res) => {
    if (!validId(req.params.contactId)) return res.status(400).json({ success: false, error: "Invalid student Contact", code: "ID_INVALID" });
    const access = isAdminRole(req.auth.role) ? null : await deps.coachingAuthorization.resolveCoachingAccess(req);
    if (access && !access.contactIds.some((id) => String(id) === String(req.params.contactId))) {
      return res.status(404).json({ success: false, error: "Coaching student not found", code: "STUDENT_NOT_FOUND" });
    }
    const contact = await deps.Contact.findOne({ _id: req.params.contactId, workspaceId: req.auth.workspaceId }).select(CONTACT_FIELDS).lean();
    if (!contact) return res.status(404).json({ success: false, error: "Coaching student not found", code: "STUDENT_NOT_FOUND" });
    const enrollmentFilter = { workspaceId: req.auth.workspaceId, contactId: contact._id };
    const assignmentFilter = { workspaceId: req.auth.workspaceId, contactId: contact._id };
    if (access) {
      enrollmentFilter._id = { $in: access.enrollmentIds };
      assignmentFilter._id = { $in: access.assignmentIds };
    }
    const studentProgramFields = access ? PROGRAM_COACH_FIELDS : "name status duration stages version skoolMapping";
    let enrollmentQuery = deps.Enrollment.find(enrollmentFilter).populate("coachingProgramId", studentProgramFields).sort({ startsAt: -1 });
    if (access) enrollmentQuery = enrollmentQuery.select("coachingProgramId status startsAt expectedEndAt completedAt currentStageKey programVersion externalRefs.skoolStatus externalRefs.skoolJoinedAt externalRefs.skoolInvitedAt externalRefs.skoolLastSyncedAt");
    const noteFilter = { workspaceId: req.auth.workspaceId, contactId: contact._id };
    const handoffFilter = { workspaceId: req.auth.workspaceId, contactId: contact._id };
    const communicationFilter = { workspaceId: req.auth.workspaceId, contactId: contact._id, direction: { $in: ["inbound", "outbound"] } };
    if (access) { noteFilter.enrollmentId = { $in: access.enrollmentIds }; handoffFilter.enrollmentId = { $in: access.enrollmentIds }; }
    if (access) {
      const coachingThreads = await deps.ConversationThread.find({ workspaceId: req.auth.workspaceId, contactIds: contact._id, tags: "coaching-communication" }).select("_id").lean();
      communicationFilter.threadId = { $in: coachingThreads.map((thread) => thread._id) };
    }
    const [enrollments, coachAssignments, coachingNotes, coachingHandoffs, coachingActivities, communicationMessages] = await Promise.all([
      enrollmentQuery.lean(),
      deps.CoachAssignment.find(assignmentFilter).populate("coachProfileId", "displayName userId status").sort({ startsAt: -1 }).lean(),
      deps.CoachingNote.find(noteFilter).populate("authorUserId", "name email").populate("authorCoachProfileId", "displayName").populate("coachAssignmentId", "stageKey status startsAt endsAt").sort({ createdAt: -1 }).limit(200).lean(),
      deps.CoachingHandoff.find(handoffFilter).populate("fromCoachProfileId", "displayName").populate("toCoachProfileId", "displayName").sort({ createdAt: -1 }).limit(200).lean(),
      deps.CrmActivity.find({ workspaceId: req.auth.workspaceId, contactId: contact._id, "metadata.eventType": { $regex: "^(coaching\\.|coach\\.assignment)" } }).sort({ occurredAt: -1, createdAt: -1 }).limit(200).lean(),
      deps.ConversationMessage.find(communicationFilter).select("channel direction subject body deliveryStatus sentAt receivedAt metadata").sort({ createdAt: -1 }).limit(100).lean(),
    ]);
    const allowedEnrollmentIds = access ? new Set(access.enrollmentIds.map(String)) : null;
    const visibleActivities = allowedEnrollmentIds ? coachingActivities.filter((item) => !item.metadata?.enrollmentId || allowedEnrollmentIds.has(String(item.metadata.enrollmentId))) : coachingActivities;
    return res.json({ success: true, data: { contact, enrollments, coachAssignments, coachingNotes, coachingHandoffs, coachingActivities: visibleActivities, communicationMessages } });
  }));

  /**
   * POST /coaching/students/:contactId/ai-summary
   * Coaching Agent: read this student's enrollment(s), coach assignment(s),
   * recent notes, and recent activity, and produce a session-prep brief.
   * Read-only — proposes nothing, changes nothing.
   */
  router.post("/students/:contactId/ai-summary", asyncRoute(async (req, res) => {
    if (!validId(req.params.contactId)) return res.status(400).json({ success: false, error: "Invalid student Contact", code: "ID_INVALID" });
    const access = isAdminRole(req.auth.role) ? null : await deps.coachingAuthorization.resolveCoachingAccess(req);
    if (access && !access.contactIds.some((id) => String(id) === String(req.params.contactId))) {
      return res.status(404).json({ success: false, error: "Coaching student not found", code: "STUDENT_NOT_FOUND" });
    }
    const contact = await deps.Contact.findOne({ _id: req.params.contactId, workspaceId: req.auth.workspaceId }).select(CONTACT_FIELDS).lean();
    if (!contact) return res.status(404).json({ success: false, error: "Coaching student not found", code: "STUDENT_NOT_FOUND" });
    const enrollmentFilter = { workspaceId: req.auth.workspaceId, contactId: contact._id };
    const assignmentFilter = { workspaceId: req.auth.workspaceId, contactId: contact._id };
    if (access) { enrollmentFilter._id = { $in: access.enrollmentIds }; assignmentFilter._id = { $in: access.assignmentIds }; }
    const [enrollments, coachAssignments, coachingNotes] = await Promise.all([
      deps.Enrollment.find(enrollmentFilter).populate("coachingProgramId", "name").select("coachingProgramId status startsAt expectedEndAt completedAt currentStageKey").sort({ startsAt: -1 }).limit(10).lean(),
      deps.CoachAssignment.find(assignmentFilter).populate("coachProfileId", "displayName").select("coachProfileId status stageKey startsAt endsAt").sort({ startsAt: -1 }).limit(10).lean(),
      deps.CoachingNote.find({ workspaceId: req.auth.workspaceId, contactId: contact._id, ...(access ? { enrollmentId: { $in: access.enrollmentIds } } : {}) }).select("body createdAt authorCoachProfileId").populate("authorCoachProfileId", "displayName").sort({ createdAt: -1 }).limit(10).lean(),
    ]);
    const context = {
      student: { displayName: contact.name, status: contact.status },
      enrollments: enrollments.map((item) => ({ program: item.coachingProgramId?.name || "Unknown program", status: item.status, currentStageKey: item.currentStageKey, startsAt: item.startsAt, expectedEndAt: item.expectedEndAt, completedAt: item.completedAt })),
      coachAssignments: coachAssignments.map((item) => ({ coach: item.coachProfileId?.displayName || "Unassigned", status: item.status, stageKey: item.stageKey })),
      recentNotes: coachingNotes.map((item) => ({ author: item.authorCoachProfileId?.displayName || "Coach", at: item.createdAt, note: String(item.body || "").slice(0, 1000) })),
    };
    try {
      const result = await deps.agentExecutionService.runAgent({
        workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req), auth: req.auth, agent: "coaching", task: "summarize_student",
        input: {},
        operationalContext: `Base every claim strictly on the supplied student context. Do not invent progress, sessions, or facts absent from the data. If notes or enrollments are empty, say so plainly rather than speculating. Student context: ${JSON.stringify(context)}`,
        correlationId: `coaching-summary:${contact._id}`,
        options: {
          responseSchema: { type: "object", properties: { summary: { type: "string" }, currentStanding: { type: "string" }, suggestedFocusAreas: { type: "array", items: { type: "string" } }, riskFlags: { type: "array", items: { type: "string" } } }, required: ["summary", "currentStanding", "suggestedFocusAreas", "riskFlags"], additionalProperties: false },
          schemaName: "student_summary",
        },
      });
      return res.json({ success: true, data: result.output, metadata: result.metadata });
    } catch (err) {
      const isBillingLimit = err.status === 429 || err.statusCode === 429;
      const status = isBillingLimit ? 429 : ["AGENT_CAPABILITY_FORBIDDEN", "AGENT_WORKSPACE_FORBIDDEN"].includes(err.code) ? 403 : ["AGENT_UNKNOWN", "AGENT_STRUCTURED_OUTPUT_FORBIDDEN", "AGENT_TEXT_OUTPUT_FORBIDDEN"].includes(err.code) ? 400 : 500;
      return res.status(status).json({ success: false, error: isBillingLimit ? "OpenAI credits are empty. Add API credits to use AI session-prep summaries." : err.message, code: err.code || "COACHING_AGENT_SUMMARY_FAILED" });
    }
  }));

  /**
   * GET /coaching/success-patterns
   * Aggregated, anonymized enrollment outcome patterns (completion rates, common
   * drop-off stages, per-program breakdown). Never individual student data.
   */
  router.get("/success-patterns", requireAdmin, asyncRoute(async (req, res) => {
    const patterns = await deps.coachingSuccessPatternsService.getSuccessPatterns(req.auth.workspaceId);
    return res.json({ success: true, data: patterns });
  }));

  /**
   * POST /coaching/success-patterns/summarize
   * Coaching Agent: turn the same aggregated, anonymized patterns into a
   * written brief. Read-only — proposes nothing, changes nothing.
   */
  router.post("/success-patterns/summarize", requireAdmin, asyncRoute(async (req, res) => {
    try {
      const result = await deps.agentExecutionService.runAgent({
        workspaceId: req.auth.workspaceId, userId: authenticatedUserId(req), auth: req.auth, agent: "coaching", task: "summarize_success_patterns",
        input: {},
        operationalContext: "Base every claim strictly on the supplied aggregated, anonymized enrollment data. Do not invent students, names, or specifics beyond the aggregate counts. Never speculate about a specific individual.",
        correlationId: `coaching-success-patterns:${req.auth.workspaceId}`,
        options: {
          tools: [{ toolId: "coaching.get_success_patterns", input: {} }],
          responseSchema: { type: "object", properties: { summary: { type: "string" }, strengths: { type: "array", items: { type: "string" } }, riskAreas: { type: "array", items: { type: "string" } } }, required: ["summary", "strengths", "riskAreas"], additionalProperties: false },
          schemaName: "coaching_success_patterns_summary",
        },
      });
      return res.json({ success: true, data: result.output, metadata: result.metadata });
    } catch (err) {
      const isBillingLimit = err.status === 429 || err.statusCode === 429;
      const status = isBillingLimit ? 429 : ["AGENT_CAPABILITY_FORBIDDEN", "AGENT_WORKSPACE_FORBIDDEN"].includes(err.code) ? 403 : ["AGENT_UNKNOWN", "AGENT_STRUCTURED_OUTPUT_FORBIDDEN", "AGENT_TEXT_OUTPUT_FORBIDDEN"].includes(err.code) ? 400 : 500;
      return res.status(status).json({ success: false, error: isBillingLimit ? "OpenAI credits are empty. Add API credits to use the AI summary." : err.message, code: err.code || "COACHING_AGENT_SUCCESS_PATTERNS_FAILED" });
    }
  }));

  return router;
}

const router = createCoachingRouter();
module.exports = router;
module.exports.createCoachingRouter = createCoachingRouter;
