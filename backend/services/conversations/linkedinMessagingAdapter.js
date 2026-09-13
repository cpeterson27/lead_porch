const SocialConnection = require("../../models/SocialConnection");
const { ConversationChannelAdapter, registerConversationAdapter } = require("./channelAdapters");
const { ingestProviderMessage } = require("./conversationIngestionService");
const { resolveIdentity } = require("../socialLeadAutomationService");
const unipileService = require("../unipileService");

const PROVIDER = "linkedin_unipile";

async function connectionForAccount(accountId) {
  return SocialConnection.findOne({ provider: PROVIDER, "providerAccount.id": accountId, status: "connected" });
}

/**
 * Thread an inbound Unipile `message_received` webhook payload into a
 * Contact + ConversationThread/ConversationMessage, the same shape used by
 * the Meta pipeline (see socialLeadAutomationService.resolveIdentity, which
 * is provider-agnostic despite living in that file).
 */
async function ingestLinkedinMessage({ connection, payload }) {
  const senderProviderId = payload.sender?.provider_id || payload.sender?.id || payload.sender_id;
  if (!senderProviderId) return { ignored: true, reason: "sender_unavailable" };

  const { contact, identity, created } = await resolveIdentity({
    provider: PROVIDER,
    assetId: connection.providerAccount?.id || "",
    providerUserId: senderProviderId,
    displayName: payload.sender?.name || payload.sender?.display_name || "",
    username: payload.sender?.username || "",
    occurredAt: payload.timestamp ? new Date(payload.timestamp) : new Date(),
  });

  const conversation = await ingestProviderMessage({
    thread: {
      channel: "linkedin",
      provider: PROVIDER,
      providerThreadId: String(payload.chat_id),
      contactIds: [contact._id],
      participants: [{ kind: "contact", role: "from", address: senderProviderId, contactId: contact._id }],
      metadata: { accountId: connection.providerAccount?.id || "" },
    },
    message: {
      providerMessageId: String(payload.message_id || `${payload.chat_id}:${payload.timestamp}`),
      direction: "inbound",
      body: payload.message || "",
      sender: { name: payload.sender?.name || "", address: senderProviderId },
      recipients: [{ address: connection.providerAccount?.id || "", role: "to" }],
      contactId: contact._id,
      deliveryStatus: "received",
      sentAt: payload.timestamp ? new Date(payload.timestamp) : new Date(),
      metadata: { socialIdentityId: identity._id },
    },
  });

  return { contact, identity, identityCreated: created, conversation };
}

class LinkedinMessagingAdapter extends ConversationChannelAdapter {
  constructor() {
    super("linkedin", PROVIDER);
  }

  async sendMessage({ chatId, accountId, providerId, body }) {
    if (chatId) return unipileService.sendChatMessage({ chatId, text: body });
    return unipileService.startNewChat({ accountId, providerId, text: body });
  }
}

const linkedinMessagingAdapter = registerConversationAdapter(new LinkedinMessagingAdapter());

module.exports = { LinkedinMessagingAdapter, connectionForAccount, ingestLinkedinMessage, linkedinMessagingAdapter, PROVIDER };
