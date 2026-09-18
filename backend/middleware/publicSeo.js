const express = require("express");
const publicSiteService = require("../services/publicSiteService");

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
      "/testimonials",
      "/contact",
      "/privacy",
      "/terms",
      "/data-deletion",
      ...(site.publicSite?.discoveryCallEnabled && site.publicSite?.discoveryCallBookingUrl ? ["/book-a-call"] : []),
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

module.exports = { publicSeo: router, publicOrigin, xml };
