const express = require("express");
const publicSiteService = require("../services/publicSiteService");
const WorkspaceConfig = require("../models/WorkspaceConfig");

const router = express.Router();

function publicOrigin(req) {
  const configured = String(process.env.PUBLIC_SITE_ORIGIN || "").trim();
  if (/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(configured)) return configured.replace(/\/$/, "");
  const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .split(":")[0]
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  const safeHost = /^[a-z0-9.-]+$/i.test(forwardedHost) ? forwardedHost : "elliescoaching.com";
  return `https://${safeHost}`;
}

function xml(value) {
  return String(value || "").replace(/[<>&'\"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  })[character]);
}

router.get("/robots.txt", (req, res) => {
  const origin = publicOrigin(req);
  res.type("text/plain").set("Cache-Control", "public, max-age=3600").send([
    "User-agent: *",
    "Allow: /",
    "Disallow: /login",
    "Disallow: /apply",
    "Disallow: /ref/",
    "Disallow: /payment/",
    "Disallow: /payment-plan/",
    "Disallow: /profile/edit/",
    "Disallow: /accept-invitation/",
    "Disallow: /oauth/",
    "Disallow: /api/",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n"));
});

router.get("/sitemap.xml", async (req, res, next) => {
  try {
    const origin = publicOrigin(req);
    const site = await publicSiteService.site(req);
    if (!site.publicSite?.published) return res.status(404).end();
    const paths = [
      "/",
      "/about",
      "/coaching-programs",
      "/faq",
      "/resources",
      "/testimonials",
      "/contact",
      ...(site.publicSite?.discoveryCallEnabled ? ["/book-a-call"] : []),
      ...(site.programs || []).filter((program) => program.slug).map((program) => `/coaching-programs/${encodeURIComponent(program.slug)}`),
      ...(site.team || []).map((profile) => `/people/${encodeURIComponent(profile.slug)}`),
    ];
    const uniquePaths = [...new Set(paths)];
    const urls = uniquePaths.map((path) => `  <url><loc>${xml(`${origin}${path}`)}</loc></url>`).join("\n");
    res
      .type("application/xml")
      .set("Cache-Control", "public, max-age=3600")
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  } catch (error) {
    next(error);
  }
});

// Google's favicon crawler (and every browser tab) checks /favicon.ico at
// the domain root regardless of what <link rel="icon"> tags say, and treats
// a stable same-domain file as the real identity signal — confirmed live:
// elliescoaching.com/favicon.ico 404'd, so Google kept its generic globe
// cached even though the homepage's <link> tags did point at a real image
// (a versioned, third-party Cloudinary URL, which isn't the stable
// same-domain source Google's own favicon guidance asks for). Proxying the
// workspace's actual configured favicon through this same-domain path is
// the fix — resolved per-request by host, same as workspaceMeta() in
// publicHtmlShell.js, since this is a multi-tenant app and different custom
// domains can belong to different workspaces.
async function serveFavicon(req, res) {
  try {
    const ws = await publicSiteService.workspace(req);
    const config = await WorkspaceConfig.findOne({ workspaceId: ws._id, key: "primary" }).select("branding").lean();
    const branding = config?.branding || {};
    const source = String(branding.faviconUrl || branding.publicSiteLogoUrl || branding.logoUrl || "").trim();
    if (!source) return res.status(404).end();
    const upstream = await fetch(source);
    if (!upstream.ok) return res.status(404).end();
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res
      .type(upstream.headers.get("content-type") || "image/png")
      .set("Cache-Control", "public, max-age=86400")
      .send(buffer);
  } catch {
    res.status(404).end();
  }
}
router.get("/favicon.ico", serveFavicon);
router.get("/favicon.png", serveFavicon);

module.exports = { publicSeo: router, publicOrigin, xml };
