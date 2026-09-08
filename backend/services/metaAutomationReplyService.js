const SocialProviderEvent = require("../models/SocialProviderEvent");
const CrmActivity = require("../models/CrmActivity");
const InAppNotification = require("../models/InAppNotification");
const { metaMessagingAdapter } = require("./conversations/metaMessagingAdapter");
const deps = { SocialProviderEvent, CrmActivity, InAppNotification, adapter: metaMessagingAdapter };
// Claim before sending. A timeout/crash is an uncertain outcome: never blindly resend.
async function deliver(record, models = deps) {
  if (process.env.META_AUTOMATIC_REPLIES_ENABLED !== "true" || !record?._id || record.reply?.status !== "pending") return { status: "disabled_or_already_handled" };
  const claimed = await models.SocialProviderEvent.findOneAndUpdate({ _id: record._id, workspaceId: record.workspaceId, processingStatus: "processed", "reply.status": "pending" }, { $set: { "reply.status": "sending", "reply.attemptedAt": new Date() } }, { new: true });
  if (!claimed) return { status: "already_claimed" };
  try {
    const reply = claimed.reply;
    if (!reply.threadId || !reply.body || reply.body.length > 2000) throw Error("Reply is not ready");
    const input = { workspaceId: claimed.workspaceId, connectionProvider: reply.connectionProvider, channel: claimed.provider, assetId: reply.assetId, recipientId: reply.recipientId, threadId: reply.threadId, body: reply.body, senderType: "automation" };
    const result = reply.policy === "private_reply"
      ? await models.adapter.sendCommentPrivateReply({ ...input, commentId: reply.commentId, occurredAt: claimed.occurredAt })
      : reply.policy === "message" ? await models.adapter.sendMessage(input) : null;
    if (!result?.message?.providerMessageId) throw Error("Reply outcome requires review");
    await models.SocialProviderEvent.updateOne({ _id: claimed._id, workspaceId: claimed.workspaceId }, { $set: { "reply.status": "sent", "reply.messageId": result.message.providerMessageId, "reply.sentAt": new Date() } });
    await models.CrmActivity.create({ workspaceId: claimed.workspaceId, contactId: claimed.contactId, type: "system", direction: "outbound", title: "Social automation reply sent", body: reply.body, source: "integration", metadata: { eventType: "social.reply.sent", provider: claimed.provider, assetId: reply.assetId, commentId: reply.commentId, providerEventId: claimed.providerEventId, providerMessageId: result.message.providerMessageId, senderType: "automation", automationId: claimed.automationId } });
    // Best-effort: a notification failure must never turn an already-successful send into a reported error.
    if (models.InAppNotification?.findOneAndUpdate) {
      await models.InAppNotification.findOneAndUpdate(
        { workspaceId: claimed.workspaceId, userId: null, eventKey: `social-automation-sent:${claimed._id}` },
        { $setOnInsert: {
          type: "social_automation_triggered",
          title: `Automation replied on ${claimed.provider === "instagram" ? "Instagram" : "Facebook"}`,
          message: `Your automation sent a reply: "${reply.body.slice(0, 140)}"`,
          actionUrl: reply.threadId ? `/social/inbox?thread=${reply.threadId}` : "/social/inbox",
        } },
        { upsert: true, setDefaultsOnInsert: true },
      ).catch(() => {});
    }
    return { status: "sent" };
  } catch {
    await models.SocialProviderEvent.updateOne({ _id: claimed._id, workspaceId: claimed.workspaceId, "reply.status": "sending" }, { $set: { "reply.status": "unknown", "reply.error": "Delivery could not be confirmed. Review the provider conversation before any manual retry." } });
    return { status: "unknown" };
  }
}
async function fromAutomation({ workspaceId, contactId, event, body }) {
  if (!event?.providerEventId || !contactId) throw new Error("A received social interaction is required");
  const record = await SocialProviderEvent.findOne({ workspaceId, contactId, provider: event.provider, providerEventId: event.providerEventId, processingStatus: "processed" });
  if (!record || !["message", "private_reply"].includes(record.reply?.policy)) throw new Error("This interaction does not permit a reply");
  // Both automation surfaces share ONE reply reservation per provider interaction.
  if (record.reply.status === "none") {
    const updated = await SocialProviderEvent.findOneAndUpdate({ _id: record._id, workspaceId, "reply.status": "none" }, { $set: { "reply.status": "pending", "reply.body": String(body || "").trim() } }, { new: true });
    return updated ? deliver(updated) : { status: "already_claimed" };
  }
  return deliver(record);
}
module.exports = { deliver, fromAutomation };
