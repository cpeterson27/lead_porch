const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.META_APP_ID = "meta-app-123";
process.env.META_APP_SECRET = "provider-secret-never-log";
process.env.META_REDIRECT_URI = "https://api.example.test/api/social/meta/oauth/callback";
process.env.META_GRAPH_API_VERSION = "v23.0";
process.env.FACEBOOK_LOGIN_CONFIG_ID = "123456789";
process.env.INSTAGRAM_APP_ID = "ig-app-123";
process.env.INSTAGRAM_APP_SECRET = "provider-secret-never-log";
process.env.INSTAGRAM_REDIRECT_URI = "https://api.example.test/api/social/instagram/oauth/callback";

const oauth = require("./services/socialOAuthService");
const { encryptCredentials } = require("./utils/credentialEncryption");
const { resolveApplicationContact } = require("./services/publicApplicationService");
const { resolveIdentity } = require("./services/socialLeadAutomationService");
const { CAPABILITIES } = require("./authorization/capabilities");
const { restrictNewRoleSurface } = require("./middleware/authorization");

function document(values) {
  return { ...values, async save() { return this; } };
}

async function oauthChecks() {
  const calls = [];
  const http = {
    async get(url) {
      calls.push(url);
      if (url.endsWith("/oauth/access_token") && calls.filter((item) => item.endsWith("/oauth/access_token")).length === 1) return { data: { access_token: "short-token", expires_in: 100 } };
      if (url.endsWith("/oauth/access_token")) return { data: { access_token: "long-token", expires_in: 5000 } };
      if (url.endsWith("/debug_token")) return { data: { data: { is_valid: true, app_id: "meta-app-123", user_id: "meta-user", data_access_expires_at: 1900000000 } } };
      if (url.endsWith("/me/permissions")) return { data: { data: [{ permission: "pages_show_list", status: "granted" }, { permission: "pages_messaging", status: "declined" }] } };
      if (url.endsWith("/me")) return { data: { id: "meta-user", name: "Ellie" } };
      if (url.endsWith("/me/accounts")) return { data: { data: [{ id: "page-1", name: "Ellie Page", access_token: "page-token", tasks: ["MANAGE"], instagram_business_account: { id: "ig-1", username: "ellie", name: "Ellie IG", profile_picture_url: "https://images.example.test/ellie.jpg" } }] } };
      throw new Error(`Unexpected GET ${url}`);
    },
  };
  const result = await oauth.exchangeMeta("authorization-code", http);
  assert.deepEqual(result.scopes, ["pages_show_list"]);
  assert.deepEqual(result.declinedScopes, ["pages_messaging"]);
  assert.equal(result.authorization.valid, true);
  assert.equal(result.authorization.userId, "meta-user");
  assert.equal(result.assets.length, 2);
  assert.deepEqual(result.assets[1], { id: "ig-1", name: "Ellie IG", username: "ellie", avatarUrl: "https://images.example.test/ellie.jpg", type: "instagram_business", parentId: "page-1", permissions: ["MANAGE"] });
}

function membershipQuery(value, expected = {}) {
  return {
    populate(path, fields) {
      assert.equal(path, "workspaceId"); assert.equal(fields, "status rolePermissionTemplates");
      return Promise.resolve(value);
    },
    filter: expected,
  };
}

async function reviewerOAuthAuthorizationChecks() {
  const workspace = { _id: "review", status: "active" };
  const reviewer = { workspaceId: workspace, userId: "reviewer", role: "viewer", roles: ["viewer"], status: "active", permissionOverrides: { allow: ["social.manage"], deny: CAPABILITIES.filter(item => item !== "social.manage") } };
  let filter;
  const allowedModels = { WorkspaceMembership: { findOne(value) { filter = value; return membershipQuery(reviewer); } } };
  assert.equal(await oauth.resolveSocialOAuthMembership({ workspaceId: "review", userId: "reviewer" }, allowedModels), reviewer);
  assert.deepEqual(filter, { workspaceId: "review", userId: "reviewer", status: "active" });
  for (const membership of [
    null,
    { ...reviewer, status: "suspended" },
    { ...reviewer, workspaceId: { _id: "review", status: "suspended" } },
    { ...reviewer, workspaceId: { _id: "ellie", status: "active" } },
    { ...reviewer, userId: "different-user" },
    { ...reviewer, permissionOverrides: { allow: [], deny: ["social.manage"] } },
  ]) {
    await assert.rejects(() => oauth.resolveSocialOAuthMembership({ workspaceId: "review", userId: "reviewer" }, { WorkspaceMembership: { findOne: () => membershipQuery(membership) } }), /no longer has permission/);
  }
  for (const role of ["owner", "admin"]) {
    const membership = { ...reviewer, userId: role, role, roles: [role], permissionOverrides: { allow: [], deny: [] } };
    assert.equal(await oauth.resolveSocialOAuthMembership({ workspaceId: "review", userId: role }, { WorkspaceMembership: { findOne: () => membershipQuery(membership) } }), membership);
  }
}

async function signedStateAndCompletionChecks() {
  const authorizationUrl = new URL(oauth.authorizationUrl("meta", { workspaceId: "review", user: { _id: "reviewer" } }));
  const signedState = authorizationUrl.searchParams.get("state");
  assert.deepEqual(oauth.verifyState(signedState, "meta").workspaceId, "review");
  const [payload, signature] = signedState.split(".");
  const substituted = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), workspaceId: "ellie" })).toString("base64url")}.${signature}`;
  assert.equal(oauth.verifyState(substituted, "meta"), null, "signed workspace cannot be substituted");
  const substitutedUser = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), userId: "different-user" })).toString("base64url")}.${signature}`;
  assert.equal(oauth.verifyState(substitutedUser, "meta"), null, "signed initiating user cannot be substituted");
  const expiredPayload = Buffer.from(JSON.stringify({ provider: "meta", workspaceId: "review", userId: "reviewer", expiresAt: Date.now() - 1 })).toString("base64url");
  const expiredSignature = crypto.createHmac("sha256", Buffer.from(process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY, "base64")).update(expiredPayload).digest("base64url");
  assert.equal(oauth.verifyState(`${expiredPayload}.${expiredSignature}`, "meta"), null);
  let storedFilter;
  await oauth.exchangeCode("meta", "mock-code", signedState, {
    SocialOAuthState: { async findOneAndUpdate() { return { consumedAt: new Date() }; } },
    models: { WorkspaceMembership: { findOne: () => membershipQuery({ workspaceId: { _id: "review", status: "active" }, userId: "reviewer", role: "viewer", roles: ["viewer"], status: "active", permissionOverrides: { allow: ["social.manage"], deny: CAPABILITIES.filter(item => item !== "social.manage") } }) } },
    exchangeProvider: async () => ({ credentials: { accessToken: "mock-token" }, scopes: ["instagram_business_basic"], assets: [{ id: "ig-1", username: "review", name: "Review IG", avatarUrl: "https://images.example.test/review.jpg" }] }),
    SocialConnection: { async findOneAndUpdate(value) { storedFilter = value; return { _id: "connection" }; } },
  });
  assert.deepEqual(storedFilter, { workspaceId: "review", provider: "meta" });
}

function reviewerSurfaceChecks() {
  const auth = { roles: ["viewer"], effectivePermissions: ["social.manage"] };
  const check = (method, path) => new Promise((resolve) => {
    const response = { status(code) { return { json(body) { resolve({ code, body }); } }; } };
    restrictNewRoleSurface({ method, path, auth }, response, () => resolve({ code: 200 }));
  });
  return Promise.all([
    check("GET", "/social-workspace/accounts").then(result => assert.equal(result.code,200)),
    check("GET", "/social-workspace/overview").then(result => assert.equal(result.code, 200)),
    check("GET", "/social/meta/oauth/start").then(result => assert.equal(result.code, 200)),
    check("PATCH", "/social/meta/assets").then(result => assert.equal(result.code, 200)),
    ...["/contacts", "/opportunities", "/coaching", "/workspace/members", "/ambassadors", "/integrations", "/conversations", "/analytics", "/social-workspace/inbox"].map(path => check("GET", path).then(result => assert.equal(result.code, 403, path))),
  ]);
}

async function subscriptionChecks() {
  // A Page-linked Instagram Business Account has no subscribed_apps edge of
  // its own — Meta only exposes it on the Page, so a Facebook Page and its
  // linked Instagram asset are provisioned together in ONE combined call
  // (see provisionMetaSubscriptions). Its only contribution ("messages") is
  // already part of the Page's own field set, so the combined call is
  // identical to the Page's field list.
  const grouped = [];
  const pageLinkedConnection = document({
    credentialsEncrypted: encryptCredentials({ accessToken: "user-token", pageTokens: { "page-1": "page-token" } }),
    assets: [{ id: "page-1", type: "facebook_page" }, { id: "ig-1", parentId: "page-1", type: "instagram_business" }],
  });
  const groupedHttp = {
    async post(url, body, options) { grouped.push({ url, fields: options.params.subscribed_fields }); return { data: { success: true } }; },
    async get() { return { data: { data: [{ id: "meta-app-123", subscribed_fields: oauth.subscriptionFields({ type: "facebook_page" }) }] } }; },
  };
  const groupedResult = await oauth.provisionMetaSubscriptions(pageLinkedConnection, ["page-1", "ig-1"], groupedHttp);
  assert.equal(groupedResult.every((row) => row.status === "subscribed"), true);
  assert.equal(grouped.length, 1, "A Page and its linked Instagram asset share one subscription call");
  assert.equal(grouped[0].fields, oauth.subscriptionFields({ type: "facebook_page" }).join(","));
  for (const field of ["messaging_optins", "message_reactions", "message_reads", "message_edits", "message_deliveries", "mention", "messaging_customer_information", "messaging_in_thread_lead_form_submit"]) assert(grouped[0].fields.includes(field));

  // A standalone, direct-Instagram-Login asset (no linked Facebook Page) has
  // its own subscribed_apps edge on graph.instagram.com, authorized with its
  // own top-level access token rather than a Page token — provisioned via
  // provisionInstagramSubscriptions, the direct-Instagram-Login counterpart
  // to provisionMetaSubscriptions.
  const standalone = [];
  const standaloneConnection = document({
    credentialsEncrypted: encryptCredentials({ accessToken: "ig-user-token" }),
    assets: [{ id: "ig-standalone", type: "instagram_business" }],
  });
  const standaloneHttp = {
    async post(url, body, options) { standalone.push({ url, fields: options.params.subscribed_fields }); return { data: { success: true } }; },
    async get() { return { data: { data: [{ id: "ig-scoped-app-id", subscribed_fields: oauth.subscriptionFields({ type: "instagram_business" }) }] } }; },
  };
  const standaloneResult = await oauth.provisionInstagramSubscriptions(standaloneConnection, ["ig-standalone"], standaloneHttp);
  assert.equal(standaloneResult.every((row) => row.status === "subscribed"), true);
  assert.equal(standalone[0].fields, oauth.subscriptionFields({ type: "instagram_business" }).join(","));
  for (const field of ["live_comments", "message_edit", "message_reactions", "messaging_seen"]) assert(standalone[0].fields.includes(field));
  assert.equal(standalone[0].fields.includes("messaging_optins"), false, "Do not provision a Facebook Page field not part of the reviewed standalone Instagram configuration");
}

async function convergenceChecks() {
  const tracked = document({ _id: "social-contact", workspaceId: "ws-1", sources: ["social:instagram"], tags: ["social-lead"], socialAttribution: { first: { provider: "instagram" } }, additionalFields: {} });
  const existing = document({ _id: "email-contact", workspaceId: "ws-1", email: "student@example.com", sources: ["eventbrite"], tags: [], additionalFields: {} });
  const identities = []; const links = [];
  const models = {
    Contact: { async findOne(filter) { return filter.email ? existing : tracked; } },
    SocialIdentity: { async updateMany(filter, update) { identities.push({ filter, update }); } },
    TrackedLink: { async updateMany(filter, update) { links.push({ filter, update }); } },
  };
  const resolved = await resolveApplicationContact({ workspaceId: "ws-1", normalizedEmail: "student@example.com", tracked: { contactId: "social-contact" } }, models);
  assert.equal(resolved._id, "email-contact");
  assert.ok(resolved.sources.includes("social:instagram"));
  assert.equal(identities[0].update.$set.contactId, "email-contact");
  assert.equal(links[0].update.$set.contactId, "email-contact");
  assert.equal(tracked.status, "archived");
  assert.equal(tracked.email, undefined);
}

async function raceCheck() {
  const winner = document({ _id: "identity-winner", contactId: "contact-winner", provider: "instagram", providerAssetId: "ig-1", providerUserId: "user-1" });
  const winnerContact = document({ _id: "contact-winner" }); let deleted = ""; let identityReads = 0;
  const models = {
    Contact: { async create(values) { return document({ _id: "contact-loser", ...values }); }, async findById(id) { return id === "contact-winner" ? winnerContact : null; }, async deleteOne(filter) { deleted = filter._id; } },
    SocialIdentity: { async findOne() { identityReads += 1; return identityReads === 1 ? null : winner; }, async find() { return []; }, async create() { const error = new Error("duplicate"); error.code = 11000; throw error; } },
  };
  const result = await resolveIdentity({ provider: "instagram", assetId: "ig-1", providerUserId: "user-1" }, models);
  assert.equal(result.identity._id, "identity-winner");
  assert.equal(result.contact._id, "contact-winner");
  assert.equal(result.created, false);
  assert.equal(deleted, "contact-loser");
}

function loggingAndSafetyChecks() {
  const error = { message: "token=secret-user-token", response: { status: 400, data: { access_token: "secret-user-token", error: { code: 190, message: "secret provider payload" } } } };
  const safe = oauth.safeProviderError(error);
  assert.equal(safe.includes("secret"), false);
  assert.match(safe, /HTTP 400/);
  assert.match(safe, /190/);
  const diagnostic = oauth.safeProviderDiagnostic({ oauthOperation: "instagram_profile_verification", response: { status: 400, data: { error: { code: 100, type: "IGApiException", message: "Bad access_token=secret-user-token at https://graph.instagram.com/v26.0/me", fbtrace_id: "trace-1" } } } });
  assert.equal(diagnostic.operation, "instagram_profile_verification");
  assert.equal(diagnostic.providerCode, "100");
  assert.equal(JSON.stringify(diagnostic).includes("secret-user-token"), false);
  assert.equal(JSON.stringify(diagnostic).includes("graph.instagram.com"), false);
  const route = fs.readFileSync(path.join(__dirname, "routes/social.js"), "utf8");
  const webhook = fs.readFileSync(path.join(__dirname, "routes/webhooks.js"), "utf8");
  const publishing = fs.readFileSync(path.join(__dirname, "services/socialPublishingService.js"), "utf8");
  assert.equal(route.includes("error.response?.data"), false);
  assert.ok(route.includes("/social/accounts?"), "OAuth callback returns to Connected Accounts with status preserved");
  assert.equal(route.includes('requireRole("owner", "admin")'), false);
  // Formatting-tolerant: each route definition and its requireCapability gate
  // may be on the same line or wrapped across lines, but both must appear
  // within a short span of each other.
  for (const [method, routePath] of [["get", "/:provider/oauth/start"], ["patch", "/:provider/assets"], ["post", "/instagram/oauth/refresh"], ["post", "/:provider/oauth/disconnect"]]) {
    const anchor = route.indexOf(`router.${method}(\n  "${routePath}"`);
    const inline = route.indexOf(`router.${method}("${routePath}"`);
    const start = anchor !== -1 ? anchor : inline;
    assert.notEqual(start, -1, `${method.toUpperCase()} ${routePath} route not found`);
    assert.ok(route.slice(start, start + 200).includes('requireCapability("social.manage")'), `${method.toUpperCase()} ${routePath} must require social.manage`);
  }
  assert.ok(webhook.includes("deliverMetaReply"));
  assert.ok(fs.readFileSync(path.join(__dirname, "services/metaAutomationReplyService.js"), "utf8").includes('META_AUTOMATIC_REPLIES_ENABLED !== "true"'));
  assert.ok(publishing.includes('SOCIAL_PUBLISHING_ENABLED!=="true"'));
}

Promise.resolve().then(oauthChecks).then(reviewerOAuthAuthorizationChecks).then(signedStateAndCompletionChecks).then(reviewerSurfaceChecks).then(subscriptionChecks).then(convergenceChecks).then(raceCheck).then(loggingAndSafetyChecks)
  .then(() => console.log("Meta pre-connection checks passed: actual permissions, token verification, subscriptions, convergence, race safety, idempotent/fail-closed outbound behavior, and secret-safe logging."))
  .catch((error) => { console.error(error); process.exitCode = 1; });
