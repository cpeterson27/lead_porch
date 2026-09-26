// Readable initial HTML for every visitor, including clients without JavaScript.
// Uses only the same published public projection consumed by the React site.
const escape = (value) => String(value || "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const paragraph = (value) => value ? `<p>${escape(value).replace(/\n/g, "<br>")}</p>` : "";
const list = (title, rows) => rows?.length ? `<section><h2>${escape(title)}</h2><ul>${rows.map((row) => `<li>${escape(row)}</li>`).join("")}</ul></section>` : "";
function link(url, text) {
  const value = String(url || "");
  if (!/^(?:\/(?!\/)|https?:\/\/|mailto:|tel:)/i.test(value)) return "";
  return `<a href="${escape(value)}">${escape(text)}</a>`;
}
function programDetails(program) {
  return paragraph(program.summary) + paragraph(program.description) + (program.audience ? `<h2>Who it is for</h2>${paragraph(program.audience)}` : "") + list("What to expect", program.highlights) + list("What you will learn", program.outcomes) + list("Curriculum", program.curriculum);
}
function renderPublicContent(pathname, site) {
  if (!site?.publicSite?.published) return "";
  const path = pathname.replace(/\/$/, "") || "/";
  const p = site.publicSite, name = site.branding?.publicSiteName || site.workspace?.name || "Coaching";
  const programs = site.programs || [];
  const programList = () => programs.map((program) => `<section><h2>${link(`/coaching-programs/${encodeURIComponent(program.slug)}`, program.title)}</h2>${paragraph(program.summary)}${list("What to expect", program.highlights)}</section>`).join("");
  let title, body;
  if (path === "/") {
    title = name;
    body = (p.sectionVisibility?.heroCopy !== false ? paragraph(p.headline) + paragraph(p.subheadline) : "") + paragraph(p.introBody) + (p.sectionVisibility?.programs !== false ? programList() : "");
  } else if (path === "/about") {
    title = p.seoPages?.aboutHeading || `About ${name}`;
    body = paragraph(p.aboutBody) + list("Why clients work with us", p.aboutHighlights);
  } else if (path === "/coaching-programs") {
    title = p.seoPages?.programsHeading || "Coaching programs"; body = programList();
  } else if (path.startsWith("/coaching-programs/")) {
    const program = programs.find((row) => `/coaching-programs/${encodeURIComponent(row.slug)}` === path);
    if (!program) return "";
    title = program.title; body = programDetails(program) + link(program.cta?.url || `/apply?program=${encodeURIComponent(program.slug)}`, program.cta?.label || "Apply to join") + paragraph(program.cta?.supportingText);
  } else if (path === "/faq") {
    title = p.seoPages?.faqHeading || "Frequently asked questions";
    body = (p.faqItems || []).map((item) => `<section><h2>${escape(item.question)}</h2>${paragraph(item.answer)}</section>`).join("");
  } else if (path === "/resources") {
    title = p.seoPages?.resourcesHeading || "Investor resources";
    body = paragraph(p.seoPages?.resourcesCopy) + programList();
  } else if (path === "/sitemap") {
    title = "Website sitemap";
    body = ["Programs", "Explore", "People", "Connect", "Policies"].map((group) => {
      const entries = (site.sitemap || []).filter((entry) => entry.group === group);
      return entries.length ? `<section><h2>${group}</h2><ul>${entries.map((entry) => `<li>${link(entry.path, entry.label)}</li>`).join("")}</ul></section>` : "";
    }).join("");
  } else if (path === "/contact") {
    title = `Contact ${name}`; body = paragraph(p.contactCopy) + paragraph(p.contactIntro) + (p.contactEmail ? link(`mailto:${p.contactEmail}`, p.contactEmail) : "") + (p.contactPhone ? paragraph(p.contactPhone) : "");
  } else if (path === "/book-a-call" && p.discoveryCallEnabled) {
    title = p.discoveryCallHeading || "Book a discovery call"; body = paragraph(p.discoveryCallCopy) + paragraph("Enable JavaScript to see availability and book a discovery call.") + link("/contact", "Contact the team");
  } else if (path === "/testimonials" && p.sectionVisibility?.testimonials !== false) {
    title = p.seoPages?.testimonialsHeading || "Student perspectives"; body = (site.featuredTestimonials || []).map((row) => `<section><h2>${escape(row.headline || row.displayName)}</h2>${paragraph(row.body)}${paragraph(row.displayName)}</section>`).join("");
  } else { return ""; }
  return `<div class="public-document"><header>${link("/", name)}<nav aria-label="Main navigation">${link("/about", "About")}${link("/coaching-programs", "Coaching programs")}${link("/faq", "FAQ")}${link("/contact", "Contact")}</nav></header><main id="main-content"><h1>${escape(title)}</h1>${body}</main><footer>${link("/sitemap", "Website sitemap")}${link("/privacy", "Privacy policy")}</footer></div>`;
}
module.exports = { renderPublicContent, escape, programDetails };
