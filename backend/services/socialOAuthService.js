const crypto = require("crypto");
const axios = require("axios");
const SocialConnection = require("../models/SocialConnection");
const WorkspaceMembership = require("../models/WorkspaceMembership");
const SocialOAuthState = require("../models/SocialOAuthState");
const {
  encryptCredentials,
  decryptCredentials,
} = require("../utils/credentialEncryption");
const { effectivePermissions } = require("../authorization/capabilities");

const providerSettings = require("./socialProviderConfig");
const PROVIDERS = new Set(providerSettings.SOCIAL_PROVIDERS);

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function splitScopes(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function linkedinApiVersion() {
  const value = required("LINKEDIN_API_VERSION");
  if (!/^\d{6}$/.test(value))
    throw new Error("LINKEDIN_API_VERSION must use YYYYMM format");
  return value;
}

function safeProviderError(
  error,
  fallback = "Meta authorization could not be verified",
) {
  const status = Number(error?.response?.status || error?.status || 0);
  const providerCode = String(error?.response?.data?.error?.code || "")
    .replace(/[^0-9A-Za-z_.-]/g, "")
    .slice(0, 40);
  return [
    fallback,
    status ? `HTTP ${status}` : "",
    providerCode ? `provider code ${providerCode}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function safeProviderDiagnostic(error) {
  const providerError =
    error?.response?.data?.error || error?.cause?.response?.data?.error || {};
  const clean = (value, limit = 240) =>
    String(value || "")
      .replace(/https?:\/\/\S+/gi, "[redacted-url]")
      .replace(
        /\b(?:access_token|code|client_secret|signed_request)\s*[=:]\s*[^\s,;]+/gi,
        "$1=[redacted]",
      )
      .replace(/\b(?:IG|EA)[A-Za-z0-9_-]{12,}\b/g, "[redacted-credential]")
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, limit);
  return {
    operation: clean(
      error?.oauthOperation ||
        error?.cause?.oauthOperation ||
        "instagram_oauth",
      60,
    ),
    httpStatus:
      Number(error?.response?.status || error?.cause?.response?.status || 0) ||
      undefined,
    providerCode: clean(providerError.code, 40) || undefined,
    providerSubcode: clean(providerError.error_subcode, 40) || undefined,
    providerType:
      String(providerError.type || "")
        .replace(/[^0-9A-Za-z_.-]/g, "")
        .slice(0, 80) || undefined,
    providerMessage: clean(providerError.message) || undefined,
    traceId: clean(providerError.fbtrace_id, 100) || undefined,
  };
}

async function instagramOAuthOperation(operation, callback) {
  try {
    return await callback();
  } catch (error) {
    error.oauthOperation = operation;
    throw error;
  }
}

function config(provider) {
  if (!PROVIDERS.has(provider)) throw new Error("Unsupported social provider");
  if (provider === "instagram")
    return {
      clientId: required("INSTAGRAM_APP_ID"),
      clientSecret: required("INSTAGRAM_APP_SECRET"),
      redirectUri: providerSettings.redirect("INSTAGRAM_REDIRECT_URI"),
      apiVersion: providerSettings.graphVersion(),
      scopes: providerSettings.scopes(
        "instagram",
        process.env.INSTAGRAM_OAUTH_SCOPES ??
          "instagram_business_basic instagram_business_manage_comments instagram_business_manage_messages instagram_business_content_publish instagram_business_manage_insights",
      ),
    };
  if (provider === "x")
    return {
      clientId: required("X_CLIENT_ID"),
      clientSecret: required("X_CLIENT_SECRET"),
      redirectUri: required("X_REDIRECT_URI"),
      scopes: splitScopes(
        process.env.X_OAUTH_SCOPES ||
          "tweet.read tweet.write users.read offline.access",
      ),
    };
  if (provider === "linkedin")
    return {
      clientId: required("LINKEDIN_CLIENT_ID"),
      clientSecret: required("LINKEDIN_CLIENT_SECRET"),
      redirectUri: required("LINKEDIN_REDIRECT_URI"),
      scopes: splitScopes(
        process.env.LINKEDIN_OAUTH_SCOPES ||
          "openid profile email rw_organization_admin w_organization_social",
      ),
      apiVersion: linkedinApiVersion(),
    };
  return {
    clientId: required("META_APP_ID"),
    clientSecret: required("META_APP_SECRET"),
    redirectUri: providerSettings.redirect("META_REDIRECT_URI"),
    configId: providerSettings.facebookConfigId(),
    // Dashboard configuration controls Business Login permissions; scope is not sent.
    scopes:
      process.env.META_OAUTH_SCOPES === undefined
        ? []
        : providerSettings.scopes("meta", process.env.META_OAUTH_SCOPES),
    apiVersion: providerSettings.graphVersion(),
  };
}

function stateKey() {
  const key = Buffer.from(
    required("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY"),
    "base64",
  );
  if (key.length !== 32)
    throw new Error(
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  return key;
}

function createState({ provider, workspaceId, userId }) {
  const payload = Buffer.from(
    JSON.stringify({
      provider,
      workspaceId: String(workspaceId),
      userId: String(userId),
      nonce: crypto.randomBytes(18).toString("hex"),
      expiresAt: Date.now() + 10 * 60 * 1000,
    }),
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", stateKey())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function stateNonceHash(nonce) {
  return crypto
    .createHash("sha256")
    .update(String(nonce || ""))
    .digest("hex");
}


async function createAuthorizationRequest(provider, auth, dependencies = {}) {
  const authorization = authorizationUrl(provider, auth);
  const parsed = new URL(authorization);
  const state = verifyState(parsed.searchParams.get("state"), provider);
  if (!state) throw new Error("Social connection state could not be created");
  await (dependencies.SocialOAuthState || SocialOAuthState).create({
    provider,
    workspaceId: state.workspaceId,
    userId: state.userId,
    nonceHash: stateNonceHash(state.nonce),
    expiresAt: new Date(state.expiresAt),
  });
  return authorization;
}


async function consumeState(rawState, provider, dependencies = {}) {
  const state = verifyState(rawState, provider);
  if (!state)
    throw new Error("Social connection request expired or is invalid");
  const record = await (
    dependencies.SocialOAuthState || SocialOAuthState
  ).findOneAndUpdate(
    {
      provider,
      workspaceId: state.workspaceId,
      userId: state.userId,
      nonceHash: stateNonceHash(state.nonce),
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { consumedAt: new Date() } },
    { new: true },
  );
  if (!record)
    throw new Error("Social connection request was already used or expired");
  return state;
}

function verifyState(rawState, expectedProvider) {
  try {
    const parts = String(rawState || "").split(".");
    if (parts.length !== 2 || !PROVIDERS.has(expectedProvider)) return null;
    const [payload, signature] = parts;
    if (!payload || !signature) return null;
    const expected = crypto
      .createHmac("sha256", stateKey())
      .update(payload)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    )
      return null;
    const state = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      state.provider !== expectedProvider ||
      !Number.isFinite(Number(state.expiresAt)) ||
      Number(state.expiresAt) <= Date.now() ||
      !state.workspaceId ||
      !state.userId
    )
      return null;
    return state;
  } catch {
    return null;
  }
}

function configured(provider) {
  try {
    config(provider);
    stateKey();
    return true;
  } catch {
    return false;
  }
}

function authorizationUrl(provider, auth) {
  const providerConfig = config(provider);
  const state = createState({
    provider,
    workspaceId: auth.workspaceId,
    userId: auth.user._id,
  });
  if (provider === "instagram") {
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: providerConfig.clientId,
      redirect_uri: providerConfig.redirectUri,
      state,
      response_type: "code",
      scope: providerConfig.scopes.join(","),
      enable_fb_login: "0",
    }).toString();
    return url.toString();
  }
  if (provider === "x") {
    const verifier = pkceVerifier(state);
    const url = new URL("https://x.com/i/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: providerConfig.clientId,
      redirect_uri: providerConfig.redirectUri,
      state,
      response_type: "code",
      scope: providerConfig.scopes.join(" "),
      code_challenge: crypto
        .createHash("sha256")
        .update(verifier)
        .digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }
  if (provider === "linkedin") {
    const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: providerConfig.clientId,
      redirect_uri: providerConfig.redirectUri,
      state,
      scope: providerConfig.scopes.join(" "),
    }).toString();
    return url.toString();
  }
  const url = new URL(
    `https://www.facebook.com/${providerConfig.apiVersion}/dialog/oauth`,
  );
  url.search = new URLSearchParams({
    client_id: providerConfig.clientId,
    redirect_uri: providerConfig.redirectUri,
    state,
    response_type: "code",
    override_default_response_type: "true",
    config_id: providerConfig.configId,
  }).toString();
  return url.toString();
}

async function linkedinAssets(accessToken, providerConfig, http = axios) {
  try {
    const response = await http.get(
      "https://api.linkedin.com/rest/organizationAcls",
      {
        params: { q: "roleAssignee", role: "ADMINISTRATOR", state: "APPROVED" },
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "LinkedIn-Version": providerConfig.apiVersion,
          "X-Restli-Protocol-Version": "2.0.0",
        },
        timeout: 15000,
      },
    );
    const access = (response.data?.elements || [])
      .map((item) => ({
        id: String(item.organization || "").replace("urn:li:organization:", ""),
        permissions: [item.role].filter(Boolean),
      }))
      .filter((item) => item.id);
    const assets = [];
    for (const item of access) {
      let organization = {};
      try {
        const detail = await http.get(
          `https://api.linkedin.com/rest/organizations/${encodeURIComponent(item.id)}`,
          {
            params: { fields: "id,localizedName,vanityName" },
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "LinkedIn-Version": providerConfig.apiVersion,
              "X-Restli-Protocol-Version": "2.0.0",
            },
            timeout: 15000,
          },
        );
        organization = detail.data || {};
      } catch {
        /* The organization remains selectable by a safe generic label. */
      }
      assets.push({
        id: item.id,
        name:
          organization.localizedName ||
          organization.vanityName ||
          `LinkedIn organization ${item.id.slice(-4)}`,
        username: organization.vanityName || "",
        type: "linkedin_organization",
        permissions: item.permissions,
      });
    }
    return assets;
  } catch {
    return [];
  }
}

async function exchangeLinkedIn(code, http = axios) {
  const providerConfig = config("linkedin");
  const tokenResponse = await http.post(
    "https://www.linkedin.com/oauth/v2/accessToken",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: providerConfig.clientId,
      client_secret: providerConfig.clientSecret,
      redirect_uri: providerConfig.redirectUri,
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    },
  );
  const accessToken = tokenResponse.data?.access_token;
  if (!accessToken) throw new Error("LinkedIn did not return an access token");
  const profileResponse = await http.get(
    "https://api.linkedin.com/v2/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 },
  );
  const profile = profileResponse.data || {};
  return {
    credentials: { accessToken },
    scopes: splitScopes(
      tokenResponse.data?.scope || providerConfig.scopes.join(" "),
    ),
    expiresAt: tokenResponse.data?.expires_in
      ? new Date(Date.now() + Number(tokenResponse.data.expires_in) * 1000)
      : null,
    account: {
      id: String(profile.sub || ""),
      name: profile.name || "LinkedIn member",
      email: profile.email || "",
    },
    assets: await linkedinAssets(accessToken, providerConfig, http),
  };
}

async function metaPermissions(accessToken, providerConfig, http = axios) {
  const response = await http.get(
    `https://graph.facebook.com/${providerConfig.apiVersion}/me/permissions`,
    { params: { access_token: accessToken }, timeout: 15000 },
  );
  const rows = response.data?.data || [];
  return {
    granted: rows
      .filter((row) => row.status === "granted")
      .map((row) => String(row.permission)),
    declined: rows
      .filter((row) => row.status !== "granted")
      .map((row) => String(row.permission)),
  };
}

async function verifyMetaToken(accessToken, providerConfig, http = axios) {
  const appToken = `${providerConfig.clientId}|${providerConfig.clientSecret}`;
  const response = await http.get(
    `https://graph.facebook.com/${providerConfig.apiVersion}/debug_token`,
    {
      params: { input_token: accessToken, access_token: appToken },
      timeout: 15000,
    },
  );
  const data = response.data?.data || {};
  if (
    !data.is_valid ||
    String(data.app_id || "") !== String(providerConfig.clientId)
  )
    throw new Error(
      "Meta returned an invalid authorization for this application",
    );
  const grantedPageIds = [
    ...new Set(
      (data.granular_scopes || [])
        .filter((row) => row.scope === "pages_show_list")
        .flatMap((row) => (row.target_ids || []).map(String)),
    ),
  ];
  return {
    valid: true,
    userId: String(data.user_id || ""),
    dataAccessExpiresAt: data.data_access_expires_at
      ? new Date(Number(data.data_access_expires_at) * 1000)
      : null,
    verifiedAt: new Date(),
    grantedPageIds,
  };
}

async function discoverPages(
  accessToken,
  providerConfig,
  http = axios,
  grantedPageIds = [],
) {
  // Meta's asset picker (Facebook Login for Business) issues granular
  // scopes tied to specific Page ids; those Pages don't appear in
  // /me/accounts, which only lists Pages under a broad, unscoped grant.
  if (grantedPageIds.length) {
    const pages = [];
    for (const pageId of grantedPageIds) {
      const response = await http.get(
        `https://graph.facebook.com/${providerConfig.apiVersion}/${pageId}`,
        {
          params: {
            fields:
              "id,name,picture,instagram_business_account{id,username,name,profile_picture_url}",
            access_token: accessToken,
          },
          timeout: 15000,
        },
      );
      if (response.data?.id) pages.push(response.data);
    }
    return pages;
  }
  const pages = new Map(),
    cursors = new Set();
  let after;
  do {
    const response = await http.get(
      `https://graph.facebook.com/${providerConfig.apiVersion}/me/accounts`,
      {
        params: {
          fields:
            "id,name,picture,tasks,instagram_business_account{id,username,name,profile_picture_url}",
          access_token: accessToken,
          ...(after ? { after } : {}),
        },
        timeout: 15000,
      },
    );
    for (const page of response.data?.data || [])
      if (page.id) pages.set(String(page.id), page);
    if (!response.data?.paging?.next) break;
    after = response.data.paging.cursors?.after;
    if (!after || cursors.has(after) || cursors.size >= 1000)
      throw new Error(
        "Page discovery could not be completed; reconnect to retry",
      );
    cursors.add(after);
    // Never follow an arbitrary provider next URL carrying credentials.
  } while (after);
  return [...pages.values()];
}

async function exchangeMeta(code, http = axios) {
  const providerConfig = config("meta");
  const tokenResponse = await http.get(
    `https://graph.facebook.com/${providerConfig.apiVersion}/oauth/access_token`,
    {
      params: {
        client_id: providerConfig.clientId,
        client_secret: providerConfig.clientSecret,
        redirect_uri: providerConfig.redirectUri,
        code,
      },
      timeout: 15000,
    },
  );
  const shortToken = tokenResponse.data?.access_token;
  if (!shortToken) throw new Error("Meta did not return an access token");
  let accessToken = shortToken;
  try {
    const longLived = await http.get(
      `https://graph.facebook.com/${providerConfig.apiVersion}/oauth/access_token`,
      {
        params: {
          grant_type: "fb_exchange_token",
          client_id: providerConfig.clientId,
          client_secret: providerConfig.clientSecret,
          fb_exchange_token: shortToken,
        },
        timeout: 15000,
      },
    );
    accessToken = longLived.data?.access_token || shortToken;
    if (longLived.data?.expires_in)
      tokenResponse.data.expires_in = longLived.data.expires_in;
  } catch {
    /* A short-lived token remains valid for initial setup. */
  }
  const authorization = await verifyMetaToken(accessToken, providerConfig, http);
  const [permissions, profileResponse, pagesResponse] = await Promise.all([
    metaPermissions(accessToken, providerConfig, http),
    http.get(`https://graph.facebook.com/${providerConfig.apiVersion}/me`, {
      params: { fields: "id,name", access_token: accessToken },
      timeout: 15000,
    }),
    discoverPages(
      accessToken,
      providerConfig,
      http,
      authorization.grantedPageIds,
    ),
  ]);
  const pageTokens = {};
  const assets = [];
  if (
    !authorization.userId ||
    String(profileResponse.data?.id || "") !== authorization.userId
  )
    throw new Error("Facebook authorization identity mismatch");
  for (const page of pagesResponse) {
    assets.push({
      id: String(page.id),
      name: page.name || "Facebook Page",
      avatarUrl: page.picture?.data?.url || "",
      type: "facebook_page",
      permissions: page.tasks || [],
    });
    if (page.instagram_business_account?.id)
      assets.push({
        id: String(page.instagram_business_account.id),
        name:
          page.instagram_business_account.name ||
          page.instagram_business_account.username ||
          "Instagram business account",
        username: page.instagram_business_account.username || "",
        avatarUrl: page.instagram_business_account.profile_picture_url || "",
        type: "instagram_business",
        parentId: String(page.id),
        permissions: page.tasks || [],
      });
  }
  return {
    credentials: { accessToken, pageTokens },
    scopes: permissions.granted,
    declinedScopes: permissions.declined,
    authorization,
    expiresAt: tokenResponse.data?.expires_in
      ? new Date(Date.now() + Number(tokenResponse.data.expires_in) * 1000)
      : null,
    account: {
      id: String(profileResponse.data?.id || ""),
      name: profileResponse.data?.name || "Meta account",
      email: "",
    },
    assets,
  };
}

async function resolveSocialOAuthMembership(
  state,
  models = { WorkspaceMembership },
) {
  const membership = await models.WorkspaceMembership.findOne({
    workspaceId: state.workspaceId,
    userId: state.userId,
    status: "active",
  }).populate("workspaceId", "status rolePermissionTemplates");
  const membershipWorkspaceId =
    membership?.workspaceId?._id || membership?.workspaceId;
  if (
    !membership ||
    membership.status !== "active" ||
    !membership.workspaceId ||
    membership.workspaceId.status !== "active" ||
    String(membershipWorkspaceId) !== String(state.workspaceId) ||
    String(membership.userId?._id || membership.userId) !== String(state.userId)
  ) {
    throw new Error(
      "The user who started this connection no longer has permission to complete it",
    );
  }
  if (
    !effectivePermissions(membership, membership.workspaceId).includes(
      "social.manage",
    )
  ) {
    throw new Error(
      "The user who started this connection no longer has permission to complete it",
    );
  }
  return membership;
}

async function exchangeCode(provider, code, rawState, dependencies = {}) {
  if (!PROVIDERS.has(provider)) throw new Error("Unsupported social provider");
  const state = await consumeState(rawState, provider, dependencies);
  await resolveSocialOAuthMembership(
    state,
    dependencies.models || { WorkspaceMembership },
  );
  const exchange =
    dependencies.exchangeProvider ||
    (provider === "linkedin"
      ? exchangeLinkedIn
      : provider === "instagram"
        ? exchangeInstagram
        : provider === "x"
          ? (value) => exchangeX(value, rawState)
          : exchangeMeta);
  const result = await exchange(code);
  const ConnectionModel = dependencies.SocialConnection || SocialConnection;
  const connection = await ConnectionModel.findOneAndUpdate(
    { workspaceId: state.workspaceId, provider },
    {
      $set: {
        status: "connected",
        credentialsEncrypted: encryptCredentials(result.credentials),
        scopes: result.scopes,
        declinedScopes: result.declinedScopes || [],
        authorization: result.authorization || {
          valid: true,
          verifiedAt: new Date(),
        },
        expiresAt: result.expiresAt,
        providerAccount: result.account,
        assets: result.assets,
        selectedAssetIds: [],
        webhookSubscriptions: [],
        connectedByUserId: state.userId,
        connectedAt: new Date(),
        lastVerifiedAt: new Date(),
        lastError: "",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return connection;
}

function publicConnection(connection, provider) {
  return {
    provider,
    configured: configured(provider),
    connected: connection?.status === "connected",
    status: connection?.status || "disconnected",
    scopes: connection?.scopes || [],
    declinedScopes: connection?.declinedScopes || [],
    authorization: connection?.authorization || null,
    expiresAt: connection?.expiresAt || null,
    account: connection?.providerAccount || null,
    assets: connection?.assets || [],
    selectedAssetIds: connection?.selectedAssetIds || [],
    webhookSubscriptions: connection?.webhookSubscriptions || [],
    connectedAt: connection?.connectedAt || null,
    lastVerifiedAt: connection?.lastVerifiedAt || null,
    lastError: connection?.lastError || "",
    authorizationNotice:
      connection && connection.status !== "disconnected"
        ? !require("./socialConnectionHealth").usable(connection)
          ? "Authorization needs attention. Reconnect before using this account."
          : require("./socialConnectionHealth").expiresSoon(connection)
            ? "Authorization expires within seven days. Refresh Instagram authorization or reconnect your account."
            : ""
        : "",
    disconnectNotice:
      provider === "instagram"
        ? "Disconnect removes access from Lead Porch locally. To revoke the authorization at Instagram, also remove this app in Instagram's Apps and websites settings."
        : provider === "linkedin"
          ? "Disconnect removes the encrypted LinkedIn authorization from Lead Porch. You can also remove Lead Porch from LinkedIn's permitted services."
          : "",
  };
}

async function status(workspaceId, provider) {
  const connection = await SocialConnection.findOne({
    workspaceId,
    provider,
  }).lean();
  if (
    connection?.status === "connected" &&
    !require("./socialConnectionHealth").usable(connection)
  ) {
    await SocialConnection.updateOne(
      { _id: connection._id },
      {
        $set: {
          status: "expired",
          lastError: "Authorization expired. Reconnect this account.",
        },
      },
    );
    connection.status = "expired";
    connection.lastError = "Authorization expired. Reconnect this account.";
  }
  await require("./socialConnectionHealth").notifyOwners(connection);
  return publicConnection(connection, provider);
}

function subscriptionFields(asset) {
  return asset.type === "instagram_business"
    ? asset.parentId
      ? // A Page-linked Instagram Business Account has no webhook fields of its
        // own — Meta delivers its DMs through the parent Page's "messages"
        // field, and rejects Instagram-only field names (comments, mentions,
        // etc.) on the Page's subscribed_apps edge with an invalid-parameter
        // error. Only a standalone Instagram Login connection uses those.
        ["messages"]
      : [
          "comments",
          "live_comments",
          "messages",
          "message_edit",
          "message_reactions",
          "messaging_postbacks",
          "messaging_referral",
          "messaging_seen",
          "mentions",
        ]
    : asset.type === "facebook_page"
      ? [
          "feed",
          "messages",
          "messaging_postbacks",
          "messaging_referrals",
          "messaging_optins",
          "message_reactions",
          "message_reads",
          "message_edits",
          "message_deliveries",
          "mention",
          "messaging_customer_information",
          "messaging_in_thread_lead_form_submit",
        ]
      : [];
}

async function provisionMetaSubscriptions(connection, selected, http = axios) {
  const providerConfig = config("meta");
  const credentials = decryptCredentials(connection.credentialsEncrypted);
  const results = [];
  // A Page-linked Instagram Business Account has no subscribed_apps edge of its
  // own — Meta only exposes that edge on the Page, and delivers the Instagram
  // fields through the same Page-level webhook subscription. So assets that
  // share an underlying Page are grouped and subscribed together in one call.
  const byPageId = new Map();
  for (const assetId of selected) {
    const asset = connection.assets.find((item) => String(item.id) === assetId);
    const fields = subscriptionFields(asset || {});
    if (!fields.length) continue;
    const pageId =
      asset.type === "instagram_business"
        ? String(asset.parentId)
        : String(asset.id);
    if (!byPageId.has(pageId)) byPageId.set(pageId, { fields: new Set(), members: [] });
    const bucket = byPageId.get(pageId);
    fields.forEach((field) => bucket.fields.add(field));
    bucket.members.push({ assetId, fields });
  }
  for (const [pageId, bucket] of byPageId) {
    const token = credentials.pageTokens?.[pageId];
    if (!token) {
      for (const member of bucket.members)
        results.push({
          assetId: member.assetId,
          parentPageId: pageId,
          fields: member.fields,
          status: "failed",
          error: "A Page authorization token is unavailable",
        });
      continue;
    }
    try {
      const allFields = [...bucket.fields];
      await http.post(
        `https://graph.facebook.com/${providerConfig.apiVersion}/${pageId}/subscribed_apps`,
        null,
        {
          params: { subscribed_fields: allFields.join(","), access_token: token },
          timeout: 15000,
        },
      );
      const health = await http.get(
        `https://graph.facebook.com/${providerConfig.apiVersion}/${pageId}/subscribed_apps`,
        { params: { access_token: token }, timeout: 15000 },
      );
      const subscribedFields =
        (health.data?.data || []).find(
          (row) => String(row.id || "") === String(providerConfig.clientId),
        )?.subscribed_fields || [];
      for (const member of bucket.members) {
        const subscribed = member.fields.every((field) =>
          subscribedFields.includes(field),
        );
        results.push({
          assetId: member.assetId,
          parentPageId: pageId,
          fields: member.fields,
          status: subscribed ? "subscribed" : "not_subscribed",
          verifiedAt: new Date(),
          error: subscribed
            ? ""
            : "Meta did not confirm all requested webhook fields",
        });
      }
    } catch (error) {
      const message = safeProviderError(error, "Webhook subscription failed");
      for (const member of bucket.members)
        results.push({
          assetId: member.assetId,
          parentPageId: pageId,
          fields: member.fields,
          status: "failed",
          verifiedAt: new Date(),
          error: message,
        });
    }
  }
  return results;
}

async function removeMetaSubscriptions(connection, removed, http = axios) {
  const providerConfig = config("meta");
  const credentials = decryptCredentials(connection.credentialsEncrypted);
  for (const assetId of removed) {
    const asset = connection.assets.find((item) => String(item.id) === assetId);
    const pageId =
      asset?.type === "instagram_business"
        ? String(asset.parentId)
        : String(asset?.id || "");
    const token = credentials.pageTokens?.[pageId];
    if (!asset || !token) continue;
    try {
      await http.delete(
        `https://graph.facebook.com/${providerConfig.apiVersion}/${asset.id}/subscribed_apps`,
        { params: { access_token: token }, timeout: 15000 },
      );
    } catch {
      /* App-side deselection still blocks processing if provider cleanup is unavailable. */
    }
  }
}

async function selectAssets(workspaceId, provider, assetIds, http = axios) {
  const connection = await SocialConnection.findOne({
    workspaceId,
    provider,
  }).select("+credentialsEncrypted");
  if (!require("./socialConnectionHealth").usable(connection))
    throw new Error(`${provider} requires reconnection`);
  if (!Array.isArray(assetIds) || assetIds.some((id) => typeof id !== "string"))
    throw new Error("Choose an account list");
  const allowed = new Set(connection.assets.map((asset) => String(asset.id)));
  const selected = [...new Set((assetIds || []).map(String))];
  if (selected.some((id) => !allowed.has(id)))
    throw new Error("Choose only assets returned by the connected provider");
  for (const asset of connection.assets.filter((row) =>
    selected.includes(String(row.id)),
  )) {
    if (
      provider === "meta" &&
      asset.type === "instagram_business" &&
      !selected.includes(String(asset.parentId))
    )
      throw new Error(
        "Select the Facebook Page before its linked Instagram account",
      );
  }
  const removed = (connection.selectedAssetIds || [])
    .map(String)
    .filter((id) => !selected.includes(id));
  const previous = {
    ...connection.toObject(),
    credentialsEncrypted: connection.credentialsEncrypted,
  };
  if (provider === "meta") {
    const credentials = decryptCredentials(connection.credentialsEncrypted),
      pageTokens = {};
    for (const asset of connection.assets.filter(
      (row) =>
        row.type === "facebook_page" && selected.includes(String(row.id)),
    )) {
      const existing = credentials.pageTokens?.[String(asset.id)];
      const response = existing
        ? null
        : await http.get(
            `https://graph.facebook.com/${config("meta").apiVersion}/${asset.id}`,
            {
              params: {
                fields: "id,access_token",
                access_token: credentials.accessToken,
              },
              timeout: 15000,
            },
          );
      if (!existing && String(response?.data?.id || "") !== String(asset.id))
        throw new Error("Selected Page authorization could not be verified");
      const token = existing || response?.data?.access_token;
      if (!token) throw new Error("Selected Page authorization is unavailable");
      pageTokens[String(asset.id)] = token;
    }
    connection.credentialsEncrypted = encryptCredentials({
      ...credentials,
      pageTokens,
    });
  }
  connection.selectedAssetIds = selected;
  // Claim ownership before provider calls; the unique selected-asset index arbitrates races.
  try {
    await connection.save();
  } catch (error) {
    throw error;
  }
  if (provider === "meta") {
    await removeMetaSubscriptions(previous, removed, http);
    connection.webhookSubscriptions = await provisionMetaSubscriptions(
      connection,
      selected,
      http,
    );
  }
  if (provider === "instagram")
    connection.webhookSubscriptions = await provisionInstagramSubscriptions(
      connection,
      selected,
      http,
    );
  await connection.save();
  return publicConnection(connection.toObject(), provider);
}

async function disconnect(workspaceId, provider) {
  const connection = await SocialConnection.findOne({
    workspaceId,
    provider,
  }).select("+credentialsEncrypted");
  if (connection?.credentialsEncrypted) {
    try {
      const credentials = decryptCredentials(connection.credentialsEncrypted);
      if (provider === "meta" && credentials.accessToken) {
        const providerConfig = config("meta");
        await axios.delete(
          `https://graph.facebook.com/${providerConfig.apiVersion}/me/permissions`,
          { params: { access_token: credentials.accessToken }, timeout: 15000 },
        );
      }
    } catch {
      /* Local disconnect must still complete if provider revocation fails. */
    }
  }
  await SocialConnection.findOneAndUpdate(
    { workspaceId, provider },
    {
      $set: {
        status: "disconnected",
        assets: [],
        selectedAssetIds: [],
        webhookSubscriptions: [],
        scopes: [],
        declinedScopes: [],
        authorization: { valid: false },
        providerAccount: {},
        connectedAt: null,
        lastVerifiedAt: null,
        lastError: "",
      },
      $unset: { credentialsEncrypted: 1, expiresAt: 1 },
    },
  );
  return status(workspaceId, provider);
}

async function refreshInstagram(workspaceId, http = axios) {
  const connection = await SocialConnection.findOne({
    workspaceId,
    provider: "instagram",
  }).select("+credentialsEncrypted");
  if (!require("./socialConnectionHealth").usable(connection))
    throw new Error(
      "Reconnect Instagram; expired or invalid authorization cannot be refreshed",
    );
  const credentials = decryptCredentials(connection.credentialsEncrypted);
  const issuedAt = credentials.refreshedAt || connection.connectedAt;
  if (!issuedAt || Date.now() - new Date(issuedAt).getTime() < 86400000)
    throw new Error(
      "Instagram authorization must be at least 24 hours old before refreshing",
    );
  const settings = config("instagram");
  const refreshed = await http.get(
    "https://graph.instagram.com/refresh_access_token",
    {
      params: {
        grant_type: "ig_refresh_token",
        access_token: credentials.accessToken,
      },
      timeout: 15000,
    },
  );
  if (!refreshed.data?.access_token || !(Number(refreshed.data.expires_in) > 0))
    throw new Error("Instagram did not confirm refreshed authorization");
  const token = refreshed.data.access_token;
  const accountId = String(connection.providerAccount.id || "");
  const profile = await instagramOAuthOperation(
    "instagram_profile_verification",
    () =>
      http.get(`https://graph.instagram.com/${settings.apiVersion}/me`, {
        params: { fields: "user_id,username", access_token: token },
        timeout: 15000,
      }),
  );

  if (String(profile.data?.user_id || "") !== accountId)
    throw new Error(
      `Instagram authorization identity mismatch: initial=${accountId} profile=${profile.data?.user_id}`,
    );
  const updated = await SocialConnection.findOneAndUpdate(
    {
      _id: connection._id,
      workspaceId,
      provider: "instagram",
      status: "connected",
      credentialsEncrypted: connection.credentialsEncrypted,
    },
    {
      $set: {
        credentialsEncrypted: encryptCredentials({
          ...credentials,
          accessToken: token,
          refreshedAt: new Date().toISOString(),
        }),
        expiresAt: new Date(
          Date.now() + Number(refreshed.data.expires_in) * 1000,
        ),
        lastVerifiedAt: new Date(),
        "authorization.valid": true,
        "authorization.verifiedAt": new Date(),
      },
    },
    { new: true },
  );
  if (!updated)
    throw new Error(
      "Connection changed while refreshing; reload account status",
    );
  return publicConnection(updated, "instagram");
}

function pkceVerifier(state) {
  return crypto
    .createHmac("sha256", stateKey())
    .update(`x-pkce:${state}`)
    .digest("base64url");
}
async function exchangeX(code, rawState, http = axios) {
  const settings = config("x");
  const token = await http.post(
    "https://api.x.com/2/oauth2/token",
    new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: settings.clientId,
      redirect_uri: settings.redirectUri,
      code_verifier: pkceVerifier(rawState),
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64")}`,
      },
      timeout: 15000,
    },
  );
  if (!token.data?.access_token)
    throw new Error("X did not return authorization");
  const profile = await http.get("https://api.x.com/2/users/me", {
    headers: { Authorization: `Bearer ${token.data.access_token}` },
    timeout: 15000,
  });
  if (!profile.data?.data?.id)
    throw new Error("X account could not be verified");
  const user = profile.data.data;
  return {
    credentials: {
      accessToken: token.data.access_token,
      refreshToken: token.data.refresh_token,
    },
    scopes: splitScopes(token.data.scope || ""),
    account: { id: user.id, name: user.name || user.username },
    expiresAt: new Date(
      Date.now() + Number(token.data.expires_in || 7200) * 1000,
    ),
    assets: [
      {
        id: user.id,
        name: user.name || user.username,
        username: user.username,
        type: "x_account",
      },
    ],
  };
}
async function exchangeInstagram(code, http = axios) {
  const settings = config("instagram");
  const response = await instagramOAuthOperation(
    "instagram_code_exchange",
    () =>
      http.post(
        "https://api.instagram.com/oauth/access_token",
        new URLSearchParams({
          client_id: settings.clientId,
          client_secret: settings.clientSecret,
          grant_type: "authorization_code",
          redirect_uri: settings.redirectUri,
          code,
        }).toString(),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 15000,
        },
      ),
  );
  const initial = response.data?.data?.[0] || response.data;
  if (!initial?.access_token || !initial.user_id)
    throw new Error("Instagram did not return account authorization");
  const token = await instagramOAuthOperation(
    "instagram_long_lived_token_exchange",
    () =>
      http.get("https://graph.instagram.com/access_token", {
        params: {
          grant_type: "ig_exchange_token",
          client_secret: settings.clientSecret,
          access_token: initial.access_token,
        },
        timeout: 15000,
      }),
  );
  if (!token.data?.access_token)
    throw new Error("Instagram long-lived authorization unavailable");
  const accessToken = token.data.access_token;
  const profile = await instagramOAuthOperation(
    "instagram_profile_verification",
    () =>
      http.get(`https://graph.instagram.com/${settings.apiVersion}/me`, {
        params: { fields: "user_id,username", access_token: accessToken },
        timeout: 15000,
      }),
  );
  const accountId = String(profile.data?.user_id || "");
  if (!accountId)
    throw new Error("Instagram did not return a verifiable account id");
    const grantedScopes = splitScopes(initial.permissions || "");
  return {
    credentials: { accessToken },
    scopes: grantedScopes,
    declinedScopes: settings.scopes.filter(
      (scope) => !grantedScopes.includes(scope),
    ),
    account: {
      id: accountId,
      name: profile.data.username || "Instagram professional account",
    },
    authorization: { valid: true, userId: accountId, verifiedAt: new Date() },
    expiresAt: new Date(
      Date.now() + Number(token.data.expires_in || 3600) * 1000,
    ),
    assets: [
      {
        id: accountId,
        name: profile.data.username || "Instagram",
        username: profile.data.username || "",
        type: "instagram_business",
      },
    ],
  };
}
async function provisionInstagramSubscriptions(
  connection,
  selected,
  http = axios,
) {
  const settings = config("instagram"),
    credentials = decryptCredentials(connection.credentialsEncrypted),
    results = [];
  for (const assetId of selected) {
    const fields = subscriptionFields({ type: "instagram_business" });
    try {
      await http.post(
        `https://graph.instagram.com/${settings.apiVersion}/${assetId}/subscribed_apps`,
        null,
        {
          params: {
            subscribed_fields: fields.join(","),
            access_token: credentials.accessToken,
          },
          timeout: 15000,
        },
      );
      const response = await http.get(
        `https://graph.instagram.com/${settings.apiVersion}/${assetId}/subscribed_apps`,
        { params: { access_token: credentials.accessToken }, timeout: 15000 },
      );
      // graph.instagram.com reports the app under its Instagram-scoped app id,
      // which differs from the OAuth client id used to authorize — the field
      // list alone is sufficient to confirm our own subscription succeeded.
      const verified = (response.data?.data || []).some((row) =>
        fields.every((field) => (row.subscribed_fields || []).includes(field)),
      );
      results.push({
        assetId,
        fields,
        status: verified ? "subscribed" : "not_subscribed",
        verifiedAt: new Date(),
      });
    } catch (error) {
      results.push({
        assetId,
        fields,
        status: "failed",
        verifiedAt: new Date(),
        error: safeProviderError(
          error,
          "Instagram webhook subscription failed",
        ),
      });
    }
  }
  return results;
}
module.exports = {
  createAuthorizationRequest,
  consumeState,
  discoverPages,
  subscriptionFields,
  refreshInstagram,
  authorizationUrl,
  configured,
  disconnect,
  exchangeCode,
  exchangeLinkedIn,
  exchangeMeta,
  exchangeInstagram,
  exchangeX,
  linkedinAssets,
  metaPermissions,
  provisionMetaSubscriptions,
  removeMetaSubscriptions,
  resolveSocialOAuthMembership,
  safeProviderDiagnostic,
  safeProviderError,
  selectAssets,
  status,
  verifyMetaToken,
  verifyState,
};
