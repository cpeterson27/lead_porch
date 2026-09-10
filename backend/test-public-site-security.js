const assert = require("node:assert/strict");
const fs = require("node:fs");
const service = require("./services/publicSiteService");
const PublicProfile = require("./models/PublicProfile");
const Testimonial = require("./models/Testimonial");
const ellie = service.defaults({ slug: "ellie", name: "Ellie" }),
  other = service.defaults({ slug: "another", name: "Another Company" });
assert.equal(ellie.branding.primaryColor, "#0a0a0a");
assert.equal(ellie.branding.accentColor, "#8bc53f");
assert.equal(ellie.publicSite.published, true);
assert.notEqual(other.branding.primaryColor, ellie.branding.primaryColor);
assert.equal(other.publicSite.published, false);
assert.equal(ellie.publicSite.allowThemeToggle, false);
assert.equal(
  service.sanitizedConfig(
    { slug: "ellie", name: "Ellie" },
    { publicSite: { allowThemeToggle: true } },
  ).publicSite.allowThemeToggle,
  true,
);
assert.equal(
  ellie.publicSite.introVideoTitle,
  "Start with the people behind the program.",
);
assert.equal(other.publicSite.introVideoTitle, undefined);
assert.deepEqual(
  service.cleanMetrics([
    { value: "12", label: "Programs" },
    { value: "", label: "Hidden" },
  ]),
  [{ value: "12", label: "Programs" }],
);
assert.equal(service.safeColor("red", "#000000"), "#000000");
assert.equal(service.safeUrl("javascript:alert(1)"), "");
assert.equal(service.safeUrl("/apply", { relative: true }), "/apply");
const profile = {
  slug: "sherry",
  ownerType: "coach",
  displayName: "Sherry",
  publicTitle: "Lead Coach",
  headline: "Investor",
  bio: "Public bio",
  avatarUrl: "https://example.com/a.jpg",
  publicLocation: "Las Vegas",
  specialties: ["Multifamily"],
  goals: ["Grow"],
  experience: "Public experience",
  socialLinks: [{ label: "LinkedIn", url: "https://linkedin.com/in/test" }],
  websiteUrl: "https://example.com",
  cta: { label: "Connect", url: "https://example.com" },
  layout: "executive",
  accentToken: "brand",
  sectionOrder: ["about"],
  featured: true,
  sortOrder: 1,
  email: "private@example.com",
  phone: "+15555555555",
  notes: "private",
  payments: [100],
  coachingHistory: [{}],
};
const projected = service.profileProjection(profile);
for (const key of [
  "email",
  "phone",
  "notes",
  "payments",
  "coachingHistory",
  "contactId",
  "userId",
  "workspaceId",
])
  assert.equal(projected[key], undefined, `${key} leaked`);
assert.equal(projected.displayName, "Sherry");
assert.equal(projected.publicTitle, "Lead Coach");
assert.equal(projected.featured, true);
assert.equal(PublicProfile.schema.path("status").defaultValue, "draft");
assert.equal(Testimonial.schema.path("status").defaultValue, "pending");
const publicRoute = fs.readFileSync(
    require.resolve("./routes/publicSite"),
    "utf8",
  ),
  management = fs.readFileSync(
    require.resolve("./routes/publicManagement"),
    "utf8",
  ),
  server = fs.readFileSync(require.resolve("./server"), "utf8");
assert(publicRoute.includes('"publicPresentation.status": "published"'));
assert(publicRoute.includes('status: "approved"'));
const siteService = fs.readFileSync(
  require.resolve("./services/publicSiteService"),
  "utf8",
);
assert(/status:\s*"approved",\s*featured:\s*true/.test(siteService));
assert(publicRoute.includes('status: "published"'));
assert(publicRoute.includes("profileProjection"));
assert(/userId:\s*req\.auth\.user\._id,\s*status:\s*"active"/.test(management));
assert(/workspaceId:\s*req\.auth\.workspaceId,\s*userId:\s*req\.body\.userId,\s*status:\s*"active"/.test(management));
assert(/ownerType:\s*"student"/.test(management));
assert(management.includes("issueToken"));
assert(server.includes('req.path.startsWith("/public/")'));
assert(server.includes('app.use("/api/public-management"'));
console.log(
  "Public branding isolation, publication filters, testimonial moderation, profile ownership/token boundaries and privacy projection checks passed.",
);
