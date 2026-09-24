const crypto = require("crypto");
const IntegrationConnection = require("../models/IntegrationConnection");
const CoachProfile = require("../models/CoachProfile");
const CoachingSession = require("../models/CoachingSession");
const Enrollment = require("../models/Enrollment");
const Contact = require("../models/Contact");
const CrmActivity = require("../models/CrmActivity");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const { encryptCredentials, decryptCredentials } = require("../utils/credentialEncryption");

const PROVIDER = "google_calendar";
const SCOPES = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

const dependencies = { IntegrationConnection, CoachProfile, CoachingSession, Enrollment, Contact, CrmActivity, WorkspaceMembership };

function calendarError(message, code) { const error = new Error(message); error.code = code; return error; }
function required(name) { const value = String(process.env[name] || "").trim(); if (!value) throw calendarError(`${name} is not configured`, "CALENDAR_CONFIG_MISSING"); return value; }
function redirectUri() { return required("GOOGLE_CALENDAR_REDIRECT_URI"); }
function stateSecret() { return required("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY"); }

function createState({ workspaceId, userId, coachProfileId, returnOrigin = "" }) {
  if (!workspaceId || !userId || !coachProfileId) throw calendarError("A signed-in coach profile is required", "CALENDAR_IDENTITY_REQUIRED");
  const payload = Buffer.from(JSON.stringify({ workspaceId: String(workspaceId), userId: String(userId), coachProfileId: String(coachProfileId), returnOrigin: String(returnOrigin || ""), createdAt: Date.now(), nonce: crypto.randomBytes(16).toString("hex") })).toString("base64url");
  const signature = crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyState(value) {
  try {
    const [payload, signature] = String(value || "").split(".");
    if (!payload || !signature) return null;
    const expected = crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Date.now() - Number(parsed.createdAt) < 10 * 60 * 1000 && parsed.workspaceId && parsed.userId && parsed.coachProfileId ? parsed : null;
  } catch { return null; }
}

function authorizationUrl(identity, { returnOrigin = "" } = {}) {
  const params = new URLSearchParams({
    client_id: required("GOOGLE_CALENDAR_CLIENT_ID"), redirect_uri: redirectUri(), response_type: "code",
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", scope: SCOPES.join(" "), state: createState({ ...identity, returnOrigin }),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function jsonRequest(url, options, fallback) {
  const response = await fetch(url, options); const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw calendarError(data.error?.message || data.error_description || fallback, "GOOGLE_CALENDAR_REQUEST_FAILED");
  return data;
}

const googleAdapter = {
  async exchangeCode(code) {
    return jsonRequest("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: required("GOOGLE_CALENDAR_CLIENT_ID"), client_secret: required("GOOGLE_CALENDAR_CLIENT_SECRET"), redirect_uri: redirectUri(), grant_type: "authorization_code" }) }, "Google token exchange failed");
  },
  async profile(accessToken) { return jsonRequest("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } }, "Unable to read the connected Google account"); },
  async refresh(refreshToken) { return jsonRequest("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ refresh_token: refreshToken, client_id: required("GOOGLE_CALENDAR_CLIENT_ID"), client_secret: required("GOOGLE_CALENDAR_CLIENT_SECRET"), grant_type: "refresh_token" }) }, "Google Calendar access refresh failed"); },
  async request(accessToken, path, options = {}) { return jsonRequest(`https://www.googleapis.com/calendar/v3${path}`, { ...options, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(options.headers || {}) } }, "Google Calendar request failed"); },
};

function connectionFilter({ workspaceId, userId, coachProfileId }) {
  return { workspaceId, provider: PROVIDER, accountScope: "user", ownerUserId: userId, coachProfileId };
}

async function coachIdentity({ workspaceId, userId }, models = dependencies) {
  const coach = await models.CoachProfile.findOne({ workspaceId, userId });
  if (!coach || coach.status !== "active") throw calendarError("Active coach profile not found", "COACH_NOT_FOUND");
  return { workspaceId, userId, coachProfileId: coach._id, coach };
}

async function validateStateIdentity(state, models = dependencies) {
  const membership = await models.WorkspaceMembership.findOne({ workspaceId: state.workspaceId, userId: state.userId, status: "active", $or: [{ role: "coach" }, { roles: "coach" }] });
  const coach = await models.CoachProfile.findOne({ _id: state.coachProfileId, workspaceId: state.workspaceId, userId: state.userId, status: "active" });
  if (!membership || !coach) throw calendarError("Coach access is no longer available", "CALENDAR_IDENTITY_FORBIDDEN");
  return { workspaceId: state.workspaceId, userId: state.userId, coachProfileId: state.coachProfileId, coach };
}

async function saveConnection(identity, tokens, profile, models = dependencies, cryptoOps = { encryptCredentials, decryptCredentials }) {
  const filter = connectionFilter(identity);
  const existing = await models.IntegrationConnection.findOne(filter).select("+credentialsEncrypted");
  const previous = existing?.credentialsEncrypted ? cryptoOps.decryptCredentials(existing.credentialsEncrypted) : {};
  const encrypted = cryptoOps.encryptCredentials({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token || previous.refreshToken });
  const connection = await models.IntegrationConnection.findOneAndUpdate(filter, { $set: {
    ...filter, status: "connected", credentialsEncrypted: encrypted,
    settings: { ...(existing?.settings || {}), email: profile.email || "", name: profile.name || "", selectedCalendarId: existing?.settings?.selectedCalendarId || "primary", timezone: existing?.settings?.timezone || identity.coach?.timezone || "UTC" },
    oauth: { scopes: String(tokens.scope || SCOPES.join(" ")).split(" ").filter(Boolean), expiresAt: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000), providerAccountId: profile.sub || "" },
    connectedAt: new Date(), lastVerifiedAt: new Date(), lastError: null,
  } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  await models.CrmActivity.create({ workspaceId: identity.workspaceId, type: "system", title: "Google Calendar connected", body: `${identity.coach.displayName || "Coach"} connected a coach-owned calendar.`, source: "integration", createdBy: identity.userId, metadata: { eventType: "google.calendar.connected", coachProfileId: identity.coachProfileId, connectionId: connection._id } });
  return connection;
}

function publicConnection(connection) {
  return { configured: Boolean(process.env.GOOGLE_CALENDAR_CLIENT_ID && process.env.GOOGLE_CALENDAR_CLIENT_SECRET && process.env.GOOGLE_CALENDAR_REDIRECT_URI && process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY), connected: connection?.status === "connected", connectionId: connection?._id || null, coachProfileId: connection?.coachProfileId || null, email: connection?.settings?.email || "", name: connection?.settings?.name || "", selectedCalendarId: connection?.settings?.selectedCalendarId || "", timezone: connection?.settings?.timezone || "UTC", connectedAt: connection?.connectedAt || null };
}

async function ownStatus(identity, models = dependencies) { return publicConnection(await models.IntegrationConnection.findOne(connectionFilter(identity))); }

async function disconnect(identity, models = dependencies) {
  const connection = await models.IntegrationConnection.findOneAndUpdate(connectionFilter(identity), { $set: { status: "disconnected", credentialsEncrypted: null, connectedAt: null, oauth: {} } }, { new: true });
  if (connection) await models.CrmActivity.create({ workspaceId: identity.workspaceId, type: "system", title: "Google Calendar disconnected", body: `${identity.coach.displayName || "Coach"} disconnected their coach-owned calendar.`, source: "integration", createdBy: identity.userId, metadata: { eventType: "google.calendar.disconnected", coachProfileId: identity.coachProfileId, connectionId: connection._id } });
  return publicConnection(connection);
}

async function accessToken(connection, adapter = googleAdapter, cryptoOps = { encryptCredentials, decryptCredentials }) {
  const credentials = cryptoOps.decryptCredentials(connection.credentialsEncrypted);
  if (credentials.accessToken && new Date(connection.oauth?.expiresAt || 0).getTime() > Date.now() + 60000) return credentials.accessToken;
  if (!credentials.refreshToken) throw calendarError("Reconnect Google Calendar to grant offline access", "CALENDAR_RECONNECT_REQUIRED");
  const refreshed = await adapter.refresh(credentials.refreshToken);
  connection.credentialsEncrypted = cryptoOps.encryptCredentials({ ...credentials, accessToken: refreshed.access_token });
  connection.oauth.expiresAt = new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000); connection.lastVerifiedAt = new Date(); await connection.save();
  return refreshed.access_token;
}

async function connectedConnection({ workspaceId, coachProfileId }, models = dependencies) {
  const connection = await models.IntegrationConnection.findOne({ workspaceId, provider: PROVIDER, accountScope: "user", coachProfileId, status: "connected" }).select("+credentialsEncrypted");
  if (!connection?.credentialsEncrypted) throw calendarError("This coach must connect Google Calendar first", "CALENDAR_NOT_CONNECTED");
  return connection;
}

async function listCalendars(identity, models = dependencies, adapter = googleAdapter, cryptoOps) {
  const connection = await connectedConnection(identity, models); const token = await accessToken(connection, adapter, cryptoOps);
  const result = await adapter.request(token, "/users/me/calendarList?minAccessRole=writer");
  return (result.items || []).map((item) => ({ id: item.id, summary: item.summary || item.id, primary: Boolean(item.primary), timezone: item.timeZone || "UTC", selected: item.id === connection.settings?.selectedCalendarId }));
}

async function selectCalendar(identity, selection, models = dependencies, adapter = googleAdapter, cryptoOps) {
  const calendars = await listCalendars(identity, models, adapter, cryptoOps); const selected = calendars.find((item) => item.id === selection.calendarId);
  if (!selected) throw calendarError("Choose a writable Google Calendar from the connected account", "CALENDAR_SELECTION_INVALID");
  const connection = await models.IntegrationConnection.findOneAndUpdate(connectionFilter(identity), { $set: { "settings.selectedCalendarId": selected.id, "settings.timezone": selected.timezone || selection.timezone || "UTC" } }, { new: true });
  return publicConnection(connection);
}

function eventPayload({ contact, enrollment, startsAt, durationMinutes, timezone, zoomJoinUrl = "" }) {
  const start = new Date(startsAt); const end = new Date(start.getTime() + durationMinutes * 60000);
  return { summary: `Coaching — ${contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Student"}`, description: [`Program: ${enrollment.programSnapshot?.name || "Coaching"}`, enrollment.currentStageKey ? `Stage: ${enrollment.currentStageKey}` : "", zoomJoinUrl ? `Join Zoom: ${zoomJoinUrl}` : ""].filter(Boolean).join("\n"), location: zoomJoinUrl || undefined, start: { dateTime: start.toISOString(), timeZone: timezone }, end: { dateTime: end.toISOString(), timeZone: timezone } };
}

async function scheduleDiscoveryCall(input, models = dependencies, adapter = googleAdapter, cryptoOps) {
  const connection = await connectedConnection(input, models);
  const token = await accessToken(connection, adapter, cryptoOps);
  const startsAt = new Date(input.startsAt);
  const durationMinutes = Number(input.durationMinutes || 30);
  const timezone = connection.settings?.timezone || "UTC";
  const calendarId = connection.settings?.selectedCalendarId || "primary";
  const end = new Date(startsAt.getTime() + durationMinutes * 60000);
  const requestId = crypto.randomUUID();
  const payload = {
    summary: `Discovery Call — ${input.name}`,
    description: [
      `Prospect: ${input.name}`,
      `Email: ${input.email}`,
      input.phone ? `Phone: ${input.phone}` : "",
      input.programName ? `Program interest: ${input.programName}` : "",
      input.qualificationSummary ? `Qualification: ${input.qualificationSummary}` : "",
      input.notes ? `Notes: ${input.notes}` : "",
    ].filter(Boolean).join("\n"),
    start: { dateTime: startsAt.toISOString(), timeZone: timezone },
    end: { dateTime: end.toISOString(), timeZone: timezone },
    attendees: [{ email: input.email, displayName: input.name }],
    conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } },
  };
  const event = await adapter.request(token, `/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`, { method: "POST", body: JSON.stringify(payload) });
  return { connection, calendarId, timezone, event, meetUrl: event.hangoutLink || event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri || "" };
}

async function validateSessionReferences(input, models = dependencies) {
  const enrollment = await models.Enrollment.findOne({ _id: input.enrollmentId, workspaceId: input.workspaceId });
  if (!enrollment) throw calendarError("Enrollment not found", "ENROLLMENT_NOT_FOUND");
  if (String(enrollment.contactId) !== String(input.contactId || enrollment.contactId)) throw calendarError("Contact does not match enrollment", "SESSION_REFERENCE_MISMATCH");
  const coach = await models.CoachProfile.findOne({ _id: input.coachProfileId, workspaceId: input.workspaceId, status: "active" });
  if (!coach) throw calendarError("Active coach not found", "COACH_NOT_FOUND");
  const contact = await models.Contact.findOne({ _id: enrollment.contactId, workspaceId: input.workspaceId });
  if (!contact) throw calendarError("Contact not found", "CONTACT_NOT_FOUND");
  return { enrollment, coach, contact };
}

async function availability({ workspaceId, coachProfileId, startsAt, durationMinutes }, models = dependencies, adapter = googleAdapter, cryptoOps) {
  const connection = await connectedConnection({ workspaceId, coachProfileId }, models); const token = await accessToken(connection, adapter, cryptoOps);
  const start = new Date(startsAt); const end = new Date(start.getTime() + Number(durationMinutes) * 60000); const calendarId = connection.settings?.selectedCalendarId || "primary";
  const result = await adapter.request(token, "/freeBusy", { method: "POST", body: JSON.stringify({ timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone: connection.settings?.timezone || "UTC", items: [{ id: calendarId }] }) });
  const busy = result.calendars?.[calendarId]?.busy || [];
  return { available: busy.length === 0, busy, calendarId, timezone: connection.settings?.timezone || "UTC" };
}

async function busyWindow({ workspaceId, coachProfileId, timeMin, timeMax }, models = dependencies, adapter = googleAdapter, cryptoOps) {
  const connection = await connectedConnection({ workspaceId, coachProfileId }, models);
  const token = await accessToken(connection, adapter, cryptoOps);
  const calendarId = connection.settings?.selectedCalendarId || "primary";
  const timezone = connection.settings?.timezone || "UTC";
  const result = await adapter.request(token, "/freeBusy", { method: "POST", body: JSON.stringify({ timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(), timeZone: timezone, items: [{ id: calendarId }] }) });
  return { busy: result.calendars?.[calendarId]?.busy || [], calendarId, timezone };
}

async function scheduleSession(input, models = dependencies, adapter = googleAdapter, cryptoOps) {
  const durationMinutes = Number(input.durationMinutes || 60); const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime()) || durationMinutes < 15 || durationMinutes > 480) throw calendarError("Valid start time and duration are required", "SESSION_INPUT_INVALID");
  const { enrollment, contact } = await validateSessionReferences(input, models); const connection = await connectedConnection(input, models); const token = await accessToken(connection, adapter, cryptoOps);
  const calendarId = connection.settings?.selectedCalendarId || "primary"; const timezone = connection.settings?.timezone || "UTC";
  const event = await adapter.request(token, `/calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", body: JSON.stringify(eventPayload({ contact, enrollment, startsAt, durationMinutes, timezone })) });
  const session = await models.CoachingSession.create({ workspaceId: input.workspaceId, contactId: enrollment.contactId, enrollmentId: enrollment._id, coachProfileId: input.coachProfileId, coachingProgramId: enrollment.coachingProgramId, stageKey: input.stageKey || enrollment.currentStageKey || "", startsAt, durationMinutes, timezone, status: "scheduled", calendar: { provider: PROVIDER, connectionId: connection._id, calendarId, eventId: event.id, htmlLink: event.htmlLink || "" }, createdBy: input.createdBy });
  await models.CrmActivity.create({ workspaceId: input.workspaceId, contactId: enrollment.contactId, type: "meeting", title: "Coaching session scheduled", body: `${startsAt.toISOString()} · ${durationMinutes} minutes`, source: "integration", createdBy: input.createdBy, metadata: { eventType: "coaching.session.scheduled", coachingSessionId: session._id, enrollmentId: enrollment._id, coachProfileId: input.coachProfileId } });
  return session;
}

async function rescheduleSession(input, models = dependencies, adapter = googleAdapter, cryptoOps) {
  const session = await models.CoachingSession.findOne({ _id: input.sessionId, workspaceId: input.workspaceId, status: "scheduled" });
  if (!session) throw calendarError("Scheduled coaching session not found", "SESSION_NOT_FOUND");
  const connection = await connectedConnection({ workspaceId: input.workspaceId, coachProfileId: session.coachProfileId }, models);
  if (String(connection._id) !== String(session.calendar.connectionId)) throw calendarError("The original coach calendar connection is unavailable", "CALENDAR_CONNECTION_MISMATCH");
  const enrollment = await models.Enrollment.findOne({ _id: session.enrollmentId, workspaceId: input.workspaceId }); const contact = await models.Contact.findOne({ _id: session.contactId, workspaceId: input.workspaceId });
  const startsAt = new Date(input.startsAt); const durationMinutes = Number(input.durationMinutes || session.durationMinutes); if (Number.isNaN(startsAt.getTime())) throw calendarError("Valid start time is required", "SESSION_INPUT_INVALID");
  const token = await accessToken(connection, adapter, cryptoOps); await adapter.request(token, `/calendars/${encodeURIComponent(session.calendar.calendarId)}/events/${encodeURIComponent(session.calendar.eventId)}`, { method: "PATCH", body: JSON.stringify(eventPayload({ contact, enrollment, startsAt, durationMinutes, timezone: session.timezone })) });
  session.startsAt = startsAt; session.durationMinutes = durationMinutes; session.updatedBy = input.updatedBy; await session.save();
  await models.CrmActivity.create({ workspaceId: input.workspaceId, contactId: session.contactId, type: "meeting", title: "Coaching session rescheduled", body: `${startsAt.toISOString()} · ${durationMinutes} minutes`, source: "integration", createdBy: input.updatedBy, metadata: { eventType: "coaching.session.rescheduled", coachingSessionId: session._id, enrollmentId: session.enrollmentId, coachProfileId: session.coachProfileId } }); return session;
}

async function cancelSession(input, models = dependencies, adapter = googleAdapter, cryptoOps) {
  const session = await models.CoachingSession.findOne({ _id: input.sessionId, workspaceId: input.workspaceId, status: "scheduled" }); if (!session) throw calendarError("Scheduled coaching session not found", "SESSION_NOT_FOUND");
  const connection = await connectedConnection({ workspaceId: input.workspaceId, coachProfileId: session.coachProfileId }, models); if (String(connection._id) !== String(session.calendar.connectionId)) throw calendarError("The original coach calendar connection is unavailable", "CALENDAR_CONNECTION_MISMATCH");
  const token = await accessToken(connection, adapter, cryptoOps); await adapter.request(token, `/calendars/${encodeURIComponent(session.calendar.calendarId)}/events/${encodeURIComponent(session.calendar.eventId)}`, { method: "DELETE" });
  session.status = "cancelled"; session.cancelledAt = new Date(); session.cancellationReason = String(input.reason || "").slice(0, 500); session.updatedBy = input.updatedBy; await session.save();
  await models.CrmActivity.create({ workspaceId: input.workspaceId, contactId: session.contactId, type: "meeting", title: "Coaching session cancelled", body: session.cancellationReason, source: "integration", createdBy: input.updatedBy, metadata: { eventType: "coaching.session.cancelled", coachingSessionId: session._id, enrollmentId: session.enrollmentId, coachProfileId: session.coachProfileId } }); return session;
}

async function syncVideoLink({ workspaceId, session }, models = dependencies, adapter = googleAdapter, cryptoOps) {
  const connection = await connectedConnection({ workspaceId, coachProfileId: session.coachProfileId }, models);
  if (String(connection._id) !== String(session.calendar.connectionId)) throw calendarError("The original coach calendar connection is unavailable", "CALENDAR_CONNECTION_MISMATCH");
  const enrollment = await models.Enrollment.findOne({ _id: session.enrollmentId, workspaceId }); const contact = await models.Contact.findOne({ _id: session.contactId, workspaceId });
  const token = await accessToken(connection, adapter, cryptoOps); await adapter.request(token, `/calendars/${encodeURIComponent(session.calendar.calendarId)}/events/${encodeURIComponent(session.calendar.eventId)}`, { method: "PATCH", body: JSON.stringify(eventPayload({ contact, enrollment, startsAt: session.startsAt, durationMinutes: session.durationMinutes, timezone: session.timezone, zoomJoinUrl: session.zoom?.joinUrl || "" })) }); return session;
}

module.exports = { PROVIDER, SCOPES, googleAdapter, createState, verifyState, authorizationUrl, coachIdentity, validateStateIdentity, saveConnection, publicConnection, ownStatus, disconnect, listCalendars, selectCalendar, availability, busyWindow, scheduleDiscoveryCall, scheduleSession, rescheduleSession, cancelSession, syncVideoLink, connectionFilter, eventPayload, _dependencies: dependencies };
