const axios = require("axios");
const crypto = require("crypto");
const ConversationThread = require("../models/ConversationThread");
const ConversationMessage = require("../models/ConversationMessage");
const CrmActivity = require("../models/CrmActivity");
const { decryptCredentials } = require("../utils/credentialEncryption");
const { connectionForAsset } = require("./conversations/metaMessagingAdapter");
const {
  ingestProviderMessage,
} = require("./conversations/conversationIngestionService");
const { graphVersion } = require("./socialProviderConfig");

const ACTIONS = new Set([
  "reply",
  "hide",
  "unhide",
  "delete",
  "like",
  "unlike",
  "delete_reply",
]);
const deps = {
  ConversationThread,
  ConversationMessage,
  CrmActivity,
  connectionForAsset,
  ingestProviderMessage,
  http: axios,
};

function clean(value, max = 2000) {
  return String(value || "")
    .trim()
    .slice(0, max);
}
function safeProviderError(error) {
  const status = Number(error?.response?.status || 0);
  const providerMessage = error?.response?.data?.error?.message;
  if (status >= 400 && status < 500)
    return providerMessage
      ? `Meta rejected this action: ${providerMessage}`
      : `Meta rejected this action (HTTP ${status})`;
  return "Meta action outcome could not be confirmed";
}

async function reserve(models, values) {
  const existing = await models.CrmActivity.findOne({
    workspaceId: values.workspaceId,
    "metadata.socialEventKey": values.metadata.socialEventKey,
  });
  if (existing) return { activity: existing, duplicate: true };
  try {
    return {
      activity: await models.CrmActivity.create(values),
      duplicate: false,
    };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return {
      activity: await models.CrmActivity.findOne({
        workspaceId: values.workspaceId,
        "metadata.socialEventKey": values.metadata.socialEventKey,
      }),
      duplicate: true,
    };
  }
}

async function perform(
  { workspaceId, userId, threadId, action, body, messageId, idempotencyKey },
  models = deps,
) {
  if (!ACTIONS.has(action))
    throw new Error("Choose a supported Meta comment action");
  if (!/^[A-Za-z0-9_-]{16,120}$/.test(String(idempotencyKey || "")))
    throw new Error("A valid action idempotency key is required");
  const thread = await models.ConversationThread.findOne({
    _id: threadId,
    workspaceId,
    channel: { $in: ["facebook", "instagram"] },
    "metadata.interactionType": "comment",
  }).lean();
  if (!thread) throw new Error("Meta comment conversation not found");
  const provider = String(thread.channel);
  if (provider === "instagram" && ["like", "unlike"].includes(action))
    throw new Error(
      "Instagram does not let a business like a comment through Meta's API. Try Hide, Unhide, or Delete instead.",
    );
  let reply = null;
  if (action === "delete_reply") {
    reply = await models.ConversationMessage.findOne({
      _id: messageId,
      workspaceId,
      threadId,
      direction: "outbound",
      deletedAt: null,
      "metadata.publicCommentReply": true,
    }).lean();
    if (!reply?.providerMessageId)
      throw new Error(`${provider === "instagram" ? "Instagram" : "Facebook"} reply context is unavailable`);
  }
  const assetId = clean(thread.metadata?.assetId, 255),
    commentId = clean(thread.metadata?.commentId, 500);
  if (!assetId || !commentId)
    throw new Error("Meta comment context is unavailable");
  if (action === "reply" && (!clean(body) || clean(body).length > 2000))
    throw new Error("Reply must contain 1–2000 characters");
  // Every action here (including delete) always targets the commenter's
  // original comment. A Page's own reply cannot be independently managed
  // through this API — confirmed live: Facebook rejects even a plain read of
  // a reply by its own ID ("does not support this operation"), the same
  // reply that reads back fine when nested under its parent comment. Only
  // Lead Porch's own copy of a reply can be removed, via the plain message
  // delete endpoint, not this one.

  // Don't force provider:"meta" here — a comment's asset can be owned by
  // either a Facebook Login ("meta") connection or a standalone Direct
  // Instagram Login ("instagram") connection, and connectionForAsset already
  // prefers the "instagram" owner when both exist for the same asset (as
  // they do whenever a Page-linked IG account is also connected directly).
  // Forcing "meta" here rejected that legitimate owner outright with "The
  // selected Meta account is not connected", even though the account was
  // fully connected via the standalone Instagram connection.
  const connection = await models.connectionForAsset(
    assetId,
    null,
    workspaceId,
  );
  const asset = connection?.assets?.find(
    (row) =>
      row.type ===
        (provider === "instagram" ? "instagram_business" : "facebook_page") &&
      String(row.id) === assetId,
  );
  if (
    !connection ||
    !asset ||
    !connection.selectedAssetIds?.map(String).includes(assetId)
  )
    throw new Error("The selected Meta account is not connected");
  const requiredScope =
    provider === "instagram"
      ? connection.provider === "instagram"
        ? "instagram_business_manage_comments"
        : "instagram_manage_comments"
      : "pages_manage_engagement";
  if (!connection.scopes?.includes(requiredScope))
    throw new Error("Meta comment-management permission is required");
  const credentials = decryptCredentials(connection.credentialsEncrypted);
  const token =
    credentials.pageTokens?.[String(asset.parentId || asset.id)] ||
    (connection.provider === "instagram" ? credentials.accessToken : null);
  if (!token)
    throw new Error("Selected Meta account authorization is unavailable");

  const socialEventKey = `facebook:manual-engagement:${crypto.createHash("sha256").update(`${workspaceId}:${threadId}:${idempotencyKey}`).digest("hex")}`;
  const title = {
    reply: `${provider === "instagram" ? "Instagram" : "Facebook"} comment replied to`,
    hide: `${provider === "instagram" ? "Instagram" : "Facebook"} comment hidden`,
    unhide: `${provider === "instagram" ? "Instagram" : "Facebook"} comment unhidden`,
    delete: `${provider === "instagram" ? "Instagram" : "Facebook"} comment deleted`,
    like: `${provider === "instagram" ? "Instagram" : "Facebook"} comment liked`,
    unlike: `${provider === "instagram" ? "Instagram" : "Facebook"} comment reaction removed`,
    delete_reply: `${provider === "instagram" ? "Instagram" : "Facebook"} reply deleted`,
  }[action];
  const reserved = await reserve(models, {
    workspaceId,
    contactId: thread.contactIds?.[0] || null,
    type: "system",
    direction: action === "reply" ? "outbound" : "",
    title,
    body: action === "reply" ? clean(body) : "",
    source: "integration",
    createdBy: userId,
    metadata: {
      socialEventKey,
      eventType: `social.facebook.comment.${action}`,
      provider,
      assetId,
      commentId,
      threadId,
      senderType: "human",
      messageId: reply?._id || null,
      outcome: "pending",
    },
  });
  if (reserved.duplicate)
    return {
      duplicate: true,
      status: reserved.activity?.metadata?.outcome || "pending",
      activityId: reserved.activity?._id,
    };

  const version = graphVersion();
  try {
    let response;
    if (provider === "instagram") {
      const apiHost =
        connection.provider === "instagram"
          ? "graph.instagram.com"
          : "graph.facebook.com";
      if (action === "reply") {
        response = await models.http.post(
          `https://${apiHost}/${version}/${commentId}/replies`,
          { message: clean(body) },
          { params: { access_token: token }, timeout: 15000 },
        );
      } else if (["hide", "unhide"].includes(action)) {
        // Real, documented Instagram comment moderation — operates on the
        // comment node directly, unlike the reply above.
        response = await models.http.post(
          `https://${apiHost}/${version}/${commentId}`,
          { hide: action === "hide" },
          { params: { access_token: token }, timeout: 15000 },
        );
      } else if (action === "delete") {
        response = await models.http.delete(
          `https://${apiHost}/${version}/${commentId}`,
          { params: { access_token: token }, timeout: 15000 },
        );
      } else if (action === "delete_reply") {
        response = await models.http.delete(
          `https://${apiHost}/${version}/${reply.providerMessageId}`,
          { params: { access_token: token }, timeout: 15000 },
        );
      }
    } else if (action === "reply")
      response = await models.http.post(
        `https://graph.facebook.com/${version}/${commentId}/comments`,
        { message: clean(body) },
        { params: { access_token: token }, timeout: 15000 },
      );
    else if (["hide", "unhide"].includes(action))
      response = await models.http.post(
        `https://graph.facebook.com/${version}/${commentId}`,
        { is_hidden: action === "hide" },
        { params: { access_token: token }, timeout: 15000 },
      );
    else if (action === "delete")
      response = await models.http.delete(
        `https://graph.facebook.com/${version}/${commentId}`,
        { params: { access_token: token }, timeout: 15000 },
      );
    else if (action === "delete_reply")
      response = await models.http.delete(
        `https://graph.facebook.com/${version}/${reply.providerMessageId}`,
        { params: { access_token: token }, timeout: 15000 },
      );
    else if (action === "like")
      response = await models.http.post(
        `https://graph.facebook.com/${version}/${commentId}/likes`,
        null,
        { params: { access_token: token }, timeout: 15000 },
      );
    else
      response = await models.http.delete(
        `https://graph.facebook.com/${version}/${commentId}/likes`,
        { params: { access_token: token }, timeout: 15000 },
      );
    // Facebook's comment-reply endpoint confirms success with an "id"; the
    // Both public comment-reply endpoints confirm creation with an "id".
    if (
      response?.data?.success === false ||
      (action === "reply" &&
        !response?.data?.id)
    )
      throw new Error("Meta did not confirm the action");
    if (action === "reply")
      await models.ingestProviderMessage({
        thread: {
          channel: provider,
          provider: "meta",
          providerThreadId: thread.providerThreadId,
          participants: thread.participants,
          contactIds: thread.contactIds,
          metadata: thread.metadata,
        },
        message: {
          providerMessageId: String(
            response.data.id,
          ),
          direction: "outbound",
          body: clean(body),
          createdBy: userId,
          sender: { address: assetId },
          contactId: thread.contactIds?.[0] || null,
          deliveryStatus: "sent",
          metadata: {
            assetId,
            senderType: "human",
            publicCommentReply: true,
            privateReply: false,
            parentCommentId: commentId,
          },
        },
      });
    if (action === "delete_reply")
      await models.ConversationMessage.updateOne(
        { _id: reply._id, workspaceId, threadId, deletedAt: null },
        { $set: { deletedAt: new Date(), deletedBy: userId } },
      );
    await models.CrmActivity.updateOne(
      { _id: reserved.activity._id, workspaceId },
      {
        $set: {
          "metadata.outcome": "confirmed",
          "metadata.providerActionId": clean(response?.data?.id, 500),
          completedAt: new Date(),
        },
      },
    );
    return { duplicate: false, status: "confirmed", action };
  } catch (error) {
    console.error(
      `[Meta comment action] failed: workspaceId=${workspaceId} action=${action} provider=${provider} assetId=${assetId} status=${error.response?.status || "n/a"} providerCode=${error.response?.data?.error?.code || "n/a"} providerMessage=${error.response?.data?.error?.message || "n/a"}`,
    );
    const outcome =
      Number(error?.response?.status || 0) >= 400 &&
      Number(error?.response?.status || 0) < 500
        ? "failed"
        : "unknown";
    await models.CrmActivity.updateOne(
      { _id: reserved.activity._id, workspaceId },
      {
        $set: {
          "metadata.outcome": outcome,
          "metadata.error": safeProviderError(error),
        },
      },
    );
    const failure = new Error(safeProviderError(error));
    failure.status = outcome === "failed" ? 400 : 502;
    throw failure;
  }
}

module.exports = { ACTIONS, perform, safeProviderError };
