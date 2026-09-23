const fs = require("fs");
const path = require("path");
const publicSiteService = require("../services/publicSiteService");
const WorkspaceConfig = require("../models/WorkspaceConfig");
const PublicProfile = require("../models/PublicProfile");
const CoachingProgram = require("../models/CoachingProgram");
const { runWithWorkspace } = require("../tenancy/workspaceContext");
const { publicOrigin } = require("./publicSeo");

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
  const text = String(value || "").trim().replace(/\bAquire\b/gi, "Acquire");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// The Vite-built shell ships a generic <title> and no Open Graph tags. Strip
// them before injecting workspace-specific ones so repeated requests never
// accumulate duplicates.
function stripGenericMeta(html) {
  return html
    .replace(/[ \t]*<meta\s+name="description"[^>]*>\n?/gi, "")
    .replace(/[ \t]*<meta\s+name="robots"[^>]*>\n?/gi, "")
    .replace(/[ \t]*<meta\s+(?:name|property)="(?:og|twitter):[a-z]+"[^>]*>\n?/gi, "")
    .replace(/[ \t]*<link\s+rel="canonical"[^>]*>\n?/gi, "")
    .replace(/[ \t]*<script\s+type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>\n?/gi, "");
}

function absoluteUrl(value, origin) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, origin).toString();
  } catch {
    return "";
  }
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function pathSettings(pathname, siteName, defaultDescription) {
  const path = pathname !== "/" ? pathname.replace(/\/$/, "") : "/";
  const fixed = {
    "/": {
      title: `${siteName} | Multifamily Real Estate Coaching`,
      description: defaultDescription,
      indexable: true,
    },
    "/testimonials": {
      title: `Student Results & Testimonials | ${siteName}`,
      description: "Read real student experiences from multifamily real estate coaching programs focused on practical execution, capital raising, and acquisitions.",
      indexable: true,
    },
    "/about": { title: `About Ellie Baxter | ${siteName}`, description: "Meet Ellie Baxter and learn about the practical, accountability-focused approach behind Ellie's multifamily real estate coaching programs.", indexable: true },
    "/coaching-programs": { title: `Multifamily Real Estate Coaching Programs | ${siteName}`, description: "Compare multifamily real estate coaching programs covering acquisitions, underwriting, capital raising, asset management, and investor development.", indexable: true },
    "/faq": { title: `Multifamily Coaching FAQ | ${siteName}`, description: "Answers about Ellie's online multifamily real estate coaching programs, applications, discovery calls, and educational topics.", indexable: true },
    "/resources": { title: `Multifamily Investor Resources | ${siteName}`, description: "Explore multifamily real estate coaching programs, student experiences, and practical resources from Ellie's Coaching.", indexable: true },
    "/contact": {
      title: `Contact ${siteName}`,
      description: "Contact Ellie's Coaching to ask about multifamily real estate coaching programs, applications, and upcoming training.",
      indexable: true,
    },
    "/privacy": { title: `Privacy Policy | ${siteName}`, description: `Privacy policy for ${siteName}.`, indexable: false },
    "/privacy-policy": { title: `Privacy Policy | ${siteName}`, description: `Privacy policy for ${siteName}.`, indexable: false, canonicalPath: "/privacy" },
    "/terms": { title: `Terms of Service | ${siteName}`, description: `Terms of service for ${siteName}.`, indexable: false },
    "/data-deletion": { title: `Data Deletion | ${siteName}`, description: `Data deletion instructions for ${siteName}.`, indexable: false },
    "/apply": { title: `Apply to a Coaching Program | ${siteName}`, description: `Apply to a ${siteName} coaching program.`, indexable: false },
    "/book-a-call": { title: `Book a Discovery Call | ${siteName}`, description: `Book a free discovery call with ${siteName}.`, indexable: true },
  };
  return { path, ...(fixed[path] || { title: siteName, description: defaultDescription, indexable: false }) };
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
    .select("branding publicSite legalBusinessName websiteUrl addressLine1 addressLine2 addressCity addressRegion addressPostalCode addressCountry")
    .lean();
  const branding = config?.branding || {};
  const publicSite = config?.publicSite || {};
  const siteName = branding.publicSiteName || ws.name || FALLBACK_TITLE;
  const origin = publicOrigin(req);
  const defaults = pathSettings(
    req.path,
    siteName,
    truncate(publicSite.subheadline || publicSite.introBody || "", 160),
  );
  // A workspace owner's explicit metaTitle/metaDescription always wins on
  // the homepage — pathSettings' "/" title is otherwise a hardcoded
  // template independent of any on-page copy, which is confusing to edit
  // around (the visible "Headline" field never touches this).
  if (defaults.path === "/") {
    if (publicSite.metaTitle) defaults.title = publicSite.metaTitle;
    if (publicSite.metaDescription) defaults.description = publicSite.metaDescription;
  }
  let profile = null;
  let program = null;
  const profileSlug = defaults.path.match(/^\/people\/([a-z0-9-]+)$/i)?.[1];
  if (profileSlug) {
    profile = await runWithWorkspace(ws._id, () => PublicProfile.findOne({
      workspaceId: ws._id,
      slug: profileSlug.toLowerCase(),
      status: "published",
    }).lean());
    if (profile) {
      defaults.title = `${profile.displayName}${profile.publicTitle ? `, ${profile.publicTitle}` : ""} | ${siteName}`;
      defaults.description = truncate(profile.headline || profile.bio, 160);
      defaults.indexable = true;
    }
  }
  const programSlug = defaults.path.match(/^\/coaching-programs\/([a-z0-9-]+)$/i)?.[1];
  if (programSlug) {
    program = await runWithWorkspace(ws._id, () => CoachingProgram.findOne({ workspaceId: ws._id, status: "active", "publicPresentation.status": "published", "publicPresentation.slug": programSlug.toLowerCase() }).lean());
    if (program) {
      defaults.title = `${program.publicPresentation.title || program.name} | ${siteName}`;
      defaults.description = truncate(program.publicPresentation.summary || program.publicPresentation.description, 160);
      defaults.indexable = true;
    }
  }
  const canonicalPath = defaults.canonicalPath || defaults.path;
  const canonical = `${origin}${canonicalPath}`;
  const image = absoluteUrl(profile?.avatarUrl || publicSite.heroMediaUrl || branding.publicSiteLogoUrl || branding.logoUrl, origin);
  // Deliberately never the profile avatar or hero media used for `image`
  // above — a favicon is a persistent per-tab/search-result identity, so it
  // should always be the workspace's actual logo, the same on every page.
  // branding.faviconUrl (a dedicated upload, distinct from the site logo)
  // is preferred when set. Previously this only ever reached the page via
  // client-side JS (WorkspaceThemeContext swapping a <link> tag in after
  // React hydrates) — invisible to Googlebot's favicon crawler, which reads
  // the server-rendered <head> directly. Rendering it here server-side is
  // part of the fix; the other part (below) is that the tags now point at
  // this same domain's own /favicon.ico and /favicon.png (proxied by
  // publicSeo.js) instead of a versioned, third-party Cloudinary URL —
  // confirmed live: elliescoaching.com/favicon.ico 404'd, and Google's own
  // favicon guidance asks for one stable same-domain file, which a raw
  // Cloudinary link never was. hasFavicon only needs to know whether a
  // source image is configured at all; the URL itself is now always the
  // same-domain path.
  const hasFavicon = Boolean(branding.faviconUrl || branding.publicSiteLogoUrl || branding.logoUrl);
  const favicon = hasFavicon ? `${origin}/favicon.png` : "";
  const faviconIco = hasFavicon ? `${origin}/favicon.ico` : "";
  const organizationId = `${origin}/#organization`;
  const organization = {
    "@type": "Organization",
    "@id": organizationId,
    name: config?.legalBusinessName || siteName,
    url: origin,
    ...(image ? { logo: image, image } : {}),
    ...(publicSite.contactEmail ? { email: publicSite.contactEmail } : {}),
    ...(publicSite.contactPhone ? { telephone: publicSite.contactPhone } : {}),
    ...(Array.isArray(publicSite.socialLinks) && publicSite.socialLinks.length
      ? { sameAs: publicSite.socialLinks.map((item) => item.url).filter(Boolean) }
      : {}),
  };
  const schemas = defaults.path === "/"
    ? [organization, { "@type": "WebSite", "@id": `${origin}/#website`, url: origin, name: siteName, publisher: { "@id": organizationId } }]
    : profile
      ? [{
          "@type": "Person",
          "@id": `${canonical}#person`,
          name: profile.displayName,
          url: canonical,
          ...(profile.publicTitle ? { jobTitle: profile.publicTitle } : {}),
          ...(profile.headline || profile.bio ? { description: truncate(profile.headline || profile.bio, 300) } : {}),
          ...(image ? { image } : {}),
          ...(profile.publicLocation ? { homeLocation: { "@type": "Place", name: profile.publicLocation } } : {}),
          ...(profile.socialLinks?.length ? { sameAs: profile.socialLinks.map((item) => item.url).filter(Boolean) } : {}),
          worksFor: { "@id": organizationId },
        }]
      : program
        ? [{ "@type": "Course", "@id": `${canonical}#course`, name: program.publicPresentation.title || program.name, description: truncate(program.publicPresentation.description || program.publicPresentation.summary, 500), url: canonical, provider: { "@id": organizationId }, ...(program.publicPresentation.audience ? { audience: { "@type": "Audience", audienceType: program.publicPresentation.audience } } : {}) }, { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: origin }, { "@type": "ListItem", position: 2, name: "Coaching Programs", item: `${origin}/coaching-programs` }, { "@type": "ListItem", position: 3, name: program.publicPresentation.title || program.name, item: canonical }] }]
        : defaults.path === "/faq"
          ? [{ "@type": "FAQPage", mainEntity: (publicSite.faqItems?.length ? publicSite.faqItems.map((item) => [item.question, item.answer]) : [
              ["Who are the coaching programs for?", "Aspiring and active multifamily real estate investors who want structured education, practical guidance, and accountability."],
              ["Is coaching available online?", "Yes. Coaching is primarily delivered virtually. Select programs may also include in-person educational experiences when offered."],
              ["Does applying guarantee acceptance?", "No. An application starts a conversation and does not guarantee enrollment in a program."],
            ]).map(([name, text]) => ({ "@type": "Question", name, acceptedAnswer: { "@type": "Answer", text } })) }]
          : [];
  return {
    title: defaults.title,
    description: truncate(defaults.description, 160),
    image,
    favicon,
    faviconIco,
    canonical,
    indexable: defaults.indexable,
    schemas,
  };
}

async function renderShell(req) {
  const baseHtml = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  const meta = await workspaceMeta(req).catch(() => ({
    title: FALLBACK_TITLE,
    description: "",
    image: "",
    favicon: "",
    faviconIco: "",
    canonical: `${publicOrigin(req)}${req.path || "/"}`,
    indexable: false,
    schemas: [],
  }));
  const safeTitle = escapeHtml(meta.title);
  const safeDescription = escapeHtml(meta.description);
  const safeImage = escapeHtml(meta.image);
  const safeFavicon = escapeHtml(meta.favicon);
  const safeCanonical = escapeHtml(meta.canonical);
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
    `<meta property="og:url" content="${safeCanonical}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${safeTitle}">`,
    meta.description ? `<meta name="twitter:description" content="${safeDescription}">` : "",
    meta.image ? `<meta name="twitter:image" content="${safeImage}">` : "",
    `<meta name="robots" content="${meta.indexable ? "index,follow,max-image-preview:large" : "noindex,follow"}">`,
    `<link rel="canonical" href="${safeCanonical}">`,
    // Every favicon tag below consistently points at this same domain's own
    // stable /favicon.ico and /favicon.png (proxied by publicSeo.js from
    // whatever image is actually configured) — not a versioned third-party
    // Cloudinary URL, and not a different URL per declared size. Browsers
    // and Google's favicon crawler don't need genuinely different images
    // per size here; they need one consistent, reliably-fetchable source.
    meta.faviconIco ? `<link rel="icon" href="${escapeHtml(meta.faviconIco)}">` : "",
    ...(meta.favicon
      ? [16, 32, 48, 192, 512].map((size) => `<link rel="icon" sizes="${size}x${size}" type="image/png" href="${safeFavicon}">`)
      : []),
    meta.favicon ? `<link rel="apple-touch-icon" sizes="180x180" href="${safeFavicon}">` : "",
    ...(meta.schemas || []).map((schema) => `<script type="application/ld+json">${safeJson({ "@context": "https://schema.org", ...schema })}</script>`),
  ]
    .filter(Boolean)
    .join("\n    ");
  let html = stripGenericMeta(baseHtml)
    .replace(/<title>.*?<\/title>/i, `<title>${safeTitle}</title>`)
    .replace("</head>", `    ${tags}\n  </head>`);
  const tagManagerId = String(process.env.GOOGLE_TAG_MANAGER_ID || "").trim();
  if (/^GTM-[A-Z0-9]+$/i.test(tagManagerId)) {
    const headScript = `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${tagManagerId}');</script>`;
    const bodyFrame = `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${tagManagerId}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`;
    html = html.replace("</head>", `    ${headScript}\n  </head>`).replace("<body>", `<body>\n    ${bodyFrame}`);
  }
  return html;
}

// Only intercepts document/navigation requests (GET, no file extension, not
// under /api). Static assets and API responses are left completely alone;
// if the built frontend isn't present on disk (e.g. local dev without a
// frontend build), this falls through via next() instead of erroring.
function publicHtmlShell(req, res, next) {
  if (!["GET", "HEAD"].includes(req.method) || req.path.startsWith("/api") || ASSET_PATH.test(req.path))
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

module.exports = { publicHtmlShell, renderShell, workspaceMeta, pathSettings, safeJson };
