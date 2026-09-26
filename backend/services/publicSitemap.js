// One public-page inventory for the HTML directory and Google's XML sitemap.
// Aliases and token-bearing/private routes intentionally have no entries.
const publicPages = [
  { path: "/", label: "Home", group: "Explore" },
  { path: "/about", label: "About", group: "Explore" },
  { path: "/coaching-programs", label: "Coaching programs", group: "Explore" },
  { path: "/testimonials", label: "Testimonials", group: "Explore", feature: "testimonials" },
  { path: "/resources", label: "Resources", group: "Explore" },
  { path: "/free-guide", label: "Free guide", group: "Explore" },
  { path: "/contact", label: "Contact", group: "Connect" },
  { path: "/book-a-call", label: "Book a discovery call", group: "Connect", feature: "discovery" },
  { path: "/faq", label: "Frequently asked questions", group: "Connect" },
  { path: "/apply", label: "Apply to join", group: "Connect", feature: "application" },
  { path: "/privacy", label: "Privacy policy", group: "Policies" },
  { path: "/terms", label: "Terms of service", group: "Policies" },
  { path: "/refund-policy", label: "Refund and cancellation policy", group: "Policies" },
  { path: "/data-deletion", label: "Data deletion", group: "Policies" },
  { path: "/sitemap", label: "Website sitemap", group: "Explore" },
];
function pageEnabled(page, site) {
  if (page.feature === "discovery") return Boolean(site.publicSite?.discoveryCallEnabled);
  if (page.feature === "application") return site.applicationEnabled !== false;
  if (page.feature === "testimonials") return site.publicSite?.sectionVisibility?.testimonials !== false;
  return true;
}
function sitemapEntries(site, profiles = site.team || []) {
  const entries = publicPages.filter((page) => pageEnabled(page, site)).map(({ path, label, group }) => ({ path, label, group }));
  for (const program of site.programs || []) {
    if (!program.slug) continue;
    entries.push({ path: `/coaching-programs/${encodeURIComponent(program.slug)}`, label: String(program.title || program.slug.replace(/-/g, " ")).trim(), group: "Programs" });
  }
  for (const profile of profiles) {
    if (!profile.slug) continue;
    entries.push({ path: `/people/${encodeURIComponent(profile.slug)}`, label: String(profile.displayName || profile.slug.replace(/-/g, " ")).trim(), group: "People" });
  }
  return [...new Map(entries.map((entry) => [entry.path, entry])).values()];
}
module.exports = { publicPages, pageEnabled, sitemapEntries };
