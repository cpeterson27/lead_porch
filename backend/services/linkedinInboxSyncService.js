const SocialConnection = require("../models/SocialConnection");
const unipile = require("./unipileService");
const { ingestLinkedinMessage } = require("./conversations/linkedinMessagingAdapter");

const PROVIDER = "linkedin_unipile";

function listOf(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.items || payload?.data || payload?.chats || payload?.messages || [];
}

function idOf(value) {
  return String(value?.id || value?.chat_id || value?.message_id || value?.provider_id || "");
}

function senderOf(message) {
  return message?.sender || message?.from || message?.author || {};
}

function normalizeMessage({ message, chat, accountId }) {
  const sender = senderOf(message);
  const senderId = String(sender.provider_id || sender.id || message.sender_id || "");
  const outgoing = Boolean(message.is_sender || message.is_outgoing || message.direction === "outbound" || senderId === String(accountId));
  const attendee = listOf(chat.attendees || chat.participants).find((person) => String(person.provider_id || person.id) !== String(accountId)) || {};
  const effectiveSender = outgoing ? attendee : sender;
  return {
    account_id: accountId,
    chat_id: idOf(chat),
    message_id: idOf(message) || `${idOf(chat)}:${message.timestamp || message.created_at || Date.now()}`,
    message: message.text || message.message || message.body || "",
    timestamp: message.timestamp || message.created_at || message.date || new Date().toISOString(),
    sender: {
      provider_id: effectiveSender.provider_id || effectiveSender.id || senderId,
      name: effectiveSender.name || effectiveSender.display_name || sender.name || "",
      username: effectiveSender.username || "",
    },
    outgoing,
  };
}

async function connectedAccount(workspaceId) {
  const connection = await SocialConnection.findOne({ workspaceId, provider: PROVIDER, status: "connected" });
  if (!connection) {
    const error = new Error("No connected LinkedIn (Unipile) account for this workspace");
    error.code = "LINKEDIN_NOT_CONNECTED";
    throw error;
  }
  return connection;
}

async function ensureMessagingWebhook({ workspaceId, backendBaseUrl, webhookToken }) {
  if (!webhookToken) throw new Error("UNIPILE_WEBHOOK_TOKEN is not configured");
  const connection = await connectedAccount(workspaceId);
  const accountId = connection.providerAccount?.id;
  const existing = connection.webhookSubscriptions?.find((row) => row.assetId === accountId && row.status === "subscribed");
  if (existing) return { registered: false, alreadyRegistered: true, accountId };
  const url = new URL(`${String(backendBaseUrl).replace(/\/$/, "")}/api/webhooks/unipile-messages`);
  url.searchParams.set("token", webhookToken);
  const response = await unipile.registerMessagingWebhook({ requestUrl: url.toString(), accountIds: [accountId] });
  connection.webhookSubscriptions = [
    ...(connection.webhookSubscriptions || []).filter((row) => row.assetId !== accountId),
    { assetId: accountId, fields: ["message_received"], status: "subscribed", verifiedAt: new Date(), error: "" },
  ];
  connection.lastVerifiedAt = new Date();
  connection.lastError = "";
  await connection.save();
  return { registered: true, accountId, webhookId: response?.id || response?.webhook_id || "" };
}

async function syncWorkspaceInbox({ workspaceId, maxChats = 100 }) {
  const connection = await connectedAccount(workspaceId);
  const accountId = connection.providerAccount?.id;
  let chatsSeen = 0;
  let messagesSeen = 0;
  let messagesImported = 0;
  let chatCursor;
  for (let chatPage = 0; chatPage < 20 && chatsSeen < maxChats; chatPage += 1) {
    const chatResponse = await unipile.getAllChats({ accountId, cursor: chatCursor });
    const chats = listOf(chatResponse);
    for (const chat of chats.slice(0, Math.max(0, maxChats - chatsSeen))) {
      chatsSeen += 1;
      let messageCursor;
      for (let messagePage = 0; messagePage < 20; messagePage += 1) {
        const response = await unipile.getAllMessagesFromChat({ chatId: idOf(chat), cursor: messageCursor });
        const messages = listOf(response);
        for (const message of [...messages].reverse()) {
          messagesSeen += 1;
          const normalized = normalizeMessage({ message, chat, accountId });
          if (!normalized.sender.provider_id || !normalized.message) continue;
          const result = await ingestLinkedinMessage({ connection, payload: normalized });
          if (result?.conversation?.created) messagesImported += 1;
        }
        messageCursor = response?.cursor || response?.next_cursor;
        if (!messageCursor || !messages.length) break;
      }
    }
    chatCursor = chatResponse?.cursor || chatResponse?.next_cursor;
    if (!chatCursor || !chats.length) break;
  }
  connection.lastVerifiedAt = new Date();
  await connection.save();
  return { chatsSeen, messagesSeen, messagesImported, syncedAt: new Date() };
}

module.exports = { listOf, normalizeMessage, connectedAccount, ensureMessagingWebhook, syncWorkspaceInbox };
