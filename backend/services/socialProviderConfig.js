// "linkedin" is LinkedIn's own Marketing API (organization-page publishing,
// OAuth-based). "linkedin_unipile" is a separate personal-profile-outreach
// connection (connection requests + DMs) brokered through Unipile via a
// hosted login flow rather than OAuth — see services/unipileService.js and
// routes/socialLinkedinOutreach.js. A workspace may hold both at once.
const SOCIAL_PROVIDERS = Object.freeze(["linkedin", "linkedin_unipile", "meta", "instagram", "x"]);
const allowed = {
  meta: new Set(["public_profile", "pages_show_list", "pages_read_engagement", "pages_read_user_content", "pages_manage_metadata", "pages_messaging", "pages_manage_posts", "pages_manage_engagement", "instagram_basic", "instagram_manage_messages", "instagram_manage_comments", "instagram_content_publish", "instagram_manage_insights", "read_insights"]),
  instagram: new Set(["instagram_business_basic", "instagram_business_manage_comments", "instagram_business_manage_messages", "instagram_business_content_publish", "instagram_business_manage_insights"]),
};
function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
function graphVersion() {
  const value = required("META_GRAPH_API_VERSION");
  if (!/^v\d+\.0$/.test(value)) throw new Error("META_GRAPH_API_VERSION must use the format v26.0");
  return value;
}
function scopes(provider, value) {
  const result = [...new Set(String(value || "").split(/[\s,]+/).filter(Boolean))];
  if (!result.length || result.some(scope => !allowed[provider]?.has(scope))) throw new Error(`${provider === "meta" ? "META" : "INSTAGRAM"}_OAUTH_SCOPES contains empty, unsupported, or malformed permissions; use comma- or space-separated permissions for this login product`);
  return result;
}
function redirect(name) {
  const value = required(name);
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) || url.username || url.password || url.hash || url.search) throw Error();
    if (url.pathname !== `/api/social/${name === "META_REDIRECT_URI" ? "meta" : "instagram"}/oauth/callback`) throw Error();
  } catch { throw new Error(`${name} must be the HTTPS /api/social/${name === "META_REDIRECT_URI" ? "meta" : "instagram"}/oauth/callback URL (HTTP localhost is allowed for development)`); }
  return value;
}
function facebookConfigId() {
  const value = required("FACEBOOK_LOGIN_CONFIG_ID");
  if (!/^\d+$/.test(value)) throw new Error("FACEBOOK_LOGIN_CONFIG_ID must be the numeric Facebook Login for Business configuration ID");
  return value;
}
module.exports = { SOCIAL_PROVIDERS, graphVersion, scopes, redirect, facebookConfigId };
