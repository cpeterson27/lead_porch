const crypto = require("crypto");
const IntegrationConnection = require("../models/IntegrationConnection");
const Testimonial = require("../models/Testimonial");
const { encryptCredentials, decryptCredentials } = require("../utils/credentialEncryption");

const PROVIDER = "google_business_profile";
const SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/business.manage"];
const dependencies = { IntegrationConnection, Testimonial };

function providerError(message, code = "GOOGLE_BUSINESS_PROFILE_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}
function env(name, fallback = "") { return String(process.env[name] || fallback || "").trim(); }
function clientId() { return env("GOOGLE_BUSINESS_PROFILE_CLIENT_ID", process.env.GOOGLE_CLIENT_ID); }
function clientSecret() { return env("GOOGLE_BUSINESS_PROFILE_CLIENT_SECRET", process.env.GOOGLE_CLIENT_SECRET); }
function redirectUri() { return env("GOOGLE_BUSINESS_PROFILE_REDIRECT_URI"); }
function stateSecret() { return env("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY"); }
function configured() { return Boolean(clientId() && clientSecret() && redirectUri() && stateSecret()); }
function requireConfigured() {
  if (!configured()) throw providerError("Google Business Profile OAuth is not configured", "GOOGLE_BUSINESS_PROFILE_CONFIG_MISSING");
}

function createState(workspaceId, userId, returnOrigin = "") {
  requireConfigured();
  const payload = Buffer.from(JSON.stringify({ workspaceId: String(workspaceId), userId: String(userId), returnOrigin: String(returnOrigin || ""), createdAt: Date.now(), nonce: crypto.randomBytes(16).toString("hex") })).toString("base64url");
  const signature = crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyState(value) {
  try {
    const [payload, signature] = String(value || "").split(".");
    if (!payload || !signature) return null;
    const expected = crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Date.now() - Number(parsed.createdAt) < 10 * 60 * 1000 && parsed.workspaceId && parsed.userId ? parsed : null;
  } catch { return null; }
}

function authorizationUrl(workspaceId, userId, returnOrigin = "") {
  requireConfigured();
  const params = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri(), response_type: "code", access_type: "offline", prompt: "consent", include_granted_scopes: "true", scope: SCOPES.join(" "), state: createState(workspaceId, userId, returnOrigin) });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function jsonRequest(url, options = {}, fallback = "Google Business Profile request failed") {
  const response = await fetch(url, options);
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw providerError(data.error?.message || data.error_description || fallback, "GOOGLE_BUSINESS_PROFILE_REQUEST_FAILED");
  return data;
}

const googleAdapter = {
  exchangeCode(code) {
    return jsonRequest("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri(), grant_type: "authorization_code" }) }, "Google token exchange failed");
  },
  profile(accessToken) { return jsonRequest("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } }, "Unable to read the connected Google account"); },
  refresh(refreshToken) { return jsonRequest("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId(), client_secret: clientSecret(), grant_type: "refresh_token" }) }, "Google access refresh failed"); },
  request(accessToken, url) { return jsonRequest(url, { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }); },
};

function connectionFilter(workspaceId) { return { workspaceId, provider: PROVIDER, accountScope: "workspace" }; }

async function saveConnection({ workspaceId }, tokens, profile, models = dependencies, cryptoOps = { encryptCredentials, decryptCredentials }) {
  const filter = connectionFilter(workspaceId);
  const existing = await models.IntegrationConnection.findOne(filter).select("+credentialsEncrypted");
  const previous = existing?.credentialsEncrypted ? cryptoOps.decryptCredentials(existing.credentialsEncrypted) : {};
  return models.IntegrationConnection.findOneAndUpdate(filter, { $set: {
    ...filter,
    status: "connected",
    credentialsEncrypted: cryptoOps.encryptCredentials({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token || previous.refreshToken }),
    settings: { ...(existing?.settings || {}), email: profile.email || "", name: profile.name || "" },
    oauth: { scopes: String(tokens.scope || SCOPES.join(" ")).split(/[ ,]+/).filter(Boolean), expiresAt: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000), providerAccountId: profile.sub || "" },
    connectedAt: new Date(), lastVerifiedAt: new Date(), lastError: null,
  } }, { upsert: true, new: true, setDefaultsOnInsert: true });
}

function publicConnection(connection) {
  return {
    configured: configured(), connected: connection?.status === "connected", email: connection?.settings?.email || "", name: connection?.settings?.name || "",
    accountName: connection?.settings?.accountName || "", locationName: connection?.settings?.locationName || "", locationTitle: connection?.settings?.locationTitle || "", mapsUri: connection?.settings?.mapsUri || "",
    lastSyncedAt: connection?.settings?.lastSyncedAt || null, reviewCount: Number(connection?.settings?.reviewCount || 0), averageRating: Number(connection?.settings?.averageRating || 0) || null,
    connectedAt: connection?.connectedAt || null, lastError: connection?.lastError || "",
  };
}

async function status(workspaceId, models = dependencies) { return publicConnection(await models.IntegrationConnection.findOne(connectionFilter(workspaceId))); }

async function connectedConnection(workspaceId, models = dependencies) {
  const connection = await models.IntegrationConnection.findOne({ ...connectionFilter(workspaceId), status: "connected" }).select("+credentialsEncrypted");
  if (!connection?.credentialsEncrypted) throw providerError("Connect Google Business Profile first", "GOOGLE_BUSINESS_PROFILE_NOT_CONNECTED");
  return connection;
}

async function accessToken(connection, adapter = googleAdapter, cryptoOps = { encryptCredentials, decryptCredentials }) {
  const credentials = cryptoOps.decryptCredentials(connection.credentialsEncrypted);
  if (credentials.accessToken && new Date(connection.oauth?.expiresAt || 0).getTime() > Date.now() + 60000) return credentials.accessToken;
  if (!credentials.refreshToken) throw providerError("Reconnect Google Business Profile to grant offline access", "GOOGLE_BUSINESS_PROFILE_RECONNECT_REQUIRED");
  const refreshed = await adapter.refresh(credentials.refreshToken);
  connection.credentialsEncrypted = cryptoOps.encryptCredentials({ ...credentials, accessToken: refreshed.access_token });
  connection.oauth.expiresAt = new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000);
  connection.lastVerifiedAt = new Date();
  await connection.save();
  return refreshed.access_token;
}

async function listLocations(workspaceId, models = dependencies, adapter = googleAdapter, cryptoOps) {
  const connection = await connectedConnection(workspaceId, models);
  const token = await accessToken(connection, adapter, cryptoOps);
  const accountResponse = await adapter.request(token, "https://mybusinessaccountmanagement.googleapis.com/v1/accounts");
  const locations = [];
  for (const account of accountResponse.accounts || []) {
    let pageToken = "";
    do {
      const params = new URLSearchParams({ readMask: "name,title,storeCode,websiteUri,metadata", pageSize: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await adapter.request(token, `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?${params}`);
      for (const location of response.locations || []) locations.push({ accountName: account.name, accountTitle: account.accountName || account.name, locationName: location.name, locationTitle: location.title || location.storeCode || location.name, websiteUri: location.websiteUri || "", mapsUri: location.metadata?.mapsUri || "" });
      pageToken = response.nextPageToken || "";
    } while (pageToken);
  }
  return locations;
}

async function selectLocation(workspaceId, selection, models = dependencies, adapter = googleAdapter, cryptoOps) {
  const locations = await listLocations(workspaceId, models, adapter, cryptoOps);
  const selected = locations.find((item) => item.accountName === selection.accountName && item.locationName === selection.locationName);
  if (!selected) throw providerError("Choose a Google Business Profile location returned by the connected account", "GOOGLE_BUSINESS_PROFILE_LOCATION_INVALID");
  const connection = await models.IntegrationConnection.findOneAndUpdate(connectionFilter(workspaceId), { $set: { "settings.accountName": selected.accountName, "settings.locationName": selected.locationName, "settings.locationTitle": selected.locationTitle, "settings.mapsUri": selected.mapsUri || "", lastError: null } }, { new: true });
  return { connection: publicConnection(connection), selected };
}

function ratingNumber(value) { return ({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 })[String(value || "").toUpperCase()] || null; }

async function syncReviews(workspaceId, models = dependencies, adapter = googleAdapter, cryptoOps) {
  const connection = await connectedConnection(workspaceId, models);
  const accountName = connection.settings?.accountName;
  const locationName = connection.settings?.locationName;
  if (!accountName || !locationName) throw providerError("Select Ellie’s Google Business Profile location before syncing reviews", "GOOGLE_BUSINESS_PROFILE_LOCATION_REQUIRED");
  const token = await accessToken(connection, adapter, cryptoOps);
  const accountId = String(accountName).split("/").pop();
  const locationId = String(locationName).split("/").pop();
  const reviews = [];
  let pageToken = "";
  let summary = {};
  do {
    const params = new URLSearchParams({ pageSize: "50", orderBy: "updateTime desc" });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await adapter.request(token, `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(accountId)}/locations/${encodeURIComponent(locationId)}/reviews?${params}`);
    reviews.push(...(response.reviews || []));
    summary = response;
    pageToken = response.nextPageToken || "";
  } while (pageToken);

  const now = new Date();
  const ids = [];
  for (const review of reviews) {
    const externalId = String(review.reviewId || review.name || "");
    if (!externalId) continue;
    ids.push(externalId);
    const body = String(review.comment || "").trim();
    await models.Testimonial.findOneAndUpdate(
      { workspaceId, source: PROVIDER, externalId },
      { $set: { displayName: String(review.reviewer?.displayName || "Google reviewer").slice(0, 160), headline: "Google Review", body: body || "Rated Ellie’s Coaching on Google.", avatarUrl: String(review.reviewer?.profilePhotoUrl || "").slice(0, 1000), rating: ratingNumber(review.starRating), source: PROVIDER, externalId, sourceUrl: String(connection.settings?.mapsUri || "").slice(0, 1500), sourceCreatedAt: review.createTime ? new Date(review.createTime) : null, sourceUpdatedAt: review.updateTime ? new Date(review.updateTime) : null, lastSyncedAt: now, status: "approved", featured: true, consentConfirmed: true, approvedAt: now, resultContext: "Verified Google review" }, $setOnInsert: { submittedAt: review.createTime ? new Date(review.createTime) : now } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }
  await models.Testimonial.updateMany({ workspaceId, source: PROVIDER, externalId: { $nin: ids } }, { $set: { status: "rejected", featured: false, lastSyncedAt: now } });
  connection.settings = { ...(connection.settings || {}), lastSyncedAt: now, reviewCount: Number(summary.totalReviewCount || reviews.length), averageRating: Number(summary.averageRating || 0) || null };
  connection.lastVerifiedAt = now; connection.lastError = null; await connection.save();
  return { imported: reviews.length, reviewCount: connection.settings.reviewCount, averageRating: connection.settings.averageRating, lastSyncedAt: now };
}

async function disconnect(workspaceId, models = dependencies) {
  const connection = await models.IntegrationConnection.findOneAndUpdate(connectionFilter(workspaceId), { $set: { status: "disconnected", credentialsEncrypted: null, connectedAt: null, oauth: {}, lastError: null } }, { new: true });
  await models.Testimonial.deleteMany({ workspaceId, source: PROVIDER });
  return publicConnection(connection);
}

module.exports = { PROVIDER, SCOPES, googleAdapter, configured, createState, verifyState, authorizationUrl, saveConnection, publicConnection, status, listLocations, selectLocation, syncReviews, disconnect, _dependencies: dependencies };
