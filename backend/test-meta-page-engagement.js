const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = crypto
  .randomBytes(32)
  .toString("base64");
process.env.META_GRAPH_API_VERSION = "v26.0";
process.env.META_AUTOMATIC_REPLIES_ENABLED = "false";
process.env.SOCIAL_PUBLISHING_ENABLED = "false";
const { encryptCredentials } = require("./utils/credentialEncryption");
const service = require("./services/metaPageEngagementService");

function lean(value) {
  return { lean: async () => value };
}
function fixtures(scopes = ["pages_manage_engagement"], channel = "facebook") {
  const activities = [],
    calls = [],
    messages = [];
  const thread = {
    _id: "thread-1",
    workspaceId: "workspace-1",
    channel,
    providerThreadId: `${channel}:page-1:person-1:comment:comment-1`,
    contactIds: ["contact-1"],
    participants: [{ kind: "contact", address: "person-1" }],
    metadata: {
      interactionType: "comment",
      assetId: "page-1",
      commentId: "comment-1",
    },
  };
  const models = {
    ConversationThread: {
      findOne(filter) {
        return lean(
          filter._id === "thread-1" && filter.workspaceId === "workspace-1"
            ? thread
            : null,
        );
      },
    },
    ConversationMessage: {
      findOne(filter) {
        return lean(
          filter._id === "reply-message-1"
            ? {
                _id: "reply-message-1",
                workspaceId: "workspace-1",
                threadId: "thread-1",
                direction: "outbound",
                providerMessageId: "reply-1",
                metadata: { publicCommentReply: true },
                deletedAt: null,
              }
            : null,
        );
      },
      updateOne: async () => ({ acknowledged: true }),
    },
    connectionForAsset: async (assetId, provider, workspaceId) => {
      assert.deepEqual(
        [assetId, provider, workspaceId],
        ["page-1", null, "workspace-1"],
      );
      return {
        workspaceId,
        provider: "meta",
        status: "connected",
        scopes,
        selectedAssetIds: ["page-1"],
        assets: [
          {
            id: "page-1",
            type: channel === "instagram" ? "instagram_business" : "facebook_page",
          },
        ],
        credentialsEncrypted: encryptCredentials({
          pageTokens: { "page-1": "fixture-page-token" },
        }),
      };
    },
    CrmActivity: {
      findOne: async (filter) =>
        activities.find(
          (row) =>
            row.workspaceId === filter.workspaceId &&
            row.metadata.socialEventKey === filter["metadata.socialEventKey"],
        ) || null,
      create: async (values) => {
        const row = { _id: `activity-${activities.length + 1}`, ...values };
        activities.push(row);
        return row;
      },
      updateOne: async (filter, update) => {
        const row = activities.find((item) => item._id === filter._id);
        Object.entries(update.$set || {}).forEach(([key, value]) => {
          if (key.startsWith("metadata.")) row.metadata[key.slice(9)] = value;
          else row[key] = value;
        });
      },
    },
    ingestProviderMessage: async (payload) => {
      messages.push(payload);
      return payload;
    },
    http: {
      post: async (url, body, options) => {
        calls.push({ method: "post", url, body, options });
        return {
          data: url.endsWith("/comments") || url.endsWith("/replies")
            ? { id: "reply-1" }
            : { success: true },
        };
      },
      delete: async (url, options) => {
        calls.push({ method: "delete", url, options });
        return { data: { success: true } };
      },
      get: async (url, options) => {
        calls.push({ method: "get", url, options });
        return { data: { id: "comment-1" } };
      },
    },
  };
  return { models, activities, calls, messages };
}

function missingObjectError() {
  const error = new Error("Request failed");
  error.response = { status: 400, data: { error: { code: 100, error_subcode: 33, message: "Unsupported delete request. Object with ID 'comment-1' does not exist, cannot be loaded due to missing permission, or does not support this operation." } } };
  return error;
}

async function run() {
  const route = fs.readFileSync(
    __dirname + "/routes/socialWorkspace.js",
    "utf8",
  );
  assert(route.includes('router.use(requireCapability("social.manage"))'));
  assert(route.includes('"/inbox/:id/comment-actions"'));
  assert(route.includes("req.body.approved !== true"));
  const data = fixtures();
  const base = {
    workspaceId: "workspace-1",
    userId: "owner-1",
    threadId: "thread-1",
  };
  const reply = await service.perform(
    {
      ...base,
      action: "reply",
      body: "Thanks for your comment.",
      idempotencyKey: "reply_action_0001",
    },
    data.models,
  );
  assert.equal(reply.status, "confirmed");
  assert.match(data.calls[0].url, /v26\.0\/comment-1\/comments$/);
  assert.equal(data.calls[0].options.params.access_token, "fixture-page-token");
  assert.equal(data.messages[0].message.metadata.publicCommentReply, true);
  assert.equal(data.activities[0].metadata.senderType, "human");
  const duplicate = await service.perform(
    {
      ...base,
      action: "reply",
      body: "Thanks for your comment.",
      idempotencyKey: "reply_action_0001",
    },
    data.models,
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(
    data.calls.length,
    1,
    "duplicate request must not call Meta twice",
  );
  for (const action of ["hide", "unhide", "delete", "like", "unlike"])
    await service.perform(
      { ...base, action, idempotencyKey: `${action}_action_0001` },
      data.models,
    );
  assert(
    data.calls.some(
      (row) => row.method === "post" && row.body?.is_hidden === true,
    ),
  );
  assert(
    data.calls.some(
      (row) => row.method === "post" && row.body?.is_hidden === false,
    ),
  );
  assert(
    data.calls.some(
      (row) => row.method === "delete" && row.url.endsWith("/comment-1"),
    ),
  );
  assert(
    data.calls.some(
      (row) => row.method === "post" && row.url.endsWith("/comment-1/likes"),
    ),
  );
  assert(
    data.calls.some(
      (row) => row.method === "delete" && row.url.endsWith("/comment-1/likes"),
    ),
  );
  await assert.rejects(
    () =>
      service.perform(
        { ...base, action: "hide", idempotencyKey: "permission_action_1" },
        fixtures([]).models,
      ),
    /permission is required/,
  );

  // Instagram replies are public child comments, not one-time private DMs.
  const igReply = fixtures(["instagram_manage_comments"], "instagram");
  const igReplyResult = await service.perform(
    {
      ...base,
      action: "reply",
      body: "Thanks for asking!",
      idempotencyKey: "ig_reply_action_0001",
    },
    igReply.models,
  );
  assert.equal(igReplyResult.status, "confirmed");
  assert.equal(igReply.messages[0].message.providerMessageId, "reply-1");
  assert.match(igReply.calls[0].url, /\/comment-1\/replies$/);
  assert.equal(igReply.calls[0].body.message, "Thanks for asking!");

  // Instagram now supports the same real moderation actions as Facebook
  // (hide, unhide, delete) — only liking a comment has no Meta API endpoint.
  const ig = fixtures(["instagram_manage_comments"], "instagram");
  for (const action of ["hide", "unhide", "delete"])
    await service.perform(
      { ...base, action, idempotencyKey: `ig_${action}_action_0001` },
      ig.models,
    );
  assert(
    ig.calls.some(
      (row) =>
        row.method === "post" &&
        row.body?.hide === true &&
        row.url.endsWith("/comment-1"),
    ),
    "Instagram hide must POST { hide: true } to the comment node",
  );
  assert(
    ig.calls.some(
      (row) =>
        row.method === "post" &&
        row.body?.hide === false &&
        row.url.endsWith("/comment-1"),
    ),
    "Instagram unhide must POST { hide: false } to the comment node",
  );
  assert(
    ig.calls.some(
      (row) => row.method === "delete" && row.url.endsWith("/comment-1"),
    ),
    "Instagram delete must DELETE the comment node",
  );
  for (const action of ["like", "unlike"])
    await assert.rejects(
      () =>
        service.perform(
          { ...base, action, idempotencyKey: `ig_${action}_action_0001` },
          fixtures(["instagram_manage_comments"], "instagram").models,
        ),
      /does not let a business like a comment/,
    );
  await assert.rejects(
    () =>
      service.perform(
        {
          ...base,
          workspaceId: "workspace-2",
          action: "hide",
          idempotencyKey: "workspace_action_1",
        },
        data.models,
      ),
    /not found/,
  );
  assert.equal(process.env.META_AUTOMATIC_REPLIES_ENABLED, "false");
  assert.equal(process.env.SOCIAL_PUBLISHING_ENABLED, "false");
  assert(
    !JSON.stringify({
      activities: data.activities,
      messages: data.messages,
    }).includes("fixture-page-token"),
  );
  // A delete retried after the comment is already gone from Meta's side must
  // not surface as a failure: a second, independent GET confirming the
  // object is missing is real provider confirmation of the desired end
  // state, so the action should report confirmed rather than error.
  const alreadyGone = fixtures();
  alreadyGone.models.http.delete = async (url, options) => {
    alreadyGone.calls.push({ method: "delete", url, options });
    throw missingObjectError();
  };
  alreadyGone.models.http.get = async (url, options) => {
    alreadyGone.calls.push({ method: "get", url, options });
    throw missingObjectError();
  };
  const alreadyGoneResult = await service.perform(
    { ...base, action: "delete", idempotencyKey: "already_gone_action_1" },
    alreadyGone.models,
  );
  assert.equal(alreadyGoneResult.status, "confirmed");
  assert.equal(
    alreadyGone.activities[alreadyGone.activities.length - 1].metadata.outcome,
    "confirmed",
  );
  assert(
    alreadyGone.calls.some((row) => row.method === "get"),
    "an already-gone delete must be independently re-verified before being treated as confirmed",
  );

  // The same "does not exist" wording covers a real permission problem, not
  // only an already-deleted object — the verification GET must be able to
  // find the comment still there, and in that case the failure must stand.
  const stillThere = fixtures();
  stillThere.models.http.delete = async (url, options) => {
    stillThere.calls.push({ method: "delete", url, options });
    throw missingObjectError();
  };
  await assert.rejects(
    () =>
      service.perform(
        { ...base, action: "delete", idempotencyKey: "genuine_failure_action_1" },
        stillThere.models,
      ),
    /Meta rejected this action/,
  );
  assert.equal(
    stillThere.activities[stillThere.activities.length - 1].metadata.outcome,
    "failed",
  );

  console.log(
    "Meta Page engagement passed: reply, hide/unhide, delete, Page like/unlike, audit history, idempotency, permission gating, workspace isolation, already-deleted idempotency, and safety switches (mocked).",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
