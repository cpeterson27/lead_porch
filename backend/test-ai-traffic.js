// Uses only an explicitly selected, isolated localhost MongoDB instance.
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const { normalizeAttribution, aiSource, publicPath } = require("./services/siteAttribution");
const { recordEvent, report } = require("./services/siteTrafficService");
const SiteTrafficEvent = require("./models/SiteTrafficEvent");
const { runWithWorkspace } = require("./tenancy/workspaceContext");
const { renderPublicContent } = require("./services/publicPageContent");
const { publicPages, sitemapEntries } = require("./services/publicSitemap");

for (const [value, source] of [["chatgpt.com", "chatgpt"], ["CHATGPT", "chatgpt"], ["https://chat.openai.com/", "chatgpt"], ["www.perplexity.ai", "perplexity"], ["claude.ai", "claude"], ["gemini.google.com", "gemini"], ["copilot.microsoft.com", "copilot"], ["grok.com", "grok"]]) assert.equal(aiSource(value), source);
for (const value of ["google.com", "bing.com", "chatgpt.com.evil.test", "notchatgpt.com", "https://chatgpt.com@evil.test", "", "openai.com"]) assert.equal(aiSource(value), "");
assert.equal(publicPath("/apply?email=private@example.com"), "/apply");
assert.equal(publicPath("/payment/secret"), "");
assert.equal(publicPath("/profile/edit/secret"), "");
assert.equal(publicPath("/ref/private-code"), "/apply");
assert.equal(publicPath("/coaching-programs/" + "a".repeat(500)), "");
assert.equal(normalizeAttribution({ sessionId: ["a".repeat(20)], landingPath: "/" }), null);
const session = crypto.randomUUID();
const tagged = { sessionId: session, landingPath: "/coaching-programs?utm_source=chatgpt.com", utmSource: "chatgpt.com", referrerHost: "https://example.com/private?email=x" };
const normalized = normalizeAttribution(tagged);
assert.equal(normalized.source, "chatgpt"); assert.equal(normalized.landingPath, "/coaching-programs"); assert.equal(normalized.referrerHost, "example.com");
assert.equal(normalizeAttribution({ ...tagged, utmSource: "newsletter", referrerHost: "chatgpt.com" }).source, "other");
assert.equal(normalizeAttribution({ ...tagged, utmSource: "", referrerHost: "perplexity.ai" }).source, "perplexity");

const publicSite = { publicSite: { published: true }, branding: { publicSiteName: "Example & Coaching" }, programs: [{ slug: "safe-course", title: "Public course", summary: "Public summary", description: '<script>alert("x")</script>', outcomes: ["Outcome"], curriculum: ["Lesson"], internalSummary: "PRIVATE INTERNAL NOTES" }] };
publicSite.sitemap = sitemapEntries(publicSite);
const html = renderPublicContent("/coaching-programs/safe-course", publicSite);
assert(html.includes("Public course") && html.includes("Public summary") && html.includes("Lesson"));
assert(html.includes("&lt;script&gt;") && !html.includes("<script>"));
assert(!html.includes("PRIVATE INTERNAL NOTES"));
assert.equal(renderPublicContent("/coaching-programs/draft", publicSite), "");
assert.equal(renderPublicContent("/", { ...publicSite, publicSite: { published: false } }), "");
assert.equal(renderPublicContent("/dashboard", publicSite), "");
console.log("AI attribution classification, private URL exclusions, source precedence, and crawler HTML safety passed.");

async function databaseTests() {
  const uri = process.env.AI_TRAFFIC_TEST_MONGO_URI;
  if (!uri) { console.log("Database integration checks skipped; set AI_TRAFFIC_TEST_MONGO_URI to the isolated localhost test instance."); return; }
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:27029\/?$/, "Only the dedicated localhost test server is permitted");
  const dbName = `test_ai_traffic_${process.pid}_${Date.now()}`;
  await mongoose.connect(uri, { dbName });
  try {
    await SiteTrafficEvent.init();
    const ws = new mongoose.Types.ObjectId(), other = new mongoose.Types.ObjectId();
    const event = (kind, id, attribution = tagged, workspaceId = ws) => recordEvent({ workspaceId, eventId: id, kind, pagePath: "/apply", attribution });
    const pageId = crypto.randomUUID();
    await Promise.all(Array.from({ length: 5 }, () => event("page_view", pageId)));
    await event("page_view", crypto.randomUUID());
    await event("application_submitted", `application:${new mongoose.Types.ObjectId()}`);
    const second = { sessionId: crypto.randomUUID(), landingPath: "/", referrerHost: "perplexity.ai" };
    await event("page_view", crypto.randomUUID(), second);
    await event("discovery_call_booked", `booking:${new mongoose.Types.ObjectId()}`, second);
    const third = { sessionId: crypto.randomUUID(), landingPath: "/free-guide", utmSource: "grok" };
    await event("guide_requested", `guide:${new mongoose.Types.ObjectId()}`, third);
    await event("page_view", crypto.randomUUID(), tagged, other);
    assert.equal(await event("page_view", crypto.randomUUID(), { ...tagged, utmSource: "google" }), false);
    const oldId = crypto.randomUUID();await event("page_view", oldId, tagged);
    await SiteTrafficEvent.updateOne({ workspaceId: ws, eventId: oldId }, { $set: { createdAt: new Date(Date.now() - 100 * 86400000) } });
    const result = await runWithWorkspace(ws, () => report(ws, 7));
    assert.equal(result.totals.visits, 3); assert.equal(result.totals.pageViews, 3);
    assert.equal(result.totals.applications, 1); assert.equal(result.totals.bookings, 1);assert.equal(result.totals.guides, 1);
    assert.equal(result.totals.convertedVisits, 2);
    assert.equal(result.trend.length, 7);
    assert.equal(result.sources.find((r) => r.source === "chatgpt").pageViews, 2);
    assert.equal(result.recentInquiries.length, 3);
    assert(!JSON.stringify(result).includes(session));
    const foreign = await runWithWorkspace(other, () => report(other, 30));assert.equal(foreign.totals.visits, 1);assert.equal(foreign.totals.applications, 0);
    assert.equal((await report(ws, 1000)).days, 30);
    const indexes = await SiteTrafficEvent.collection.indexes();assert(indexes.some((i) => i.expireAfterSeconds === 90 * 86400));
    console.log("Real MongoDB event ingestion, concurrent deduplication, source/conversion totals, retention index, date ranges, and tenant isolation passed.");
  } finally {
    assert(mongoose.connection.name.startsWith("test_ai_traffic_"));
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
}
databaseTests().catch((error) => { console.error(error); process.exitCode = 1; });
