const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { normalize } = require("./services/metaEventNormalizer");
const { ingestSocialEvent } = require("./services/socialLeadAutomationService");
const { deliver } = require("./services/metaAutomationReplyService");
const {
  connectionForAsset,
  metaMessagingAdapter,
  webhookAssetId,
} = require("./services/conversations/metaMessagingAdapter");
const Connection = require("./models/SocialConnection");
const oauth = require("./services/socialOAuthService");
const {
  encryptCredentials,
  decryptCredentials,
} = require("./utils/credentialEncryption");
const { usable } = require("./services/socialConnectionHealth");
const {
  runWithWorkspace,
  currentWorkspaceId,
} = require("./tenancy/workspaceContext");

Object.assign(process.env, {
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: crypto
    .randomBytes(32)
    .toString("base64"),
  META_APP_ID: "app",
  META_APP_SECRET: "fixture",
  FACEBOOK_LOGIN_CONFIG_ID: "123",
  META_REDIRECT_URI: "https://example.test/api/social/meta/oauth/callback",
  META_GRAPH_API_VERSION: "v26.0",
  INSTAGRAM_APP_ID: "ig-app",
  INSTAGRAM_APP_SECRET: "fixture",
  INSTAGRAM_REDIRECT_URI:
    "https://example.test/api/social/instagram/oauth/callback",
  META_AUTOMATIC_REPLIES_ENABLED: "false",
  SOCIAL_PUBLISHING_ENABLED: "false",
});
const now = Date.now();
const connection = {
  workspaceId: "a",
  provider: "instagram",
  status: "connected",
  authorization: { valid: true },
  assets: [{ id: "ig", type: "instagram_business" }],
  selectedAssetIds: ["ig"],
};
const comment = normalize({
  connection,
  assetId: "ig",
  entryTime: now,
  change: {
    field: "comments",
    value: {
      id: "comment",
      from: { id: "person", username: "student" },
      media: { id: "reel" },
      text: "DEAL",
    },
  },
});
assert.equal(comment.providerUserId, "person");
assert.equal(comment.contentId, "reel");
assert.equal(comment.sourceMetadata.commentId, "comment");
assert.equal(comment.replyPolicy, "private_reply");
assert.equal(comment.opensMessagingWindow, false);
const dm = normalize({
  connection,
  assetId: "ig",
  messaging: {
    sender: { id: "person" },
    recipient: { id: "ig" },
    timestamp: now,
    message: { mid: "dm", text: "Hello" },
  },
});
assert.equal(dm.eventType, "dm_received");
assert.equal(dm.opensMessagingWindow, true);
const pageLinkedConnection = {
  ...connection,
  provider: "meta",
  assets: [
    { id: "page", type: "facebook_page" },
    { id: "ig", type: "instagram_business", parentId: "page" },
  ],
  selectedAssetIds: ["page", "ig"],
};
assert.equal(
  webhookAssetId(pageLinkedConnection, "page", {
    sender: { id: "person" },
    recipient: { id: "ig" },
  }),
  "ig",
  "Page-level webhook deliveries must route Instagram DMs to the linked Instagram asset",
);
assert.equal(
  normalize({
    connection: pageLinkedConnection,
    assetId: webhookAssetId(pageLinkedConnection, "page", {
      sender: { id: "person" },
      recipient: { id: "ig" },
    }),
    messaging: {
      sender: { id: "person" },
      recipient: { id: "ig" },
      timestamp: now,
      message: { mid: "page-routed-instagram-dm", text: "Hello from Instagram" },
    },
  }).provider,
  "instagram",
);
const edited = normalize({
  connection,
  assetId: "ig",
  messaging: {
    sender: { id: "person" },
    recipient: { id: "ig" },
    timestamp: now,
    message: { mid: "edited", text: "Corrected", is_edited: true },
  },
});
assert.equal(edited.eventType, "dm_received");
assert.equal(edited.sourceMetadata.edited, true);
const reaction = normalize({
  connection,
  assetId: "ig",
  messaging: {
    sender: { id: "person" },
    recipient: { id: "ig" },
    timestamp: now,
    reaction: { mid: "dm", reaction: "love" },
  },
});
assert.equal(reaction.eventType, "message_reaction");
assert.equal(reaction.sourceMetadata.reaction, "love");
const optin = normalize({
  connection,
  assetId: "ig",
  messaging: {
    sender: { id: "person" },
    recipient: { id: "ig" },
    timestamp: now,
    optin: { ref: "welcome" },
  },
});
assert.equal(optin.eventType, "optin_received");
assert.equal(optin.triggerType, "optin");
assert.equal(optin.opensMessagingWindow, false);
const seen = normalize({
  connection,
  assetId: "ig",
  messaging: {
    sender: { id: "person" },
    recipient: { id: "ig" },
    timestamp: now,
    seen: { watermark: now },
  },
});
assert.equal(seen.eventType, "message_seen");
assert.equal(seen.recordOnly, true);
const delivered = normalize({
  connection,
  assetId: "ig",
  messaging: {
    sender: { id: "person" },
    recipient: { id: "ig" },
    timestamp: now,
    delivery: { mids: ["sent-message"] },
  },
});
assert.equal(delivered.eventType, "message_delivered");
assert.deepEqual(delivered.sourceMetadata.messageIds, ["sent-message"]);
const changedEdit = normalize({
  connection,
  assetId: "ig",
  entryTime: now,
  change: {
    field: "message_edit",
    value: {
      sender: { id: "person" },
      recipient: { id: "ig" },
      timestamp: now,
      message_id: "changed-edit",
      text: "Changed through field",
    },
  },
});
assert.equal(changedEdit.eventType, "dm_received");
assert.equal(changedEdit.sourceMetadata.edited, true);
const mention = normalize({
  connection,
  assetId: "ig",
  entryTime: now,
  change: {
    field: "mentions",
    value: { media_id: "media", comment_id: "mention", from: { id: "person" } },
  },
});
assert.equal(mention.eventType, "mention_received");
assert.equal(mention.replyPolicy, "none");
const anonymous = normalize({
  connection,
  assetId: "ig",
  entryTime: now,
  change: { field: "mentions", value: { media_id: "media-2" } },
});
assert.equal(anonymous.contextOnly, true);
assert.equal(anonymous.providerUserId, "");
const postback = normalize({
  connection,
  assetId: "ig",
  messaging: {
    sender: { id: "person" },
    timestamp: now,
    postback: { mid: "button", title: "Get resource", payload: "DEAL" },
  },
});
assert.equal(postback.eventType, "postback_received");
assert.equal(postback.sourceMetadata.postbackPayload, "DEAL");
const referralInput = {
  connection,
  assetId: "ig",
  messaging: {
    sender: { id: "person" },
    timestamp: now,
    referral: { ref: "campaign", source: "SHORTLINK", type: "OPEN_THREAD" },
  },
};
const referral = normalize(referralInput);
assert.equal(referral.eventType, "referral_received");
assert.equal(referral.opensMessagingWindow, false);
assert.equal(
  normalize(referralInput).providerEventId,
  referral.providerEventId,
);
const story = normalize({
  connection,
  assetId: "ig",
  messaging: {
    sender: { id: "person" },
    timestamp: now,
    message: {
      mid: "story",
      text: "Interested",
      reply_to: { story: { id: "story-id" } },
    },
  },
});
assert.equal(story.eventType, "story_reply");
assert.equal(story.contentId, "story-id");
assert.equal(
  normalize({
    connection,
    assetId: "ig",
    change: { field: "story_insights", value: { id: "story", reach: 42 } },
  }),
  null,
);
assert.equal(
  normalize({
    connection,
    assetId: "ig",
    change: { field: "messaging_handover", value: { id: "handover" } },
  }),
  null,
);
assert.equal(
  normalize({
    connection,
    assetId: "ig",
    change: { field: "standby", value: { id: "standby" } },
  }),
  null,
);
assert.equal(
  normalize({
    connection,
    assetId: "ig",
    messaging: { sender: { id: "person" }, timestamp: now, follow: true },
  }),
  null,
);
assert.equal(
  normalize({
    connection,
    assetId: "unselected",
    change: { field: "comments", value: { id: "x" } },
  }),
  null,
);
assert.equal(
  normalize({
    connection,
    assetId: "ig",
    messaging: {
      sender: { id: "ig" },
      timestamp: now,
      message: { mid: "echo", is_echo: true },
    },
  }),
  null,
);
const facebook = {
  ...connection,
  provider: "meta",
  assets: [{ id: "page", type: "facebook_page" }],
  selectedAssetIds: ["page"],
};
const feed = normalize({
  connection: facebook,
  assetId: "page",
  entryTime: now,
  change: {
    field: "feed",
    value: {
      item: "comment",
      verb: "add",
      comment_id: "fb-comment",
      post_id: "post",
      from: { id: "fb-person" },
      message: "DEAL",
    },
  },
});
assert.equal(feed.provider, "facebook");
assert.equal(feed.contentId, "post");
const liveComment = normalize({
  connection,
  assetId: "ig",
  entryTime: now,
  change: {
    field: "live_comments",
    value: {
      id: "live-comment",
      from: { id: "person" },
      media: { id: "live-video" },
      text: "DEAL",
    },
  },
});
assert.equal(liveComment.eventType, "comment_received");
assert.equal(liveComment.sourceMetadata.field, "live_comments");
const customerInfo = normalize({
  connection: facebook,
  assetId: "page",
  entryTime: now,
  change: {
    field: "messaging_customer_information",
    value: { id: "info", psid: "fb-person", name: "Student" },
  },
});
assert.equal(customerInfo.eventType, "customer_information");
assert.equal(customerInfo.recordOnly, true);
const leadForm = normalize({
  connection: facebook,
  assetId: "page",
  entryTime: now,
  change: {
    field: "messaging_in_thread_lead_form_submit",
    value: { lead_id: "lead", psid: "fb-person" },
  },
});
assert.equal(leadForm.eventType, "lead_form_received");
assert.equal(leadForm.providerUserId, "fb-person");
assert.equal(
  normalize({
    connection: facebook,
    assetId: "page",
    change: { field: "feed", value: { item: "reaction", id: "reaction" } },
  }),
  null,
);
assert.equal(
  normalize({
    connection: facebook,
    assetId: "page",
    change: {
      field: "feed",
      value: { item: "comment", verb: "remove", comment_id: "x" },
    },
  }),
  null,
);

function doc(values) {
  return {
    ...values,
    _id: values._id || crypto.randomUUID(),
    workspaceId: values.workspaceId || currentWorkspaceId(),
    set(path, value) {
      const [a, b] = path.split(".");
      if (b) {
        this[a] ||= {};
        this[a][b] = value;
      } else this[a] = value;
    },
    async save() {
      return this;
    },
  };
}
async function pipeline() {
  const contacts = [],
    identities = [],
    events = [],
    activities = [],
    inbox = [],
    deliveryUpdates = [],
    editUpdates = [];
  const scope = (row) => row.workspaceId === currentWorkspaceId();
  const models = {
    Contact: {
      create: async (values) => {
        const row = doc(values);
        contacts.push(row);
        return row;
      },
      findById: async (id) =>
        contacts.find((row) => scope(row) && row._id === id),
    },
    SocialIdentity: {
      findOne: async (filter) =>
        identities.find(
          (row) =>
            scope(row) &&
            Object.entries(filter).every(([key, value]) => row[key] === value),
        ),
      find: async (filter) =>
        identities.filter(
          (row) =>
            scope(row) &&
            Object.entries(filter).every(([key, value]) =>
              Array.isArray(row[key]) ? row[key].includes(value) : row[key] === value,
            ),
        ),
      create: async (values) => {
        const row = doc(values);
        identities.push(row);
        return row;
      },
    },
    SocialProviderEvent: {
      create: async (values) => {
        if (
          events.some(
            (row) =>
              scope(row) &&
              row.providerEventId === values.providerEventId &&
              row.provider === values.provider,
          )
        )
          throw Object.assign(Error("duplicate"), { code: 11000 });
        const row = doc(values);
        events.push(row);
        return row;
      },
      findOne: async (filter) =>
        events.find(
          (row) =>
            scope(row) &&
            row.providerEventId === filter.providerEventId &&
            row.provider === filter.provider,
        ),
    },
    SocialAutomation: {
      find: () => ({
        sort: async () => [
          doc({
            triggerType: "comment_keyword",
            keywords: ["deal"],
            responseTemplate: "Here is your resource",
            tags: ["resource-request"],
          }),
        ],
      }),
    },
    CrmActivity: {
      create: async (values) => {
        activities.push(doc(values));
        return values;
      },
    },
    ConversationMessage: {
      updateMany: async (filter, update) => {
        deliveryUpdates.push({ filter, update });
      },
      updateOne: async (filter, update) => {
        editUpdates.push({ filter, update });
      },
    },
  };
  const options = {
    models,
    ingestMessage: async (payload) => {
      inbox.push(payload);
      return { thread: { _id: "thread" }, message: payload.message };
    },
  };
  await runWithWorkspace("a", async () => {
    const first = await ingestSocialEvent(comment, options);
    assert.equal(first.contact.type, "lead");
    assert(first.contact.tags.includes("resource-request"));
    assert.equal(first.event.reply.body, "Here is your resource");
    assert.equal(first.event.reply.status, "pending");
    assert.equal((await ingestSocialEvent(comment, options)).duplicate, true);
    assert.equal(contacts.length, 1);
    assert.equal(inbox.length, 1);
    first.event.providerEventId = comment.legacyProviderEventId;
    assert.equal(
      (await ingestSocialEvent(comment, options)).duplicate,
      true,
      "Legacy event receipt prevents repeat delivery",
    );
    assert.equal(inbox.length, 1);
    for (const event of [
      dm,
      edited,
      reaction,
      optin,
      seen,
      delivered,
      mention,
      postback,
      referral,
      story,
      liveComment,
    ]) {
      const result = await ingestSocialEvent(event, options);
      assert.equal(result.contact._id, first.contact._id);
    }
    const customerResult = await ingestSocialEvent(customerInfo, options);
    const leadResult = await ingestSocialEvent(leadForm, options);
    assert.equal(
      customerResult.contact._id,
      leadResult.contact._id,
      "Facebook customer information and in-thread lead form converge by scoped Meta identity",
    );
    assert.equal(identities.length, 2);
    const count = contacts.length;
    assert.equal(
      (await ingestSocialEvent(anonymous, options)).contextOnly,
      true,
    );
    assert.equal(contacts.length, count);
    assert.equal(
      (
        await ingestSocialEvent(
          { ...comment, eventType: "follow", triggerType: "follow" },
          options,
        )
      ).ignored,
      true,
    );
    assert(
      activities.some(
        (row) => row.metadata.eventType === "social.keyword.matched",
      ),
    );
    assert(
      activities.some((row) => row.metadata.eventType === "social.dm.received"),
    );
    assert.equal(deliveryUpdates.length, 1);
    assert.equal(deliveryUpdates[0].update.$set.deliveryStatus, "delivered");
    assert.equal(editUpdates.length, 1);
    assert.equal(editUpdates[0].update.$set.body, "Corrected");
    assert(
      inbox.every((row) =>
        contacts.some((contact) => contact._id === row.thread.contactIds[0]),
      ),
    );
  });
  await runWithWorkspace("b", async () => {
    const other = await ingestSocialEvent(comment, options);
    assert.equal(other.duplicate, false);
    assert.equal(other.contact.workspaceId, "b");
    assert.notEqual(other.contact._id, contacts[0]._id);
  });
}

async function replies() {
  let sends = 0,
    state = "pending";
  const record = {
    _id: "event",
    workspaceId: "a",
    provider: "instagram",
    occurredAt: new Date(),
    reply: {
      status: "pending",
      policy: "private_reply",
      body: "Exact message",
      threadId: "thread",
    },
  };
  const models = {
    SocialProviderEvent: {
      findOneAndUpdate: async (filter) => {
        assert.equal(filter.workspaceId, "a");
        if (state !== "pending") return null;
        state = "sending";
        return record;
      },
      updateOne: async (_, update) => {
        state = update.$set["reply.status"];
      },
    },
    adapter: {
      sendCommentPrivateReply: async (input) => {
        sends++;
        assert.equal(input.body, "Exact message");
        return { message: { providerMessageId: "sent" } };
      },
    },
    CrmActivity: {
      create: async (row) => {
        assert.equal(row.body, "Exact message");
        assert.equal(row.metadata.senderType, "automation");
      },
    },
  };
  assert.equal(
    (await deliver(record, models)).status,
    "disabled_or_already_handled",
  );
  assert.equal(sends, 0);
  process.env.META_AUTOMATIC_REPLIES_ENABLED = "true";
  await Promise.all([deliver(record, models), deliver(record, models)]);
  assert.equal(sends, 1);
  assert.equal(state, "sent");
  state = "pending";
  models.adapter.sendCommentPrivateReply = async () => {
    sends++;
    throw Error("uncertain provider timeout");
  };
  assert.equal((await deliver(record, models)).status, "unknown");
  await deliver(record, models);
  assert.equal(sends, 2);
  process.env.META_AUTOMATIC_REPLIES_ENABLED = "false";
}

async function discoveryAndSelection() {
  let gets = 0;
  const pages = await oauth.discoverPages(
    "secret",
    { apiVersion: "v26.0" },
    {
      get: async (url, options) => {
        assert.equal(url, "https://graph.facebook.com/v26.0/me/accounts");
        gets++;
        if (gets === 1)
          return {
            data: {
              data: [{ id: "page-a" }],
              paging: {
                next: "https://untrusted.test/?token=secret",
                cursors: { after: "cursor" },
              },
            },
          };
        assert.equal(options.params.after, "cursor");
        return { data: { data: [{ id: "page-b" }] } };
      },
    },
  );
  assert.equal(pages.length, 2);
  const original = Connection.findOne;
  const row = doc({
    workspaceId: "a",
    provider: "meta",
    status: "connected",
    authorization: { valid: true },
    assets: [
      { id: "page-a", type: "facebook_page" },
      { id: "page-b", type: "facebook_page" },
      { id: "ig", type: "instagram_business", parentId: "page-a" },
    ],
    selectedAssetIds: [],
    credentialsEncrypted: encryptCredentials({
      accessToken: "user",
      pageTokens: { "page-b": "discard-me" },
    }),
  });
  row.toObject = () => ({ ...row });
  let subscriptions = 0;
  Connection.findOne = (filter) => ({
    select: async () => (filter.workspaceId === "a" ? row : null),
  });
  const http = {
    get: async (url) =>
      url.endsWith("/subscribed_apps")
        ? {
            data: {
              data: [
                {
                  id: "app",
                  subscribed_fields: oauth.subscriptionFields({
                    type: "facebook_page",
                  }),
                },
              ],
            },
          }
        : { data: { id: "page-a", access_token: "selected-only" } },
    post: async () => {
      subscriptions++;
      return { data: { success: true } };
    },
    delete: async () => ({}),
  };
  try {
    await assert.rejects(
      oauth.selectAssets("b", "meta", ["page-a"], http),
      /reconnection/,
    );
    await assert.rejects(
      oauth.selectAssets("a", "meta", ["ig"], http),
      /Facebook Page/,
    );
    // Selecting an asset already selected through another connection is
    // intentionally allowed (see "Restore simultaneous Meta and Instagram
    // routing") — an Instagram business account may be routed through both
    // Facebook Login and direct Instagram Login at once.
    await oauth.selectAssets("a", "meta", ["page-a"], http);
    assert.deepEqual(decryptCredentials(row.credentialsEncrypted).pageTokens, {
      "page-a": "selected-only",
    });
    await oauth.selectAssets("a", "meta", [], http);
    assert.deepEqual(
      decryptCredentials(row.credentialsEncrypted).pageTokens,
      {},
    );
  } finally {
    Connection.findOne = original;
  }
  // Intentionally non-unique — see "Restore simultaneous Meta and Instagram
  // routing": the same asset may be selected through more than one connection.
  assert(
    Connection.schema
      .indexes()
      .some(
        ([keys, opts]) => keys.selectedAssetIds && opts.partialFilterExpression && !opts.unique,
      ),
  );
}
async function ownership() {
  const original = Connection.find;
  let rows = [{ ...connection, provider: "meta" }, connection];
  Connection.find = (filter) => ({
    select: async () =>
      rows.filter(
        (row) => !filter.workspaceId || row.workspaceId === filter.workspaceId,
      ),
  });
  try {
    assert.equal((await connectionForAsset("ig")).provider, "instagram");
    assert.equal(await connectionForAsset("ig", "meta"), null);
    assert.equal(await connectionForAsset("ig", null, "b"), null);
    rows.push({ ...connection, workspaceId: "b" });
    assert.equal(
      await connectionForAsset("ig"),
      null,
      "Ambiguous workspace must fail closed",
    );
    rows = [
      { ...connection, provider: "meta" },
      { ...connection, expiresAt: new Date(0) },
    ];
    assert.equal(
      await connectionForAsset("ig"),
      null,
      "Expired direct owner must not silently fall back",
    );
    await assert.rejects(
      metaMessagingAdapter.sendMessage({ assetId: "ig", workspaceId: "a" }),
      /not connected/,
    );
  } finally {
    Connection.find = original;
  }
  assert.equal(
    usable({ ...connection, authorization: { valid: false } }),
    false,
  );
  assert.equal(
    usable({
      ...connection,
      authorization: { valid: true, dataAccessExpiresAt: new Date(0) },
    }),
    false,
  );
}

async function refresh() {
  const original = {
    findOne: Connection.findOne,
    update: Connection.findOneAndUpdate,
  };
  const row = {
    ...connection,
    _id: "connection",
    connectedAt: new Date(Date.now() - 2 * 86400000),
    expiresAt: new Date(Date.now() + 86400000),
    credentialsEncrypted: encryptCredentials({ accessToken: "old" }),
    providerAccount: { id: "ig" },
  };
  let calls = 0,
    saved;
  Connection.findOne = (filter) => ({
    select: async () => (filter.workspaceId === "a" ? row : null),
  });
  Connection.findOneAndUpdate = async (filter, update) => {
    assert.equal(filter.workspaceId, "a");
    assert.deepEqual(filter.credentialsEncrypted, row.credentialsEncrypted);
    saved = update.$set;
    return { ...row, ...saved };
  };
  const http = {
    get: async (url, options) => {
      calls++;
      if (url.endsWith("/refresh_access_token")) {
        assert.equal(options.params.grant_type, "ig_refresh_token");
        return { data: { access_token: "new", expires_in: 5184000 } };
      }
      if (url.endsWith("/me"))
        return { data: { user_id: "ig", username: "leadporch" } };
      throw Error("Unexpected mocked URL");
    },
  };
  try {
    await assert.rejects(oauth.refreshInstagram("b", http), /Reconnect/);
    assert.equal(calls, 0);
    row.connectedAt = new Date();
    await assert.rejects(oauth.refreshInstagram("a", http), /24 hours/);
    assert.equal(calls, 0);
    row.connectedAt = new Date(Date.now() - 2 * 86400000);
    const result = await oauth.refreshInstagram("a", http);
    assert.equal(
      decryptCredentials(saved.credentialsEncrypted).accessToken,
      "new",
    );
    assert.equal(result.credentialsEncrypted, undefined);
    // refreshInstagram renews the access token and re-verifies account
    // identity, but does not currently re-fetch granted permissions — scopes
    // reflect whatever was already stored (empty here, since this fixture's
    // row never had scopes set).
    assert.deepEqual(result.scopes, []);
    row.expiresAt = new Date(0);
    await assert.rejects(oauth.refreshInstagram("a", http), /Reconnect/);
    assert.equal(calls, 2);
  } finally {
    Connection.findOne = original.findOne;
    Connection.findOneAndUpdate = original.update;
  }
}

async function notifications() {
  let count = 0;
  await require("./services/socialConnectionHealth").notifyOwners(
    { ...connection, expiresAt: new Date(Date.now() + 86400000) },
    {
      Membership: {
        find: (filter) => {
          assert.equal(filter.workspaceId, "a");
          assert.equal(filter.status, "active");
          return {
            select: () => ({ lean: async () => [{ userId: "owner" }] }),
          };
        },
      },
      Notification: {
        findOneAndUpdate: async (filter, update) => {
          count++;
          assert.equal(filter.userId, "owner");
          assert.equal(filter.workspaceId, "a");
          assert(filter.actionUrl.startsWith("/social/accounts"));
          assert(
            update.$setOnInsert.message.includes("expires within seven days"),
          );
        },
      },
    },
  );
  assert.equal(count, 1);
}

Promise.resolve()
  .then(pipeline)
  .then(replies)
  .then(discoveryAndSelection)
  .then(ownership)
  .then(refresh)
  .then(notifications)
  .then(() =>
    console.log(
      "Meta interactions passed: comments/DEAL, canonical contacts, inbox, mentions/context-only, postbacks/referrals/stories, dedup/uncertain delivery, disabled outbound, Page pagination/selection/credential cleanup, ownership and workspace isolation. No live calls.",
    ),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
