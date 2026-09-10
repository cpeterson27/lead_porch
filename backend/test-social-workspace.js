const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const taskService = require("./services/ambassadorContentService");
const oauth = require("./services/socialOAuthService");
const publishing = require("./services/socialPublishingService");
const query = (value) => ({
  lean: async () => value,
  sort() {
    return this;
  },
  limit() {
    return this;
  },
});
async function tasks() {
  let created;
  let activity;
  const models = {
    ContentBrief: {
      findOne: (filter) => {
        assert.equal(filter.workspaceId, "w1");
        return query({
          _id: "c1",
          title: "Education",
          body: "Reviewed",
          status: "approved",
          social: { media: [{ url: "https://cdn.example/image.jpg" }] },
        });
      },
    },
    AmbassadorProfile: {
      find: (filter) => {
        assert.equal(filter.workspaceId, "w1");
        return query([{ _id: "a1", referralCode: "abc", status: "active" }]);
      },
      findOne: () => query({ _id: "a1" }),
    },
    AmbassadorContentTask: {
      findOne: async () => null,
      findOneAndUpdate: async (_filter, update) => {
        created = { _id: "t1", ...update.$setOnInsert };
        return created;
      },
    },
    CrmActivity: {
      create: async (value) => {
        activity = value;
      },
    },
  };
  await taskService.assign(
    {
      workspaceId: "w1",
      userId: "owner",
      contentId: "c1",
      input: { ambassadorIds: ["a1"], includeReferral: true },
    },
    models,
  );
  assert.equal(created.contentBriefId, "c1");
  assert.equal(created.ambassadorProfileId, "a1");
  assert.match(created.referralUrl, /\/ref\/abc$/);
  assert.equal(activity.metadata.eventType, "ambassador.content.assigned");
  await assert.rejects(
    () =>
      taskService.assign(
        {
          workspaceId: "w1",
          userId: "owner",
          contentId: "c1",
          input: { ambassadorIds: ["a1", "other-workspace"] },
        },
        models,
      ),
    /Every ambassador/,
  );
  models.AmbassadorContentTask.findOne = async (filter) => {
    assert.deepEqual(filter, {
      _id: "other-task",
      workspaceId: "w1",
      ambassadorProfileId: "a1",
    });
    return null;
  };
  await assert.rejects(
    () =>
      taskService.transition(
        {
          workspaceId: "w1",
          userId: "user",
          taskId: "other-task",
          status: "completed",
        },
        models,
      ),
    /not found/,
  );
}
async function authorization() {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = crypto
    .randomBytes(32)
    .toString("base64");
  for (const [name, value] of Object.entries({
    INSTAGRAM_APP_ID: "ig-app",
    INSTAGRAM_APP_SECRET: "fixture",
    INSTAGRAM_REDIRECT_URI:
      "https://example.test/api/social/instagram/oauth/callback",
    META_GRAPH_API_VERSION: "v25.0",
    X_ENABLED: "true",
    X_CLIENT_ID: "x-app",
    X_CLIENT_SECRET: "fixture",
    X_REDIRECT_URI: "https://example.test/api/social/x/oauth/callback",
  }))
    process.env[name] = value;
  const auth = { workspaceId: "w1", user: { _id: "u1" } };
  const ig = new URL(oauth.authorizationUrl("instagram", auth));
  assert.equal(ig.hostname, "www.instagram.com");
  assert(
    ig.searchParams.get("scope").includes("instagram_business_content_publish"),
  );
  assert(!ig.searchParams.get("scope").includes("pages_"));
  const x = new URL(oauth.authorizationUrl("x", auth));
  assert.equal(x.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    oauth.verifyState(x.searchParams.get("state"), "instagram"),
    null,
  );
   process.env.INSTAGRAM_OAUTH_SCOPES =
    "instagram_business_basic,instagram_business_content_publish";
  const token = await oauth.exchangeInstagram("fixture-code", {
    post: async () => ({
      data: {
        access_token: "short-fixture",
        // Real Meta responses use a different, legacy-style ID here than
        // graph.instagram.com/me; this must not be treated as the account id.
        user_id: 39250387624560410,
        permissions: "instagram_business_basic",
      },
    }),
    get: async (url) =>
      url.endsWith("/access_token")
        ? { data: { access_token: "long-fixture", expires_in: 1000 } }
        : { data: { user_id: "123", username: "fixture" } },
  });
  assert.deepEqual(token.scopes, ["instagram_business_basic"]);
  assert.deepEqual(token.declinedScopes, [
    "instagram_business_content_publish",
  ]);
  assert.equal(token.account.id, "123");
  assert.equal(token.assets[0].id, "123");
  assert.equal(
    publishing.capability(
      "instagram",
      {
        status: "connected",
        provider: "instagram",
        scopes: token.scopes,
        selectedAssetIds: ["123"],
      },
      { id: "123" },
    ).status,
    "unavailable",
  );
}
function contracts() {
  const router = fs.readFileSync(
    __dirname + "/routes/socialWorkspace.js",
    "utf8",
  );
  assert(router.includes('router.use(requireCapability("social.manage"))'));
  const adapter = fs.readFileSync(
    __dirname + "/services/conversations/metaMessagingAdapter.js",
    "utf8",
  );
  assert(adapter.includes("Recipient and asset must match"));
  assert(adapter.includes('senderType = "automation"'));
  const ingestion = fs.readFileSync(
    __dirname + "/services/conversations/conversationIngestionService.js",
    "utf8",
  );
  assert(ingestion.includes("createdBy: message.createdBy"));
}
async function partialPublishing() {
  const { encryptCredentials } = require("./utils/credentialEncryption");
  let calls = 0;
  const item = {
    _id: "content",
    workspaceId: "w1",
    body: "Caption",
    social: {
      publications: [],
      destinations: [
        { provider: "facebook", assetId: "page" },
        { provider: "x", assetId: "x-user" },
      ],
    },
    save: async function () {
      return this;
    },
  };
  const connection = {
    provider: "meta",
    status: "connected",
    scopes: ["pages_manage_posts", "tweet.write"],
    selectedAssetIds: ["page", "x-user"],
    assets: [
      { id: "page", type: "facebook_page" },
      { id: "x-user", type: "x_account" },
    ],
    credentialsEncrypted: encryptCredentials({
      accessToken: "mock",
      pageTokens: { page: "mock" },
    }),
  };
  const models = {
    SocialConnection: { findOne: () => ({ select: async () => connection }) },
    CrmActivity: { create: async () => ({}) },
    http: {
      post: async (url) => {
        calls += 1;
        if (url.includes("api.x.com"))
          throw new Error("Connection interrupted");
        return { data: { id: "post-1" } };
      },
    },
  };
  await publishing.processItem(item, models);
  assert.equal(item.status, "partially_published");
  assert.equal(item.social.publications[0].status, "published");
  assert.equal(item.social.publications[1].status, "unknown");
  await publishing.processItem(item, models);
  assert.equal(
    calls,
    2,
    "successful or uncertain publications must not be reposted automatically",
  );
}
Promise.resolve()
  .then(tasks)
  .then(authorization)
  .then(contracts)
  .then(partialPublishing)
  .then(() =>
    console.log(
      "Social workspace: distribution isolation, approved snapshots, Instagram grants, X PKCE, sender security, partial results and uncertain-outcome retry safety passed (mocked).",
    ),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
