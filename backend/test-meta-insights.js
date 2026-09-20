const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { encryptCredentials } = require("./utils/credentialEncryption");

process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.META_GRAPH_API_VERSION = "v26.0";
const service = require("./services/metaInsightsService");

function query(value) { return { select: async () => value }; }
const connection = {
  provider: "meta", status: "connected", authorization: { valid: true }, scopes: ["read_insights", "instagram_manage_insights"],
  selectedAssetIds: ["page-1", "ig-1"], expiresAt: new Date(Date.now() + 86400000),
  assets: [{ id: "page-1", name: "Ellie Page", type: "facebook_page" }, { id: "ig-1", parentId: "page-1", name: "Ellie IG", type: "instagram_business" }],
  credentialsEncrypted: encryptCredentials({ accessToken: "user-token", pageTokens: { "page-1": "page-token" } }),
};
const directInstagram = {
  provider: "instagram", status: "connected", authorization: { valid: true }, scopes: ["instagram_business_manage_insights"],
  selectedAssetIds: ["ig-direct"], expiresAt: new Date(Date.now() + 86400000),
  assets: [{ id: "ig-direct", name: "@elliescoaching", type: "instagram_business" }],
  credentialsEncrypted: encryptCredentials({ accessToken: "instagram-token" }),
};

async function run() {
  const calls = [];
  const result = await service.fetchWorkspaceInsights("workspace-1", {
    SocialConnection: { find(filter) { assert.deepEqual(filter, { workspaceId: "workspace-1", provider: { $in: ["meta", "instagram"] }, status: "connected" }); return query([connection]); } },
    http: { async get(url, options) {
      calls.push({ url, options });
      assert.equal(options.params.access_token, "page-token");
      if (url.endsWith("/page-1")) return { data: { followers_count: 120 } };
      if (url.endsWith("/page-1/insights")) return { data: { data: [{ name: "page_post_engagements", values: [{ value: 15 }] }] } };
      if (url.endsWith("/ig-1")) return { data: { followers_count: 80, media_count: 12 } };
      return { data: { data: [{ name: "reach", values: [{ value: 40 }] }, { name: "profile_views", values: [{ value: 5 }] }] } };
    } },
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(result.assets.map(({ provider, followers, reach, engagements, profileViews }) => ({ provider, followers, reach, engagements, profileViews })), [
    { provider: "facebook", followers: 120, reach: null, engagements: 15, profileViews: null },
    { provider: "instagram", followers: 80, reach: 40, engagements: null, profileViews: 5 },
  ]);

  const permission = await service.fetchWorkspaceInsights("workspace-1", {
    SocialConnection: { find: () => query([{ ...connection, scopes: [] }]) }, http: { get: async () => { throw new Error("must not call provider without grants"); } },
  });
  assert.deepEqual(permission.assets.map(row => row.requiredPermission), ["read_insights", "instagram_manage_insights"]);
  assert(!JSON.stringify(result).includes("page-token"));

  const directCalls = [];
  const direct = await service.fetchWorkspaceInsights("workspace-1", {
    SocialConnection: { find: () => query([connection, directInstagram]) },
    http: { async get(url, options) {
      directCalls.push({ url, options });
      if (url.includes("ig-direct/insights")) return { data: { data: [{ name: "reach", total_value: { value: 77 } }, { name: "profile_views", total_value: { value: 9 } }] } };
      if (url.includes("ig-direct")) return { data: { username: "elliescoaching", followers_count: 205, media_count: 18 } };
      if (url.endsWith("/page-1")) return { data: { followers_count: 120 } };
      if (url.endsWith("/page-1/insights")) return { data: { data: [] } };
      if (url.endsWith("/ig-1")) return { data: { followers_count: 80, media_count: 12 } };
      return { data: { data: [] } };
    } },
  });
  const directRow = direct.assets.find(row => row.assetId === "ig-direct");
  assert.deepEqual(
    { provider: directRow.provider, followers: directRow.followers, reach: directRow.reach, profileViews: directRow.profileViews },
    { provider: "instagram", followers: 205, reach: 77, profileViews: 9 },
  );
  assert(directCalls.filter(call => call.url.includes("ig-direct")).every(call => call.url.startsWith("https://graph.instagram.com/v26.0/")));
  assert(directCalls.filter(call => call.url.includes("ig-direct")).every(call => call.options.params.access_token === "instagram-token"));

  const directPermission = await service.fetchWorkspaceInsights("workspace-1", {
    SocialConnection: { find: () => query([{ ...directInstagram, scopes: [] }]) },
    http: { get: async () => { throw new Error("must not call provider without direct Instagram insight grant"); } },
  });
  assert.equal(directPermission.assets[0].requiredPermission, "instagram_business_manage_insights");
  console.log("Meta insights passed: selected assets, permission gating, safe metrics, and no credential exposure (mocked).");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
