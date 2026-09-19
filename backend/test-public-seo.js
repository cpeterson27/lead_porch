const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { publicOrigin, xml } = require("./middleware/publicSeo");
const { pathSettings, safeJson } = require("./middleware/publicHtmlShell");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

assert.equal(publicOrigin({ headers: { host: "www.elliescoaching.com" } }), "https://elliescoaching.com");
assert.equal(xml("A&B <C>"), "A&amp;B &lt;C&gt;");
assert.equal(pathSettings("/", "Ellie's Coaching", "Description").indexable, true);
assert.equal(pathSettings("/apply", "Ellie's Coaching", "Description").indexable, false);
assert.equal(pathSettings("/dashboard", "Ellie's Coaching", "Description").indexable, false);
assert.equal(pathSettings("/privacy-policy", "Ellie's Coaching", "Description").canonicalPath, "/privacy");
assert(!safeJson({ value: "</script>" }).includes("</script>"));

const server = read("backend/server.js");
const seo = read("backend/middleware/publicSeo.js");
const shell = read("backend/middleware/publicHtmlShell.js");
const app = read("frontend/src/App.jsx");
const application = read("frontend/src/pages/PublicApplication.jsx");
for (const value of ["/robots.txt", "/sitemap.xml", "Sitemap:", "Disallow: /api/"]) assert(seo.includes(value));
for (const value of ['rel="canonical"', 'name="robots"', 'application/ld+json', 'property="og:url"', "GOOGLE_TAG_MANAGER_ID"]) assert(shell.includes(value));
// Real, reported incident: the favicon was set via WorkspaceThemeContext
// swapping a <link> tag in client-side after React hydrates, which
// Googlebot's favicon crawler never sees — it reads the server-rendered
// <head> directly. The fix must render a real <link rel="icon"> here,
// sourced from branding.faviconUrl (the dedicated upload) ahead of the
// generic site logo, never from a per-page image like a hero photo or a
// coach's profile avatar.
for (const value of ['rel="icon"', 'rel="apple-touch-icon"', "branding.faviconUrl"]) assert(shell.includes(value), `Missing favicon fix: ${value}`);
assert(!/const favicon = absoluteUrl\(profile\?\.avatarUrl/.test(shell), "favicon must never fall back to a per-page image like a profile avatar or hero photo");
assert(server.includes('require("./middleware/publicSeo").publicSeo'));
assert(app.includes('trackSiteEvent("virtual_page_view"'));
for (const event of ["application_start", "application_submit", "program_select"]) assert(application.includes(`trackSiteEvent("${event}"`));

console.log("Public SEO crawl files, canonical metadata, safe schema, GTM hook, public page views, and application conversions passed.");
