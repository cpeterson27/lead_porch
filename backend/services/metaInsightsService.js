const axios = require("axios");
const SocialConnection = require("../models/SocialConnection");
const { decryptCredentials } = require("../utils/credentialEncryption");
const { graphVersion } = require("./socialProviderConfig");
const { usable } = require("./socialConnectionHealth");

const deps = { SocialConnection, http: axios };

function metricValue(row) {
  const values = Array.isArray(row?.values) ? row.values : [];
  const value = values.at(-1)?.value ?? row?.total_value?.value ?? null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sum(rows, name) {
  const values = rows
    .filter((row) => row.name === name)
    .map(metricValue)
    .filter((value) => value !== null);
  return values.length
    ? values.reduce((total, value) => total + value, 0)
    : null;
}

function safeError(error) {
  const status = Number(error?.response?.status || 0);
  const code = String(error?.response?.data?.error?.code || "")
    .replace(/[^0-9A-Za-z_.-]/g, "")
    .slice(0, 30);
  return [
    "Insights unavailable",
    status ? `HTTP ${status}` : "",
    code ? `provider code ${code}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

async function facebookInsights(connection, asset, credentials, http, version) {
  if (!connection.scopes?.includes("read_insights"))
    return {
      provider: "facebook",
      assetId: asset.id,
      assetName: asset.name,
      status: "permission_required",
      requiredPermission: "read_insights",
    };
  const token = credentials.pageTokens?.[String(asset.id)];
  if (!token)
    return {
      provider: "facebook",
      assetId: asset.id,
      assetName: asset.name,
      status: "authorization_required",
    };
  try {
    const [profile, insight] = await Promise.all([
      http.get(`https://graph.facebook.com/${version}/${asset.id}`, {
        params: { fields: "fan_count,followers_count", access_token: token },
        timeout: 15000,
      }),
      http.get(`https://graph.facebook.com/${version}/${asset.id}/insights`, {
        params: {
          metric: "page_post_engagements",
          period: "day",
          access_token: token,
        },
        timeout: 15000,
      }),
    ]);
    const rows = insight.data?.data || [];
    return {
      provider: "facebook",
      assetId: asset.id,
      assetName: asset.name,
      status: "available",
      followers:
        profile.data?.followers_count ?? profile.data?.fan_count ?? null,
      engagements: sum(rows, "page_post_engagements"),
      reach: null,
      impressions: null,
      profileViews: null,
    };
  } catch (error) {
    return {
      provider: "facebook",
      assetId: asset.id,
      assetName: asset.name,
      status: "unavailable",
      error: safeError(error),
    };
  }
}

async function instagramInsights(
  connection,
  asset,
  credentials,
  http,
  version,
) {
  if (!connection.scopes?.includes("instagram_manage_insights"))
    return {
      provider: "instagram",
      assetId: asset.id,
      assetName: asset.name,
      status: "permission_required",
      requiredPermission: "instagram_manage_insights",
    };
  const token =
    credentials.pageTokens?.[String(asset.parentId)] || credentials.accessToken;
  if (!token)
    return {
      provider: "instagram",
      assetId: asset.id,
      assetName: asset.name,
      status: "authorization_required",
    };
  try {
    const [profile, insight] = await Promise.all([
      http.get(`https://graph.facebook.com/${version}/${asset.id}`, {
        params: {
          fields: "followers_count,media_count,username",
          access_token: token,
        },
        timeout: 15000,
      }),
      http.get(`https://graph.facebook.com/${version}/${asset.id}/insights`, {
        params: {
          metric: "reach,profile_views",
          period: "day",
          // Meta now rejects profile_views without this — it used to return
          // a per-day "values" array like reach did, but requires opting
          // into the newer "total_value" shape or the whole request 400s.
          // metricValue() below already reads total_value.value, so no
          // parsing change is needed to support it.
          metric_type: "total_value",
          access_token: token,
        },
        timeout: 15000,
      }),
    ]);
    const rows = insight.data?.data || [];
    return {
      provider: "instagram",
      assetId: asset.id,
      assetName: profile.data?.username ? `@${profile.data.username}` : asset.name,
      status: "available",
      followers: profile.data?.followers_count ?? null,
      mediaCount: profile.data?.media_count ?? null,
      reach: sum(rows, "reach"),
      profileViews: sum(rows, "profile_views"),
      impressions: null,
      engagements: null,
    };
  } catch (error) {
    return {
      provider: "instagram",
      assetId: asset.id,
      assetName: asset.name,
      status: "unavailable",
      error: safeError(error),
    };
  }
}

async function fetchWorkspaceInsights(workspaceId, models = deps) {
  const connections = await models.SocialConnection.find({
    workspaceId,
    provider: "meta",
    status: "connected",
  }).select("+credentialsEncrypted");
  const assets = [];
  for (const connection of connections) {
    if (!usable(connection)) continue;
    const credentials = decryptCredentials(connection.credentialsEncrypted);
    const selected = new Set((connection.selectedAssetIds || []).map(String));
    for (const asset of connection.assets || []) {
      if (!selected.has(String(asset.id))) continue;
      if (asset.type === "facebook_page")
        assets.push(
          await facebookInsights(
            connection,
            asset,
            credentials,
            models.http,
            graphVersion(),
          ),
        );
      if (asset.type === "instagram_business")
        assets.push(
          await instagramInsights(
            connection,
            asset,
            credentials,
            models.http,
            graphVersion(),
          ),
        );
    }
  }
  return {
    assets,
    fetchedAt: new Date(),
    note: "Metrics are returned only for explicitly selected assets and granted permissions. Unavailable values remain blank rather than being reported as zero.",
  };
}

module.exports = { fetchWorkspaceInsights, metricValue, safeError };
