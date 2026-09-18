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
    // SocialIdentity uses the public channel name; ConversationThread keeps
    // the concrete transport provider so replies route through Unipile.
    provider: "linkedin",
    assetId: connection.providerAccount?.id || "",
    providerUserId: senderProviderId,
    displayName: payload.sender?.name || payload.sender?.display_name || "",
    username: payload.sender?.username || "",
    occurredAt: payload.timestamp ? new Date(payload.timestamp) : new Date(),
  });
  let contactChanged = false;
  if (!contact.linkedin && payload.sender?.username) {
    contact.linkedin = `https://www.linkedin.com/in/${String(payload.sender.username).replace(/^\/+|\/+$/g, "")}`;
    contactChanged = true;
  }
  if (!contact.linkedinOutreach?.unipileProviderId && senderProviderId) {
    contact.linkedinOutreach = { ...contact.linkedinOutreach, unipileProviderId: senderProviderId };
    contactChanged = true;
  }
  if (contactChanged) await contact.save();

  const outgoing = payload.outgoing === true || payload.direction === "outbound";
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
      direction: outgoing ? "outbound" : "inbound",
      body: payload.message || "",
      sender: outgoing
        ? { name: connection.providerAccount?.name || "LinkedIn account", address: connection.providerAccount?.id || "" }
        : { name: payload.sender?.name || "", address: senderProviderId },
      recipients: [{ address: outgoing ? senderProviderId : connection.providerAccount?.id || "", role: "to" }],
      contactId: contact._id,
      deliveryStatus: outgoing ? "sent" : "received",
      ...(outgoing
        ? { sentAt: payload.timestamp ? new Date(payload.timestamp) : new Date() }
        : { receivedAt: payload.timestamp ? new Date(payload.timestamp) : new Date() }),
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
