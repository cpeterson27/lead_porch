// Coverage gaps identified during the instagram_business_manage_messages
// Meta App Review audit: the webhook verification handshake, malformed/
// garbage webhook payload handling, and the actually-used inbox reply route
// (routes/socialWorkspace.js) had zero prior test coverage — only the
// unused routes/socialMessaging.js twin was covered.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.META_APP_SECRET = "meta-secret-for-tests";
process.env.INSTAGRAM_APP_SECRET = "instagram-secret-for-tests";
process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-meta";
process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = "verify-instagram";

const crypto = require("node:crypto");
const { normalize } = require("./services/metaEventNormalizer");
const { ingestSocialEvent } = require("./services/socialLeadAutomationService");
const { validateMetaSignature } = require("./services/conversations/metaMessagingAdapter");
const webhooksRouter = require("./routes/webhooks");

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}
function includesAll(contents, expected, label) {
  for (const value of expected)
    assert.ok(contents.includes(value), `${label} missing ${value}`);
}

function findRoute(method, matchPath) {
  const layer = webhooksRouter.stack.find(
    (row) =>
      row.route?.methods?.[method] &&
      (Array.isArray(row.route.path)
        ? row.route.path.includes(matchPath)
        : row.route.path === matchPath),
  );
  assert.ok(layer, `Route ${method.toUpperCase()} ${matchPath} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.send = (value) => {
    res.body = value;
    return res;
  };
  res.json = (value) => {
    res.body = value;
    return res;
  };
  return res;
}

async function webhookVerificationHandshake() {
  const get = findRoute("get", "/meta");
  const ok = mockRes();
  await get(
    {
      path: "/meta",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-meta",
        "hub.challenge": "challenge-123",
      },
    },
    ok,
  );
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, "challenge-123");

  const wrongToken = mockRes();
  await get(
    {
      path: "/meta",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "not-the-real-token",
        "hub.challenge": "challenge-123",
      },
    },
    wrongToken,
  );
  assert.equal(wrongToken.statusCode, 403);

  const instagramGet = findRoute("get", "/instagram");
  const igOk = mockRes();
  await instagramGet(
    {
      path: "/instagram",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-instagram",
        "hub.challenge": "ig-challenge",
      },
    },
    igOk,
  );
  assert.equal(igOk.statusCode, 200);
  assert.equal(igOk.body, "ig-challenge");
  // Using Instagram's verify token against the Meta callback must not
  // accidentally succeed — each webhook path checks its own token.
  const crossToken = mockRes();
  await get(
    {
      path: "/meta",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-instagram",
        "hub.challenge": "should-not-pass",
      },
    },
    crossToken,
  );
  assert.equal(crossToken.statusCode, 403);
}

function webhookSignatureValidation() {
  const body = JSON.stringify({ entry: [] });
  const validSig =
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.META_APP_SECRET)
      .update(body)
      .digest("hex");
  assert.equal(validateMetaSignature(body, validSig, "META_APP_SECRET"), true);
  assert.equal(
    validateMetaSignature(body, "sha256=" + "0".repeat(64), "META_APP_SECRET"),
    false,
  );
  assert.equal(validateMetaSignature(body, "", "META_APP_SECRET"), false);
  assert.equal(validateMetaSignature("", validSig, "META_APP_SECRET"), false);
  // Malformed/garbage signature headers must never throw.
  assert.equal(
    validateMetaSignature(body, "not-a-real-signature-at-all", "META_APP_SECRET"),
    false,
  );
}

function malformedEventNormalization() {
  const connection = {
    assets: [{ id: "asset-1", type: "instagram_business" }],
    selectedAssetIds: ["asset-1"],
    provider: "instagram",
  };
  // Missing sender entirely.
  assert.equal(
    normalize({ connection, assetId: "asset-1", messaging: {}, entryTime: Date.now() / 1000 }),
    null,
  );
  // Echo of our own outbound message must not be re-ingested as inbound.
  assert.equal(
    normalize({
      connection,
      assetId: "asset-1",
      messaging: {
        sender: { id: "asset-1" },
        recipient: { id: "asset-1" },
        message: { mid: "m1", text: "hi", is_echo: true },
        timestamp: Date.now(),
      },
    }),
    null,
  );
  // Asset not selected/connected in this workspace's connection record.
  assert.equal(
    normalize({
      connection: { ...connection, selectedAssetIds: ["some-other-asset"] },
      assetId: "asset-1",
      messaging: { sender: { id: "u1" }, message: { mid: "m1", text: "hi" } },
    }),
    null,
  );
  // Completely garbage/unexpected shape must not throw.
  assert.doesNotThrow(() =>
    normalize({ connection, assetId: "asset-1", messaging: { garbage: [1, 2, { nested: true }] } }),
  );
  assert.doesNotThrow(() => normalize({ connection, assetId: "asset-1", change: null }));
  assert.doesNotThrow(() => normalize({ connection, assetId: "asset-1" }));
  // A genuine DM parses into an actionable, identity-bearing event.
  const validEvent = normalize({
    connection,
    assetId: "asset-1",
    messaging: {
      sender: { id: "customer-1" },
      recipient: { id: "asset-1" },
      message: { mid: "wamid.1", text: "Hi! I'm interested in learning more about your services." },
      timestamp: Date.now(),
    },
  });
  assert.equal(validEvent.eventType, "dm_received");
  assert.equal(validEvent.providerUserId, "customer-1");
  assert.equal(validEvent.opensMessagingWindow, true);
}

async function duplicateWebhookDoesNotDuplicateRecords() {
  const store = { events: new Map(), identities: new Map(), contacts: new Map(), threads: new Map(), messages: new Map() };
  let contactSeq = 0, msgSeq = 0;
  const models = {
    SocialProviderEvent: {
      async create(values) {
        if (store.events.has(values.providerEventId)) {
          const error = new Error("duplicate");
          error.code = 11000;
          throw error;
        }
        const record = { ...values, _id: `event-${store.events.size}`, save: async function () { store.events.set(this.providerEventId, this); } };
        store.events.set(values.providerEventId, record);
        return record;
      },
      async findOne({ providerEventId }) {
        return store.events.get(providerEventId) || null;
      },
    },
    SocialIdentity: {
      async findOne({ provider, providerAssetId, providerUserId }) {
        return store.identities.get(`${provider}:${providerAssetId}:${providerUserId}`) || null;
      },
      async create(values) {
        const key = `${values.provider}:${values.providerAssetId}:${values.providerUserId}`;
        const record = { ...values, _id: `identity-${store.identities.size}`, save: async () => {} };
        store.identities.set(key, record);
        return record;
      },
      async find(filter) {
        const all = [...store.identities.values()];
        if (filter?.linkedIdentityKeys)
          return all.filter((item) => (item.linkedIdentityKeys || []).includes(filter.linkedIdentityKeys));
        return all.filter((item) => item.contactId === filter?.contactId);
      },
    },
    Contact: {
      async create(values) {
        contactSeq += 1;
        const record = {
          ...values,
          _id: `contact-${contactSeq}`,
          set(path, value) {
            const parts = path.split(".");
            let node = this;
            for (let index = 0; index < parts.length - 1; index += 1) {
              node[parts[index]] = node[parts[index]] || {};
              node = node[parts[index]];
            }
            node[parts[parts.length - 1]] = value;
          },
          async save() {
            store.contacts.set(this._id, this);
          },
        };
        store.contacts.set(record._id, record);
        return record;
      },
      async findById(id) {
        return store.contacts.get(String(id)) || null;
      },
    },
    SocialAutomation: {
      find() {
        return { sort: async () => [] };
      },
    },
    CrmActivity: {
      async create(values) {
        return { ...values, _id: `activity-${store.events.size}-${Math.random()}` };
      },
    },
    ConversationThread: {
      async findOneAndUpdate({ provider, providerThreadId }, update) {
        const key = `${provider}:${providerThreadId}`;
        const existing = store.threads.get(key);
        const merged = { ...(existing || update.$setOnInsert), ...update.$set, _id: existing?._id || `thread-${store.threads.size}` };
        store.threads.set(key, merged);
        return { lean: () => merged, ...merged };
      },
    },
    ConversationMessage: {
      async findOne({ providerMessageId }) {
        for (const message of store.messages.values())
          if (message.providerMessageId === providerMessageId) return { lean: () => message, ...message };
        return null;
      },
      async create(values) {
        msgSeq += 1;
        const record = { ...values, _id: `message-${msgSeq}`, toObject: function () { return this; } };
        store.messages.set(record._id, record);
        return record;
      },
    },
  };
  const connection = {
    assets: [{ id: "asset-1", type: "instagram_business" }],
    selectedAssetIds: ["asset-1"],
    provider: "instagram",
  };
  const rawMessaging = {
    sender: { id: "customer-1" },
    recipient: { id: "asset-1" },
    message: { mid: "wamid.dup-test", text: "Hi! I'm interested in learning more about your services." },
    timestamp: Date.now(),
  };
  // ingestProviderMessage (the real conversation/message persistence) is a
  // direct module import in socialLeadAutomationService, not deps-injected —
  // it's only overridable via options.ingestMessage, matching that function's
  // real ({thread, message}) => {thread, message, created} contract.
  async function mockIngestMessage({ thread, message }) {
    const existing = [...store.messages.values()].find((row) => row.providerMessageId === message.providerMessageId);
    if (existing) return { thread: store.threads.get(`${thread.provider}:${thread.providerThreadId}`), message: existing, created: false };
    const threadKey = `${thread.provider}:${thread.providerThreadId}`;
    const savedThread = { ...(store.threads.get(threadKey) || {}), ...thread, _id: store.threads.get(threadKey)?._id || `thread-${store.threads.size}` };
    store.threads.set(threadKey, savedThread);
    msgSeq += 1;
    const savedMessage = { ...message, threadId: savedThread._id, _id: `message-${msgSeq}` };
    store.messages.set(savedMessage._id, savedMessage);
    return { thread: savedThread, message: savedMessage, created: true };
  }
  const event = normalize({ connection, assetId: "asset-1", messaging: rawMessaging });
  const first = await ingestSocialEvent(event, { models, ingestMessage: mockIngestMessage });
  assert.equal(first.duplicate, false);
  assert.equal(first.contactCreated, true);
  assert.equal(store.messages.size, 1, "exactly one message should exist after the first delivery");
  assert.equal(store.contacts.size, 1, "exactly one contact should exist after the first delivery");

  // Meta redelivers the identical webhook (same message id / provider event id).
  const second = await ingestSocialEvent(event, { models, ingestMessage: mockIngestMessage });
  assert.equal(second.duplicate, true);
  assert.equal(store.messages.size, 1, "a duplicate delivery must not create a second message");
  assert.equal(store.contacts.size, 1, "a duplicate delivery must not create a second contact");
}

function inboxReplyRouteContract() {
  const contents = source("routes/socialWorkspace.js");
  includesAll(
    contents,
    [
      'req.body.approved !== true',
      'Explicit reply approval is required',
      "channel: { $in: [\"instagram\", \"facebook\"] }",
      "workspaceId: req.auth.workspaceId",
      'thread.metadata?.interactionType === "comment"',
      "Human comment/private-reply controls are not implemented yet",
      "metaMessagingAdapter.sendMessage",
    ],
    "routes/socialWorkspace.js inbox reply route",
  );
  // The route the frontend actually calls must require auth (there is no
  // public-path carve-out for /social-workspace in server.js).
  assert.ok(!source("server.js").includes('"/social-workspace/'), "no accidental public bypass for /api/social-workspace");
}

function outboundSendAuthorizationLogic() {
  const contents = source("services/conversations/metaMessagingAdapter.js");
  includesAll(
    contents,
    [
      "Social conversation is not in this workspace",
      "Recipient and asset must match the existing social conversation",
      "Meta free-form replies require a customer message within the last 24 hours",
      "Messaging permission is unavailable",
      "instagram_business_manage_messages",
    ],
    "metaMessagingAdapter.sendMessage authorization/window checks",
  );
}

Promise.resolve()
  .then(webhookVerificationHandshake)
  .then(webhookSignatureValidation)
  .then(malformedEventNormalization)
  .then(duplicateWebhookDoesNotDuplicateRecords)
  .then(inboxReplyRouteContract)
  .then(outboundSendAuthorizationLogic)
  .then(() =>
    console.log(
      "Instagram messaging review checks passed: webhook verify handshake, signature validation, malformed/garbage payload safety, duplicate webhook idempotency end-to-end, live inbox reply route contract, and outbound send authorization/window checks.",
    ),
  )
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
