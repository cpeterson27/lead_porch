const axios = require("axios");
const SocialConnection = require("../models/SocialConnection");
const { decryptCredentials } = require("../utils/credentialEncryption");

const dependencies = { SocialConnection, http: axios, decryptCredentials, graphVersion: () => require("./socialProviderConfig").graphVersion() };
function clean(value, max = 500) { return String(value || "").trim().slice(0, max); }

async function recentPosts({ workspaceId, provider, assetId }, deps = dependencies) {
  if (!workspaceId || !["facebook", "instagram"].includes(provider) || !clean(assetId)) throw new Error("Choose a connected Facebook or Instagram account");
  const rows = await deps.SocialConnection.find({ workspaceId, provider: { $in: ["meta", "instagram"] }, status: "connected", selectedAssetIds: String(assetId) }).select("+credentialsEncrypted");
  const connection = provider === "instagram" ? rows.find((row) => row.provider === "instagram") || rows.find((row) => row.provider === "meta") : rows.find((row) => row.provider === "meta");
  const asset = connection?.assets?.find((row) => String(row.id) === String(assetId));
  const expectedType = provider === "facebook" ? "facebook_page" : "instagram_business";
  if (!connection || asset?.type !== expectedType || !(connection.selectedAssetIds || []).map(String).includes(String(assetId))) throw new Error("That account is not selected in this workspace");
  if (!require("./socialConnectionHealth").usable(connection)) throw new Error("Reconnect this social account before loading posts");
  const scopes = new Set(connection.scopes || []);
  const canRead = provider === "facebook" ? scopes.has("pages_read_engagement") || scopes.has("pages_read_user_content") : connection.provider === "instagram" ? scopes.has("instagram_business_basic") : scopes.has("instagram_basic");
  if (!canRead) throw new Error("The connected account did not grant permission to read recent posts");
  const credentials = deps.decryptCredentials(connection.credentialsEncrypted);
  const parentId = asset.type === "instagram_business" ? asset.parentId : asset.id;
  const token = credentials.pageTokens?.[String(parentId)] || (connection.provider === "instagram" ? credentials.accessToken : null);
  if (!token) throw new Error("The selected account authorization cannot read posts");
  const version = deps.graphVersion();
  const directInstagram = connection.provider === "instagram";
  const host = directInstagram ? "graph.instagram.com" : "graph.facebook.com";
  const edge = provider === "facebook" ? "published_posts" : "media";
  const fields = provider === "facebook" ? "id,message,created_time,permalink_url,full_picture" : "id,caption,timestamp,permalink,media_type,thumbnail_url";
  let response;
  try {
    response = await deps.http.get(`https://${host}/${version}/${encodeURIComponent(assetId)}/${edge}`, { params: { fields, limit: 25, access_token: token }, timeout: 15000 });
  } catch {
    throw new Error("Recent posts could not be loaded from this connected account");
  }
  return (response.data?.data || []).map((row) => ({
    id: clean(row.id, 255),
    text: clean(row.message || row.caption || "Post without a caption", 500),
    publishedAt: row.created_time || row.timestamp || null,
    permalink: clean(row.permalink_url || row.permalink, 1000),
    mediaType: clean(row.media_type, 50),
  })).filter((row) => row.id);
}

// Looks up the post/media a comment belongs to, for the Comments section to
// show what was actually commented on and link out to it. Fails soft (null)
// rather than throwing — a stale or deleted post shouldn't break the list.
async function postContext({ workspaceId, provider, assetId, postId }, deps = dependencies) {
  if (!workspaceId || !["facebook", "instagram"].includes(provider) || !clean(assetId) || !clean(postId)) return null;
  try {
    const rows = await deps.SocialConnection.find({ workspaceId, provider: { $in: ["meta", "instagram"] }, status: "connected", selectedAssetIds: String(assetId) }).select("+credentialsEncrypted");
    const connection = provider === "instagram" ? rows.find((row) => row.provider === "instagram") || rows.find((row) => row.provider === "meta") : rows.find((row) => row.provider === "meta");
    const asset = connection?.assets?.find((row) => String(row.id) === String(assetId));
    if (!connection || !asset) return null;
    const credentials = deps.decryptCredentials(connection.credentialsEncrypted);
    const parentId = asset.type === "instagram_business" ? asset.parentId : asset.id;
    const token = credentials.pageTokens?.[String(parentId)] || (connection.provider === "instagram" ? credentials.accessToken : null);
    if (!token) return null;
    const version = deps.graphVersion();
    const host = connection.provider === "instagram" ? "graph.instagram.com" : "graph.facebook.com";
    const fields = provider === "facebook" ? "message,permalink_url,full_picture" : "caption,permalink,media_url,thumbnail_url";
    const response = await deps.http.get(`https://${host}/${version}/${encodeURIComponent(postId)}`, { params: { fields, access_token: token }, timeout: 15000 });
    const permalink = clean(response.data?.permalink_url || response.data?.permalink, 1000);
    if (!permalink) return null;
    return {
      text: clean(response.data?.message || response.data?.caption || "", 500),
      permalink,
      imageUrl: clean(response.data?.full_picture || response.data?.thumbnail_url || response.data?.media_url, 1000),
    };
  } catch {
    return null;
  }
}

// Real published-post engagement counts (likes, comments, shares), read
// directly off the post/media object's own field summaries rather than the
// Insights API — those fields are covered by the read permission we already
// require to show recent posts, and unlike Insights metric names they are
// not prone to being renamed or deprecated between Graph API versions. Fails
// soft (null) so a card can show "unavailable" instead of breaking.
async function postEngagement({ workspaceId, provider, assetId, postId }, deps = dependencies) {
  if (!workspaceId || !["facebook", "instagram"].includes(provider) || !clean(assetId) || !clean(postId)) return null;
  try {
    const rows = await deps.SocialConnection.find({ workspaceId, provider: { $in: ["meta", "instagram"] }, status: "connected", selectedAssetIds: String(assetId) }).select("+credentialsEncrypted");
    const connection = provider === "instagram" ? rows.find((row) => row.provider === "instagram") || rows.find((row) => row.provider === "meta") : rows.find((row) => row.provider === "meta");
    const asset = connection?.assets?.find((row) => String(row.id) === String(assetId));
    if (!connection || !asset) return null;
    const credentials = deps.decryptCredentials(connection.credentialsEncrypted);
    const parentId = asset.type === "instagram_business" ? asset.parentId : asset.id;
    const token = credentials.pageTokens?.[String(parentId)] || (connection.provider === "instagram" ? credentials.accessToken : null);
    if (!token) return null;
    const version = deps.graphVersion();
    const host = connection.provider === "instagram" ? "graph.instagram.com" : "graph.facebook.com";
    const fields =
      provider === "facebook"
        ? "likes.summary(true).limit(0),comments.summary(true).limit(0)"
        : "like_count,comments_count";
    const response = await deps.http.get(`https://${host}/${version}/${encodeURIComponent(postId)}`, { params: { fields, access_token: token }, timeout: 15000 });
    if (provider !== "facebook")
      return {
        likes: response.data?.like_count ?? null,
        comments: response.data?.comments_count ?? null,
        shares: null,
      };
    // The "shares" field errors with "Tried accessing nonexisting field" on
    // any post that has never been shared, so it cannot be requested
    // alongside likes/comments without failing the whole call — fetch it
    // separately and treat a failure as "no shares" rather than "unavailable".
    let shares = null;
    try {
      const shareResponse = await deps.http.get(`https://${host}/${version}/${encodeURIComponent(postId)}`, { params: { fields: "shares", access_token: token }, timeout: 15000 });
      shares = shareResponse.data?.shares?.count ?? 0;
    } catch {
      shares = 0;
    }
    return {
      likes: response.data?.likes?.summary?.total_count ?? null,
      comments: response.data?.comments?.summary?.total_count ?? null,
      shares,
    };
  } catch {
    return null;
  }
}

module.exports = { recentPosts, postContext, postEngagement };
