const express = require("express");

const Contact = require("../models/Contact");
const Organization = require("../models/Organization");
const Audience = require("../models/Audience");
const DiscoveryRun = require("../models/DiscoveryRun");
const MarketResearchJob = require("../models/MarketResearchJob");
const PeopleResearchPreview = require("../models/PeopleResearchPreview");
const IntentSignal = require("../models/IntentSignal");
const ResearchMonitor = require("../models/ResearchMonitor");
const MonitorActivity = require("../models/MonitorActivity");
const InAppNotification = require("../models/InAppNotification");
const IntentEmailDraft = require("../models/IntentEmailDraft");
const Campaign = require("../models/Campaign");
const Outreach = require("../models/Outreach");
const CoachingProgram = require("../models/CoachingProgram");
const leadDiscoveryTaxonomy = require("../services/leadDiscoveryTaxonomy");

const {
  discoverAudienceSources,
  discoverOrganizationsForAudience,
} = require("../services/audience");
const { previewOrganizationImport, importOrganizations } = require("../services/organizationImportService");
const { compileMarketQuestion } = require("../services/marketResearchService");
const { sourceStatus } = require("../services/businessDataSourceService");
const { runMarketResearchJob } = require("../services/externalMarketResearchService");
const { classifySignalBucket, deduplicateSignals, requestResearchMonitorRun, runResearchMonitor, scoreSignal, signalEligibility } = require("../services/researchMonitorService");
const { ensureLinks, generateIntentEmailDraft } = require("../services/intentEmailDraftService");
const { researchAudienceForSignal } = require("../services/researchAudienceTemplates");
const { researchPublicWebsite } = require("../services/publicWebsiteResearchService");
const { RESEARCH_MONITOR_PRESETS } = require("../services/researchMonitorPresets");
const leadQualificationService = require("../services/leadQualificationService");
const biggerPocketsPolicy = require("../services/biggerPocketsEngagementPolicy");
const agentExecutionService = require("../services/agentExecutionService");
const searchQualityService = require("../services/searchQualityService");

const router = express.Router();
const MONITOR_SOURCE_DEFAULTS = {
  buyer_intent: ["bing_web", "reddit_rss"],
  investor_profile: ["bing_web", "reddit_rss"],
  community_partner: ["linkedin_public", "facebook_public", "meetup_public", "community_directories", "bing_web"],
};
const sourcesForMonitorType = (type) => [...(MONITOR_SOURCE_DEFAULTS[type] || MONITOR_SOURCE_DEFAULTS.buyer_intent)];

router.get("/research/sources", (_req, res) => {
  return res.json({
    success: true,
    sources: [sourceStatus()],
    automaticSources: [
      { id: "google_web", name: "Google Programmable Search", signalClass: "D", intendedUses: ["company", "discussion"], accountRequired: true, configured: Boolean(process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID) },
      { id: "bing_web", name: "Open web (Bing RSS)", signalClass: "A/C", intendedUses: ["student_intent", "investor", "community", "company"], accountRequired: false },
      { id: "bing_news", name: "Bing News RSS", signalClass: "B/C", intendedUses: ["company", "investor"], accountRequired: false },
      { id: "linkedin_public", name: "Public LinkedIn group/page metadata", signalClass: "B", intendedUses: ["community"], accountRequired: false, availability: "public_index_only" },
      { id: "facebook_public", name: "Public Facebook group/page metadata", signalClass: "B", intendedUses: ["community"], accountRequired: false, availability: "public_index_only" },
      { id: "meetup_public", name: "Public Meetup group metadata", signalClass: "B", intendedUses: ["community"], accountRequired: false },
      { id: "community_directories", name: "Public REIA and club directories", signalClass: "B", intendedUses: ["community"], accountRequired: false },
      { id: "gdelt", name: "Worldwide news (GDELT)", signalClass: "C", intendedUses: ["company"], accountRequired: false },
      { id: "sec_form_d", name: "SEC Form D filings — experimental, never student intent", signalClass: "B", intendedUses: ["disabled_experimental"], accountRequired: false },
      { id: "bluesky", name: "Public Bluesky posts", signalClass: "C/D", intendedUses: ["discussion"], accountRequired: false },
      { id: "hacker_news", name: "Hacker News discussions", signalClass: "A/C", intendedUses: ["discussion"], accountRequired: false },
      { id: "stack_exchange", name: "Stack Exchange questions", signalClass: "A/C", intendedUses: ["discussion"], accountRequired: false },
      { id: "reddit_rss", name: "Public Reddit discussions", signalClass: "A/C", intendedUses: ["student_intent", "investor"], accountRequired: false, availability: "best_effort" },
      { id: "duckduckgo", name: "Open-web discovery (DuckDuckGo)", signalClass: "C", intendedUses: ["company", "discussion"], accountRequired: false, availability: "best_effort" },
      { id: "rss", name: "Public RSS and Atom feeds — use a configured URL", signalClass: "D", intendedUses: ["configured_url_only"], accountRequired: false },
      { id: "discourse", name: "Public Discourse — use a configured URL", signalClass: "D", intendedUses: ["configured_url_only"], accountRequired: false },
    ],
  });
});

router.get("/research/monitors", async (req, res) => {
  const monitors = await ResearchMonitor.find({ workspaceId: req.auth.workspaceId }).sort({ createdAt: -1 }).lean();
  return res.json({ success: true, monitors });
});

router.get("/research/monitor-presets", (_req, res) => res.json({ success: true, presets: RESEARCH_MONITOR_PRESETS }));

/**
 * GET /audience/research/monitor-performance
 * Search-quality feedback loop: measures each monitor by real downstream
 * outcomes (opportunities, enrollments, won revenue) instead of raw result
 * volume, and produces deterministic, evidence-based improvement
 * recommendations. No OpenAI call — this works without any AI budget.
 */
router.get("/research/monitor-performance", async (req, res) => {
  const performance = await searchQualityService.getMonitorPerformance(req.auth.workspaceId);
  const recommendations = searchQualityService.recommendationsFor(performance);
  return res.json({ success: true, performance, recommendations });
});

router.post("/research/monitors", async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (query.length < 5) return res.status(400).json({ success: false, error: "Describe the intent or audience to monitor." });
    const allowedSources = new Set(["google_web", "bing_web", "bing_news", "linkedin_public", "facebook_public", "meetup_public", "community_directories", "gdelt", "sec_form_d", "bluesky", "hacker_news", "stack_exchange", "discourse", "rss", "reddit_rss", "duckduckgo"]);
    const monitorType = ["buyer_intent", "community_partner", "investor_profile"].includes(req.body?.monitorType) ? req.body.monitorType : "buyer_intent";
    const requestedSources = Array.isArray(req.body?.sources) ? req.body.sources.filter((source) => allowedSources.has(source)) : [];
    const safeSources = requestedSources.filter((source) => monitorType === "community_partner" || !["linkedin_public", "facebook_public", "meetup_public", "community_directories"].includes(source)).filter((source) => monitorType !== "buyer_intent" || source !== "sec_form_d");
    const selectedSources = safeSources.length ? safeSources : sourcesForMonitorType(monitorType);
    const monitor = await ResearchMonitor.create({
      workspaceId: req.auth.workspaceId,
      userId: req.auth.user?._id || null,
      name: String(req.body?.name || query).trim().slice(0, 160),
      monitorType,
      query,
      keywords: (req.body?.keywords || []).map(String).map((value) => value.trim()).filter(Boolean).slice(0, 50),
      intentCategories: (req.body?.intentCategories || []).slice(0, 12).map((category) => ({ name: String(category.name || "Intent").trim().slice(0, 80), phrases: (category.phrases || []).map(String).map((value) => value.trim()).filter(Boolean).slice(0, 30) })),
      negativeKeywords: (req.body?.negativeKeywords || []).map(String).map((value) => value.trim()).filter(Boolean).slice(0, 50),
      locations: (req.body?.locations || []).map(String).map((value) => value.trim()).filter(Boolean).slice(0, 25),
      sources: selectedSources,
      feedUrls: (req.body?.feedUrls || []).map(String).filter((url) => /^https:\/\//i.test(url)).slice(0, 30),
      intervalMinutes: Math.min(10080, Math.max(15, Number(req.body?.intervalMinutes) || 60)),
      maxResultsPerSource: Math.min(100, Math.max(5, Number(req.body?.maxResultsPerSource) || 25)),
      nextRunAt: new Date(),
      runRequestedAt: new Date(),
      sourceHealth: selectedSources.map((source) => ({ source, enabled: true, state: "never", nextScheduledAttempt: new Date() })),
    });
    // A new monitor always performs its first check immediately. The selected
    // interval controls subsequent checks, not the initial one.
    setImmediate(() => runResearchMonitor(monitor._id).catch((error) => {
      console.error("Immediate first monitor run failed:", error.message || error);
    }));
    return res.status(201).json({ success: true, monitor });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to create the monitor." });
  }
});

router.patch("/research/monitors/:monitorId", async (req, res) => {
  const existingMonitor = await ResearchMonitor.findOne({ _id: req.params.monitorId, workspaceId: req.auth.workspaceId }).select("monitorType").lean();
  if (!existingMonitor) return res.status(404).json({ success: false, error: "Monitor not found." });
  const allowed = ["name", "monitorType", "query", "keywords", "intentCategories", "negativeKeywords", "locations", "sources", "feedUrls", "enabled", "intervalMinutes", "maxResultsPerSource"];
  const update = Object.fromEntries(allowed.filter((key) => req.body?.[key] !== undefined).map((key) => [key, req.body[key]]));
  const effectiveType = ["buyer_intent", "community_partner", "investor_profile"].includes(update.monitorType) ? update.monitorType : existingMonitor.monitorType;
  if (Array.isArray(update.sources) && effectiveType !== "community_partner") update.sources = update.sources.filter((source) => !["linkedin_public", "facebook_public", "meetup_public", "community_directories"].includes(source));
  if (Array.isArray(update.sources) && effectiveType === "buyer_intent") update.sources = update.sources.filter((source) => source !== "sec_form_d");
  if (update.enabled === true) update.nextRunAt = new Date();
  const monitor = await ResearchMonitor.findOneAndUpdate({ _id: req.params.monitorId, workspaceId: req.auth.workspaceId }, { $set: update }, { new: true, runValidators: true });
  if (!monitor) return res.status(404).json({ success: false, error: "Monitor not found." });
  return res.json({ success: true, monitor });
});

router.delete("/research/monitors/:monitorId", async (req, res) => {
  const monitor = await ResearchMonitor.findOneAndDelete({ _id: req.params.monitorId, workspaceId: req.auth.workspaceId });
  if (!monitor) return res.status(404).json({ success: false, error: "Monitor not found." });
  await Promise.all([
    MonitorActivity.deleteMany({ workspaceId: req.auth.workspaceId, monitorId: monitor._id }),
    InAppNotification.deleteMany({ workspaceId: req.auth.workspaceId, monitorId: monitor._id }),
  ]);
  return res.json({ success: true, deleted: String(monitor._id) });
});

router.post("/research/monitors/:monitorId/run", async (req, res) => {
  const monitor = await ResearchMonitor.findOne({ _id: req.params.monitorId, workspaceId: req.auth.workspaceId });
  if (!monitor) return res.status(404).json({ success: false, error: "Monitor not found." });
  if (monitor.lastRunStatus === "running") return res.status(409).json({ success: false, error: "This monitor is already running." });
  const queued = await requestResearchMonitorRun(monitor._id);
  return res.status(202).json({ success: true, monitor: { ...queued.toObject(), lastRunStatus: "queued" } });
});

router.get("/research/activity", async (req, res) => {
  const filter = { workspaceId: req.auth.workspaceId };
  if (req.query.monitorId) filter.monitorId = req.query.monitorId;
  const activity = await MonitorActivity.find(filter).sort({ createdAt: -1 }).limit(Math.min(250, Number(req.query.limit) || 100)).lean();
  return res.json({ success: true, activity });
});

router.get("/research/notifications", async (req, res) => {
  const notifications = await InAppNotification.find({ workspaceId: req.auth.workspaceId }).sort({ createdAt: -1 }).limit(100).lean();
  return res.json({ success: true, notifications, unread: notifications.filter((item) => !item.readAt).length });
});

router.patch("/research/notifications/:notificationId", async (req, res) => {
  const notification = await InAppNotification.findOneAndUpdate({ _id: req.params.notificationId, workspaceId: req.auth.workspaceId }, { $set: { readAt: req.body?.read === false ? null : new Date() } }, { new: true });
  if (!notification) return res.status(404).json({ success: false, error: "Notification not found." });
  return res.json({ success: true, notification });
});

router.delete("/research/notifications", async (req, res) => {
  const result = await InAppNotification.deleteMany({ workspaceId: req.auth.workspaceId });
  return res.json({ success: true, deleted: result.deletedCount || 0 });
});

/**
 * POST /audience/research/weekly-brief
 * Research Agent: read this week's real Discovery signals (public evidence
 * only) and turn them into a written brief. Read-only — proposes nothing,
 * changes nothing. Deterministic short-circuit when there is nothing to
 * summarize, so this never spends an OpenAI call on an empty week.
 */
router.post("/research/weekly-brief", async (req, res) => {
  const days = Math.min(30, Math.max(1, Number(req.body?.days) || 7));
  const signalCount = await IntentSignal.countDocuments({ workspaceId: req.auth.workspaceId, discoveredAt: { $gte: new Date(Date.now() - days * 86400000) } });
  if (!signalCount) {
    return res.json({ success: true, data: { summary: `No Discovery signals were found in the last ${days} days.`, topFindings: [], recommendedFollowUps: [] }, signalCount: 0 });
  }
  try {
    const result = await agentExecutionService.runAgent({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, auth: req.auth, agent: "research", task: "summarize_weekly_discovery_findings",
      input: { days },
      operationalContext: `Base every claim strictly on the supplied Discovery signals. Do not invent organizations, people, or intent beyond what is in the data. If a signal's evidence is weak or ambiguous, say so rather than overstating confidence. Summarize the last ${days} days of Discovery findings into a written brief for the workspace owner.`,
      correlationId: `research-weekly-brief:${req.auth.workspaceId}`,
      options: {
        tools: [{ toolId: "research.list_recent_signals", input: { days, limit: 50 } }],
        responseSchema: { type: "object", properties: { summary: { type: "string" }, topFindings: { type: "array", items: { type: "object", properties: { title: { type: "string" }, why: { type: "string" } }, required: ["title", "why"], additionalProperties: false } }, recommendedFollowUps: { type: "array", items: { type: "string" } } }, required: ["summary", "topFindings", "recommendedFollowUps"], additionalProperties: false },
        schemaName: "discovery_weekly_brief",
      },
    });
    return res.json({ success: true, data: result.output, metadata: result.metadata, signalCount });
  } catch (err) {
    const isBillingLimit = err.status === 429 || err.statusCode === 429;
    const status = isBillingLimit ? 429 : ["AGENT_CAPABILITY_FORBIDDEN", "AGENT_WORKSPACE_FORBIDDEN"].includes(err.code) ? 403 : ["AGENT_UNKNOWN", "AGENT_STRUCTURED_OUTPUT_FORBIDDEN", "AGENT_TEXT_OUTPUT_FORBIDDEN"].includes(err.code) ? 400 : 500;
    return res.status(status).json({ success: false, error: isBillingLimit ? "OpenAI credits are empty. Add API credits to use the AI weekly brief." : err.message, code: err.code || "RESEARCH_AGENT_BRIEF_FAILED" });
  }
});

/**
 * POST /audience/research/strategy-recommendations
 * Research Agent: read every monitor's real performance (leads, enrollments,
 * won revenue) plus the workspace's real active programs, and recommend
 * concrete new focused searches, monitors to pause or narrow, and program
 * coverage gaps. Read-only — proposes nothing, changes nothing.
 */
router.post("/research/strategy-recommendations", async (req, res) => {
  const programs = await CoachingProgram.find({ workspaceId: req.auth.workspaceId, status: "active" }).select("name internalSummary").lean();
  try {
    const result = await agentExecutionService.runAgent({
      workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, auth: req.auth, agent: "research", task: "recommend_discovery_strategy",
      input: { programs: programs.map((p) => ({ name: p.name, summary: p.internalSummary })) },
      operationalContext: "Base every recommendation strictly on the supplied monitor performance data and the real active program list. Do not invent monitors, numbers, or outcomes. Recommend specific, focused search queries (not broad keyword dumps) tied to a specific program's real language. Flag any active program with no dedicated monitor as a coverage gap. Never propose creating or changing a monitor automatically — only suggest.",
      correlationId: `discovery-strategy:${req.auth.workspaceId}`,
      options: {
        tools: [{ toolId: "research.get_monitor_performance", input: {} }, { toolId: "research.list_recent_signals", input: { days: 14, limit: 50 } }],
        responseSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            coverageGaps: { type: "array", items: { type: "string" } },
            monitorsToReview: { type: "array", items: { type: "object", properties: { monitorName: { type: "string" }, issue: { type: "string" }, recommendation: { type: "string" } }, required: ["monitorName", "issue", "recommendation"], additionalProperties: false } },
            suggestedSearches: { type: "array", items: { type: "object", properties: { program: { type: "string" }, query: { type: "string" }, rationale: { type: "string" } }, required: ["program", "query", "rationale"], additionalProperties: false } },
          },
          required: ["summary", "coverageGaps", "monitorsToReview", "suggestedSearches"],
          additionalProperties: false,
        },
        schemaName: "discovery_strategy_recommendations",
      },
    });
    return res.json({ success: true, data: result.output, metadata: result.metadata });
  } catch (err) {
    const isBillingLimit = err.status === 429 || err.statusCode === 429;
    const status = isBillingLimit ? 429 : ["AGENT_CAPABILITY_FORBIDDEN", "AGENT_WORKSPACE_FORBIDDEN"].includes(err.code) ? 403 : ["AGENT_UNKNOWN", "AGENT_STRUCTURED_OUTPUT_FORBIDDEN", "AGENT_TEXT_OUTPUT_FORBIDDEN"].includes(err.code) ? 400 : 500;
    return res.status(status).json({ success: false, error: isBillingLimit ? "OpenAI credits are empty. Add API credits to use AI strategy recommendations." : err.message, code: err.code || "RESEARCH_AGENT_STRATEGY_FAILED" });
  }
});

router.get("/research/signals", async (req, res) => {
  const limit = Math.min(250, Math.max(1, Number(req.query.limit) || 100));
  const filter = { workspaceId: req.auth.workspaceId };
  if (req.query.monitorId) filter.monitorId = req.query.monitorId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.bucket) filter.bucket = req.query.bucket;
  const signals = await IntentSignal.find(filter).sort({ score: -1, publishedAt: -1, discoveredAt: -1 }).limit(limit).lean();
  const programProfiles = leadDiscoveryTaxonomy.buildProgramProfiles(await CoachingProgram.find({ workspaceId: req.auth.workspaceId, status: "active" }).select("name internalSummary publicPresentation.summary status").lean());
  const [liveLeadCount, watchlistCount, communityOpportunityCount, rejectedCount] = await Promise.all(["live_lead", "watchlist", "community_opportunity", "rejected"].map((bucket) => IntentSignal.countDocuments({ workspaceId: req.auth.workspaceId, bucket })));
  const bucketSummary = { live_lead: liveLeadCount, watchlist: watchlistCount, community_opportunity: communityOpportunityCount, rejected: rejectedCount };
  const stalePlatformIdentities = signals.filter((signal) => invalidPlatformIdentityName(signal.authorName));
  if (stalePlatformIdentities.length) await Promise.all(stalePlatformIdentities.map(async (signal) => {
    signal.authorName = "";
    signal.authorUrl = "";
    signal.people = (signal.people || []).filter((person) => !invalidPlatformIdentityName(person.name));
    signal.publishedEmails = (signal.publishedEmails || []).filter((email) => !/@(?:meetup|facebook|linkedin)\.com$/i.test(email));
    signal.identityResolution = { status: "unresolved", reason: "A platform staff or editorial identity was removed because it is not the community's contact person.", evidenceUrls: [] };
    await IntentSignal.updateOne({ _id: signal._id, workspaceId: req.auth.workspaceId }, { $set: { authorName: "", authorUrl: "", people: signal.people, publishedEmails: signal.publishedEmails, identityResolution: signal.identityResolution } });
  }));
  const monitorIds = [...new Set(signals.map((signal) => String(signal.monitorId || "")).filter(Boolean))];
  const monitorMap = new Map((await ResearchMonitor.find({ _id: { $in: monitorIds } }).lean()).map((monitor) => [String(monitor._id), monitor]));
  const assessed = signals.map((signal) => {
    const monitor = monitorMap.get(String(signal.monitorId));
    const eligibility = signalEligibility(signal, monitor, programProfiles);
    const ranking = monitor ? scoreSignal(signal, monitor, programProfiles) : null;
    const { bucket, rejectionReason } = monitor ? classifySignalBucket({ signal, monitor, eligibility, ranking }) : { bucket: signal.bucket || "live_lead", rejectionReason: signal.rejectionReason || "" };
    return { signal, eligibility, ranking, bucket, rejectionReason };
  });
  // Watchlist / Community Opportunities / Rejected are separate discovery-track result areas,
  // not part of the "accepted live lead" pipeline below (which assumes buyer-intent eligibility).
  // Serve them directly so a rejected signal's reason is actually visible, not filtered away.
  if (["watchlist", "community_opportunity", "rejected"].includes(req.query.bucket)) {
    await Promise.all(assessed.map(({ signal, eligibility, bucket, rejectionReason }) => (signal.bucket !== bucket || signal.rejectionReason !== rejectionReason)
      ? IntentSignal.updateOne({ _id: signal._id }, { $set: { bucket, rejectionReason, audienceEligible: bucket !== "rejected", audienceRejectionReason: bucket === "rejected" ? (eligibility.reason || "") : "" } })
      : Promise.resolve()));
    const trackSignals = assessed.map(({ signal, ranking, bucket, rejectionReason }) => {
      const monitor = monitorMap.get(String(signal.monitorId));
      return { ...signal, ...(ranking ? { score: ranking.score, scoreReasons: ranking.reasons, dimensions: ranking.dimensions } : {}), bucket, rejectionReason, monitorName: monitor?.name || "Unknown monitor", monitorType: monitor?.monitorType || "" };
    });
    return res.json({ success: true, signals: trackSignals, bucketSummary, summary: { total: trackSignals.length } });
  }
  const rejected = assessed.filter((item) => !item.eligibility.eligible || (item.ranking && item.ranking.score < 45));
  if (rejected.length) await Promise.all(rejected.map(({ signal, eligibility, bucket, rejectionReason }) => IntentSignal.updateOne({ _id: signal._id }, { $set: { audienceEligible: false, audienceRejectionReason: eligibility.reason, status: "dismissed", classification: "irrelevant", classificationReason: eligibility.reason, bucket, rejectionReason } })));
  const rebucketed = assessed.filter((item) => item.eligibility.eligible && item.signal.bucket !== item.bucket);
  if (rebucketed.length) await Promise.all(rebucketed.map(({ signal, bucket, rejectionReason }) => IntentSignal.updateOne({ _id: signal._id }, { $set: { bucket, rejectionReason } })));
  const accepted = assessed.filter((item) => item.eligibility.eligible && (!item.ranking || item.ranking.score >= 45) && item.signal.audienceEligible !== false);
  if (accepted.length) await Promise.all(accepted.filter((item) => item.ranking && (item.signal.score !== item.ranking.score || JSON.stringify(item.signal.scoreReasons || []) !== JSON.stringify(item.ranking.reasons))).map(({ signal, ranking }) => IntentSignal.updateOne({ _id: signal._id }, { $set: { score: ranking.score, scoreReasons: ranking.reasons } })));
  const acceptedSignals = deduplicateSignals(accepted.map(({ signal, ranking, bucket, rejectionReason }) => ({ ...signal, ...(ranking ? { score: ranking.score, scoreReasons: ranking.reasons } : {}), bucket, rejectionReason })));
  const drafts = await IntentEmailDraft.find({ workspaceId: req.auth.workspaceId, signalId: { $in: acceptedSignals.map((signal) => signal._id) } }).sort({ updatedAt: -1 }).lean();
  const draftsBySignal = new Map();
  drafts.forEach((draft) => { const key = String(draft.signalId); draftsBySignal.set(key, [...(draftsBySignal.get(key) || []), draft]); });
  const contacts = await Contact.find({
    sourceProvider: "intent_monitor",
    providerContactId: { $in: acceptedSignals.map((signal) => String(signal._id)) },
  }).select("name email emailStatus company title researchStatus stage providerContactId website").lean();
  const contactsBySignal = new Map(contacts.map((contact) => [String(contact.providerContactId), contact]));
  const categorizedSignals = acceptedSignals.map((signal) => {
    const emailDrafts = draftsBySignal.get(String(signal._id)) || [];
    const crmContact = contactsBySignal.get(String(signal._id)) || null;
    const monitor = monitorMap.get(String(signal.monitorId));
    const opportunityType = opportunityKind(signal, monitor);
    return {
      ...signal,
      opportunityType,
      monitorType: monitor?.monitorType || "",
      monitorName: monitor?.name || "Unknown monitor",
      nextStep: opportunityNextStep(signal, opportunityType, crmContact, emailDrafts),
      emailDrafts,
      crmContact,
    };
  });
  const summary = categorizedSignals.reduce((counts, signal) => {
    counts.total += 1;
    counts[signal.opportunityType] += 1;
    counts[signal.status] = (counts[signal.status] || 0) + 1;
    if (signal.nextStep === "identify_person") counts.needsIdentity += 1;
    if (signal.nextStep === "verify_email") counts.needsEmailVerification += 1;
    if (["create_draft", "review_draft", "ready_in_outreach"].includes(signal.nextStep)) counts.contactReady += 1;
    return counts;
  }, { total: 0, person: 0, community_partner: 0, organization: 0, intent_signal: 0, public_engagement: 0, new: 0, qualified: 0, converted: 0, needsIdentity: 0, needsEmailVerification: 0, contactReady: 0 });
  return res.json({ success: true, signals: categorizedSignals, summary, bucketSummary, automaticallyRejected: rejected.length });
});

router.patch("/research/signals/:signalId", async (req, res) => {
  const status = String(req.body?.status || "");
  if (!["new", "reviewing", "qualified", "dismissed"].includes(status)) return res.status(400).json({ success: false, error: "Choose a valid review status." });
  const signal = await IntentSignal.findOneAndUpdate({ _id: req.params.signalId, workspaceId: req.auth.workspaceId }, { $set: { status } }, { new: true });
  if (!signal) return res.status(404).json({ success: false, error: "Signal not found." });
  if (status === "qualified") await InAppNotification.create({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id || null, monitorId: signal.monitorId, signalId: signal._id, type: "qualified_lead", title: "Qualified lead ready for review", message: `${signal.title || "A public lead"} was qualified. CRM import still requires individual approval.` });
  return res.json({ success: true, signal });
});

function invalidPlatformIdentityName(value) {
  return /\b(?:team|staff|editorial|support|customer service|meetup|linkedin|facebook)\b/i.test(String(value || ""));
}

function supportedPublicPerson(person) {
  const name = String(person?.name || "").replace(/\s+/g, " ").trim();
  return Boolean(name
    && /^[\p{L}.'’ -]+$/u.test(name)
    && name.split(/\s+/).length >= 2
    && !/\b(?:llc|l\.l\.c\.|inc\.?|corp\.?|company|fund|partners?|association|community|group|network|club)\b/i.test(name)
    && !invalidPlatformIdentityName(name));
}

const COMMUNITY_SOURCES = new Set(["linkedin_public", "facebook_public", "meetup_public", "community_directories"]);

function opportunityKind(signal, monitor) {
  if (biggerPocketsPolicy.isBiggerPocketsSignal(signal)) return "public_engagement";
  if (supportedPublicPerson({ name: signal.authorName }) || (signal.people || []).some(supportedPublicPerson)) return "person";
  if (monitor?.monitorType === "community_partner" || COMMUNITY_SOURCES.has(signal.source)) return "community_partner";
  if (signal.organizationName || signal.organizationDomain) return "organization";
  return "intent_signal";
}

function opportunityNextStep(signal, kind, crmContact, drafts = []) {
  if (kind === "public_engagement") return "manual_public_response";
  if (signal.status === "new") return "review_fit";
  if (kind !== "person" && signal.identityResolution?.status !== "supported") return "identify_person";
  if (!crmContact) return "add_to_crm";
  if (crmContact.emailStatus !== "verified") return "verify_email";
  if (!drafts.length) return "create_draft";
  if (!drafts.some((draft) => draft.status === "transferred")) return "review_draft";
  return "ready_in_outreach";
}

router.post("/research/signals/:signalId/identity-research", async (req, res) => {
  const signal = await IntentSignal.findOne({ _id: req.params.signalId, workspaceId: req.auth.workspaceId });
  if (!signal) return res.status(404).json({ success: false, error: "Signal not found." });
  try { biggerPocketsPolicy.assertNoBiggerPocketsSolicitation(signal, "Author enrichment for solicitation"); }
  catch (error) { return res.status(403).json({ success: false, error: error.message, code: error.code }); }

  const selected = req.body?.selectedPerson;
  if (selected) {
    const match = (signal.people || []).find((person) => person.name === String(selected.name || "").trim()
      && person.evidenceUrl === String(selected.evidenceUrl || "").trim()
      && supportedPublicPerson(person));
    if (!match) return res.status(400).json({ success: false, error: "Choose a person supported by the saved public evidence." });
    signal.authorName = match.name;
    signal.authorUrl = match.evidenceUrl;
    signal.identityResolution = {
      status: "supported",
      reason: `${match.name}${match.title ? ` (${match.title})` : ""} is explicitly named on the cited public page.`,
      evidenceUrls: [match.evidenceUrl],
    };
    await signal.save();
    return res.json({ success: true, status: "person_found", signal, person: match, message: `${match.name} was attached from public evidence. Any published email remains unverified.` });
  }

  try {
    const previousPeople = (signal.people || []).map((person) => person.toObject ? person.toObject() : person);
    const priorAutomatedIdentity = previousPeople.some((person) => person.name === signal.authorName && person.evidenceUrl === signal.authorUrl);
    const targets = [signal.sourceUrl];
    if (signal.organizationDomain) targets.push(`https://${signal.organizationDomain}`);
    const results = [];
    for (const target of [...new Set(targets.filter((url) => /^https?:\/\//i.test(url)))].slice(0, 2)) {
      try { results.push(await researchPublicWebsite(target)); } catch (_error) {}
    }
    const people = [...new Map(results.flatMap((result) => result.people || [])
      .filter(supportedPublicPerson)
      .map((person) => [`${person.name.toLowerCase()}|${person.evidenceUrl}`, person])).values()];
    const platformEmail = /@(?:meetup|facebook|linkedin)\.com$/i;
    const publishedEmails = [...new Set([...(signal.publishedEmails || []), ...results.flatMap((result) => result.emails || [])].filter((email) => !platformEmail.test(email)))].slice(0, 20);
    const evidence = [...new Map([...(signal.evidence || []).map((item) => item.toObject ? item.toObject() : item), ...results.flatMap((result) => result.evidence || [])]
      .filter((item) => item?.url)
      .map((item) => [item.url, item])).values()];

    signal.people = people;
    signal.publishedEmails = publishedEmails;
    signal.evidence = evidence;
    signal.websiteResearchStatus = results.some((result) => result.status === "completed") ? "completed" : results.some((result) => result.status === "blocked") ? "blocked" : "failed";
    if (priorAutomatedIdentity && !people.some((person) => person.name === signal.authorName && person.evidenceUrl === signal.authorUrl)) {
      signal.authorName = "";
      signal.authorUrl = "";
    }

    if (!results.some((result) => result.status === "completed")) {
      signal.identityResolution = {
        status: "unresolved",
        reason: "The public source blocked automated reading or was unavailable. No identity was added.",
        evidenceUrls: evidence.map((item) => item.url).slice(0, 10),
      };
      await signal.save();
      return res.json({ success: true, status: "source_unavailable", signal, message: "This public page would not allow an automated contact check. No identity was added. Open the original source and use its public group-contact option." });
    }

    if (people.length === 1) {
      const person = people[0];
      signal.authorName = person.name;
      signal.authorUrl = person.evidenceUrl;
      signal.identityResolution = {
        status: "supported",
        reason: `${person.name}${person.title ? ` (${person.title})` : ""} is explicitly named on the cited public page.`,
        evidenceUrls: [person.evidenceUrl],
      };
      await signal.save();
      return res.json({ success: true, status: "person_found", signal, person, message: `${person.name} was found on a public page. Any published email remains unverified.` });
    }

    signal.identityResolution = {
      status: "unresolved",
      reason: people.length > 1 ? "Several people are named in the public evidence; select the correct contact." : "The checked public pages do not publish a named organizer or contact person.",
      evidenceUrls: evidence.map((item) => item.url).slice(0, 10),
    };
    await signal.save();
    if (people.length > 1) return res.json({ success: true, status: "choose_person", signal, people, message: "Several people are named publicly. Choose the correct contact below; Growth Operator will not guess." });
    return res.json({ success: true, status: "no_person_found", signal, message: "No named organizer or contact person is published on this page. Keep it as a community opportunity or contact the group through the original platform." });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to research this public source." });
  }
});

router.post("/research/signals/:signalId/convert", async (req, res) => {
  try {
    const evaluated = await leadQualificationService.evaluate({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, signalId: req.params.signalId, auth: req.auth, useAi: false });
    if (biggerPocketsPolicy.isBiggerPocketsSignal(evaluated.signal) && !biggerPocketsPolicy.validIndependentRelationship(req.body)) return res.status(403).json({ success: false, code: "BIGGERPOCKETS_RELATIONSHIP_EVIDENCE_REQUIRED", error: `${biggerPocketsPolicy.POLICY_MESSAGE} CRM conversion requires documented inbound interest or an independently sourced relationship.` });
    let qualification = evaluated.signal.status === "qualified"
      ? { ...evaluated.qualification, qualificationStatus: "qualified", warnings: [...new Set([...(evaluated.qualification.warnings || []), "Qualification was confirmed by a human before CRM conversion."])] }
      : evaluated.qualification;
    if (biggerPocketsPolicy.isBiggerPocketsSignal(evaluated.signal)) qualification = { ...qualification, reasons: [...(qualification.reasons || []), `Relationship basis: ${req.body.relationshipBasis} — ${String(req.body.relationshipNote).trim().slice(0, 1000)}`] };
    const result = await leadQualificationService.converge({ workspaceId: req.auth.workspaceId, userId: req.auth.user?._id, signal: evaluated.signal, qualification, input: req.body || {} });
    return res.status(result.createdOpportunity ? 201 : 200).json({ success: true, contact: result.contact, organization: result.organization, opportunity: result.opportunity, qualification });
  } catch (error) { return res.status(error.code === "LEAD_SIGNAL_NOT_FOUND" ? 404 : 400).json({ success: false, error: error.message || "Unable to create CRM lead." }); }
});

function campaignRegistrationLinks(campaign) {
  return {
    eventbriteUrl: String(campaign.registrationLinks?.eventbrite?.url || campaign.eventId?.integrations?.eventbrite?.url || "").trim(),
    meetupUrl: String(campaign.registrationLinks?.meetup?.url || campaign.eventId?.integrations?.meetup?.url || "").trim(),
  };
}

function identifiedSignalPersonName(signal) {
  const name = String(signal.authorName || "").replace(/\s+/g, " ").trim();
  if (!name || /^(?:account not available|no person identified|unknown|anonymous|\/?u\/|@|https?:\/\/)/i.test(name)) return "";
  if (!/^[\p{L}.'’ -]+$/u.test(name) || name.split(/\s+/).length < 2) return "";
  if (/\b(?:llc|l\.l\.c\.|inc\.?|corp\.?|company|fund|partners?|association|community|group|network|club|team|staff|editorial|support|customer service|meetup|linkedin|facebook)\b/i.test(name)) return "";
  return name;
}

router.post("/research/signals/:signalId/email-drafts", async (req, res) => {
  try {
    const signal = await IntentSignal.findOne({ _id: req.params.signalId, workspaceId: req.auth.workspaceId });
    if (!signal) return res.status(404).json({ success: false, error: "Signal not found." });
    biggerPocketsPolicy.assertNoBiggerPocketsSolicitation(signal, "Email-draft generation");
    if (!['qualified', 'converted'].includes(signal.status)) return res.status(400).json({ success: false, error: "Save this as a possible lead before creating an email draft." });
    if (!identifiedSignalPersonName(signal)) return res.status(400).json({ success: false, error: "This result identifies a community or organization, not a person. Use Find contact person & email before creating a person-level email draft." });
    const campaign = await Campaign.findById(req.body?.campaignId).populate("eventId");
    if (!campaign) return res.status(404).json({ success: false, error: "Choose a valid event campaign." });
    const monitor = await ResearchMonitor.findById(signal.monitorId).lean();
    const templateSelection = researchAudienceForSignal(signal, monitor);
    templateSelection.template = campaign.emailAudienceTemplates?.[templateSelection.key] || null;
    const links = campaignRegistrationLinks(campaign);
    const missing = [!links.eventbriteUrl && "Eventbrite", !links.meetupUrl && "Meetup"].filter(Boolean);
    if (missing.length) return res.status(400).json({ success: false, error: `Add the ${missing.join(" and ")} link${missing.length === 1 ? "" : "s"} to this campaign before generating drafts. Every intent draft must include both registration links.` });
    const generated = generateIntentEmailDraft(signal.toObject(), campaign.toObject(), links, templateSelection);
    const draft = await IntentEmailDraft.findOneAndUpdate(
      { workspaceId: req.auth.workspaceId, signalId: signal._id, campaignId: campaign._id },
      { $set: { ...generated, ...links, body: ensureLinks(generated.body, links.eventbriteUrl, links.meetupUrl), status: "draft", reviewedAt: null, outreachId: null } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return res.status(201).json({ success: true, draft });
  } catch (error) { return res.status(400).json({ success: false, error: error.message || "Unable to generate the personalized draft." }); }
});

router.patch("/research/signals/:signalId/email-drafts/:draftId", async (req, res) => {
  const existing = await IntentEmailDraft.findOne({ _id: req.params.draftId, signalId: req.params.signalId, workspaceId: req.auth.workspaceId });
  if (!existing) return res.status(404).json({ success: false, error: "Email draft not found." });
  if (existing.status === "transferred") return res.status(409).json({ success: false, error: "This draft is already in Outreach." });
  if (req.body?.subject !== undefined) existing.subject = String(req.body.subject).trim().slice(0, 300);
  if (req.body?.body !== undefined) existing.body = ensureLinks(String(req.body.body), existing.eventbriteUrl, existing.meetupUrl);
  if (!existing.subject || !existing.body) return res.status(400).json({ success: false, error: "The subject and email body are required." });
  if (req.body?.status === "reviewed") { existing.status = "reviewed"; existing.reviewedAt = new Date(); }
  else existing.status = "draft";
  await existing.save();
  return res.json({ success: true, draft: existing });
});

router.post("/research/signals/:signalId/email-drafts/:draftId/transfer", async (req, res) => {
  const draft = await IntentEmailDraft.findOne({ _id: req.params.draftId, signalId: req.params.signalId, workspaceId: req.auth.workspaceId });
  if (!draft) return res.status(404).json({ success: false, error: "Email draft not found." });
  if (draft.status !== "reviewed") return res.status(400).json({ success: false, error: "Review and save the draft before moving it to Outreach." });
  if (!draft.templateAudienceKey || !draft.templateAudienceLabel || !draft.templateVersion) return res.status(400).json({ success: false, error: "This is an older untracked draft. Click Choose another campaign, select the campaign again, and generate a new draft from its approved template." });
  const signal = await IntentSignal.findOne({ _id: req.params.signalId, workspaceId: req.auth.workspaceId });
  try { biggerPocketsPolicy.assertNoBiggerPocketsSolicitation(signal || {}, "Outbound sequence transfer"); }
  catch (error) { return res.status(403).json({ success: false, error: error.message, code: error.code }); }
  if (!signal || !identifiedSignalPersonName(signal)) return res.status(400).json({ success: false, error: "This draft is not linked to a valid identified person. Research a real named contact before moving anything to Outreach." });
  const contact = await Contact.findOne({ sourceProvider: "intent_monitor", providerContactId: String(req.params.signalId) });
  if (!contact) return res.status(400).json({ success: false, error: "This person is not linked to a CRM contact yet. Close this window, click Add researched person to CRM, complete the contact, then reopen this draft." });
  if (!supportedPublicPerson({ name: contact.name || `${contact.firstName || ""} ${contact.lastName || ""}` })) return res.status(400).json({ success: false, error: "The linked CRM record is a platform or organization name—not a person. Identify a real contact before moving this draft to Outreach." });
  if (!contact.email) return res.status(400).json({ success: false, error: "This CRM contact has no email address. Open Contact next steps, add the email, save the contact, then try again." });
  if (contact.emailStatus !== "verified") return res.status(400).json({ success: false, error: "This email has not been confirmed. Open Contact next steps and check ‘I know this email address is correct’ only if you personally confirmed it, save the contact, then try again." });
  await Contact.updateOne({ _id: contact._id }, { $addToSet: { campaignIds: draft.campaignId } });
  const firstName = String(contact.firstName || contact.name || "there").trim().split(/\s+/)[0];
  const replaceContactFields = (value) => String(value || "")
    .replaceAll("{{firstName}}", firstName)
    .replaceAll("{{company}}", String(contact.company || contact.name || "your organization").trim());
  const personalizedSubject = replaceContactFields(draft.subject);
  const personalizedBody = replaceContactFields(draft.body);
  const escapedBody = personalizedBody.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  const outreach = await Outreach.findOneAndUpdate(
    { campaignId: draft.campaignId, contactEmail: contact.email.toLowerCase().trim() },
    { $set: { campaignId: draft.campaignId, contactId: contact._id, organization: contact.company || contact.name || "Individual lead", contactName: contact.name || contact.firstName || "", contactEmail: contact.email.toLowerCase().trim(), contactRole: contact.title || "", reason: "Evidence-backed public prospect", subject: personalizedSubject, emailDraft: personalizedBody, htmlBody: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#333;">${escapedBody}</div>`, eventLink: draft.eventbriteUrl, templateVersion: draft.templateVersion, templateAudienceKey: draft.templateAudienceKey, templateAudienceLabel: draft.templateAudienceLabel, status: "pending", errorMessage: "" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  draft.status = "transferred"; draft.outreachId = outreach._id; await draft.save();
  return res.status(201).json({ success: true, draft, outreach, message: "Draft moved to Outreach as pending review. Nothing was sent." });
});

router.post("/research/signals/:signalId/public-response-draft", async (req, res) => {
  const signal = await IntentSignal.findOne({ _id: req.params.signalId, workspaceId: req.auth.workspaceId }).lean();
  if (!signal) return res.status(404).json({ success: false, error: "Signal not found." });
  if (!biggerPocketsPolicy.isBiggerPocketsSignal(signal)) return res.status(400).json({ success: false, error: "This public-response policy applies only to BiggerPockets-derived results." });
  const draft = req.body?.draft === undefined ? biggerPocketsPolicy.publicResponseDraft(signal) : String(req.body.draft || "").trim();
  if (!draft) return res.status(400).json({ success: false, error: "Enter a useful individualized public response." });
  const violations = biggerPocketsPolicy.prohibitedPublicResponseContent(draft);
  if (violations.length) return res.status(400).json({ success: false, code: "BIGGERPOCKETS_PROMOTION_BLOCKED", error: `Remove ${violations.join(", ")} before copying this public response.` });
  return res.json({ success: true, draft, policy: biggerPocketsPolicy.POLICY_MESSAGE, manualReviewRequired: true, postingSupported: false });
});

router.post("/research/plan", async (req, res) => {
  try {
    const question = String(req.body?.question || "").trim();
    if (question.length < 8 || question.length > 1000) {
      return res.status(400).json({ success: false, error: "Enter a market question between 8 and 1,000 characters." });
    }
    const plan = await compileMarketQuestion(question);
    return res.json({ success: true, plan });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to build a research plan." });
  }
});

router.get("/research/history", async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const audiences = await Audience.find({ workspaceId: req.auth.workspaceId })
      .select("name description status source totalOrgs lastDiscoveredAt createdAt updatedAt")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const audienceIds = audiences.map((audience) => audience._id);
    const jobs = await MarketResearchJob.find({ workspaceId: req.auth.workspaceId, audienceId: { $in: audienceIds } })
      .select("audienceId question sourceId status statistics error startedAt completedAt createdAt updatedAt")
      .sort({ createdAt: -1 })
      .lean();
    const latestJobByAudience = new Map();
    jobs.forEach((job) => {
      const key = String(job.audienceId || "");
      if (key && !latestJobByAudience.has(key)) latestJobByAudience.set(key, job);
    });
    return res.json({
      success: true,
      history: audiences.map((audience) => ({
        ...audience,
        job: latestJobByAudience.get(String(audience._id)) || null,
      })),
    });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to load saved research history." });
  }
});

router.get("/research/people-previews", async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const previews = await PeopleResearchPreview.find({ workspaceId: req.auth.workspaceId })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();
    return res.json({ success: true, previews });
  } catch (_error) {
    return res.status(500).json({ success: false, error: "Unable to load staged people research." });
  }
});

router.get("/research/results/:audienceId", async (req, res) => {
  try {
    const audience = await Audience.findOne({ _id: req.params.audienceId, workspaceId: req.auth.workspaceId }).lean();
    if (!audience) return res.status(404).json({ success: false, error: "Research list not found." });
    const organizations = await Organization.find({ _id: { $in: audience.organizationIds || [] }, workspaceId: req.auth.workspaceId })
      .sort({ audienceScore: -1, name: 1 })
      .limit(500)
      .lean();
    return res.json({ success: true, audience, organizations });
  } catch (error) {
    return res.status(400).json({ success: false, error: "Unable to load research results." });
  }
});

router.get("/research/results/:audienceId/people", async (req, res) => {
  const audience = await Audience.findOne({ _id: req.params.audienceId, workspaceId: req.auth.workspaceId }).lean();
  if (!audience) return res.status(404).json({ success: false, error: "Research list not found." });
  const organizations = await Organization.find({ _id: { $in: audience.organizationIds || [] }, workspaceId: req.auth.workspaceId })
    .select("name domain decisionMakers")
    .lean();
  const people = organizations.flatMap((organization) => (organization.decisionMakers || []).map((person) => ({
    ...person,
    organizationId: organization._id,
    company: organization.name,
    domain: organization.domain,
    verificationRequired: Boolean(person.email && person.emailStatus !== "verified"),
  })));
  return res.json({ success: true, people });
});

router.post("/research/run", async (req, res) => {
  try {
    const question = String(req.body?.question || "").trim();
    const plan = req.body?.plan || await compileMarketQuestion(question);
    const maxResults = Math.min(5000, Math.max(1, Number(req.body?.maxResults) || 1000));
    const status = sourceStatus();
    const audience = await Audience.create({
      workspaceId: req.auth.workspaceId,
      name: String(plan.name || "Growth Operator market research").slice(0, 160),
      description: String(plan.summary || question),
      source: "ai",
      criteria: plan.criteria || {},
    });
    const job = await MarketResearchJob.create({
      workspaceId: req.auth.workspaceId,
      userId: req.auth.user?._id || null,
      audienceId: audience._id,
      question: question || plan.summary || plan.name,
      plan,
      sourceId: status.id,
      status: status.configured ? "queued" : "source_required",
      error: status.configured ? "" : status.message,
    });
    if (status.configured) setImmediate(() => runMarketResearchJob(job._id, { maxResults }).catch(() => {}));
    return res.status(202).json({ success: true, job, audience, source: status });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to start market research." });
  }
});

router.get("/research/jobs/:jobId", async (req, res) => {
  const job = await MarketResearchJob.findOne({ _id: req.params.jobId, workspaceId: req.auth.workspaceId }).lean();
  if (!job) return res.status(404).json({ success: false, error: "Research job not found." });
  return res.json({ success: true, job });
});

// ===================================================================
// AUDIENCE CRUD ROUTES
// ===================================================================

// ======================================
// LIST AUDIENCES
// ======================================

router.get("/", async (req, res) => {
  try {
    const {
      status,
      source,
      sort = "recent",
      page = "1",
      limit = "25",
    } = req.query;

    const filter = { workspaceId: req.auth.workspaceId };

    if (status) {
      const validStatuses = ["draft", "active", "archived"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        });
      }
      filter.status = status;
    }

    if (source) {
      const validSources = ["manual", "ai", "import"];
      if (!validSources.includes(source)) {
        return res.status(400).json({
          success: false,
          error: `Invalid source. Must be one of: ${validSources.join(", ")}`,
        });
      }
      filter.source = source;
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    // Sort (newest first by default)
    const sortMap = {
      recent: { createdAt: -1 },
      name: { name: 1 },
    };
    const sortOrder = sortMap[sort] || sortMap.recent;

    const [audiences, totalResults] = await Promise.all([
      Audience.find(filter)
        .select(
          "name status source totalOrgs lastDiscoveredAt createdAt updatedAt",
        )
        .sort(sortOrder)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Audience.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      audiences,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalResults,
        totalPages: Math.ceil(totalResults / limitNum),
      },
    });
  } catch (error) {
    console.error("GET / error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to retrieve audiences",
    });
  }
});

router.post("/imports/organizations/preview", async (req, res) => {
  try {
    const data = await previewOrganizationImport(req.body?.rows);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to preview organizations" });
  }
});

router.post("/imports/organizations", async (req, res) => {
  try {
    const data = await importOrganizations({ rows: req.body?.rows, name: req.body?.name });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to import organizations" });
  }
});

// ======================================
// GET AUDIENCE DETAILS
// ======================================

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const audience = await Audience.findById(id).lean();

    if (!audience) {
      return res.status(404).json({
        success: false,
        error: "Audience not found",
      });
    }

    // Get latest DiscoveryRun
    const latestDiscoveryRun = await DiscoveryRun.findOne({ audienceId: id })
      .sort({ createdAt: -1 })
      .select(
  "status statistics scoreDistribution completedAt startedAt errorDetails pagination",
      )
      .lean();

    return res.json({
      success: true,
      audience: {
        ...audience,
        organizationIdsCount: audience.organizationIds?.length || 0,
      },
      latestDiscoveryRun: latestDiscoveryRun || null,
    });
  } catch (error) {
    console.error("GET /:id error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to retrieve audience",
    });
  }
});

// ======================================
// CREATE AUDIENCE
// ======================================

router.post("/", async (req, res) => {
  try {
    const {
      name,
      description,
      status = "draft",
      source = "manual",
      criteria,
    } = req.body;

    // Validate name
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: "name is required and must be a non-empty string",
      });
    }

    // Validate status
    const validStatuses = ["draft", "active", "archived"];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    // Validate source
    const validSources = ["manual", "ai", "import"];
    if (source && !validSources.includes(source)) {
      return res.status(400).json({
        success: false,
        error: `Invalid source. Must be one of: ${validSources.join(", ")}`,
      });
    }

    // Validate criteria if provided
    if (criteria) {
      if (criteria.minimumScore !== undefined) {
        const score = Number(criteria.minimumScore);
        if (isNaN(score) || score < 0 || score > 100) {
          return res.status(400).json({
            success: false,
            error: "criteria.minimumScore must be a number between 0 and 100",
          });
        }
      }

      if (criteria.targetTier !== undefined && criteria.targetTier !== null) {
        const validTiers = ["high", "medium", "low", "unscored"];
        if (!validTiers.includes(criteria.targetTier)) {
          return res.status(400).json({
            success: false,
            error: `Invalid criteria.targetTier. Must be one of: ${validTiers.join(", ")}, or null`,
          });
        }
      }

      if (criteria.employeeRange) {
        const { min, max } = criteria.employeeRange;
        if (min !== null && max !== null && min > max) {
          return res.status(400).json({
            success: false,
            error: "criteria.employeeRange.min must be <= max",
          });
        }
      }
    }

    const audience = await Audience.create({
      workspaceId: req.auth.workspaceId,
      name: name.trim(),
      description: description ? description.trim() : "",
      status,
      source,
      criteria: criteria || {
        keywords: [],
        industries: [],
        locations: [],
        employeeRange: { min: null, max: null },
        minimumScore: 0,
        targetTier: null,
      },
    });

    return res.status(201).json({
      success: true,
      audience: audience.toObject(),
    });
  } catch (error) {
    console.error("POST / error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to create audience",
    });
  }
});

// ======================================
// UPDATE AUDIENCE
// ======================================

router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, status, criteria } = req.body;

    const audience = await Audience.findById(id);

    if (!audience) {
      return res.status(404).json({
        success: false,
        error: "Audience not found",
      });
    }

    // Do not allow updates to archived audiences
    if (audience.status === "archived") {
      return res.status(400).json({
        success: false,
        error: "Cannot update archived audience",
      });
    }

    // Validate and update name
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: "name must be a non-empty string",
        });
      }
      audience.name = name.trim();
    }

    // Update description
    if (description !== undefined) {
      audience.description = description ? description.trim() : "";
    }

    // Validate and update status
    if (status !== undefined) {
      const validStatuses = ["draft", "active", "archived"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        });
      }
      audience.status = status;
    }

    // Validate and update criteria
    if (criteria !== undefined) {
      if (criteria.minimumScore !== undefined) {
        const score = Number(criteria.minimumScore);
        if (isNaN(score) || score < 0 || score > 100) {
          return res.status(400).json({
            success: false,
            error: "criteria.minimumScore must be a number between 0 and 100",
          });
        }
        audience.criteria.minimumScore = score;
      }

      if (criteria.targetTier !== undefined) {
        if (criteria.targetTier !== null) {
          const validTiers = ["high", "medium", "low", "unscored"];
          if (!validTiers.includes(criteria.targetTier)) {
            return res.status(400).json({
              success: false,
              error: `Invalid criteria.targetTier. Must be one of: ${validTiers.join(", ")}, or null`,
            });
          }
        }
        audience.criteria.targetTier = criteria.targetTier;
      }

      if (criteria.keywords !== undefined) {
        if (!Array.isArray(criteria.keywords)) {
          return res.status(400).json({
            success: false,
            error: "criteria.keywords must be an array",
          });
        }
        audience.criteria.keywords = criteria.keywords;
      }

      if (criteria.industries !== undefined) {
        if (!Array.isArray(criteria.industries)) {
          return res.status(400).json({
            success: false,
            error: "criteria.industries must be an array",
          });
        }
        audience.criteria.industries = criteria.industries;
      }

      if (criteria.locations !== undefined) {
        if (!Array.isArray(criteria.locations)) {
          return res.status(400).json({
            success: false,
            error: "criteria.locations must be an array",
          });
        }
        audience.criteria.locations = criteria.locations;
      }

      if (criteria.employeeRange !== undefined) {
        const { min, max } = criteria.employeeRange;
        if (min !== null && max !== null && min > max) {
          return res.status(400).json({
            success: false,
            error: "criteria.employeeRange.min must be <= max",
          });
        }
        audience.criteria.employeeRange = criteria.employeeRange;
      }
    }

    await audience.save();

    return res.json({
      success: true,
      audience: audience.toObject(),
    });
  } catch (error) {
    console.error("PATCH /:id error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to update audience",
    });
  }
});

// ======================================
// ARCHIVE AUDIENCE
// ======================================

router.patch("/:id/archive", async (req, res) => {
  try {
    const { id } = req.params;

    const audience = await Audience.findById(id);

    if (!audience) {
      return res.status(404).json({
        success: false,
        error: "Audience not found",
      });
    }

    if (audience.status === "archived") {
      return res.status(400).json({
        success: false,
        error: "Audience is already archived",
      });
    }

    audience.status = "archived";
    await audience.save();

    return res.json({
      success: true,
      message: "Audience archived successfully",
      audience: audience.toObject(),
    });
  } catch (error) {
    console.error("PATCH /:id/archive error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to archive audience",
    });
  }
});

// ===================================================================
// ANALYTICS ROUTES (READ-ONLY)
// ===================================================================

// ======================================
// GET AUDIENCE ANALYTICS SUMMARY
// Dashboard view: performance, quality, latest run
// ======================================

router.get("/:id/analytics", async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format
    if (!id.match(/^[0-9a-f]{24}$/i)) {
      return res.status(404).json({
        success: false,
        error: "Audience not found",
      });
    }

    // Validate audience exists
    const audience = await Audience.findById(id).lean();
    if (!audience) {
      return res.status(404).json({
        success: false,
        error: "Audience not found",
      });
    }

    // Get all discovery runs for this audience
    const runs = await DiscoveryRun.find({ audienceId: id })
      .select(
  "status statistics scoreDistribution startedAt completedAt errorDetails",
      )
      .sort({ completedAt: -1 })
      .lean();

    // Aggregate run statistics
    const summary = {
      totalRuns: runs.length,
      successfulRuns: 0,
      partialRuns: 0,
      failedRuns: 0,
      totalOrganizationsFound: 0,
      totalOrganizationsCreated: 0,
      totalOrganizationsUpdated: 0,
    };

    runs.forEach((run) => {
      if (run.status === "success") summary.successfulRuns += 1;
      if (run.status === "partial") summary.partialRuns += 1;
      if (run.status === "failed") summary.failedRuns += 1;

      if (run.statistics) {
        summary.totalOrganizationsFound +=
          run.statistics.organizationsFound || 0;
        summary.totalOrganizationsCreated +=
          run.statistics.organizationsCreated || 0;
        summary.totalOrganizationsUpdated +=
          run.statistics.organizationsUpdated || 0;
      }
    });

    // Get organizations for this audience
    const organizations = await Organization.find({
      _id: { $in: audience.organizationIds || [] },
    })
      .select("audienceScore audienceTier")
      .lean();

    // Calculate quality metrics
    let totalScore = 0;
    const tierCounts = {
      high: 0,
      medium: 0,
      low: 0,
      unscored: 0,
    };

    organizations.forEach((org) => {
      totalScore += org.audienceScore || 0;
      tierCounts[org.audienceTier] = (tierCounts[org.audienceTier] || 0) + 1;
    });

    const quality = {
      averageScore:
        organizations.length > 0
          ? Math.round((totalScore / organizations.length) * 10) / 10
          : 0,
      highTierOrganizations: tierCounts.high,
      mediumTierOrganizations: tierCounts.medium,
      lowTierOrganizations: tierCounts.low,
      unscoredOrganizations: tierCounts.unscored,
    };

    // Format latest run
    const latestRun = runs.length > 0 ? runs[0] : null;
    const latestRunSummary = latestRun
      ? {
          id: latestRun._id,
          status: latestRun.status,
          startedAt: latestRun.startedAt,
          completedAt: latestRun.completedAt,
          organizationsCreated: latestRun.statistics?.organizationsCreated || 0,
          scoreDistribution: latestRun.scoreDistribution || {
            high: 0,
            medium: 0,
            low: 0,
            unscored: 0,
          },
        }
      : null;

    return res.json({
      success: true,
      analytics: {
        audienceId: audience._id,
        audienceName: audience.name,
        summary,
        quality,
        latestRun: latestRunSummary,
      },
    });
  } catch (error) {
    console.error("GET /:id/analytics error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to retrieve analytics",
    });
  }
});

// ======================================
// GET DISCOVERY RUN HISTORY
// List all discovery runs with pagination
// ======================================

router.get("/:id/runs", async (req, res) => {
  try {
    const { id } = req.params;
    const { page = "1", limit = "25", status } = req.query;

    // Validate ID format
    if (!id.match(/^[0-9a-f]{24}$/i)) {
      return res.status(404).json({
        success: false,
        error: "Audience not found",
      });
    }

    // Validate audience exists
    const audience = await Audience.findById(id).lean();
    if (!audience) {
      return res.status(404).json({
        success: false,
        error: "Audience not found",
      });
    }

    // Validate status filter
    const validStatuses = ["success", "partial", "failed"];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    // Validate pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));

    if (isNaN(pageNum) || isNaN(limitNum)) {
      return res.status(400).json({
        success: false,
        error: "page and limit must be numeric",
      });
    }

    const skip = (pageNum - 1) * limitNum;

    // Build filter
    const filter = { audienceId: id };
    if (status) {
      filter.status = status;
    }

    // Query runs (newest first)
    const [runs, totalResults] = await Promise.all([
      DiscoveryRun.find(filter)
        .select(
  "status startedAt completedAt statistics scoreDistribution errorDetails pagination criteriaSnapshot",
        )
        .sort({ completedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      DiscoveryRun.countDocuments(filter),
    ]);

    // Format runs with computed duration
    const formattedRuns = runs.map((run) => {
      const duration =
        run.completedAt && run.startedAt
          ? run.completedAt.getTime() - run.startedAt.getTime()
          : 0;

      return {
        id: run._id,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: duration,
        statistics: run.statistics || {},
        scoreDistribution: run.scoreDistribution || {
          high: 0,
          medium: 0,
          low: 0,
          unscored: 0,
        },
        pagination: run.pagination || {},
errorDetails: run.errorDetails || {},      };
    });

    return res.json({
      success: true,
      runs: formattedRuns,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalResults,
        totalPages: Math.ceil(totalResults / limitNum),
      },
    });
  } catch (error) {
    console.error("GET /:id/runs error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to retrieve discovery runs",
    });
  }
});

// ======================================
// GET ORGANIZATION INSIGHTS FOR AUDIENCE
// Analytics on discovered organizations
// ======================================

router.get("/:id/organizations/summary", async (req, res) => {
  try {
    const { id } = req.params;
    const { top = "5" } = req.query;

    // Validate ID format
    if (!id.match(/^[0-9a-f]{24}$/i)) {
      return res.status(404).json({
        success: false,
        error: "Audience not found",
      });
    }

    // Validate audience exists
    const audience = await Audience.findById(id).lean();
    if (!audience) {
      return res.status(404).json({
        success: false,
        error: "Audience not found",
      });
    }

    // Validate top parameter
    const topNum = parseInt(top, 10);
    if (isNaN(topNum) || topNum < 1 || topNum > 100) {
      return res.status(400).json({
        success: false,
        error: "top must be numeric between 1 and 100",
      });
    }

    // Get organizations for this audience
    const organizations = await Organization.find({
      _id: { $in: audience.organizationIds || [] },
    })
      .select(
        "name audienceScore audienceTier industry location employeeCount keywords",
      )
      .lean();

    // Calculate score distribution and metrics
    let totalScore = 0;
    const tierCounts = {
      high: 0,
      medium: 0,
      low: 0,
      unscored: 0,
    };
    const industryCounts = {};
    const locationCounts = {};
    const employeeSizeCounts = {
      small: 0,
      medium: 0,
      large: 0,
    };

    organizations.forEach((org) => {
      // Score and tier
      totalScore += org.audienceScore || 0;
      tierCounts[org.audienceTier] = (tierCounts[org.audienceTier] || 0) + 1;

      // Industry
      if (org.industry) {
        industryCounts[org.industry] = (industryCounts[org.industry] || 0) + 1;
      }

      // Location
      if (org.location) {
        locationCounts[org.location] = (locationCounts[org.location] || 0) + 1;
      }

      // Employee size
      const count = org.employeeCount || 0;
      if (count <= 50) {
        employeeSizeCounts.small += 1;
      } else if (count <= 500) {
        employeeSizeCounts.medium += 1;
      } else {
        employeeSizeCounts.large += 1;
      }
    });

    // Sort and limit top industries
    const topIndustries = Object.entries(industryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topNum)
      .map(([industry, count]) => ({
        industry,
        count,
      }));

    // Sort and limit top locations
    const topLocations = Object.entries(locationCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topNum)
      .map(([location, count]) => ({
        location,
        count,
      }));

    // Get top scoring organizations
    const topOrganizations = organizations
      .sort((a, b) => (b.audienceScore || 0) - (a.audienceScore || 0))
      .slice(0, topNum)
      .map((org) => ({
        name: org.name,
        score: org.audienceScore || 0,
        tier: org.audienceTier,
        industry: org.industry || "Unknown",
      }));

    return res.json({
      success: true,
      organizationSummary: {
        totalOrganizations: organizations.length,
        scoreDistribution: tierCounts,
        averageScore:
          organizations.length > 0
            ? Math.round((totalScore / organizations.length) * 10) / 10
            : 0,
      },
      topIndustries,
      topLocations,
      employeeSizeBreakdown: employeeSizeCounts,
      topOrganizations,
    });
  } catch (error) {
    console.error("GET /:id/organizations/summary error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to retrieve organization summary",
    });
  }
});

// ===================================================================
// DISCOVERY & ORGANIZATION ROUTES (EXISTING)
// ===================================================================

// ======================================
// GET SAVED ORGANIZATIONS
// Query saved orgs by tier, score, source,
// industry, or location.
// ======================================

router.get("/organizations", async (req, res) => {
  try {
    const {
      tier,
      minScore,
      source,
      industry,
      location,
      sort = "score",
      page = "1",
      limit = "25",
    } = req.query;

    const filter = {};

    if (tier) {
      const validTiers = ["high", "medium", "low", "unscored"];
      if (!validTiers.includes(tier)) {
        return res.status(400).json({
          error: `Invalid tier. Must be one of: ${validTiers.join(", ")}`,
        });
      }
      filter.audienceTier = tier;
    }

    if (minScore !== undefined) {
      const parsed = Number(minScore);
      if (isNaN(parsed) || parsed < 0 || parsed > 100) {
        return res
          .status(400)
          .json({ error: "minScore must be a number between 0 and 100" });
      }
      filter.audienceScore = { $gte: parsed };
    }

    if (source) filter.source = source;

    if (industry) {
      filter.industry = { $regex: industry, $options: "i" };
    }

    if (location) {
      filter.location = { $regex: location, $options: "i" };
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    // Sort
    const sortMap = {
      score: { audienceScore: -1 },
      name: { name: 1 },
      recent: { createdAt: -1 },
    };
    const sortOrder = sortMap[sort] || sortMap.score;

    const [organizations, totalResults] = await Promise.all([
      Organization.find(filter)
        .select(
          "name website industry employeeCount location audienceScore audienceTier scoreReasons domain source discoveredAt",
        )
        .sort(sortOrder)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Organization.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      organizations,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalResults,
        totalPages: Math.ceil(totalResults / limitNum),
      },
    });
  } catch (error) {
    console.error("GET /organizations error:", error);
    return res.status(500).json({ error: "Failed to retrieve organizations" });
  }
});

// ======================================
// DISCOVER ORGANIZATIONS FOR AUDIENCE
// Triggers discovery flow for a given Audience:
// - Search Growth Operator's organization intelligence records
// - Enrich each organization
// - Score and filter by criteria
// - Save/update to MongoDB
// - Link to Audience.organizationIds
// ======================================

router.post("/:id/discover", async (req, res) => {
  const startedAt = Date.now();
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Audience ID is required",
      });
    }

    const result = await discoverOrganizationsForAudience(id);

    if (!result.success) {
      const status = result.status === 401 || result.status === 403 || result.status === 429
        ? result.status
        : 400;
      return res.status(status).json({
        success: false,
        error: result.error,
        code: result.errorCode || "organization_search_failed",
        retryAfter: result.retryAfter || null,
        action: "Review the research criteria, then retry.",
      });
    }

    return res.json({
      success: result.success,
      audienceId: result.audienceId,
      discoveryRunId: result.discoveryRunId,
      organizationsFound: result.organizationsFound,
      organizationsCreated: result.organizationsCreated,
      organizationsUpdated: result.organizationsUpdated,
      duplicatesSkipped: result.duplicatesSkipped,
      completedAt: result.completedAt,
      audience: result.audience,
    });
  } catch (error) {
    console.error("POST /:id/discover error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to discover organizations for audience",
    });
  }
});

// ======================================
// DISCOVER AUDIENCE
// Community and future first-party research sources
// ======================================

router.post("/discover", async (req, res) => {
  try {
    const { query, campaignId } = req.body;

    if (!query) {
      return res.status(400).json({
        error: "Audience query is required",
      });
    }

    const result = await discoverAudienceSources(query);

    if (!result.success) {
      return res.status(400).json(result);
    }

    const contacts = [];

    for (const item of result.results) {
      // Prevent duplicate contacts
      const existing = await Contact.findOne({
        email: item.email || "",

        company: item.company || item.organization || "",
      });

      if (existing) {
        contacts.push(existing);

        continue;
      }

      const contact = await Contact.create({
        name: item.name || "",

        email: item.email || "",

        company: item.company || item.organization || "",

        role: item.role || item.contactRole || "",

        source: item.source || "manual",

        campaignId,

        tags: [query],

        status: "new",
      });

      contacts.push(contact);
    }

    res.json({
      success: true,

      contactsCreated: contacts.length,

      contacts,
    });
  } catch (error) {
    console.error("AUDIENCE DISCOVERY ERROR:", error);

    res.status(500).json({
      error: "Failed discovering audience",
    });
  }
});

// ===================================================================
// ORGANIZATION PRIORITIZATION RETRIEVAL ROUTES (READ-ONLY)
// ===================================================================

// ======================================
// GET PRIORITIZED ORGANIZATIONS FOR AUDIENCE
// Return organizations ranked by priorityScore
// with support for filtering by tier/score and sorting
// ======================================

router.get("/:id/organizations/prioritized", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      page = "1",
      limit = "25",
      tier,
      minScore,
      maxScore,
      sortBy = "priority",
    } = req.query;

    // Validate audience ID format
    if (!id.match(/^[0-9a-f]{24}$/i)) {
      return res.status(404).json({
        success: false,
        error: "Audience not found",
      });
    }

    // Validate audience exists
    const audience = await Audience.findById(id).lean();
    if (!audience) {
      return res.status(404).json({
        success: false,
        error: "Audience not found",
      });
    }

    // Validate and parse pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));

    if (isNaN(pageNum) || isNaN(limitNum)) {
      return res.status(400).json({
        success: false,
        error: "page and limit must be numeric",
      });
    }

    if (pageNum < 1) {
      return res.status(400).json({
        success: false,
        error: "page must be >= 1",
      });
    }

    if (limitNum < 1 || limitNum > 100) {
      return res.status(400).json({
        success: false,
        error: "limit must be between 1 and 100",
      });
    }

    // Validate tier filter
    const validTiers = ["hot", "warm", "cold"];
    if (tier && !validTiers.includes(tier)) {
      return res.status(400).json({
        success: false,
        error: `Invalid tier value. Must be one of: ${validTiers.join(", ")}`,
      });
    }

    // Validate score filters
    let minScoreNum = null;
    let maxScoreNum = null;

    if (minScore !== undefined) {
      minScoreNum = Number(minScore);
      if (isNaN(minScoreNum) || minScoreNum < 0 || minScoreNum > 100) {
        return res.status(400).json({
          success: false,
          error: "minScore must be between 0 and 100",
        });
      }
    }

    if (maxScore !== undefined) {
      maxScoreNum = Number(maxScore);
      if (isNaN(maxScoreNum) || maxScoreNum < 0 || maxScoreNum > 100) {
        return res.status(400).json({
          success: false,
          error: "maxScore must be between 0 and 100",
        });
      }
    }

    // Validate sortBy
    const validSortOptions = [
      "priority",
      "score_asc",
      "score_desc",
      "recent",
      "name",
    ];
    if (!validSortOptions.includes(sortBy)) {
      return res.status(400).json({
        success: false,
        error: `Invalid sortBy. Must be one of: ${validSortOptions.join(", ")}`,
      });
    }

    // Build filter for organizations
    const filter = { _id: { $in: audience.organizationIds || [] } };

    if (tier) {
      filter.priorityTier = tier;
    }

    if (minScoreNum !== null || maxScoreNum !== null) {
      filter.priorityScore = {};
      if (minScoreNum !== null) {
        filter.priorityScore.$gte = minScoreNum;
      }
      if (maxScoreNum !== null) {
        filter.priorityScore.$lte = maxScoreNum;
      }
    }

    // Build sort order
    const sortMap = {
      priority: { priorityScore: -1 },
      score_asc: { priorityScore: 1 },
      score_desc: { priorityScore: -1 },
      recent: { discoveredAt: -1 },
      name: { name: 1 },
    };
    const sortOrder = sortMap[sortBy];

    // Calculate skip
    const skip = (pageNum - 1) * limitNum;

    // Query organizations
    const [organizations, totalResults] = await Promise.all([
      Organization.find(filter)
        .select(
          "name domain website industry employeeCount location linkedinUrl audienceScore audienceTier scoreReasons priorityScore priorityTier priorityReasons discoveredAt enrichedAt priorityCalculatedAt source keywords",
        )
        .sort(sortOrder)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Organization.countDocuments(filter),
    ]);

    // Calculate tier counts and summary statistics
    let hotCount = 0;
    let warmCount = 0;
    let coldCount = 0;
    let totalPriorityScore = 0;

    const scoreDistribution = { "80-100": 0, "50-79": 0, "0-49": 0 };

    // Get all organizations for summary (not paginated)
    const allOrganizations = await Organization.find(filter)
      .select("priorityScore priorityTier")
      .lean();

    allOrganizations.forEach((org) => {
      const score = org.priorityScore || 0;
      totalPriorityScore += score;

      if (org.priorityTier === "hot") hotCount += 1;
      if (org.priorityTier === "warm") warmCount += 1;
      if (org.priorityTier === "cold") coldCount += 1;

      if (score >= 80) {
        scoreDistribution["80-100"] += 1;
      } else if (score >= 50) {
        scoreDistribution["50-79"] += 1;
      } else {
        scoreDistribution["0-49"] += 1;
      }
    });

    const averagePriorityScore =
      allOrganizations.length > 0
        ? Math.round((totalPriorityScore / allOrganizations.length) * 10) / 10
        : 0;

    return res.json({
      success: true,
      organizations,
      summary: {
        totalOrganizations: allOrganizations.length,
        byTier: {
          hot: hotCount,
          warm: warmCount,
          cold: coldCount,
        },
        averagePriorityScore,
        scoreDistribution,
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalResults,
        totalPages: Math.ceil(totalResults / limitNum),
      },
    });
  } catch (error) {
    console.error("GET /:id/organizations/prioritized error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to retrieve prioritized organizations",
    });
  }
});

// ======================================
// GET ORGANIZATION PRIORITY DETAILS
// Return single organization's priority breakdown
// ======================================

router.get("/organizations/:id/priority", async (req, res) => {
  try {
    const { id } = req.params;

    // Validate organization ID format
    if (!id.match(/^[0-9a-f]{24}$/i)) {
      return res.status(404).json({
        success: false,
        error: "Organization not found",
      });
    }

    // Fetch organization
    const organization = await Organization.findById(id)
      .select(
        "name domain website industry employeeCount location linkedinUrl phone description audienceScore audienceTier scoreReasons priorityScore priorityTier priorityReasons prioritySignals priorityCalculatedAt discoveredAt enrichedAt source keywords",
      )
      .lean();

    if (!organization) {
      return res.status(404).json({
        success: false,
        error: "Organization not found",
      });
    }

    // Build detailed signal explanations
    const signals = organization.prioritySignals || {};
    const detailedSignals = {
      audienceFit: {
        points: signals.audienceFit || 0,
        explanation:
          signals.audienceFit >= 30
            ? "High audience fit"
            : signals.audienceFit >= 20
              ? "Good audience fit"
              : signals.audienceFit > 0
                ? "Moderate audience fit"
                : "Low audience fit",
        calculation: `audienceScore ${organization.audienceScore} → ${signals.audienceFit} points`,
      },
      industryMatch: {
        points: signals.industryMatch || 0,
        explanation:
          signals.industryMatch >= 15
            ? "Exact industry match"
            : signals.industryMatch > 0
              ? "Partial industry match"
              : "No industry match",
        calculation: `${organization.industry || "Unknown"} industry → ${signals.industryMatch} points`,
      },
      companySize: {
        points: signals.companySize || 0,
        explanation:
          signals.companySize >= 15
            ? "Ideal employee count"
            : signals.companySize > 0
              ? "Known employee count"
              : "Unknown employee count",
        calculation: `${organization.employeeCount || "Unknown"} employees → ${signals.companySize} points`,
      },
      keywordMatch: {
        points: signals.keywordMatch || 0,
        explanation:
          signals.keywordMatch >= 7
            ? "Strong keyword overlap"
            : signals.keywordMatch > 0
              ? "Some keyword match"
              : "No keyword match",
        calculation: `${(organization.keywords || []).length} keywords → ${signals.keywordMatch} points`,
      },
      dataQuality: {
        points: signals.dataQuality || 0,
        explanation:
          signals.dataQuality >= 8
            ? "Complete profile"
            : signals.dataQuality >= 5
              ? "Well-enriched profile"
              : "Minimal enrichment",
        calculation: `Profile completeness → ${signals.dataQuality} points`,
      },
      recency: {
        points: signals.recency || 0,
        explanation:
          signals.recency >= 10
            ? "Recently discovered"
            : signals.recency >= 6
              ? "Moderately recent"
              : signals.recency > 0
                ? "Older discovery"
                : "Very stale",
        calculation: `${
          organization.discoveredAt
            ? Math.floor(
                (Date.now() - new Date(organization.discoveredAt).getTime()) /
                  (1000 * 60 * 60 * 24),
              )
            : "unknown"
        } days ago → ${signals.recency} points`,
      },
    };

    // Determine if recalculation recommended
    const recalculationRecommended =
      !organization.priorityCalculatedAt ||
      Date.now() - new Date(organization.priorityCalculatedAt).getTime() >
        30 * 24 * 60 * 60 * 1000; // 30 days

    return res.json({
      success: true,
      organization: {
        _id: organization._id,
        name: organization.name,
        domain: organization.domain,
        website: organization.website,
        industry: organization.industry,
        employeeCount: organization.employeeCount,
        location: organization.location,
        linkedinUrl: organization.linkedinUrl,
        phone: organization.phone,
        description: organization.description,
        audienceScore: organization.audienceScore,
        audienceTier: organization.audienceTier,
        scoreReasons: organization.scoreReasons,
        discoveredAt: organization.discoveredAt,
        enrichedAt: organization.enrichedAt,
        source: organization.source,
        keywords: organization.keywords,
      },
      priority: {
        score: organization.priorityScore || 0,
        tier: organization.priorityTier || "cold",
        reasons: organization.priorityReasons || [],
        signals: detailedSignals,
        calculatedAt: organization.priorityCalculatedAt,
        recalculationRecommended,
      },
    });
  } catch (error) {
    console.error("GET /organizations/:id/priority error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to retrieve organization priority details",
    });
  }
});

module.exports = router;
