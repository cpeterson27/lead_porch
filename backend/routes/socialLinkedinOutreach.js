const express = require("express");
const { requireCapability } = require("../middleware/auth");
const unipile = require("../services/unipileService");
const outreachEngine = require("../services/linkedinOutreachEngineService");
const sequenceService = require("../services/linkedinSequenceService");
const SocialConnection = require("../models/SocialConnection");
const Contact = require("../models/Contact");
const LinkedinSequence = require("../models/LinkedinSequence");
const LinkedinSequenceEnrollment = require("../models/LinkedinSequenceEnrollment");
const ConversationMessage = require("../models/ConversationMessage");

const router = express.Router();
const PROVIDER = "linkedin_unipile";

function backendBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BACKEND_URL || process.env.BACKEND_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  const host = req.get("x-forwarded-host") || req.get("host");
  const protocol = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${protocol}://${host}`.replace(/\/$/, "");
}

function webhookToken() {
  return String(process.env.UNIPILE_WEBHOOK_TOKEN || "").trim();
}

function frontendRedirect(req, params) {
  const frontend = String(process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0].trim().replace(/\/$/, "");
  return `${frontend}/social/accounts?${new URLSearchParams(params)}`;
}

/**
 * Start the hosted LinkedIn login flow for this workspace. The frontend
 * should redirect the browser to the returned url; the customer logs in
 * (including any 2FA challenge) entirely on Unipile's hosted page, so this
 * backend never sees a raw LinkedIn password.
 */
router.post("/connect", requireCapability("social.manage"), async (req, res, next) => {
  try {
    const token = webhookToken();
    if (!token) return res.status(503).json({ error: "UNIPILE_WEBHOOK_TOKEN is not configured" });
    const notifyUrl = new URL(`${backendBaseUrl(req)}/api/webhooks/unipile`);
    notifyUrl.searchParams.set("token", token);
    const link = await unipile.requestHostedAuthLink({
      // Encodes both ids so the webhook (which has no session) can attribute
      // the resulting SocialConnection to the workspace and the user who
      // started the connection.
      identifier: `${req.auth.workspaceId}:${req.auth.user?._id}`,
      notifyUrl: notifyUrl.toString(),
      successRedirectUrl: frontendRedirect(req, { provider: PROVIDER, status: "success" }),
      failureRedirectUrl: frontendRedirect(req, { provider: PROVIDER, status: "error" }),
    });
    return res.json({ url: link.url || link.link || link });
  } catch (error) {
    if (error.code === "UNIPILE_DISABLED") return res.status(503).json({ error: error.message });
    return next(error);
  }
});

router.get("/status", async (req, res, next) => {
  try {
    const connection = await SocialConnection.findOne({ workspaceId: req.auth.workspaceId, provider: PROVIDER }).lean();
    if (!connection) return res.json({ connected: false });
    return res.json({
      connected: connection.status === "connected",
      status: connection.status,
      providerAccountName: connection.providerAccount?.name || "",
      connectedAt: connection.connectedAt,
      lastError: connection.lastError || "",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/disconnect", requireCapability("social.manage"), async (req, res, next) => {
  try {
    await SocialConnection.updateOne(
      { workspaceId: req.auth.workspaceId, provider: PROVIDER },
      { $set: { status: "disconnected" } },
    );
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Send a one-off connection request outside of any sequence — resolves the
 * contact's LinkedIn provider_id (caching it) and sends the invitation.
 */
router.post("/contacts/:contactId/send-invitation", requireCapability("social.manage"), async (req, res, next) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.contactId });
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    const message = String(req.body?.message || contact.linkedinOutreach?.draft || "").slice(0, 300);
    await outreachEngine.sendConnectionRequestToContact({
      workspaceId: req.auth.workspaceId,
      contact,
      message,
      actorUserId: req.auth.user?._id || null,
    });
    return res.json({ success: true, connectionStatus: "pending" });
  } catch (error) {
    if (["UNIPILE_DISABLED", "LINKEDIN_NOT_CONNECTED", "LINKEDIN_URL_MISSING"].includes(error.code))
      return res.status(400).json({ error: error.message });
    if (["UNIPILE_REQUEST_FAILED", "LINKEDIN_PROFILE_UNRESOLVED"].includes(error.code))
      return res.status(502).json({ error: error.message });
    return next(error);
  }
});

router.post("/sequences", requireCapability("social.manage"), async (req, res, next) => {
  try {
    const connection = await SocialConnection.findOne({ workspaceId: req.auth.workspaceId, provider: PROVIDER, status: "connected" });
    if (!connection) return res.status(400).json({ error: "Connect a LinkedIn (Unipile) account before creating a sequence" });
    const sequence = await LinkedinSequence.create({
      workspaceId: req.auth.workspaceId,
      name: String(req.body?.name || "").trim().slice(0, 180),
      description: String(req.body?.description || "").slice(0, 2000),
      steps: Array.isArray(req.body?.steps) ? req.body.steps : [],
      dailyInvitationLimit: req.body?.dailyInvitationLimit,
      autonomousSendEnabled: Boolean(req.body?.autonomousSendEnabled),
      calendarBookingUrl: String(req.body?.calendarBookingUrl || "").slice(0, 2000),
      unipileAccountId: connection.providerAccount?.id,
      createdBy: req.auth.user?._id,
      updatedBy: req.auth.user?._id,
    });
    return res.status(201).json({ success: true, data: sequence });
  } catch (error) {
    if (error.name === "ValidationError") return res.status(400).json({ error: error.message });
    return next(error);
  }
});

router.get("/sequences", async (req, res, next) => {
  try {
    const sequences = await LinkedinSequence.find({ workspaceId: req.auth.workspaceId }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, data: sequences });
  } catch (error) {
    return next(error);
  }
});

router.patch("/sequences/:id", requireCapability("social.manage"), async (req, res, next) => {
  try {
    const updates = {};
    for (const field of ["name", "description", "status", "steps", "dailyInvitationLimit", "autonomousSendEnabled", "calendarBookingUrl"])
      if (req.body?.[field] !== undefined) updates[field] = req.body[field];
    updates.updatedBy = req.auth.user?._id;
    const sequence = await LinkedinSequence.findOneAndUpdate(
      { _id: req.params.id, workspaceId: req.auth.workspaceId },
      { $set: updates },
      { new: true, runValidators: true },
    );
    if (!sequence) return res.status(404).json({ error: "Sequence not found" });
    return res.json({ success: true, data: sequence });
  } catch (error) {
    if (error.name === "ValidationError") return res.status(400).json({ error: error.message });
    return next(error);
  }
});

router.post("/sequences/:id/enroll", requireCapability("social.manage"), async (req, res, next) => {
  try {
    const sequence = await LinkedinSequence.findOne({ _id: req.params.id, workspaceId: req.auth.workspaceId });
    if (!sequence) return res.status(404).json({ error: "Sequence not found" });
    const contactIds = Array.isArray(req.body?.contactIds) ? req.body.contactIds : [];
    if (!contactIds.length) return res.status(400).json({ error: "contactIds is required" });
    const enrollments = await sequenceService.enrollContacts({ sequence, contactIds, workspaceId: req.auth.workspaceId });
    return res.status(201).json({ success: true, data: enrollments });
  } catch (error) {
    return next(error);
  }
});

router.get("/sequences/:id/enrollments", async (req, res, next) => {
  try {
    const enrollments = await LinkedinSequenceEnrollment.find({ workspaceId: req.auth.workspaceId, sequenceId: req.params.id })
      .populate("contactId", "name firstName company title linkedin")
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, data: enrollments });
  } catch (error) {
    return next(error);
  }
});

/** AI-drafted replies awaiting human review before sending (see linkedinSequenceReplyService.js). */
router.get("/reply-drafts", async (req, res, next) => {
  try {
    const drafts = await ConversationMessage.find({ provider: PROVIDER, deliveryStatus: "draft" })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("contactId", "name firstName company title")
      .lean();
    return res.json({ success: true, data: drafts });
  } catch (error) {
    return next(error);
  }
});

router.post("/reply-drafts/:messageId/send", requireCapability("social.manage"), async (req, res, next) => {
  try {
    const draft = await ConversationMessage.findOne({ _id: req.params.messageId, provider: PROVIDER, deliveryStatus: "draft" });
    if (!draft) return res.status(404).json({ error: "Draft not found" });
    const enrollmentId = draft.metadata?.enrollmentId;
    const enrollment = enrollmentId ? await LinkedinSequenceEnrollment.findById(enrollmentId) : null;
    if (!enrollment?.unipileChatId) return res.status(400).json({ error: "No chat is available to send this reply into" });
    const text = String(req.body?.text || draft.body).slice(0, 8000);
    await unipile.sendChatMessage({ chatId: enrollment.unipileChatId, text });
    draft.body = text;
    draft.deliveryStatus = "sent";
    draft.sentAt = new Date();
    await draft.save();
    return res.json({ success: true, data: draft });
  } catch (error) {
    if (error.code === "UNIPILE_REQUEST_FAILED") return res.status(502).json({ error: error.message });
    return next(error);
  }
});

router.post("/reply-drafts/:messageId/discard", requireCapability("social.manage"), async (req, res, next) => {
  try {
    const result = await ConversationMessage.deleteOne({ _id: req.params.messageId, provider: PROVIDER, deliveryStatus: "draft" });
    if (!result.deletedCount) return res.status(404).json({ error: "Draft not found" });
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
