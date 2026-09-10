// Regression coverage for the lead-discovery bucket system (Live Leads / Watchlist /
// Community Opportunities / Rejected): the 3-factor gate, exclusion-persona detection,
// program matching, multi-dimensional scoring, and — critically — that rejected candidates
// are now actually PERSISTED with a recorded rejection reason instead of only being counted.
require("dotenv").config();
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const taxonomy = require("./services/leadDiscoveryTaxonomy");

// Force deterministic-only classification for this test (no real OpenAI calls).
const originalOpenAiFlag = process.env.JARVIS_OPENAI_ENABLED;
process.env.JARVIS_OPENAI_ENABLED = "false";

const intentSourceService = require("./services/intentSourceService");
const originalCollect = intentSourceService.collectMonitorSignals;

const researchMonitorService = require("./services/researchMonitorService");
const IntentSignal = require("./models/IntentSignal");
const ResearchMonitor = require("./models/ResearchMonitor");
const CoachingProgram = require("./models/CoachingProgram");
const InAppNotification = require("./models/InAppNotification");

function unit() {
  // Exclusion personas
  assert.equal(taxonomy.detectExclusionPersona("I'm a mortgage broker here to help investors get financing").reason, "vendor_lender_agent_recruiter");
  assert.equal(taxonomy.detectExclusionPersona("Check out my course on multifamily investing, link in bio").reason, "seller_or_promoter");
  assert.equal(taxonomy.detectExclusionPersona("As an AI language model, I cannot provide financial advice").reason, "bot_or_automated");
  assert.equal(taxonomy.detectExclusionPersona("I've closed 40 units and I'm a syndicator with 10 years in the game").reason, "too_experienced");
  assert.equal(taxonomy.detectExclusionPersona("I need help underwriting my first multifamily deal").excluded, false);

  // Program matching against real-shaped CoachingProgram data
  const profiles = taxonomy.buildProgramProfiles([
    { _id: "p1", status: "active", name: "6-Week Coaching - Acquisitions", internalSummary: "Build a personalized buy box, interpret market analysis reports, underwriting template, letters of intent LOIs." },
  ]);
  const match = taxonomy.matchProgram("I need help with my buy box and underwriting an LOI for my first acquisition", profiles);
  assert.equal(match.matched, true);
  assert.equal(match.program, "6-Week Coaching - Acquisitions");

  // 3-factor gate: strong current-need language must produce a full gate pass.
  const liveLeadEligibility = researchMonitorService.buyerIntentAssessment({ title: "", excerpt: "I need help underwriting my first multifamily deal, I'm overwhelmed and ready to invest in coaching." }, []);
  assert.equal(liveLeadEligibility.eligible, true);
  assert.equal(liveLeadEligibility.gate.firstPersonEvidence, true);
  assert.equal(liveLeadEligibility.gate.currentNeed, true);
  assert.ok(liveLeadEligibility.gate.programMatch);

  // Weak/aspirational-only language must NOT satisfy currentNeed (Watchlist material, not a Live Lead).
  const watchlistEligibility = researchMonitorService.buyerIntentAssessment({ title: "", excerpt: "I'm exploring multifamily investing and thinking about my next move into apartments." }, []);
  assert.equal(watchlistEligibility.eligible, true);
  assert.equal(watchlistEligibility.gate.currentNeed, false, "aspirational-only language must not count as a current need");

  // Persona exclusion must reject outright regardless of topic match.
  const rejectedEligibility = researchMonitorService.buyerIntentAssessment({ title: "", excerpt: "I'm a mortgage broker helping multifamily investors get financing for their first deal." }, []);
  assert.equal(rejectedEligibility.eligible, false);
  assert.equal(rejectedEligibility.exclusionReason, "vendor_lender_agent_recruiter");

  // Hard, deterministic industry gate: urgency language alone (with no
  // multifamily/apartment-investing relevance) must never pass eligibility,
  // no matter how high its urgency score would otherwise be. This is what
  // keeps unrelated "urgent" posts from ever reaching a lead bucket.
  const urgentUnrelatedText = "I need help ASAP, this is urgent, I'm actively looking for a personal trainer to help me lose weight before my wedding next month, budget is $500-$1000.";
  const urgentUnrelatedEligibility = researchMonitorService.buyerIntentAssessment({ title: "", excerpt: urgentUnrelatedText }, []);
  assert.equal(urgentUnrelatedEligibility.eligible, false, "urgent language with no multifamily relevance must still fail the hard industry gate");
  assert.equal(urgentUnrelatedEligibility.exclusionReason, "wrong_industry");
  // Confirm this isn't merely low-scoring — its urgency dimension score is
  // genuinely high on its own; only the deterministic eligibility gate (run
  // upstream of scoring, see classifySignalBucket) keeps it out of any bucket.
  const urgentUnrelatedDimensions = taxonomy.scoreDimensions({ text: urgentUnrelatedText });
  assert.ok(urgentUnrelatedDimensions.urgency >= 60, "sanity check: the post really does read as urgent");
  const urgentUnrelatedMonitor = { monitorType: "buyer_intent", keywords: ["underwriting", "multifamily"], intentCategories: [], negativeKeywords: [] };
  const urgentUnrelatedBucket = researchMonitorService.classifySignalBucket({
    signal: { title: "", excerpt: urgentUnrelatedText },
    monitor: urgentUnrelatedMonitor,
    eligibility: urgentUnrelatedEligibility,
    ranking: researchMonitorService.scoreSignal({ title: "", excerpt: urgentUnrelatedText }, urgentUnrelatedMonitor, []),
  });
  assert.equal(urgentUnrelatedBucket.bucket, "rejected", "a high urgency score must never override a failed relevance gate");

  // classifySignalBucket must route each case to the correct bucket.
  const monitor = { monitorType: "buyer_intent", keywords: ["underwriting", "multifamily"], intentCategories: [], negativeKeywords: [] };
  const liveSignal = { title: "", excerpt: "I need help underwriting my first multifamily deal, I'm overwhelmed and ready to invest in coaching." };
  const liveRanking = researchMonitorService.scoreSignal(liveSignal, monitor, []);
  assert.equal(researchMonitorService.classifySignalBucket({ signal: liveSignal, monitor, eligibility: liveLeadEligibility, ranking: liveRanking }).bucket, "live_lead");

  const watchlistRanking = researchMonitorService.scoreSignal({ title: "", excerpt: "I'm exploring multifamily investing and thinking about my next move into apartments." }, monitor, []);
  assert.equal(researchMonitorService.classifySignalBucket({ signal: {}, monitor, eligibility: watchlistEligibility, ranking: watchlistRanking }).bucket, "watchlist");

  const rejectedResult = researchMonitorService.classifySignalBucket({ signal: {}, monitor, eligibility: rejectedEligibility, ranking: { dimensions: {} } });
  assert.equal(rejectedResult.bucket, "rejected");
  assert.equal(rejectedResult.rejectionReason, "vendor_lender_agent_recruiter");

  console.log("Lead discovery taxonomy unit checks passed.");
}

async function integration() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const program = await CoachingProgram.create({ workspaceId, status: "active", name: "6-Week Coaching - Acquisitions", internalSummary: "Build a personalized buy box, market analysis, underwriting template, letters of intent." });
  const monitor = await ResearchMonitor.create({ workspaceId, name: "Test buyer-intent monitor", monitorType: "buyer_intent", query: "multifamily investing help", keywords: ["multifamily", "underwriting"], enabled: true, intervalMinutes: 60 });

  const liveLeadUrl = "https://reddit.com/r/realestate/live-lead";
  const watchlistUrl = "https://reddit.com/r/realestate/watchlist";
  const rejectedUrl = "https://reddit.com/r/realestate/rejected";

  intentSourceService.collectMonitorSignals = async () => ({
    groups: [{
      source: "reddit_rss",
      signals: [
        { source: "reddit_rss", sourceId: "live1", sourceUrl: liveLeadUrl, title: "Need help with my first deal", excerpt: "I need help underwriting my first multifamily deal, I'm overwhelmed and ready to invest in coaching.", evidence: [{ label: "Reddit", url: liveLeadUrl, observedAt: new Date() }], raw: {} },
        { source: "reddit_rss", sourceId: "watch1", sourceUrl: watchlistUrl, title: "Thinking about multifamily", excerpt: "I'm exploring multifamily investing and thinking about my next move into apartments.", evidence: [{ label: "Reddit", url: watchlistUrl, observedAt: new Date() }], raw: {} },
        { source: "reddit_rss", sourceId: "reject1", sourceUrl: rejectedUrl, title: "Financing available", excerpt: "I'm a mortgage broker helping multifamily investors get financing for their first deal.", evidence: [{ label: "Reddit", url: rejectedUrl, observedAt: new Date() }], raw: {} },
      ],
    }],
    failures: [],
  });

  try {
    await researchMonitorService.runResearchMonitor(monitor._id);

    const live = await IntentSignal.findOne({ workspaceId, sourceUrl: liveLeadUrl }).lean();
    assert.ok(live, "the live-lead candidate must be persisted");
    assert.equal(live.bucket, "live_lead");
    assert.equal(live.rejectionReason, "");
    assert.equal(live.scoreBreakdown.firstPersonEvidence, true);
    assert.equal(live.scoreBreakdown.currentNeed, true);
    assert.ok(live.scoreBreakdown.programMatch);

    const watchlist = await IntentSignal.findOne({ workspaceId, sourceUrl: watchlistUrl }).lean();
    assert.ok(watchlist, "the watchlist candidate must be persisted");
    assert.equal(watchlist.bucket, "watchlist");

    // This is the core fix: a rejected candidate must now be a real, queryable record with a reason —
    // previously rejected candidates were never saved at all, only counted.
    const rejected = await IntentSignal.findOne({ workspaceId, sourceUrl: rejectedUrl }).lean();
    assert.ok(rejected, "the rejected candidate must now be persisted with a recorded reason");
    assert.equal(rejected.bucket, "rejected");
    assert.equal(rejected.rejectionReason, "vendor_lender_agent_recruiter");
    assert.equal(rejected.audienceEligible, false);

    const updatedMonitor = await ResearchMonitor.findById(monitor._id).lean();
    assert.match(updatedMonitor.lastRunMessage, /1 live lead/);
    assert.match(updatedMonitor.lastRunMessage, /1 watchlisted/);
    assert.match(updatedMonitor.lastRunMessage, /1 rejected/);

    console.log("Lead discovery bucket persistence (live/watchlist/rejected) integration checks passed.");
  } finally {
    intentSourceService.collectMonitorSignals = originalCollect;
    await IntentSignal.deleteMany({ workspaceId });
    await ResearchMonitor.deleteMany({ workspaceId });
    await CoachingProgram.deleteMany({ workspaceId });
    await mongoose.disconnect();
    process.env.JARVIS_OPENAI_ENABLED = originalOpenAiFlag;
  }
}

// A "blocked" source (401/403 — an auth/permission failure that will never
// self-resolve by retrying, e.g. a provider API closed to new customers)
// must be automatically removed from a monitor's sources, with a visible
// notification, instead of being silently retried forever.
async function sourceAutoDisable() {
  await mongoose.connect(process.env.MONGO_URI);
  const workspaceId = new mongoose.Types.ObjectId();
  const monitor = await ResearchMonitor.create({ workspaceId, name: "Blocked-source monitor", monitorType: "buyer_intent", query: "multifamily investing help", keywords: ["multifamily"], enabled: true, intervalMinutes: 60, sources: ["google_web", "reddit_rss"] });

  intentSourceService.collectMonitorSignals = async () => ({
    groups: [],
    failures: [{ source: "google_web", message: "Request failed with status code 403", state: "blocked", retryAt: null }],
  });

  try {
    await researchMonitorService.runResearchMonitor(monitor._id);

    const updatedMonitor = await ResearchMonitor.findById(monitor._id).lean();
    assert.ok(!updatedMonitor.sources.includes("google_web"), "a blocked source must be auto-removed from the monitor's sources");
    assert.ok(updatedMonitor.sources.includes("reddit_rss"), "an unaffected source must remain enabled");
    const blockedHealth = updatedMonitor.sourceHealth.find((row) => row.source === "google_web");
    assert.equal(blockedHealth.state, "blocked");

    const notification = await InAppNotification.findOne({ workspaceId, monitorId: monitor._id, type: "source_disabled" }).lean();
    assert.ok(notification, "disabling a blocked source must produce a visible notification");
    assert.match(notification.message, /403/);

    console.log("Blocked-source auto-disable (research monitor) checks passed.");
  } finally {
    intentSourceService.collectMonitorSignals = originalCollect;
    await ResearchMonitor.deleteMany({ workspaceId });
    await InAppNotification.deleteMany({ workspaceId });
    await mongoose.disconnect();
  }
}

unit();
integration()
  .then(sourceAutoDisable)
  .then(() => console.log("Lead discovery bucket system: taxonomy, gating, real persistence of rejected/watchlisted signals, and blocked-source auto-disable all passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
