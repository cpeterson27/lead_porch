const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buyerIntentAssessment, communityPartnerAssessment, deduplicateSignals, investorProfileAssessment, scoreSignal } = require("./services/researchMonitorService");

const studentMonitor = { monitorType: "buyer_intent", keywords: ["underwriting help", "multifamily mentor", "first apartment"], intentCategories: [], negativeKeywords: [], locations: [] };
const communityMonitor = { monitorType: "community_partner", keywords: ["real estate investing group", "REIA"], intentCategories: [], negativeKeywords: [] };

function studentQualificationChecks() {
  const secExecutive = { source: "sec_form_d", title: "Managing Partner — Related Person", excerpt: "Form D pooled investment fund and securities offering" };
  assert.equal(buyerIntentAssessment(secExecutive).eligible, false);
  assert.equal(scoreSignal(secExecutive, studentMonitor).score, 0);

  for (const title of ["Founder", "Managing Partner", "Director"]) {
    const identityOnly = { source: "bing_web", title, excerpt: `${title} at an institutional investment firm` };
    assert.equal(buyerIntentAssessment(identityOnly).eligible, false);
    assert.equal(scoreSignal(identityOnly, studentMonitor).score, 0, `${title} must not create student intent`);
  }

  const underwriting = { source: "reddit_rss", title: "Need help", excerpt: "I'm underwriting my first 20-unit deal and need help understanding debt service." };
  assert.equal(buyerIntentAssessment(underwriting).eligible, true);
  assert.ok(scoreSignal(underwriting, studentMonitor).score >= 75);

  const mentor = { source: "configured_feed", title: "Course recommendation", excerpt: "Looking for a multifamily mentor/course before analyzing my first apartment acquisition." };
  assert.equal(buyerIntentAssessment(mentor).eligible, true);
  assert.ok(scoreSignal(mentor, studentMonitor).score >= 75);
}

function sourceBoundaryChecks() {
  for (const source of ["linkedin_public", "facebook_public", "meetup_public", "community_directories"]) {
    const metadata = { source, title: "Multifamily Real Estate Investors Group", excerpt: "Public community directory and organizer page", organizationName: "Investor Community" };
    assert.equal(buyerIntentAssessment(metadata).eligible, false, `${source} metadata must not become student intent`);
    assert.equal(communityPartnerAssessment(metadata, communityMonitor).eligible, true, `${source} metadata should route to community review`);
  }
  const indexedGroup = { source: "bing_web", sourceUrl: "https://www.facebook.com/groups/multifamily-learning", title: "Multifamily learning group", excerpt: "Looking for a multifamily mentor" };
  assert.equal(buyerIntentAssessment(indexedGroup).eligible, false, "search-indexed group metadata must not become student intent");
  const discussion = { source: "bing_web", title: "First apartment deal", excerpt: "I'm analyzing my first apartment acquisition and looking for underwriting help." };
  assert.equal(buyerIntentAssessment(discussion).eligible, true, "specific public discussion may qualify");

  const institutional = { source: "bing_news", title: "Private Equity Director", excerpt: "Venture capital and hedge fund manager" };
  assert.equal(investorProfileAssessment(institutional, { negativeKeywords: [] }).eligible, false);
}

function dedupeChecks() {
  const rows = deduplicateSignals([
    { _id: "one", source: "reddit_rss", sourceId: "a", authorName: "Alex Person", authorUrl: "https://example.com/alex", score: 76, evidence: [{ url: "https://example.com/post-1" }] },
    { _id: "two", source: "bing_web", sourceId: "b", authorName: "Alex Person", authorUrl: "https://example.com/alex/", score: 82, evidence: [{ url: "https://example.com/post-2" }] },
    { _id: "three", source: "bing_web", sourceId: "c", authorName: "Alex Person", authorUrl: "", score: 90, evidence: [{ url: "https://example.com/post-3" }] },
  ]);
  assert.equal(rows.length, 2, "same supported public account should reconcile; uncertain identity stays separate");
  assert.equal(rows.find((row) => row.duplicateSignalIds.length === 2).evidence.length, 2);
}

function staticUxAndSourceChecks() {
  const route = fs.readFileSync(path.join(__dirname, "routes/audience.js"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "services/intentSourceService.js"), "utf8");
  const ui = fs.readFileSync(path.join(__dirname, "../frontend/src/pages/Discovery.jsx"), "utf8");
  assert.equal(route.includes("AUGUST_22_PRESET"), false); assert.equal(ui.includes("August 22 online event"), false);
  assert.ok(route.includes('buyer_intent: ["reddit_rss", "bluesky"]'));
  assert.ok(source.includes('monitor.monitorType === "buyer_intent"'));
  assert.ok(ui.includes("Public web / community discovery")); assert.ok(ui.includes("Connected social accounts are a separate OAuth capability"));
  assert.ok(ui.includes("Legacy Apollo-labeled research")); assert.ok(ui.includes("titles alone never qualify"));
  assert.ok(ui.includes("Latest acquisition funnel")); assert.ok(ui.includes("legacy stored source count"));
  assert.ok(ui.includes("no dedicated reliable BiggerPockets adapter") || ui.includes("has no dedicated reliable BiggerPockets adapter"));
  assert.ok(ui.includes("indexedSourceLabel"), "Live Leads should identify BiggerPockets provenance instead of only generic Bing");
  assert.ok(ui.includes("Temporarily rate limited"));
}

Promise.resolve().then(studentQualificationChecks).then(sourceBoundaryChecks).then(dedupeChecks).then(staticUxAndSourceChecks)
  .then(() => console.log("Market Intelligence boundary checks passed: student intent, institutional exclusions, community routing, conservative deduplication, source semantics, and current presets."))
  .catch((error) => { console.error(error); process.exitCode = 1; });
