const crypto = require("node:crypto");
const express = require("express");
const OAuthClient = require("../models/OAuthClient");
const OAuthCredential = require("../models/OAuthCredential");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const SCOPES = ["openid", "offline_access", "crm:read", "crm:write", "research:read", "research:write", "campaigns:read", "campaigns:write", "imports:write", "settings:write"];
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const randomValue = (prefix) => `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
const frontendUrl = () => String(process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0].trim().replace(/\/$/, "");
const serverUrl = (req) => String(process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

function validRedirectUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch (_error) { return false; }
}

function requestedScopes(value) {
  const scopes = [...new Set(String(value || "").split(/\s+/).filter((scope) => SCOPES.includes(scope)))];
  return scopes.length ? scopes : ["crm:read", "research:read"];
}

const protectedResourceMetadata = (req, res) => res.json({
  resource: `${serverUrl(req)}/mcp`,
  authorization_servers: [serverUrl(req)],
  scopes_supported: SCOPES,
  resource_documentation: `${frontendUrl()}/settings`,
});
router.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
router.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);

router.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = serverUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SCOPES,
  });
});

router.post("/oauth/register", async (req, res) => {
  const redirectUris = (Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : []).filter(validRedirectUri).slice(0, 10);
  if (!redirectUris.length) return res.status(400).json({ error: "invalid_redirect_uri" });
  const clientId = randomValue("ellie_client");
  const client = await OAuthClient.create({
    clientId,
    clientName: String(req.body?.client_name || "ChatGPT").slice(0, 160),
    redirectUris,
  });
  res.status(201).json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    token_endpoint_auth_method: "none",
  });
});

async function validateAuthorizationQuery(query) {
  const client = await OAuthClient.findOne({ clientId: String(query.client_id || "") }).lean();
  if (!client || query.response_type !== "code" || !client.redirectUris.includes(String(query.redirect_uri || ""))) return null;
  if (query.code_challenge_method !== "S256" || !String(query.code_challenge || "")) return null;
  return client;
}

router.get("/oauth/authorize", async (req, res) => {
  const client = await validateAuthorizationQuery(req.query);
  if (!client) return res.status(400).send("Invalid Growth Operator authorization request.");
  const params = new URLSearchParams(Object.entries(req.query).map(([key, value]) => [key, String(value)]));
  res.redirect(`${frontendUrl()}/oauth/consent?${params}`);
});

router.get("/api/oauth/authorize/details", requireAuth, async (req, res) => {
  const client = await validateAuthorizationQuery(req.query);
  if (!client) return res.status(400).json({ error: "Invalid authorization request" });
  res.json({ clientName: client.clientName, workspaceName: req.auth.workspace.name, scopes: requestedScopes(req.query.scope) });
});

router.post("/api/oauth/authorize", requireAuth, async (req, res) => {
  const query = req.body || {};
  const client = await validateAuthorizationQuery(query);
  if (!client) return res.status(400).json({ error: "Invalid authorization request" });
  const redirect = new URL(query.redirect_uri);
  if (query.approved !== true) {
    redirect.searchParams.set("error", "access_denied");
  } else {
    const rawCode = randomValue("ellie_code");
    await OAuthCredential.create({
      kind: "authorization_code", valueHash: hash(rawCode), clientId: client.clientId,
      userId: req.auth.user._id, workspaceId: req.auth.workspaceId,
      scopes: requestedScopes(query.scope), redirectUri: query.redirect_uri,
      codeChallenge: query.code_challenge, expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    redirect.searchParams.set("code", rawCode);
  }
  if (query.state) redirect.searchParams.set("state", query.state);
  res.json({ redirectUrl: redirect.toString() });
});

router.get("/api/oauth/connections", requireAuth, async (req, res) => {
  const grants = await OAuthCredential.find({ workspaceId: req.auth.workspaceId, userId: req.auth.user._id, kind: "refresh_token", revokedAt: null, expiresAt: { $gt: new Date() } })
    .select("clientId scopes createdAt expiresAt").sort({ createdAt: -1 }).lean();
  const clients = await OAuthClient.find({ clientId: { $in: grants.map((grant) => grant.clientId) } }).select("clientId clientName").lean();
  const names = new Map(clients.map((client) => [client.clientId, client.clientName]));
  res.json({ connections: grants.map((grant) => ({ id: grant._id, clientId: grant.clientId, name: names.get(grant.clientId) || "AI assistant", scopes: grant.scopes, connectedAt: grant.createdAt, expiresAt: grant.expiresAt })) });
});

router.delete("/api/oauth/connections/:clientId", requireAuth, async (req, res) => {
  await OAuthCredential.updateMany({ workspaceId: req.auth.workspaceId, userId: req.auth.user._id, clientId: req.params.clientId, revokedAt: null }, { revokedAt: new Date() });
  res.json({ success: true });
});

async function issueTokens(credential) {
  const accessToken = randomValue("ellie_oauth");
  const refreshToken = randomValue("ellie_refresh");
  const accessExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const refreshExpiresAt = new Date(Date.now() + 90 * 86400000);
  await OAuthCredential.insertMany([
    { kind: "access_token", valueHash: hash(accessToken), clientId: credential.clientId, userId: credential.userId, workspaceId: credential.workspaceId, scopes: credential.scopes, expiresAt: accessExpiresAt },
    { kind: "refresh_token", valueHash: hash(refreshToken), clientId: credential.clientId, userId: credential.userId, workspaceId: credential.workspaceId, scopes: credential.scopes, expiresAt: refreshExpiresAt },
  ]);
  return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600, scope: credential.scopes.join(" ") };
}

router.post("/oauth/token", async (req, res) => {
  const grantType = String(req.body?.grant_type || "");
  if (grantType === "authorization_code") {
    const credential = await OAuthCredential.findOne({ kind: "authorization_code", valueHash: hash(String(req.body?.code || "")), consumedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } }).select("+valueHash");
    if (!credential || credential.clientId !== req.body.client_id || credential.redirectUri !== req.body.redirect_uri) return res.status(400).json({ error: "invalid_grant" });
    const verifierHash = crypto.createHash("sha256").update(String(req.body.code_verifier || "")).digest("base64url");
    if (verifierHash !== credential.codeChallenge) return res.status(400).json({ error: "invalid_grant" });
    credential.consumedAt = new Date(); await credential.save();
    return res.json(await issueTokens(credential));
  }
  if (grantType === "refresh_token") {
    const credential = await OAuthCredential.findOne({ kind: "refresh_token", valueHash: hash(String(req.body?.refresh_token || "")), revokedAt: null, expiresAt: { $gt: new Date() } }).select("+valueHash");
    if (!credential || credential.clientId !== req.body.client_id) return res.status(400).json({ error: "invalid_grant" });
    credential.revokedAt = new Date(); await credential.save();
    return res.json(await issueTokens(credential));
  }
  return res.status(400).json({ error: "unsupported_grant_type" });
});

// Search reporting uses its own one-time OAuth state and read-only scopes.
router.get("/oauth/search-reporting/callback", async (req, res) => {
  const service = require("../services/searchReportingService");
  const frontend = require("../utils/frontendUrl").primaryFrontendUrl();
  try {
    const state = await service.consumeState(req.query.state);
    const membership = await require("../models/WorkspaceMembership").findOne({ workspaceId: state.workspaceId, userId: state.userId, status: "active", $or: [{ role: { $in: ["owner", "admin"] } }, { roles: { $in: ["owner", "admin"] } }] });
    if (!membership || typeof req.query.code !== "string" || req.query.error) throw new Error("Connection denied");
    await require("../tenancy/workspaceContext").runWithWorkspace(state.workspaceId, () => service.finish(state, req.query.code));
    res.redirect(`${frontend}/analytics?searchConnection=connected#search-visibility`);
  } catch {
    res.redirect(`${frontend}/analytics?searchConnection=failed#search-visibility`);
  }
});
module.exports = router;
