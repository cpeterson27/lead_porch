const fs = require("fs");
const path = require("path");
const publicSiteService = require("../services/publicSiteService");
const WorkspaceConfig = require("../models/WorkspaceConfig");

const INDEX_HTML_PATH = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "dist",
  "index.html",
);
const FALLBACK_TITLE = "Lead Porch — The intelligent growth workspace";
const ASSET_PATH = /\.[a-z0-9]+$/i;

function escapeHtml(value) {
  return String(value || "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
}

function truncate(value, max) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// The Vite-built shell ships a generic <title> and no Open Graph tags. Strip
// them before injecting workspace-specific ones so repeated requests never
// accumulate duplicates.
function stripGenericMeta(html) {
  return html
    .replace(/[ \t]*<meta\s+name="description"[^>]*>\n?/gi, "")
    .replace(/[ \t]*<meta\s+property="og:[a-z]+"[^>]*>\n?/gi, "");
}

// Reuses the same domain-to-workspace resolution the public API already
// uses (publicSiteService.workspace), rather than re-deriving it from the
// Host header here. Only reads the two WorkspaceConfig fields meta tags
// need, instead of the full site() aggregation (programs/testimonials/
// events/etc.), since none of that is relevant to a <head> tag.
async function workspaceMeta(req) {
  const ws = await publicSiteService.workspace(req);
  const config = await WorkspaceConfig.findOne({
    workspaceId: ws._id,
    key: "primary",
  })
    .select("branding publicSite")
    .lean();
  const branding = config?.branding || {};
  const publicSite = config?.publicSite || {};
  return {
    title: branding.publicSiteName || ws.name || FALLBACK_TITLE,
    description: truncate(
      publicSite.subheadline || publicSite.introBody || "",
      200,
    ),
    image:
      publicSite.heroMediaUrl ||
      branding.publicSiteLogoUrl ||
      branding.logoUrl ||
      "",
  };
}

async function renderShell(req) {
  const baseHtml = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  const meta = await workspaceMeta(req).catch(() => ({
    title: FALLBACK_TITLE,
    description: "",
    image: "",
  }));
  const safeTitle = escapeHtml(meta.title);
  const safeDescription = escapeHtml(meta.description);
  const safeImage = escapeHtml(meta.image);
  const tags = [
    meta.description
      ? `<meta name="description" content="${safeDescription}">`
      : "",
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${safeTitle}">`,
    meta.description
      ? `<meta property="og:description" content="${safeDescription}">`
      : "",
    meta.image ? `<meta property="og:image" content="${safeImage}">` : "",
  ]
    .filter(Boolean)
    .join("\n    ");
  return stripGenericMeta(baseHtml)
    .replace(/<title>.*?<\/title>/i, `<title>${safeTitle}</title>`)
    .replace("</head>", `    ${tags}\n  </head>`);
}

// Only intercepts document/navigation requests (GET, no file extension, not
// under /api). Static assets and API responses are left completely alone;
// if the built frontend isn't present on disk (e.g. local dev without a
// frontend build), this falls through via next() instead of erroring.
function publicHtmlShell(req, res, next) {
  if (req.method !== "GET" || req.path.startsWith("/api") || ASSET_PATH.test(req.path))
    return next();
  if (!fs.existsSync(INDEX_HTML_PATH)) return next();
  renderShell(req)
    .then((html) => {
      res.set("Content-Type", "text/html; charset=utf-8");
      res.set("Cache-Control", "no-store");
      res.send(html);
    })
    .catch(next);
}

module.exports = { publicHtmlShell, renderShell, workspaceMeta };
