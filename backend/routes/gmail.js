const express = require("express");
const IntegrationConnection = require("../models/IntegrationConnection");
const Outreach = require("../models/Outreach");
const Campaign = require("../models/Campaign");
const Contact = require("../models/Contact");
const gmail = require("../services/gmailOAuthService");
const { classifyReply, draftReply } = require("../services/replyIntelligence");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const { runWithWorkspace } = require("../tenancy/workspaceContext");
const ConversationThread = require("../models/ConversationThread");
const { gmailConversationAdapter, syncGmailThread } = require("../services/conversations/gmailConversationAdapter");
const { requireRole } = require("../middleware/auth");
const { primaryFrontendUrl } = require("../utils/frontendUrl");
const router = express.Router();

router.get("/status", async (_req, res) => {
  try { res.json(await gmail.status()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

router.get("/oauth/start", requireRole("owner", "admin"), (req, res) => {
  try { res.json({ authorizationUrl: gmail.authorizationUrl(req.auth.workspaceId, req.auth.user._id) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

router.get("/oauth/callback", async (req, res) => {
  const frontend = primaryFrontendUrl();
  try {
    const state = gmail.verifyState(req.query.state);
    if (!state) throw new Error("Google connection request expired or is invalid");
    const membership = await WorkspaceMembership.findOne({ workspaceId: state.workspaceId, userId: state.userId, status: "active", $or: [{ role: { $in: ["owner", "admin"] } }, { roles: { $in: ["owner", "admin"] } }] });
    if (!membership) throw new Error("Workspace permission is no longer available");
    if (!req.query.code) throw new Error(req.query.error || "Google did not return an authorization code");
    const tokens = await gmail.exchangeCode(req.query.code);
    const profile = await gmail.googleProfile(tokens.access_token);
    await runWithWorkspace(state.workspaceId, () => gmail.saveConnection(tokens, profile));
    res.redirect(`${frontend}/integrations?gmail=connected`);
  } catch (error) {
    res.redirect(`${frontend}/integrations?gmail=error&message=${encodeURIComponent(error.message)}`);
  }
});

router.post("/disconnect", requireRole("owner", "admin"), async (_req, res) => {
  await IntegrationConnection.findOneAndUpdate(
    { provider: "gmail" },
    { $set: { status: "disconnected", credentialsEncrypted: null, connectedAt: null, oauth: {} } },
  );
  res.json({ success: true });
});

router.get("/threads", async (req, res) => {
  try { res.json(await gmail.listThreads({ query: req.query.q || "in:inbox", maxResults: Number(req.query.limit || 20) })); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

router.post("/sync", async (req, res) => {
  try {
    const query = String(req.body?.query || "in:inbox").slice(0, 500);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.body?.limit, 10) || 20));
    const result = await gmailConversationAdapter.syncThreads({ query, limit });
    res.json({ success: true, synced: result.synced, failed: result.failed, nextPageToken: result.nextPageToken || null });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get("/threads/:threadId", async (req, res) => {
  try {
    const [thread, canonical] = await Promise.all([
      gmail.getThread(req.params.threadId),
      ConversationThread.findOne({ provider: "gmail", providerThreadId: req.params.threadId }).select("_id draft assignedTo status priority mailboxId").lean(),
    ]);
    res.json({ ...thread, canonicalThreadId: canonical?._id || null, workspace: canonical || null });
  }
  catch (error) { res.status(400).json({ error: error.message }); }
});

router.post("/threads/:threadId/action", async (req, res) => {
  try {
    await gmail.modifyThread(req.params.threadId, req.body?.action);
    const canonicalUpdate = {
      archive: { status: "closed" }, trash: { status: "closed" }, untrash: { status: "open" },
      read: { unreadCount: 0 }, unread: { unreadCount: 1 },
    }[req.body?.action];
    let syncWarning = "";
    if (canonicalUpdate) {
      try { await ConversationThread.updateOne({ provider: "gmail", providerThreadId: req.params.threadId }, { $set: canonicalUpdate }); }
      catch { syncWarning = "Gmail updated, but the CRM mirror will retry on the next sync"; }
    }
    res.json({ success: true, syncWarning });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.delete("/trash", async (req, res) => {
  if (req.body?.confirmation !== "DELETE ALL TRASH") {
    return res.status(400).json({ error: "Trash deletion must be explicitly confirmed" });
  }
  try {
    const result = await gmail.emptyTrash();
    res.json({ success: true, ...result });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post("/trash/delete-selected", async (req, res) => {
  const threadIds = Array.isArray(req.body?.threadIds) ? req.body.threadIds : [];
  if (req.body?.confirmation !== "DELETE SELECTED" || !threadIds.length) {
    return res.status(400).json({ error: "Select at least one trash conversation and confirm deletion" });
  }
  try {
    const result = await gmail.deleteThreads(threadIds);
    res.json({ success: true, ...result });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post("/send", async (req, res) => {
  try {
    const result = await gmail.sendMessage(req.body || {});
    let canonicalThreadId = null;
    let syncWarning = "";
    if (result.threadId) {
      try {
        const synced = await syncGmailThread(result.threadId);
        canonicalThreadId = synced.canonicalThread?._id || null;
        if (canonicalThreadId) await ConversationThread.updateOne({ _id: canonicalThreadId }, { $set: { "draft.body": "", "draft.subject": "", "draft.attachments": [], "draft.updatedAt": new Date() } });
      } catch { syncWarning = "Message sent; the CRM copy will appear after the next sync"; }
    }
    res.json({ success: true, messageId: result.id, threadId: result.threadId, canonicalThreadId, syncWarning });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post("/sync-outreach-replies", async (_req, res) => {
  try {
    const sent = await Outreach.find({ status: "sent", contactEmail: { $ne: "" } }).select("contactEmail sentAt");
    if (!sent.length) return res.json({ success: true, repliesFound: 0 });
    const emails = [...new Set(sent.map((item) => item.contactEmail.toLowerCase()))];
    const search = emails.slice(0, 40).map((email) => `from:${email}`).join(" OR ");
    const { threads } = await gmail.listThreads({ query: `in:inbox newer_than:1y (${search})`, maxResults: 50 });
    let repliesFound = 0;
    for (const thread of threads) {
      const sender = String(thread.from || "").match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0]?.toLowerCase();
      if (!sender || !emails.includes(sender)) continue;
      const receivedAt = thread.date ? new Date(thread.date) : new Date();
      const matching = await Outreach.find(
        { contactEmail: sender, status: "sent", sentAt: { $lte: receivedAt } },
      ).populate("campaignId", "name");
      const intelligence = classifyReply(thread.snippet || "");
      for (const item of matching) {
        item.status = "replied";
        item.repliedAt = receivedAt;
        item.replyText = thread.snippet || "";
        item.replyCategory = intelligence.category;
        item.replyUrgency = intelligence.urgency;
        item.aiReplyDraft = draftReply({
          contactName: item.contactName,
          category: intelligence.category,
          campaignName: item.campaignId?.name,
        });
        await item.save();
        if (intelligence.category === "unsubscribe" && item.contactId) {
          await Contact.updateOne(
            { _id: item.contactId },
            {
              $set: {
                status: "unsubscribed",
                "emailPreferences.marketingStatus": "unsubscribed",
                "emailPreferences.unsubscribedAt": receivedAt,
                "emailPreferences.unsubscribeSource": "reply_request",
                "emailPreferences.topics.eventInvitations": false,
                "emailPreferences.topics.programOffers": false,
                "emailPreferences.topics.educationalNewsletter": false,
              },
            },
          );
        }
        await Campaign.updateOne({ _id: item.campaignId?._id }, { $inc: { "metrics.replied": 1 } });
        repliesFound += 1;
      }
    }
    res.json({ success: true, repliesFound });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get("/contact-history", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return res.status(400).json({ error: "A contact email is required" });
    const outreach = await Outreach.find({ contactEmail: email })
      .populate("campaignId", "name")
      .sort({ createdAt: -1 })
      .lean();
    res.json({
      outreach: outreach.map((item) => ({
        id: item._id,
        campaignName: item.campaignId?.name || "Campaign outreach",
        subject: item.subject,
        body: item.emailDraft,
        htmlBody: item.htmlBody,
        status: item.status,
        sentAt: item.sentAt,
        repliedAt: item.repliedAt,
        replyText: item.replyText,
        replyCategory: item.replyCategory,
        replyUrgency: item.replyUrgency,
        aiReplyDraft: item.aiReplyDraft,
        deliveryStatus: item.deliveryStatus,
        deliveredAt: item.deliveredAt,
        openedAt: item.openedAt,
        clickedAt: item.clickedAt,
      })),
    });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get("/outreach-history", async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query?.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, Number.parseInt(req.query?.limit, 10) || 50));
    const filter = { status: { $in: ["sent", "replied"] } };
    const total = await Outreach.countDocuments(filter);
    const outreach = await Outreach.find(filter)
      .populate("campaignId", "name")
      .sort({ sentAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
    res.json({
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      outreach: outreach.map((item) => ({
        id: item._id,
        contactName: item.contactName,
        contactEmail: item.contactEmail,
        campaignName: item.campaignId?.name || "Campaign outreach",
        subject: item.subject,
        body: item.emailDraft,
        status: item.status,
        sentAt: item.sentAt,
        repliedAt: item.repliedAt,
        replyText: item.replyText,
        replyCategory: item.replyCategory,
        replyUrgency: item.replyUrgency,
        aiReplyDraft: item.aiReplyDraft,
        deliveryStatus: item.deliveryStatus,
        deliveredAt: item.deliveredAt,
        openedAt: item.openedAt,
        clickedAt: item.clickedAt,
      })),
    });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

module.exports = router;
