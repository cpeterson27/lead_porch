const assert = require("node:assert/strict");
const fs = require("node:fs");
const service = require("./services/publicSiteService");
const { publicPages, sitemapEntries } = require("./services/publicSitemap");
const { pathSettings, workspaceMeta, renderShell } = require("./middleware/publicHtmlShell");
const { publicSeo } = require("./middleware/publicSeo");
const WorkspaceConfig = require("./models/WorkspaceConfig");

const chain = (data) => ({ sort() { return this; }, select() { return this; }, limit(n) { return chain(Array.isArray(data) ? data.slice(0, n) : data); }, lean: async () => data });
const program = service.programProjection({ _id: "p1", name: "Internal name", publicPresentation: { slug: "published-program", title: "Published Program & Coaching" } });
assert.equal(program.name, undefined); // The API contract that caused the blank links.
assert.equal(sitemapEntries({ programs: [program] }).find((e) => e.group === "Programs").label, program.title);
const profiles = Array.from({ length: 61 }, (_, i) => ({ slug: `coach-${i}`, ownerType: "coach", displayName: `Coach ${i}`, bio: "Public biography", coachProfileId: `c${i}`, userId: `u${i}` }));
profiles.push({ slug: "published-student", ownerType: "student", displayName: "Published Student" });
profiles.push({ slug: "inactive-coach", ownerType: "coach", displayName: "Inactive", bio: "Bio", coachProfileId: "inactive", userId: "inactive" });
const config = { publicSite: { published: true, discoveryCallEnabled: true }, publicApplication: { enabled: true } };
const models = {
  Workspace: { findOne: () => chain({ _id: "ws", slug: "ellie", name: "Ellie" }) },
  WorkspaceConfig: { findOne: () => chain(config) },
  CoachingProgram: { find: (query) => { assert.equal(query.workspaceId, "ws"); assert.equal(query.status, "active"); assert.equal(query["publicPresentation.status"], "published"); return chain([{ _id: "p1", name: "Internal", publicPresentation: { title: program.title, slug: program.slug } }]); } },
  PublicProfile: { find: (query) => { assert.equal(query.workspaceId, "ws"); assert.equal(query.status, "published"); return chain(profiles); } },
  Testimonial: { find: () => chain([]) },
  Event: { findOne: () => chain(null) },
  CoachProfile: { find: () => chain(profiles.filter((p) => p.slug !== "inactive-coach").map((p) => ({ _id: p.coachProfileId, userId: p.userId }))) },
  WorkspaceMembership: { find: () => chain(profiles.filter((p) => p.slug !== "inactive-coach").map((p) => ({ userId: p.userId }))) },
};

(async () => {
  const site = await service.site(models);
  assert.equal(site.team.length, 12, "homepage team stays short");
  assert.equal(site.sitemap.filter((e) => e.group === "People").length, 62, "sitemap includes profiles beyond both old caps and published students");
  assert(!site.sitemap.some((e) => e.path.includes("inactive-coach")));
  assert(site.sitemap.every((e) => e.label.trim()));
  assert.equal(new Set(site.sitemap.map((e) => e.path)).size, site.sitemap.length);
  const app = fs.readFileSync(require.resolve("../frontend/src/App.jsx"), "utf8");
  const publicRoutes = app.slice(app.indexOf('<Route path="/" element={<PublicHome')).matchAll(/<Route path="([^\"]+)"/g);
  const excluded = new Set(["/privacy-policy", "/ref/:code", "/payment/:token", "/payment-plan/:token", "/profile/edit/:token", "/login", "/accept-invitation/:token", "/oauth/consent", "*", "/coaching-programs/:slug", "/people/:slug"]);
  for (const [, route] of publicRoutes) {
    if (!excluded.has(route)) assert(site.sitemap.some((e) => e.path === route), `Public route missing from sitemap: ${route}`);
  }
  for (const page of publicPages) assert.equal(pathSettings(page.path, "Ellie", "Description").indexable, true, `${page.path} must be indexable`);
  for (const route of ["/dashboard", "/ref/example", "/payment/secret", "/profile/edit/secret", "/login"]) assert.equal(pathSettings(route, "Ellie", "").indexable, false);
  const disabled = sitemapEntries({ publicSite: { discoveryCallEnabled: false, sectionVisibility: { testimonials: false } }, applicationEnabled: false });
  for (const route of ["/book-a-call", "/testimonials", "/apply"]) assert(!disabled.some((e) => e.path === route));

  const originalSite = service.site, originalWorkspace = service.workspace, originalFind = WorkspaceConfig.findOne;
  try {
    service.site = async () => site;
    service.workspace = async () => ({ _id: "ws", name: "Ellie" });
    WorkspaceConfig.findOne = () => chain(config);
    const req = { path: "/refund-policy", headers: { host: "elliescoaching.com" } };
    const meta = await workspaceMeta(req);
    assert.equal(meta.indexable, true);
    assert.equal(meta.canonical, "https://elliescoaching.com/refund-policy");
    const html = await renderShell(req);
    assert.match(html, /<meta name="robots" content="index,follow,max-image-preview:large">/);
    assert(!html.includes("noindex"));
    assert.equal((html.match(/name="robots"/g) || []).length, 1);
    let body;
    const response = { type() { return this; }, set() { return this; }, send(value) { body = value; return this; } };
    await publicSeo.stack.find((layer) => layer.route?.path === "/sitemap.xml").route.stack[0].handle(req, response, (error) => { throw error; });
    assert.equal((body.match(/<loc>/g) || []).length, site.sitemap.length);
    for (const entry of site.sitemap) assert(body.includes(`https://elliescoaching.com${entry.path}</loc>`));
    config.publicSite.discoveryCallEnabled = false;
    config.publicApplication.enabled = false;
    for (const route of ["/apply", "/book-a-call"]) assert.equal((await workspaceMeta({ ...req, path: route })).indexable, false);
  } finally { service.site = originalSite; service.workspace = originalWorkspace; WorkspaceConfig.findOne = originalFind; }
  console.log("Public sitemap route coverage, real API titles, XML parity, profile completeness, disabled pages, private exclusions, and rendered refund metadata passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
