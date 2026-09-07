const ConversationThread = require("../../models/ConversationThread");
const ConversationMessage = require("../../models/ConversationMessage");
const { currentWorkspaceId } = require("../../tenancy/workspaceContext");
const { emitWorkspaceEvent } = require("../realtimeEvents");

function messageTime(message) {
  const value = message.sentAt || message.receivedAt || message.createdAt || new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

async function ingestProviderMessage({ thread, message }) {
  if (!thread?.channel || !thread?.provider || !thread?.providerThreadId) throw new Error("Channel, provider, and providerThreadId are required");
  if (!message?.providerMessageId || !["inbound", "outbound"].includes(message.direction)) throw new Error("providerMessageId and message direction are required");

  const occurredAt = messageTime(message);
  const existingMessage = await ConversationMessage.findOne({ provider: thread.provider, providerMessageId: message.providerMessageId }).select("_id threadId").lean();
  if (existingMessage) {
    const existingThread = await ConversationThread.findById(existingMessage.threadId).lean();
    return { thread: existingThread, message: existingMessage, created: false };
  }

  const set = {
    channel: thread.channel,
    provider: thread.provider,
    providerThreadId: thread.providerThreadId,
    mailboxId: thread.mailboxId || null,
    subject: thread.subject || message.subject || "",
    preview: String(message.body || "").replace(/\s+/g, " ").trim().slice(0, 1000),
    participants: thread.participants || [],
    contactIds: thread.contactIds || [],
    organizationId: thread.organizationId || null,
    opportunityId: thread.opportunityId || null,
    metadata: thread.metadata || {},
    lastMessageAt: occurredAt,
    ...(message.direction === "inbound" ? (message.opensMessagingWindow === false ? {} : { lastInboundAt: occurredAt }) : { lastOutboundAt: occurredAt }),
  };
  const setOnInsert = { status: "open", priority: "normal", assignedTo: thread.assignedTo || null, tags: thread.tags || [] };
  const threadUpdate = { $set: set, $setOnInsert: setOnInsert };
  if (message.direction === "inbound") threadUpdate.$inc = { unreadCount: 1 };
  const savedThread = await ConversationThread.findOneAndUpdate(
    { provider: thread.provider, providerThreadId: thread.providerThreadId },
    threadUpdate,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  const savedMessage = await ConversationMessage.create({
    threadId: savedThread._id,
    channel: thread.channel,
    provider: thread.provider,
    providerMessageId: message.providerMessageId,
    direction: message.direction,
    kind: "message",
    subject: message.subject || "",
    body: message.body || "",
    html: message.html || "",
    sender: message.sender || {},
    recipients: message.recipients || [],
    attachments: message.attachments || [],
    deliveryStatus: message.deliveryStatus || (message.direction === "inbound" ? "received" : "sent"),
    sentAt: message.direction === "outbound" ? occurredAt : null,
    receivedAt: message.direction === "inbound" ? occurredAt : null,
    contactId: message.contactId || null,
    createdBy: message.createdBy || null,
    metadata: message.metadata || {},
  });
  emitWorkspaceEvent(currentWorkspaceId(), {
    type: "conversation:new-message",
    threadId: String(savedThread._id),
    channel: savedThread.channel,
    direction: message.direction,
  });
  return { thread: savedThread, message: savedMessage.toObject(), created: true };
}

module.exports = { ingestProviderMessage, messageTime };
