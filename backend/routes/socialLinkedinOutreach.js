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
const linkedinInboxSync = require("../services/linkedinInboxSyncService");

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
  const normalized = { ...params, status: params.status === "success" ? "success" : "error" };
  return `${frontend}/social/linkedin-outreach?${new URLSearchParams(normalized)}`;
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
    if (!connection) return res.json({ connected: false, integrationEnabled: unipile.isEnabled(), inboxWebhookRegistered: false });
    return res.json({
      connected: connection.status === "connected",
      status: connection.status,
      integrationEnabled: unipile.isEnabled(),
      providerAccountName: connection.providerAccount?.name || "",
      connectedAt: connection.connectedAt,
      inboxWebhookRegistered: Boolean(connection.webhookSubscriptions?.some((row) => row.status === "subscribed")),
      lastInboxSyncAt: connection.lastVerifiedAt,
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
    await LinkedinSequence.updateMany(
      { workspaceId: req.auth.workspaceId, status: "active" },
      { $set: { status: "paused", updatedBy: req.auth.user?._id } },
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
      hourlyInvitationLimit: req.body?.hourlyInvitationLimit,
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
    for (const field of ["name", "description", "status", "steps", "dailyInvitationLimit", "hourlyInvitationLimit", "autonomousSendEnabled", "calendarBookingUrl"])
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

// A CRM-first picker for safe enrollment. Discovery results must be reviewed
// and saved to the CRM before they can appear here; LinkedIn is a delivery
// channel, never an unreviewed people-scraping source.
router.get("/candidates", async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 100));
    const query = {
      linkedin: { $exists: true, $nin: [null, ""] },
      doNotCall: { $ne: true },
      status: { $nin: ["archived", "rejected", "unsubscribed", "invalid"] },
      "linkedinOutreach.status": { $nin: ["sent", "replied", "not_interested"] },
    };
    const search = String(req.query.search || "").trim().slice(0, 120);
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = ["name", "company", "title", "email"].map((field) => ({ [field]: { $regex: escaped, $options: "i" } }));
    }
    const contacts = await Contact.find(query)
      .select("name firstName lastName company title email emailStatus linkedin qualifyContact researchStatus tags linkedinOutreach status createdAt")
      .sort({ qualifyContact: -1, updatedAt: -1 })
      .limit(limit)
      .lean();
    const enrolled = await LinkedinSequenceEnrollment.find({
      workspaceId: req.auth.workspaceId,
      contactId: { $in: contacts.map((contact) => contact._id) },
      status: { $nin: ["stopped", "failed", "completed"] },
    }).select("contactId sequenceId status").lean();
    const enrollmentByContact = new Map(enrolled.map((row) => [String(row.contactId), row]));
    return res.json({
      success: true,
      data: contacts.map((contact) => ({ ...contact, activeEnrollment: enrollmentByContact.get(String(contact._id)) || null })),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/inbox/sync", requireCapability("social.manage"), async (req, res, next) => {
  try {
    const result = await linkedinInboxSync.syncWorkspaceInbox({
      workspaceId: req.auth.workspaceId,
      maxChats: Math.min(200, Math.max(10, Number(req.body?.maxChats) || 100)),
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    if (["UNIPILE_DISABLED", "LINKEDIN_NOT_CONNECTED"].includes(error.code)) return res.status(400).json({ error: error.message });
    return next(error);
  }
});

router.post("/inbox/register-webhook", requireCapability("social.manage"), async (req, res, next) => {
  try {
    const result = await linkedinInboxSync.ensureMessagingWebhook({
      workspaceId: req.auth.workspaceId,
      backendBaseUrl: backendBaseUrl(req),
      webhookToken: webhookToken(),
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    if (["UNIPILE_DISABLED", "LINKEDIN_NOT_CONNECTED"].includes(error.code)) return res.status(400).json({ error: error.message });
    return next(error);
  }
});

router.get("/analytics", async (req, res, next) => {
  try {
    const sequenceIds = await LinkedinSequence.find({ workspaceId: req.auth.workspaceId }).distinct("_id");
    const enrollmentRows = await LinkedinSequenceEnrollment.aggregate([
      { $match: { workspaceId: req.auth.workspaceId, sequenceId: { $in: sequenceIds } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const counts = Object.fromEntries(enrollmentRows.map((row) => [row._id, row.count]));
    const invitationsSent = await LinkedinSequenceEnrollment.countDocuments({
      workspaceId: req.auth.workspaceId,
      sequenceId: { $in: sequenceIds },
      history: { $elemMatch: { type: "connection_request", result: "sent" } },
    });
    const accepted = (counts.connection_accepted || 0) + (counts.awaiting_reply || 0) + (counts.meeting_booked || 0) + (counts.completed || 0);
    const replies = await ConversationMessage.countDocuments({ workspaceId: req.auth.workspaceId, provider: PROVIDER, direction: "inbound" });
    return res.json({
      success: true,
      data: {
        invitationsSent,
        accepted,
        replies,
        meetingsBooked: counts.meeting_booked || 0,
        acceptanceRate: invitationsSent ? Math.round((accepted / invitationsSent) * 1000) / 10 : 0,
        replyRate: invitationsSent ? Math.round((replies / invitationsSent) * 1000) / 10 : 0,
        enrollmentsByStatus: counts,
      },
    });
  } catch (error) {
    return next(error);
  }
});

function linkedinSearchPerson(row) {
  const firstName = String(row.first_name || row.firstName || "").trim();
  const lastName = String(row.last_name || row.lastName || "").trim();
  const name = String(row.name || row.display_name || `${firstName} ${lastName}`).trim();
  const publicIdentifier = String(row.public_identifier || row.public_id || row.slug || "").trim();
  const linkedinUrl = String(row.profile_url || row.linkedin_url || (publicIdentifier ? `https://www.linkedin.com/in/${publicIdentifier}` : "")).trim();
  return {
    providerId: String(row.provider_id || row.id || ""),
    publicIdentifier,
    name,
    firstName,
    lastName,
    title: String(row.headline || row.title || row.current_position?.title || "").trim(),
    company: String(row.company || row.current_company?.name || row.current_position?.company || "").trim(),
    location: String(row.location || row.location_name || "").trim(),
    linkedinUrl,
    degree: String(row.network_distance || row.connection_degree || "").trim(),
  };
}

router.post("/search", requireCapability("social.manage"), async (req, res, next) => {
  try {
    const connection = await linkedinInboxSync.connectedAccount(req.auth.workspaceId);
    const url = String(req.body?.url || "").trim();
    const keywords = String(req.body?.keywords || "").trim().slice(0, 300);
    if (!url && !keywords) return res.status(400).json({ error: "Enter search keywords or paste a LinkedIn people-search URL" });
    if (url && !/^https:\/\/(www\.)?linkedin\.com\/(search\/results\/people|sales\/search\/people)/i.test(url)) {
      return res.status(400).json({ error: "Use a LinkedIn People or Sales Navigator people-search URL" });
    }
    const response = await unipile.searchLinkedinPeople({
      accountId: connection.providerAccount?.id,
      url,
      keywords,
      cursor: req.body?.cursor,
      limit: Math.min(25, Math.max(1, Number(req.body?.limit) || 25)),
    });
    const items = response.items || response.data || response.results || (Array.isArray(response) ? response : []);
    return res.json({
      success: true,
      data: {
        people: items.map(linkedinSearchPerson).filter((person) => person.name && (person.linkedinUrl || person.providerId)),
        nextCursor: response.cursor || response.next_cursor || "",
        disclosure: "Preview only. Nothing was added to the CRM or contacted.",
      },
    });
  } catch (error) {
    if (["UNIPILE_DISABLED", "LINKEDIN_NOT_CONNECTED"].includes(error.code)) return res.status(400).json({ error: error.message });
    if (error.code === "UNIPILE_REQUEST_FAILED") return res.status(502).json({ error: error.message });
    return next(error);
  }
});

router.post("/search/import", requireCapability("social.manage"), async (req, res, next) => {
  try {
    const people = Array.isArray(req.body?.people) ? req.body.people.slice(0, 50) : [];
    if (!people.length) return res.status(400).json({ error: "Select at least one person" });
    const contacts = [];
    for (const person of people) {
      const name = String(person.name || "").trim().slice(0, 200);
      const linkedin = String(person.linkedinUrl || "").trim().slice(0, 500);
      const providerId = String(person.providerId || "").trim().slice(0, 200);
      if (!name || (!linkedin && !providerId)) continue;
      const match = linkedin
        ? { workspaceId: req.auth.workspaceId, linkedin }
        : { workspaceId: req.auth.workspaceId, "linkedinOutreach.unipileProviderId": providerId };
      const contact = await Contact.findOneAndUpdate(
        match,
        {
          $setOnInsert: {
            name,
            firstName: String(person.firstName || "").trim().slice(0, 100),
            lastName: String(person.lastName || "").trim().slice(0, 100),
            status: "prospect",
            type: "lead",
            sourceProvider: PROVIDER,
            sources: ["linkedin_search"],
          },
          $set: {
            ...(linkedin ? { linkedin } : {}),
            ...(person.title ? { title: String(person.title).slice(0, 200) } : {}),
            ...(person.company ? { company: String(person.company).slice(0, 200) } : {}),
            ...(providerId ? { "linkedinOutreach.unipileProviderId": providerId } : {}),
          },
          $addToSet: { tags: "linkedin-search" },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      contacts.push(contact);
    }
    return res.status(201).json({ success: true, data: contacts, message: `${contacts.length} selected people added to the CRM for review.` });
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
