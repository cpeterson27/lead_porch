import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url)),
  source = (file) => fs.readFileSync(path.join(root, "src", file), "utf8");
const app = source("App.jsx"),
  site = source("pages/PublicSite.jsx"),
  legal = source("pages/PublicLegal.jsx"),
  css = source("pages/PublicSite.css"),
  editors = source("pages/ProfileEditors.jsx"),
  admin = source("components/PublicSiteAdmin.jsx"),
  programManager = source("components/ProgramWebsiteSettings.jsx"),
  theme = source("context/WorkspaceThemeContext.jsx");
for (const route of [
  'path="/"',
  'path="/about"',
  'path="/coaching-programs"',
  'path="/coaching-programs/:slug"',
  'path="/testimonials"',
  'path="/contact"',
  'path="/people/:slug"',
  'path="/privacy"',
  'path="/privacy-policy"',
  'path="/terms"',
  'path="/data-deletion"',
  'path="/login"',
  'path="/apply"',
  'path="/ref/:code"',
  'path="/profile/edit/:token"',
])
  assert(app.includes(route), `missing ${route}`);
for (const value of [
  "Effective date:",
  "AI-assisted analysis",
  "does not sell personal information",
  'to="/data-deletion"',
])
  assert(legal.includes(value), `privacy policy missing ${value}`);
assert(
  app.indexOf('path="/privacy-policy"') <
    app.indexOf('path="*" element={<ProtectedApp'),
  "privacy policy must be declared before the authenticated catch-all",
);
assert(
  app.indexOf('path="/data-deletion"') <
    app.indexOf('path="*" element={<ProtectedApp'),
  "data deletion must be declared before the authenticated catch-all",
);
assert(app.includes("<WorkspaceThemeProvider><AuthProvider>"));
for (const value of [
  "featuredTestimonials",
  "upcomingEvent",
  "ProgramCards",
  "Testimonials",
  "public-login",
  "HeroVideoTile",
  "Student perspectives",
  "journeyTitle",
  "communityTitle",
  "team-section",
])
  assert(site.includes(value), `public site missing ${value}`);
for (const value of ["prefers-reduced-motion", "--workspace-accent"])
  assert(css.includes(value), `public CSS missing ${value}`);
for (const width of [1024, 850, 520])
  assert(new RegExp(`@media\\s*\\(max-width:\\s*${width}px\\)`).test(css), `public CSS missing ${width}px breakpoint`);
assert(/overflow-x:\s*hidden/.test(css));
for (const value of [
  "Only the fields on this page can become public",
  "updateStudentProfile",
  "updateMyPublicProfile",
  "Private draft",
  "Published",
])
  assert(editors.includes(value));
for (const value of [
  "introVideoUrl",
  "trustMetrics",
  "sectionVisibility",
  "publicTitle",
  "sortOrder",
  "Approve",
  "Reject",
  "Feature",
  "Create private edit link",
  "All branding changes saved successfully.",
])
  assert(admin.includes(value), `admin missing ${value}`);
assert(theme.includes('setProperty("--workspace-primary"'));
assert(theme.includes("fetchWorkspaceConfig") && theme.includes("publicRoute"));
for (const size of [16, 32, 48, 180, 192, 512])
  assert(theme.includes(String(size)), `favicon handling missing ${size}px size`);
assert(theme.includes("apple-touch-icon") && theme.includes("app?.faviconUrl"));
assert(site.includes("ApplicationButton") && site.includes("embed=1"));
assert(site.includes("aboutImageUrl") && site.includes("public-meet-photo"));
assert(css.includes("public-rise") && css.includes("community-section__word"));
assert(css.includes("public-accelerator-row") && /repeat\(3,\s*1fr\)/.test(css));
assert(css.includes("public-program-row") && /repeat\(4,\s*1fr\)/.test(css));
assert(site.includes("Number(program.price?.amount || 0) >= 10000"));
assert(site.includes("popularId === String(program.id)"));
for (const field of ["tierLabel", "comparisonPriceLabel", "comparisonDurationLabel", "coachingFormat"]) assert(site.includes(field), `public comparison table missing ${field}`);
assert(admin.includes("Website section"));
assert(admin.includes("High Performance Accelerators"));
assert(admin.includes("Intensive Programs"));
assert(admin.includes("Mark as Most Popular"));
for (const value of [
  "Arrange your programs",
  'draggable={!saving}',
  "saveOrder",
  "Save program order",
  "orderDirty",
  "High-value accelerators stay on top",
  "Move ${program.name} earlier",
  "Move ${program.name} later",
  "High Performance Accelerators",
  "Intensive 6-Week Programs",
  "Show “Most Popular”",
])
  assert(programManager.includes(value), `program manager missing ${value}`);
assert(site.includes('const [expanded, setExpanded] = useState("")'));
assert(/current === String\(program\.id\)\s*\? ""\s*:\s*String\(program\.id\)/.test(site));
assert(site.includes("public-program-apply"));
assert(site.includes("program.description || program.summary"));
assert(site.includes("program.price?.amount != null"));
assert(site.includes("data-public-theme={theme}"));
assert(site.includes("allowThemeToggle") && site.includes("public-theme-toggle"));
assert(css.includes('[data-public-theme="light"]'));
assert(css.includes('[data-public-theme="dark"]'));
assert(css.includes(".program-application-modal"));
assert(css.includes("position: fixed"));
assert(css.includes("public-accelerator-card.is-featured"));
assert(css.includes("public-hero-btn-primary") && css.includes("background: var(--public-accent)"));
assert(css.includes("public-accelerator-row.has-expanded"));
assert(!site.includes("<p>{program.summary}</p>"));
assert(!site.includes("Skip to content"));
console.log(
  "Public routes, privacy-policy/data-deletion public routing, legal content, responsive breakpoints, accessibility motion controls, workspace tokens and moderation UI contracts passed.",
);
assert(fs.existsSync(path.join(root, "public", "elliescoachinglogo-dark.png")));
assert(
  fs.existsSync(path.join(root, "public", "elliescoachinglogo-white.png")),
);
assert(
  site
    .slice(site.indexOf("function Brand"), site.indexOf("function SmartLink"))
    .includes("publicSiteLogoUrl"),
);
