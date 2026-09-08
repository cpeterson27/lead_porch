const assert = require("node:assert/strict");
const { recentPosts, postCommentIds } = require("./services/metaRecentPostService");

function query(rows, captures) {
  return { find(filter) { captures.filters.push(filter); return { async select(selection) { captures.selections.push(selection); return rows; } }; } };
}
function connection(values) { return { status: "connected", authorization: { valid: true }, selectedAssetIds: [values.asset.id], assets: [values.asset], provider: values.provider, scopes: values.provider === "instagram" ? ["instagram_business_basic"] : ["pages_read_engagement", "instagram_basic"], credentialsEncrypted: "encrypted" }; }

async function run() {
  const calls = [], captures = { filters: [], selections: [] };
  const facebook = connection({ provider: "meta", asset: { id: "page-1", type: "facebook_page" } });
  const facebookPosts = await recentPosts({ workspaceId: "workspace-1", provider: "facebook", assetId: "page-1" }, { SocialConnection: query([facebook], captures), decryptCredentials: () => ({ pageTokens: { "page-1": "secret-page-token" } }), graphVersion: () => "v26.0", http: { async get(url, options) { calls.push({ url, options }); return { data: { data: [{ id: "post-1", message: "Freedom starts here", created_time: "2026-08-20T12:00:00Z", permalink_url: "https://facebook.test/post-1" }] } }; } } });
  assert.deepEqual(facebookPosts, [{ id: "post-1", text: "Freedom starts here", publishedAt: "2026-08-20T12:00:00Z", permalink: "https://facebook.test/post-1", mediaType: "" }]);
  assert.match(calls[0].url, /page-1\/published_posts$/); assert.equal(calls[0].options.params.access_token, "secret-page-token");
  assert.equal(captures.filters[0].workspaceId, "workspace-1"); assert.equal(captures.filters[0].selectedAssetIds, "page-1"); assert.equal(captures.selections[0], "+credentialsEncrypted");

  const instagram = connection({ provider: "instagram", asset: { id: "ig-1", type: "instagram_business", parentId: "" } });
  const instagramPosts = await recentPosts({ workspaceId: "workspace-1", provider: "instagram", assetId: "ig-1" }, { SocialConnection: query([instagram], captures), decryptCredentials: () => ({ accessToken: "secret-ig-token" }), graphVersion: () => "v26.0", http: { async get(url) { calls.push({ url }); return { data: { data: [{ id: "media-1", caption: "A recent reel", timestamp: "2026-08-21T12:00:00Z", media_type: "REELS" }] } }; } } });
  assert.equal(instagramPosts[0].id, "media-1"); assert.equal(instagramPosts[0].text, "A recent reel"); assert.match(calls[1].url, /graph\.instagram\.com\/v26\.0\/ig-1\/media$/);

  let providerCalls = 0;
  await assert.rejects(() => recentPosts({ workspaceId: "workspace-1", provider: "facebook", assetId: "other" }, { SocialConnection: query([], captures), decryptCredentials: () => ({}), graphVersion: () => "v26.0", http: { async get() { providerCalls += 1; } } }), /not selected/);
  assert.equal(providerCalls, 0);

  // postCommentIds is the live source of truth for "which comments really
  // exist on this post right now" — used to keep Lead Porch's comment lists
  // from still showing a comment after it has been deleted on the platform.
  const fbCommentIds = await postCommentIds({ workspaceId: "workspace-1", provider: "facebook", assetId: "page-1", postId: "post-1" }, { SocialConnection: query([facebook], captures), decryptCredentials: () => ({ pageTokens: { "page-1": "secret-page-token" } }), graphVersion: () => "v26.0", http: { async get(url) { calls.push({ url }); return { data: { comments: { data: [{ id: "comment-1" }] } } }; } } });
  assert.deepEqual(fbCommentIds, ["comment-1"]);
  const igCommentIds = await postCommentIds({ workspaceId: "workspace-1", provider: "instagram", assetId: "ig-1", postId: "media-1" }, { SocialConnection: query([instagram], captures), decryptCredentials: () => ({ accessToken: "secret-ig-token" }), graphVersion: () => "v26.0", http: { async get(url) { calls.push({ url }); return { data: { comments: { data: [{ id: "ig-comment-1" }] } } }; } } });
  assert.deepEqual(igCommentIds, ["ig-comment-1"]);
  assert.equal(
    await postCommentIds({ workspaceId: "workspace-1", provider: "facebook", assetId: "other", postId: "post-1" }, { SocialConnection: query([], captures), decryptCredentials: () => ({}), graphVersion: () => "v26.0", http: { async get() { throw new Error("must not be called"); } } }),
    null,
    "must fail soft (null) rather than throw when the connection cannot be resolved",
  );
}
run().then(() => console.log("Recent Meta post selection passed with mocked Facebook/Instagram responses, workspace scoping and selected-asset enforcement.")).catch((error) => { console.error(error); process.exitCode = 1; });
