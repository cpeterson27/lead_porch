const crypto = require("crypto");
const axios = require("axios");
const ConversationThread = require("../../models/ConversationThread");
const SocialConnection = require("../../models/SocialConnection");
const { decryptCredentials } = require("../../utils/credentialEncryption");
const { ConversationChannelAdapter, registerConversationAdapter } = require("./channelAdapters");
const { ingestProviderMessage } = require("./conversationIngestionService");
const { ingestSocialEvent } = require("../socialLeadAutomationService");

function validateMetaSignature(rawBody, signature, secretName = "META_APP_SECRET") {
  const secret = String(process.env[secretName] || "").trim();
  const supplied = String(signature || "").replace(/^sha256=/, "");
  if (!secret || !rawBody || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}

async function connectionForAsset(assetId, provider = null, workspaceId = null) {
  const scope = workspaceId || require("../../tenancy/workspaceContext").currentWorkspaceId();
  const rows = await SocialConnection.find({ ...(scope ? { workspaceId: scope } : {}), provider: { $in: ["meta", "instagram"] }, status: { $in: ["connected", "expired", "failed"] }, selectedAssetIds: String(assetId) }).select("+credentialsEncrypted");
  // Fail closed across workspaces; legacy dual selections use direct Instagram only.
  if (new Set(rows.map(row => String(row.workspaceId))).size !== 1) return null;
  const owner = rows.find(row => row.provider === "instagram") || rows[0];
  return require("../socialConnectionHealth").usable(owner) && (!provider || owner.provider === provider) ? owner : null;
}

function assetChannel(connection, assetId) {
  const asset = connection.assets.find((item) => String(item.id) === String(assetId));
  return asset?.type === "instagram_business" ? "instagram" : "facebook";
}

function webhookAssetId(connection, entryAssetId, payload = {}) {
  const entryId = String(entryAssetId || "");
  const recipientId = String(payload?.recipient?.id || "");
  if (!recipientId || recipientId === entryId) return entryId;
  const selected = new Set((connection?.selectedAssetIds || []).map(String));
  const recipientAsset = (connection?.assets || []).find(
    (asset) =>
      String(asset.id) === recipientId &&
      selected.has(String(asset.id)) &&
      (String(asset.parentId || "") === entryId || String(asset.id) === entryId),
  );
  return recipientAsset ? String(recipientAsset.id) : entryId;
}

async function ingestMetaMessage({ connection, assetId, event, entryTime }) {
  const normalized = require("../metaEventNormalizer").normalize({ connection, assetId, messaging: event, entryTime });
  return normalized ? ingestSocialEvent(normalized) : { ignored: true };
}
async function ingestMetaComment({ connection, assetId, change, entryTime }) {
  const normalized = require("../metaEventNormalizer").normalize({ connection, assetId, change, entryTime });
  return normalized ? ingestSocialEvent(normalized) : { ignored: true };
}

class MetaMessagingAdapter extends ConversationChannelAdapter {
  constructor() { super("social", "meta"); }
  async status(connection) {
    const scopes = new Set(connection?.scopes || []);
    return { connected: connection?.status === "connected", webhookConfigured: Boolean(String((connection?.provider === "instagram" ? process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN : process.env.META_WEBHOOK_VERIFY_TOKEN) || "").trim()), facebookMessaging: scopes.has("pages_messaging"), instagramMessaging: scopes.has("instagram_manage_messages") || scopes.has("instagram_business_manage_messages"), selectedAssets: connection?.selectedAssetIds?.length || 0 };
  }
  async sendMessage({ channel, assetId, recipientId, body, threadId, workspaceId, userId = null, senderType = "automation", connectionProvider = null }) {
    const connection = await connectionForAsset(assetId, connectionProvider, workspaceId);
    if (!connection || !connection.selectedAssetIds.includes(String(assetId))) throw new Error("The Meta asset is not connected and selected");
    const thread = threadId ? await ConversationThread.findById(threadId).lean() : null;
    if (!thread || (workspaceId && String(thread.workspaceId) !== String(workspaceId)) || String(connection.workspaceId) !== String(thread.workspaceId)) throw new Error("Social conversation is not in this workspace");
    if (thread.channel !== channel || String(thread.metadata?.assetId) !== String(assetId) || !thread.participants?.some(person => String(person.address) === String(recipientId) && person.kind === "contact")) throw new Error("Recipient and asset must match the existing social conversation");
    if (!String(body || "").trim() || String(body).length > 2000) throw new Error("Reply must contain 1–2000 characters");
    if (["comment", "mention"].includes(thread.metadata?.interactionType)) throw new Error("Comments require a permitted comment/private-reply action, not a free-form DM");
    if (!thread?.lastInboundAt || Date.now() - new Date(thread.lastInboundAt).getTime() > 24 * 60 * 60 * 1000) throw new Error("Meta free-form replies require a customer message within the last 24 hours");
    const scope = channel === "facebook" ? "pages_messaging" : connection.provider === "instagram" ? "instagram_business_manage_messages" : "instagram_manage_messages";
    if (!connection.scopes?.includes(scope)) throw new Error("Messaging permission is unavailable");
    const credentials = decryptCredentials(connection.credentialsEncrypted);
    const asset = connection.assets.find((item) => String(item.id) === String(assetId));
    const pageId = asset?.type === "instagram_business" ? asset.parentId : assetId;
    const token = credentials.pageTokens?.[String(pageId)] || (connection.provider === "instagram" ? credentials.accessToken : null);
    const version = require("../socialProviderConfig").graphVersion();
    if (!token || !version) throw new Error("Meta messaging credentials are unavailable");
    const apiHost = connection.provider === "instagram" ? "graph.instagram.com" : "graph.facebook.com";
    console.log(`[Meta messaging] outbound message requested: workspaceId=${connection.workspaceId} channel=${channel} assetId=${assetId} senderType=${senderType} bodyLength=${String(body || "").trim().length}`);
    let response;
    try {
      response = await axios.post(`https://${apiHost}/${version}/${assetId}/messages`, { recipient: { id: recipientId }, message: { text: String(body || "").trim() } }, { params: { access_token: token }, timeout: 15000 });
    } catch (error) {
      console.error(`[Meta messaging] Meta API request failed: workspaceId=${connection.workspaceId} assetId=${assetId} status=${error.response?.status || "n/a"} providerCode=${error.response?.data?.error?.code || "n/a"}`);
      throw error;
    }
    console.log(`[Meta messaging] Meta API response: workspaceId=${connection.workspaceId} assetId=${assetId} status=${response.status} messageId=${response.data?.message_id || "missing"}`);
    if (!response.data?.message_id) throw new Error("Provider message outcome is unknown");
    const saved = await ingestProviderMessage({ thread: { channel, provider: "meta", providerThreadId: thread.providerThreadId, participants: thread.participants, contactIds: thread.contactIds, organizationId: thread.organizationId, metadata: thread.metadata }, message: { providerMessageId: response.data?.message_id || `meta:${crypto.randomUUID()}`, direction: "outbound", body, createdBy: userId, sender: { address: String(assetId) }, recipients: [{ address: String(recipientId), role: "to" }], deliveryStatus: "sent", metadata: { assetId, senderType } } });
    console.log(`[Meta messaging] outbound message saved: threadId=${saved.thread._id} messageId=${saved.message._id}`);
    return saved;
  }
  async sendCommentPrivateReply({ assetId, commentId, body, occurredAt, threadId, workspaceId, connectionProvider = null, senderType = "automation" }) {
    if (!commentId || !String(body || "").trim() || String(body).length > 2000) throw new Error("A comment and 1–2000 character response are required");
    if (!occurredAt || !Number.isFinite(new Date(occurredAt).getTime()) || Date.now() - new Date(occurredAt).getTime() > 7 * 24 * 60 * 60 * 1000) throw new Error("Private reply window has expired");
    const connection = await connectionForAsset(assetId, connectionProvider, workspaceId);
    if (!connection) throw new Error("The Meta asset is not connected");
    const thread = await ConversationThread.findOne({ _id: threadId, workspaceId: connection.workspaceId }).lean();
    if (!thread || String(thread.metadata?.assetId) !== String(assetId) || String(thread.metadata?.commentId) !== String(commentId)) throw new Error("Comment must belong to this workspace conversation");
    const asset = connection.assets.find(item => String(item.id) === String(assetId));
    const scope = asset?.type === "facebook_page" ? "pages_messaging" : connection.provider === "instagram" ? "instagram_business_manage_comments" : "instagram_manage_comments";
    if (!connection.scopes?.includes(scope)) throw new Error("Private reply permission is unavailable");
    const credentials = decryptCredentials(connection.credentialsEncrypted);
    const token = credentials.pageTokens?.[String(asset.parentId || asset.id)] || (connection.provider === "instagram" ? credentials.accessToken : null);
    if (!token) throw new Error("Selected account credentials are unavailable");
    const version = require("../socialProviderConfig").graphVersion();
    const host = connection.provider === "instagram" ? "graph.instagram.com" : "graph.facebook.com";
    const response = asset.type === "facebook_page"
      ? await axios.post(`https://graph.facebook.com/${version}/${commentId}/private_replies`, { message: String(body) }, { params: { access_token: token }, timeout: 15000 })
      : await axios.post(`https://${host}/${version}/${assetId}/messages`, { recipient: { comment_id: commentId }, message: { text: String(body) } }, { params: { access_token: token }, timeout: 15000 });
    const messageId = response.data?.message_id || response.data?.id;
    if (!messageId) throw new Error("Provider message outcome is unknown");
    return ingestProviderMessage({ thread: { channel: thread.channel, provider: "meta", providerThreadId: thread.providerThreadId, participants: thread.participants, contactIds: thread.contactIds, metadata: thread.metadata }, message: { providerMessageId: String(messageId), direction: "outbound", body: String(body), sender: { address: String(assetId) }, contactId: thread.contactIds?.[0], deliveryStatus: "sent", metadata: { senderType, commentId, privateReply: true } } });
  }
}

const metaMessagingAdapter = registerConversationAdapter(new MetaMessagingAdapter());
module.exports = { MetaMessagingAdapter, assetChannel, connectionForAsset, ingestMetaComment, ingestMetaMessage, metaMessagingAdapter, validateMetaSignature, webhookAssetId };
